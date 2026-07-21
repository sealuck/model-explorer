"""Model Explorer adapter for Zygon Viewer MLIR, FX, and Graph artifacts."""

import hashlib
import json
import subprocess
import tempfile
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Dict

from .adapter import Adapter, AdapterMetadata
from .graph_builder import (
    Edge,
    EdgeOverlay,
    EdgeOverlaysData,
    Graph,
    GraphCollection,
    GraphNode,
    GraphNodeStyle,
    IncomingEdge,
    KeyValue,
    MetadataItem,
    NodeIdsNodeAttributeValue,
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
        )
        for item in data
    ]


_STORAGE_COLORS = (
    "#4477AA",
    "#EE6677",
    "#228833",
    "#CCBB44",
    "#66CCEE",
    "#AA3377",
    "#BBBBBB",
)


@dataclass(frozen=True)
class _AccessGroup:
    """All occurrences of one exact memref View at one operation."""

    target_node_id: str
    source_node_id: str
    source_node_output_id: str
    storage_id: str
    view_region: dict
    edges: tuple[dict, ...]


@dataclass(frozen=True)
class _MemoryProjection:
    """ME topology and presentation facts derived from Graph v5 evidence."""

    incoming_edges_by_node: dict[str, list[dict]]
    layout_edges: list[Edge]
    overlay_edges_by_storage: dict[str, list[Edge]]
    member_node_ids_by_storage: dict[str, set[str]]
    storage_ids_by_node: dict[str, set[str]]
    access_groups: tuple[_AccessGroup, ...]
    hidden_node_ids: frozenset[str]


def _memory_access_label(access: dict) -> str:
    """Return a compact badge from the presence of typed effect regions."""
    if "readRegion" in access and "writeRegion" in access:
        return "R+W"
    if "writeRegion" in access:
        return "W"
    if "readRegion" in access:
        return "R"
    return ""


def _range_value_label(value: dict) -> str:
    kind = value.get("kind")
    if kind == "constant":
        return str(value["value"])
    if kind == "symbolic":
        return value["expression"]
    return "unknown"


def _memory_region_label(region: dict) -> str:
    """Format a byte region without pretending an unknown region is exact."""
    kind = region["kind"]
    if kind == "unknown":
        reason = region.get("reason", "")
        return f"unknown ({reason})" if reason else "unknown"
    if kind == "strided":
        offset = _range_value_label(region["offsetBytes"])
        sizes = ", ".join(str(value) for value in region["sizes"])
        strides = ", ".join(str(value) for value in region["stridesBytes"])
        return (
            f"strided(offset={offset} bytes, sizes=[{sizes}], "
            f"strides=[{strides}] bytes, element={region['elementBytes']} bytes)"
        )

    offset = region["offsetBytes"]
    length = region["lengthBytes"]
    if offset.get("kind") == "constant" and length.get("kind") == "constant":
        begin = offset["value"]
        return f"[{begin}, {begin + length['value']}) bytes"
    return (
        f"offset={_range_value_label(offset)}, "
        f"length={_range_value_label(length)} bytes"
    )


def _memory_edge_label(memory: dict) -> str:
    """Describe the local effect carried by one ordinary SSA edge."""
    access = memory["access"]
    read = access.get("readRegion")
    write = access.get("writeRegion")
    if read is not None and read == write:
        label = f"R+W {_memory_region_label(read)}"
    else:
        effects = []
        if read is not None:
            effects.append(f"R {_memory_region_label(read)}")
        if write is not None:
            effects.append(f"W {_memory_region_label(write)}")
        label = "; ".join(effects)
    if not label:
        label = f"View {_memory_region_label(memory['viewRegion'])}"

    copy = memory.get("copy")
    if copy:
        overlap = copy["overlapKind"]
        if overlap == "overlap":
            overlap = _memory_region_label(copy["overlapRegion"])
        label += f"; copy {copy['role']} overlap={overlap}"
    return label


def _storage_presentation(graph: dict) -> dict[str, dict]:
    """Resolve stable Graph palette slots to ME-owned names and colors."""
    storages = graph.get("storages", [])
    short_names = [storage["rootSsa"].rsplit("::", 1)[-1] for storage in storages]
    counts = Counter(short_names)
    result = {}
    for storage, short_name in zip(storages, short_names):
        display_name = (
            short_name if counts[short_name] == 1 else storage["rootSsa"]
        )
        result[storage["id"]] = {
            "name": display_name,
            "color": _STORAGE_COLORS[
                storage["paletteSlot"] % len(_STORAGE_COLORS)
            ],
            "storage": storage,
        }
    return result


def _operand_role(edge: dict) -> str:
    """Use structured DPS roles; never infer linalg roles from operation text."""
    memory = edge["metadata"]["memory"]
    dps_role = memory.get("dpsRole")
    if dps_role:
        prefix = "ins" if dps_role["kind"] == "input" else "outs"
        return f"{prefix}[{dps_role['index']}]"
    return f"input {edge['targetNodeInputId']}"


def _access_group_label(group: _AccessGroup) -> str:
    """Describe every operand occurrence collapsed into one rendered lane."""
    labels = []
    for edge in group.edges:
        memory_label = _memory_edge_label(edge["metadata"]["memory"])
        label = f"{_operand_role(edge)}: {memory_label}"
        if label not in labels:
            labels.append(label)
    return "; ".join(labels)


def _collect_access_groups(graph: dict) -> tuple[_AccessGroup, ...]:
    """Group exact Views while preserving their first occurrence order."""
    grouped: dict[tuple[str, str, str], list[dict]] = {}
    for node in graph.get("nodes", []):
        for edge in node.get("incomingEdges", []):
            memory = edge.get("metadata", {}).get("memory")
            if memory is None:
                continue
            key = (
                node["id"],
                edge["sourceNodeId"],
                edge.get("sourceNodeOutputId", "0"),
            )
            grouped.setdefault(key, []).append(edge)

    result = []
    for (target_id, source_id, output_id), edges in grouped.items():
        first_memory = edges[0]["metadata"]["memory"]
        for edge in edges[1:]:
            memory = edge["metadata"]["memory"]
            if (
                memory["storageId"] != first_memory["storageId"]
                or memory["viewRegion"] != first_memory["viewRegion"]
            ):
                raise RuntimeError(
                    "Graph v5 exact-View edges disagree on Storage or region"
                )
        result.append(
            _AccessGroup(
                target_node_id=target_id,
                source_node_id=source_id,
                source_node_output_id=output_id,
                storage_id=first_memory["storageId"],
                view_region=first_memory["viewRegion"],
                edges=tuple(edges),
            )
        )
    return tuple(result)


def _constant_interval(region: dict) -> tuple[int, int] | None:
    """Return a half-open static byte interval when Graph proves one."""
    if region.get("kind") != "contiguous":
        return None
    offset = region.get("offsetBytes", {})
    length = region.get("lengthBytes", {})
    if offset.get("kind") != "constant" or length.get("kind") != "constant":
        return None
    begin = offset["value"]
    return begin, begin + length["value"]


def _interval_is_covered(
    interval: tuple[int, int], regions: list[dict]
) -> bool:
    """Prove that a union of static dependency regions covers one read."""
    begin, end = interval
    cursor = begin
    intervals = sorted(
        candidate
        for region in regions
        if (candidate := _constant_interval(region)) is not None
    )
    for candidate_begin, candidate_end in intervals:
        if candidate_end <= cursor:
            continue
        if candidate_begin > cursor:
            break
        cursor = max(cursor, candidate_end)
        if cursor >= end:
            return True
    return cursor >= end


def _read_is_supplied_by_dependencies(
    group: _AccessGroup, dependencies: list[dict]
) -> bool:
    """Return true only when MUST dependencies fully replace the raw read."""
    read_regions = [
        memory["access"]["readRegion"]
        for edge in group.edges
        if "readRegion"
        in (memory := edge["metadata"]["memory"])["access"]
    ]
    if not read_regions:
        return False
    must_regions = [
        dependency["region"]
        for dependency in dependencies
        if dependency["certainty"] == "must"
    ]
    return all(
        (interval := _constant_interval(region)) is not None
        and _interval_is_covered(interval, must_regions)
        for region in read_regions
    )


def _dependency_label(dependencies: list[dict]) -> str:
    labels = []
    for dependency in dependencies:
        prefix = "content" if dependency["certainty"] == "must" else "may content"
        label = f"{prefix} {_memory_region_label(dependency['region'])}"
        if label not in labels:
            labels.append(label)
    return "; ".join(labels)


def _allocation_origin_node_ids(graph: dict) -> frozenset[str]:
    """Return allocation roots hidden only from the ME presentation Graph."""
    return frozenset(
        storage["origin"]["nodeId"]
        for storage in graph.get("storages", [])
        if storage["origin"]["kind"] == "allocation"
    )


def _project_memory(graph: dict) -> _MemoryProjection:
    """Project Graph evidence into ME topology without changing Graph JSON.

    Allocation operations remain authoritative Storage origins in Graph v5,
    but are omitted from ME's visible operation graph. Their first-use access
    edges therefore become node membership rather than dangling rendered
    edges. Argument and global roots stay visible as actual data entrances.
    """
    groups = _collect_access_groups(graph)
    dependencies = graph.get("memoryDependencies", [])
    primary_storage_id = graph.get("primaryStorageId")
    hidden_node_ids = _allocation_origin_node_ids(graph)
    visible_node_ids = {
        node["id"]
        for node in graph.get("nodes", [])
        if node["id"] not in hidden_node_ids
    }

    incoming_by_node: dict[str, list[dict]] = {
        node["id"]: [
            edge
            for edge in node.get("incomingEdges", [])
            if edge.get("metadata", {}).get("memory") is None
            and edge["sourceNodeId"] in visible_node_ids
        ]
        for node in graph.get("nodes", [])
        if node["id"] in visible_node_ids
    }
    overlays: dict[str, list[Edge]] = {}
    layout_edges: list[Edge] = []
    memberships: dict[str, set[str]] = {}
    members_by_storage: dict[str, set[str]] = {}

    def add_membership(node_id: str, storage_id: str) -> None:
        """Record one visible operation as a member of a logical Storage."""
        if node_id not in visible_node_ids:
            return
        memberships.setdefault(node_id, set()).add(storage_id)
        members_by_storage.setdefault(storage_id, set()).add(node_id)

    dependencies_by_target: dict[tuple[str, str], list[dict]] = {}
    for dependency in dependencies:
        dependencies_by_target.setdefault(
            (dependency["targetNodeId"], dependency["storageId"]), []
        ).append(dependency)

    for group in groups:
        add_membership(group.source_node_id, group.storage_id)
        add_membership(group.target_node_id, group.storage_id)
        target_dependencies = dependencies_by_target.get(
            (group.target_node_id, group.storage_id), []
        )
        if _read_is_supplied_by_dependencies(group, target_dependencies):
            continue

        # The allocation remains the Storage identity but is not a visible ME
        # endpoint. The consumer membership above preserves single-operation
        # paths without creating an edge from a node that is not rendered.
        if group.source_node_id in hidden_node_ids:
            continue

        # One representative ordinary edge keeps initial reads, pure writes,
        # and View construction anchored at a visible argument/global root.
        representative = group.edges[0]
        incoming_by_node[group.target_node_id].append(representative)
        overlays.setdefault(group.storage_id, []).append(
            Edge(
                sourceNodeId=group.source_node_id,
                targetNodeId=group.target_node_id,
                id=representative["id"],
                sourceNodeOutputId=group.source_node_output_id,
                targetNodeInputId=representative["targetNodeInputId"],
                label=_access_group_label(group),
            )
        )
    # Disjoint regions between the same Node pair share one ME lane while the
    # Graph artifact retains every dependency as an independent evidence row.
    dependency_groups: dict[tuple[str, str, str], list[dict]] = {}
    for dependency in dependencies:
        if dependency["certainty"] == "may" and (
            primary_storage_id != dependency["storageId"]
        ):
            continue
        key = (
            dependency["storageId"],
            dependency["sourceNodeId"],
            dependency["targetNodeId"],
        )
        dependency_groups.setdefault(key, []).append(dependency)

    for (
        storage_id,
        source_id,
        target_id,
    ), grouped_dependencies in dependency_groups.items():
        add_membership(source_id, storage_id)
        add_membership(target_id, storage_id)
        if source_id in hidden_node_ids or target_id in hidden_node_ids:
            continue
        edge_id = f"content:{grouped_dependencies[0]['id']}"
        layout_edges.append(
            Edge(
                sourceNodeId=source_id,
                targetNodeId=target_id,
                id=edge_id,
            )
        )
        overlays.setdefault(storage_id, []).append(
            Edge(
                sourceNodeId=source_id,
                targetNodeId=target_id,
                id=edge_id,
                label=_dependency_label(grouped_dependencies),
            )
        )
    for storage in graph.get("storages", []):
        add_membership(storage["origin"]["nodeId"], storage["id"])

    return _MemoryProjection(
        incoming_edges_by_node=incoming_by_node,
        layout_edges=layout_edges,
        overlay_edges_by_storage=overlays,
        member_node_ids_by_storage=members_by_storage,
        storage_ids_by_node=memberships,
        access_groups=groups,
        hidden_node_ids=hidden_node_ids,
    )


def _memory_tasks(
    graph: dict,
    presentation: dict[str, dict],
    projection: _MemoryProjection,
) -> TasksData | None:
    """Build a weak baseline lane and selectable legend item per Storage."""
    overlays = []
    primary_storage_id = graph.get("primaryStorageId")
    node_order = {
        node["id"]: index for index, node in enumerate(graph.get("nodes", []))
    }
    presentation_items = list(presentation.items())
    # Hidden allocations depend on the legend for discovery, so keep them
    # ahead of already-visible argument/global roots. Python's stable sort
    # preserves Graph order within each origin class.
    origin_priority = {"allocation": 0, "argument": 1, "global": 1}
    presentation_items.sort(
        key=lambda pair: origin_priority[pair[1]["storage"]["origin"]["kind"]]
    )
    for storage_id, item in presentation_items:
        edges = projection.overlay_edges_by_storage.get(storage_id, [])
        member_node_ids = sorted(
            projection.member_node_ids_by_storage.get(storage_id, set()),
            key=node_order.__getitem__,
        )
        if not edges and not member_node_ids:
            continue
        overlays.append(
            EdgeOverlay(
                name=item["name"],
                edgeColor=item["color"],
                edges=edges,
                showEdgesConnectedToSelectedNodeOnly=False,
                dimNonOverlayNodes=primary_storage_id == storage_id,
                alwaysVisible=True,
                storageFocusSelector=item["storage"]["rootSsa"],
                memberNodeIds=member_node_ids,
            )
        )
    if not overlays:
        return None
    data = EdgeOverlaysData(
        name="Memory content",
        overlays=overlays,
        selectByDefault=True,
        graphName=graph["id"],
        selectionMode="single_highlight",
    )
    return TasksData(edgeOverlaysDataListLeftPane=[data])


def _storage_origin_attrs(
    storage: dict, name: str, use_node_ids: list[str]
) -> list[KeyValue]:
    """Describe the minimal root record on the Storage origin Node."""
    origin = storage["origin"]
    attrs = [
        KeyValue(key=f"{name} Storage", value=storage["id"]),
        KeyValue(key=f"{name} Root SSA", value=storage["rootSsa"]),
        KeyValue(
            key=f"{name} Origin",
            value=f"{origin['kind']} {origin['nodeId']}:{origin['outputId']}",
        ),
        KeyValue(
            key=f"{name} Region",
            value=_memory_region_label(storage["region"]),
        ),
        KeyValue(key=f"{name} Memory space", value=storage["memorySpace"]),
    ]
    if use_node_ids:
        attrs.append(
            KeyValue(
                key=f"{name} Use nodes",
                value=NodeIdsNodeAttributeValue(nodeIds=use_node_ids),
            )
        )
    return attrs


def _storage_use_attrs(
    storage: dict,
    name: str,
    groups: list[_AccessGroup],
    origin_is_visible: bool,
) -> list[KeyValue]:
    """Describe the Storage identity, View, and effects at one consumer."""
    origin = storage["origin"]
    view_lines = [
        f"{', '.join(_operand_role(edge) for edge in group.edges)}: "
        f"{_memory_region_label(group.view_region)}"
        for group in groups
    ]
    access_lines = [_access_group_label(group) for group in groups]

    attrs = [KeyValue(key=f"{name} Storage", value=storage["id"])]
    if origin_is_visible:
        attrs.append(
            KeyValue(
                key=f"{name} Origin node",
                value=NodeIdsNodeAttributeValue(nodeIds=[origin["nodeId"]]),
            )
        )
    else:
        # A node reference would be dangling because allocation roots are
        # intentionally absent from the ME projection. Keep the parsed SSA as
        # stable, human-readable identity instead.
        attrs.append(KeyValue(key=f"{name} Root SSA", value=storage["rootSsa"]))
    attrs.append(KeyValue(key=f"{name} View", value="\n".join(view_lines)))
    if access_lines:
        attrs.append(KeyValue(key=f"{name} Access", value="\n".join(access_lines)))
    return attrs


def _storage_details_by_node(
    graph: dict,
    presentation: dict[str, dict],
    projection: _MemoryProjection,
) -> dict[str, list[KeyValue]]:
    """Derive root, exact-View, and writer/reader details for each Node."""
    result: dict[str, list[KeyValue]] = {}
    uses: dict[str, dict[str, list[_AccessGroup]]] = {}
    for group in projection.access_groups:
        uses.setdefault(group.storage_id, {}).setdefault(
            group.target_node_id, []
        ).append(group)

    content_inputs: dict[tuple[str, str], list[str]] = {}
    content_outputs: dict[tuple[str, str], list[str]] = {}
    for dependency in graph.get("memoryDependencies", []):
        input_key = (dependency["storageId"], dependency["targetNodeId"])
        output_key = (dependency["storageId"], dependency["sourceNodeId"])
        content_inputs.setdefault(input_key, []).append(dependency["sourceNodeId"])
        content_outputs.setdefault(output_key, []).append(dependency["targetNodeId"])

    for storage_id, item in presentation.items():
        storage = item["storage"]
        name = item["name"]
        by_node = uses.get(storage_id, {})
        origin_node_id = storage["origin"]["nodeId"]
        use_node_ids = list(by_node)
        for dependency in graph.get("memoryDependencies", []):
            if dependency["storageId"] != storage_id:
                continue
            for node_id in (dependency["sourceNodeId"], dependency["targetNodeId"]):
                if node_id not in use_node_ids:
                    use_node_ids.append(node_id)
        origin_is_visible = origin_node_id not in projection.hidden_node_ids
        if origin_is_visible:
            result.setdefault(origin_node_id, []).extend(
                _storage_origin_attrs(storage, name, use_node_ids)
            )
        for node_id, node_groups in by_node.items():
            if node_id == origin_node_id:
                continue
            result.setdefault(node_id, []).extend(
                _storage_use_attrs(
                    storage, name, node_groups, origin_is_visible
                )
            )
        for node_id in use_node_ids:
            producers = list(
                dict.fromkeys(
                    producer
                    for producer in content_inputs.get((storage_id, node_id), [])
                    if producer not in projection.hidden_node_ids
                )
            )
            consumers = list(
                dict.fromkeys(
                    consumer
                    for consumer in content_outputs.get((storage_id, node_id), [])
                    if consumer not in projection.hidden_node_ids
                )
            )
            if producers:
                result.setdefault(node_id, []).append(
                    KeyValue(
                        key=f"{name} Content producers",
                        value=NodeIdsNodeAttributeValue(nodeIds=producers),
                    )
                )
            if consumers:
                result.setdefault(node_id, []).append(
                    KeyValue(
                        key=f"{name} Content consumers",
                        value=NodeIdsNodeAttributeValue(nodeIds=consumers),
                    )
                )
    return result


def _build_node(
    data: dict,
    storage_attrs: list[KeyValue],
    incoming_edges: list[dict],
    style: GraphNodeStyle | None,
) -> GraphNode:
    return GraphNode(
        id=data["id"],
        label=data.get("label", ""),
        namespace=data.get("namespace", ""),
        incomingEdges=_to_edge_list(incoming_edges),
        inputsMetadata=_to_metadata_list(data.get("inputsMetadata", [])),
        outputsMetadata=_to_metadata_list(data.get("outputsMetadata", [])),
        attrs=_to_kv_list(data.get("attrs", [])) + storage_attrs,
        style=style,
    )


def _dict_to_graph(data: dict) -> Graph:
    presentation = _storage_presentation(data)
    projection = _project_memory(data)
    storage_details = _storage_details_by_node(data, presentation, projection)
    primary_storage_id = data.get("primaryStorageId")

    def node_style(node_id: str) -> GraphNodeStyle | None:
        storage_ids = sorted(
            projection.storage_ids_by_node.get(node_id, set()),
            key=lambda storage_id: (
                presentation[storage_id]["storage"]["paletteSlot"],
                storage_id,
            ),
        )
        if not storage_ids:
            return None
        return GraphNodeStyle(
            accentColors=[
                presentation[storage_id]["color"] for storage_id in storage_ids
            ],
            tintColor=(
                presentation[primary_storage_id]["color"]
                if primary_storage_id in storage_ids
                else ""
            ),
        )

    return Graph(
        id=data["id"],
        nodes=[
            _build_node(
                node,
                storage_details.get(node["id"], []),
                projection.incoming_edges_by_node.get(node["id"], []),
                node_style(node["id"]),
            )
            for node in data.get("nodes", [])
            if node["id"] not in projection.hidden_node_ids
        ],
        groupNodeAttributes=data.get("groupNodeAttributes"),
        tasksData=_memory_tasks(data, presentation, projection),
        layoutEdges=projection.layout_edges,
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
