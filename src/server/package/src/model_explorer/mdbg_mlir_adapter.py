"""mdbg MLIR adapter."""

from functools import lru_cache
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from typing import Dict

# Cache: mlir model_path -> path of the translated graph JSON temp file.
# Populated during convert(); consumed by server.py focus/dataflow endpoints
# so the already-translated JSON is reused without re-invoking mdbg translate.
_translate_cache: dict[str, str] = {}


def get_cached_graph_json_path(model_path: str) -> str | None:
  """Return the cached graph JSON path for a model, or None if not cached."""
  return _translate_cache.get(model_path)

from .adapter import Adapter, AdapterMetadata
from .graph_builder import (
    Graph,
    GraphCollection,
    GraphNode,
    IncomingEdge,
    KeyValue,
    MetadataItem,
)
from .types import ModelExplorerGraphs


_DEFAULT_MDBG = str(Path(__file__).resolve().parents[7] / "build" / "bin" / "mdbg")


@lru_cache(maxsize=1)
def _find_mdbg() -> str:
  env_mdbg = os.environ.get("MDBG")
  if env_mdbg:
    if os.path.exists(env_mdbg):
      return env_mdbg
    raise RuntimeError(f"MDBG env var points to missing file: {env_mdbg}")

  path_mdbg = shutil.which("mdbg")
  if path_mdbg:
    return path_mdbg

  if os.path.exists(_DEFAULT_MDBG):
    return _DEFAULT_MDBG

  raise RuntimeError(
      "mdbg binary not found; set MDBG or build build/bin/mdbg"
  )


def _to_kv_list(data: list[dict]) -> list[KeyValue]:
  return [KeyValue(key=d["key"], value=d["value"]) for d in data]


def _to_metadata_list(data: list[dict]) -> list[MetadataItem]:
  return [MetadataItem(id=d["id"], attrs=_to_kv_list(d.get("attrs", []))) for d in data]


def _to_edge_list(data: list[dict]) -> list[IncomingEdge]:
  return [
      IncomingEdge(
          sourceNodeId=d["sourceNodeId"],
          sourceNodeOutputId=d.get("sourceNodeOutputId", "0"),
          targetNodeInputId=d.get("targetNodeInputId", "0"),
      )
      for d in data
  ]


def _build_node(d: dict) -> GraphNode:
  return GraphNode(
      id=d["id"],
      label=d["label"],
      namespace=d.get("namespace", ""),
      incomingEdges=_to_edge_list(d.get("incomingEdges", [])),
      inputsMetadata=_to_metadata_list(d.get("inputsMetadata", [])),
      outputsMetadata=_to_metadata_list(d.get("outputsMetadata", [])),
      attrs=_to_kv_list(d.get("attrs", [])),
  )


def _dict_to_graph(d: dict) -> Graph:
  return Graph(
      id=d["id"],
      nodes=[_build_node(n) for n in d.get("nodes", [])],
      groupNodeAttributes=d.get("groupNodeAttributes"),
  )


def _dict_to_graph_collection(d: dict) -> GraphCollection:
  return GraphCollection(
      label=d.get("label", ""),
      graphs=[_dict_to_graph(g) for g in d.get("graphs", [])],
  )


def _parse_graph_collection_json(text: str) -> GraphCollection:
  try:
    data = json.loads(text)
  except json.JSONDecodeError as e:
    raise RuntimeError(
        f"mdbg translate produced invalid JSON: {e}"
    ) from e
  return _dict_to_graph_collection(data)


class MdbgMlirAdapter(Adapter):
  """Adapter that translates MLIR or loads mdbg graph JSON directly."""

  metadata = AdapterMetadata(
      id='mdbg_mlir',
      name='mdbg MLIR adapter',
      description='Loads MLIR computation graph produced by mdbg translate',
      fileExts=['json', 'mlir'],
  )

  def __init__(self):
    super().__init__()

  def convert(self, model_path: str, settings: Dict) -> ModelExplorerGraphs:
    del settings

    if model_path.endswith(".json"):
      _translate_cache[model_path] = model_path
      with open(model_path, "r", encoding="utf-8") as f:
        try:
          data = json.load(f)
        except json.JSONDecodeError as e:
          raise RuntimeError(f"mdbg graph JSON is invalid: {e}") from e
      return {"graphCollections": [_dict_to_graph_collection(data)]}

    proc = subprocess.run(
        [_find_mdbg(), "translate", model_path, "-o", "-"],
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
      stderr = proc.stderr.strip()
      detail = f": {stderr}" if stderr else ""
      raise RuntimeError(f"mdbg translate failed{detail}")

    # Cache translated JSON to disk; reused by focus/dataflow endpoints.
    tmp = tempfile.NamedTemporaryFile(
        mode='w', suffix='.json', prefix='mdbg_graph_', delete=False
    )
    tmp.write(proc.stdout)
    tmp.close()
    _translate_cache[model_path] = tmp.name

    return {"graphCollections": [_parse_graph_collection_json(proc.stdout)]}
