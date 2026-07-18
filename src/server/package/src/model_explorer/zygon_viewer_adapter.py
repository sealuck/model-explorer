"""Model Explorer adapter for Zygon Viewer MLIR, FX, and Graph artifacts."""

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
from typing import Dict

from .adapter import Adapter, AdapterMetadata
from .graph_builder import (
    Edge,
    EdgeOverlay,
    EdgeOverlaysData,
    Graph,
    GraphCollection,
    GraphNode,
    IncomingEdge,
    KeyValue,
    MetadataItem,
    TasksData,
)
from .types import ModelExplorerGraphs
from .zygon_viewer_tools import find_viewer_tool

# Source artifact path -> versioned Graph JSON path. Focus routes consume the
# exact Graph produced during conversion instead of projecting the Model again.
_graph_cache: dict[str, str] = {}

_RUN_MANIFEST_SCHEMA = "zygon/run-manifest/v2"
_OVERLAY_CACHE_SCHEMA = "zygon-viewer/overlay-cache/v2"
_LAYER_FILES = ("anomaly.json", "timing.json", "memory.json", "crash.json")


@dataclass(frozen=True)
class MaterializedRunManifest:
    """Persistent Viewer files selected for one Run Manifest."""

    graph_path: str
    node_data_paths: list[str]
    model_label: str


def get_cached_graph_json_path(model_path: str) -> str | None:
    """Return the cached Graph path for a converted Model artifact."""
    return _graph_cache.get(model_path)


def is_run_manifest(model_path: str) -> bool:
    """Return whether a JSON file declares the current Run Manifest schema."""
    if Path(model_path).suffix.lower() != ".json":
        return False
    try:
        document = json.loads(Path(model_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return isinstance(document, dict) and document.get("schema") == _RUN_MANIFEST_SCHEMA


def materialize_run_manifest(model_path: str) -> MaterializedRunManifest:
    """Refresh and resolve the persistent Overlay cache for a Run Manifest."""
    manifest_path = Path(model_path).resolve()
    tool = find_viewer_tool("zygon-viewer-overlay")
    process = subprocess.run(
        [tool, str(manifest_path)],
        check=False,
        capture_output=True,
        text=True,
    )
    if process.returncode != 0:
        detail = f": {process.stderr.strip()}" if process.stderr.strip() else ""
        raise RuntimeError(f"zygon-viewer-overlay failed{detail}")

    materialized = _read_overlay_cache(manifest_path.parent / "overlay")
    _graph_cache[str(manifest_path)] = materialized.graph_path
    _graph_cache[model_path] = materialized.graph_path
    return materialized


def _read_overlay_cache(cache_dir: Path) -> MaterializedRunManifest:
    """Validate one persistent Overlay cache and return its public files."""
    metadata_path = cache_dir / "metadata.json"
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(
            f"zygon-viewer-overlay produced invalid metadata: {metadata_path}"
        ) from error
    if metadata.get("schema") != _OVERLAY_CACHE_SCHEMA:
        raise RuntimeError("zygon-viewer-overlay produced unsupported cache metadata")

    graph_metadata = metadata.get("graph", {})
    if graph_metadata.get("path") != "graph.json":
        raise RuntimeError("Overlay cache metadata must select graph.json")
    graph_path = cache_dir / "graph.json"
    if not graph_path.is_file():
        raise RuntimeError("Overlay cache is missing graph.json")

    layers = metadata.get("layers", {})
    node_data_paths = [
        str(cache_dir / file_name)
        for file_name in _LAYER_FILES
        if layers.get(file_name.removesuffix(".json"), {}).get("present") is True
        and (cache_dir / file_name).is_file()
    ]
    try:
        graph_document = json.loads(graph_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("Overlay cache contains invalid graph.json") from error
    model_label = str(graph_document.get("label", ""))

    return MaterializedRunManifest(str(graph_path), node_data_paths, model_label)


def find_compiler_overlay(model_path: str) -> MaterializedRunManifest | None:
    """Resolve a fresh sibling `<model-stem>.overlay` cache for one MLIR file."""
    model = Path(model_path).resolve()
    if model.suffix.lower() != ".mlir":
        return None
    cache_dir = model.parent / f"{model.stem}.overlay"
    metadata_path = cache_dir / "metadata.json"
    if not metadata_path.is_file():
        return None
    materialized = _read_overlay_cache(cache_dir)
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    source = metadata.get("source", {})
    if source.get("kind") != "compiler_telemetry":
        return None
    actual_digest = hashlib.sha256(model.read_bytes()).hexdigest()
    if source.get("model_sha256") != actual_digest:
        raise RuntimeError(
            "the compiler telemetry Overlay is stale; rerun "
            "zygon-viewer-overlay for this MLIR artifact"
        )
    _graph_cache[str(model)] = materialized.graph_path
    _graph_cache[model_path] = materialized.graph_path
    return materialized


def _to_kv_list(data: list[dict]) -> list[KeyValue]:
    return [KeyValue(key=item["key"], value=item["value"]) for item in data]


def _to_metadata_list(data: list[dict]) -> list[MetadataItem]:
    return [
        MetadataItem(id=item["id"], attrs=_to_kv_list(item.get("attrs", [])))
        for item in data
    ]


def _to_edge_list(data: list[dict]) -> list[IncomingEdge]:
    return [
        IncomingEdge(
            sourceNodeId=item["sourceNodeId"],
            sourceNodeOutputId=item.get("sourceNodeOutputId", "0"),
            targetNodeInputId=item.get("targetNodeInputId", "0"),
            id=item["id"],
            relationKind=item["relationKind"],
        )
        for item in data
        if item.get("relationKind") == "data_flow"
    ]


def _buffer_access_label(access: dict) -> str:
    if access.get("free"):
        return "F"
    if access.get("read") and access.get("write"):
        return "R+W"
    if access.get("discard") and access.get("write"):
        return "D+W"
    if access.get("write"):
        return "W"
    if access.get("read"):
        return "R"
    return ""


def _range_value_label(value: dict) -> str:
    kind = value.get("kind")
    if kind == "constant":
        return str(value["value"])
    if kind == "symbolic":
        return value["expression"]
    return "unknown"


def _byte_range_label(byte_range: dict) -> str:
    offset = byte_range["offset"]
    length = byte_range["length"]
    if offset.get("kind") == "constant" and length.get("kind") == "constant":
        begin = offset["value"]
        return f"[{begin}, {begin + length['value']})"
    return (
        f"offset={_range_value_label(offset)}, "
        f"length={_range_value_label(length)}"
    )


def _buffer_edge_label(buffer: dict) -> str:
    access = _buffer_access_label(buffer["access"])
    view = buffer.get("view")
    if not view:
        return access
    role = access or "View"
    label = f"{role} {view['aliasKind']} {_byte_range_label(view['range'])}"
    copy = buffer.get("copy")
    if copy and copy["role"] == "target":
        if copy["overlapKind"] == "overlap":
            label += f" overlap {_byte_range_label(copy['overlapRange'])}"
        elif copy["overlapKind"] == "unknown":
            label += " overlap unknown"
    return label


def _buffer_flow_tasks(nodes: list[dict], graph_id: str) -> TasksData | None:
    by_storage: dict[str, dict] = {}
    for node in nodes:
        for relation in node.get("incomingEdges", []):
            if relation.get("relationKind") != "buffer_flow":
                continue
            buffer = relation["metadata"]["buffer"]
            storage_id = buffer["storageId"]
            group = by_storage.setdefault(
                storage_id,
                {"color": buffer["color"], "edges": []},
            )
            group["edges"].append(
                Edge(
                    sourceNodeId=relation["sourceNodeId"],
                    targetNodeId=node["id"],
                    id=relation["id"],
                    sourceNodeOutputId=relation["sourceNodeOutputId"],
                    targetNodeInputId=relation["targetNodeInputId"],
                    label=_buffer_edge_label(buffer),
                )
            )

    if not by_storage:
        return None
    overlays = [
        EdgeOverlay(
            name=storage_id,
            edgeColor=group["color"],
            edges=group["edges"],
            showEdgesConnectedToSelectedNodeOnly=False,
            dimNonOverlayNodes=True,
        )
        for storage_id, group in sorted(by_storage.items())
    ]
    data = EdgeOverlaysData(
        name="Logical Storage",
        overlays=overlays,
        selectByDefault=False,
        graphName=graph_id,
    )
    return TasksData(edgeOverlaysDataListLeftPane=[data])


def _build_node(data: dict) -> GraphNode:
    return GraphNode(
        id=data["id"],
        label=data.get("label", ""),
        namespace=data.get("namespace", ""),
        incomingEdges=_to_edge_list(data.get("incomingEdges", [])),
        inputsMetadata=_to_metadata_list(data.get("inputsMetadata", [])),
        outputsMetadata=_to_metadata_list(data.get("outputsMetadata", [])),
        attrs=_to_kv_list(data.get("attrs", [])),
    )


def _dict_to_graph(data: dict) -> Graph:
    return Graph(
        id=data["id"],
        nodes=[_build_node(node) for node in data.get("nodes", [])],
        groupNodeAttributes=data.get("groupNodeAttributes"),
        tasksData=_buffer_flow_tasks(data.get("nodes", []), data["id"]),
    )


def _dict_to_graph_collection(data: dict) -> GraphCollection:
    return GraphCollection(
        label=data.get("label", ""),
        graphs=[_dict_to_graph(graph) for graph in data.get("graphs", [])],
    )


def _write_cached_graph(model_path: str, document: dict) -> None:
    if model_path in _graph_cache:
        return
    if model_path.endswith(".json"):
        _graph_cache[model_path] = model_path
        return

    with tempfile.NamedTemporaryFile(
        mode="w",
        suffix=".json",
        prefix="zygon_viewer_graph_",
        delete=False,
        encoding="utf-8",
    ) as output:
        json.dump(document, output)
        _graph_cache[model_path] = output.name


def _convert_mlir(model_path: str) -> dict:
    # Keep Zygon Viewer an optional integration from Model Explorer's
    # perspective. The fork can start independently; installing zygon-viewer
    # makes this Adapter operational.
    from zygon_viewer.graph_json import GraphJsonError, decode_document

    tool = find_viewer_tool("zygon-viewer-mlir")
    process = subprocess.run(
        [tool, model_path, "-o", "-"],
        check=False,
        capture_output=True,
        text=True,
    )
    if process.returncode != 0:
        detail = f": {process.stderr.strip()}" if process.stderr.strip() else ""
        raise RuntimeError(f"zygon-viewer-mlir failed{detail}")
    try:
        return decode_document(process.stdout)
    except GraphJsonError as error:
        raise RuntimeError(
            f"zygon-viewer-mlir produced invalid Graph JSON: {error}"
        ) from error


def _convert_fx(model_path: str) -> dict:
    from zygon_viewer.fx_translate import parse_fx_code
    from zygon_viewer.graph_json import decode_document

    source = Path(model_path).read_text(encoding="utf-8")
    document, warnings = parse_fx_code(source)
    for warning in warnings:
        print(f"! Zygon Viewer FX warning: {warning}")
    return decode_document(json.dumps(document))


class ZygonViewerAdapter(Adapter):
    """Project supported Model artifacts to the versioned Viewer Graph schema."""

    metadata = AdapterMetadata(
        id="zygon_viewer",
        name="Zygon Viewer adapter",
        description=(
            "Loads MLIR, torch.fx, Run Manifest, and Zygon Viewer Graph artifacts"
        ),
        fileExts=["mlir", "fx", "json"],
    )

    def convert(self, model_path: str, settings: Dict) -> ModelExplorerGraphs:
        del settings

        suffix = Path(model_path).suffix.lower()
        if suffix == ".mlir":
            compiler_overlay = find_compiler_overlay(model_path)
            if compiler_overlay:
                from zygon_viewer.graph_json import GraphJsonError, load_document

                try:
                    document = load_document(compiler_overlay.graph_path)
                except GraphJsonError as error:
                    raise RuntimeError(
                        f"invalid Zygon Viewer Graph JSON: {error}"
                    ) from error
            else:
                document = _convert_mlir(model_path)
        elif suffix == ".fx":
            document = _convert_fx(model_path)
        elif suffix == ".json":
            from zygon_viewer.graph_json import GraphJsonError, load_document

            graph_path = model_path
            if is_run_manifest(model_path):
                graph_path = materialize_run_manifest(model_path).graph_path
            try:
                document = load_document(graph_path)
            except GraphJsonError as error:
                raise RuntimeError(
                    f"invalid Zygon Viewer Graph JSON: {error}"
                ) from error
        else:
            raise RuntimeError(f"unsupported Zygon Viewer artifact: {model_path}")

        _write_cached_graph(model_path, document)
        return {"graphCollections": [_dict_to_graph_collection(document)]}
