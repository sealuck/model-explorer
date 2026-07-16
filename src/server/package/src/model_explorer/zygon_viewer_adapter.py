"""Model Explorer adapter for Zygon Viewer MLIR, FX, and Graph artifacts."""

import json
from pathlib import Path
import subprocess
import tempfile
from typing import Dict

from zygon_viewer.fx_translate import parse_fx_code
from zygon_viewer.graph_json import GraphJsonError, decode_document, load_document

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
from .zygon_viewer_tools import find_viewer_tool

# Source artifact path -> schema-v1 Graph JSON path. Focus routes consume the
# exact Graph produced during conversion instead of projecting the Model again.
_graph_cache: dict[str, str] = {}


def get_cached_graph_json_path(model_path: str) -> str | None:
  """Return the cached Graph path for a converted Model artifact."""
  return _graph_cache.get(model_path)


def _to_kv_list(data: list[dict]) -> list[KeyValue]:
  return [KeyValue(key=item['key'], value=item['value']) for item in data]


def _to_metadata_list(data: list[dict]) -> list[MetadataItem]:
  return [
      MetadataItem(id=item['id'], attrs=_to_kv_list(item.get('attrs', [])))
      for item in data
  ]


def _to_edge_list(data: list[dict]) -> list[IncomingEdge]:
  return [
      IncomingEdge(
          sourceNodeId=item['sourceNodeId'],
          sourceNodeOutputId=item.get('sourceNodeOutputId', '0'),
          targetNodeInputId=item.get('targetNodeInputId', '0'),
      )
      for item in data
  ]


def _build_node(data: dict) -> GraphNode:
  return GraphNode(
      id=data['id'],
      label=data.get('label', ''),
      namespace=data.get('namespace', ''),
      incomingEdges=_to_edge_list(data.get('incomingEdges', [])),
      inputsMetadata=_to_metadata_list(data.get('inputsMetadata', [])),
      outputsMetadata=_to_metadata_list(data.get('outputsMetadata', [])),
      attrs=_to_kv_list(data.get('attrs', [])),
  )


def _dict_to_graph(data: dict) -> Graph:
  return Graph(
      id=data['id'],
      nodes=[_build_node(node) for node in data.get('nodes', [])],
      groupNodeAttributes=data.get('groupNodeAttributes'),
  )


def _dict_to_graph_collection(data: dict) -> GraphCollection:
  return GraphCollection(
      label=data.get('label', ''),
      graphs=[_dict_to_graph(graph) for graph in data.get('graphs', [])],
  )


def _write_cached_graph(model_path: str, document: dict) -> None:
  if model_path.endswith('.json'):
    _graph_cache[model_path] = model_path
    return

  with tempfile.NamedTemporaryFile(
      mode='w',
      suffix='.json',
      prefix='zygon_viewer_graph_',
      delete=False,
      encoding='utf-8',
  ) as output:
    json.dump(document, output)
    _graph_cache[model_path] = output.name


def _convert_mlir(model_path: str) -> dict:
  tool = find_viewer_tool('zygon-viewer-mlir')
  process = subprocess.run(
      [tool, model_path, '-o', '-'],
      check=False,
      capture_output=True,
      text=True,
  )
  if process.returncode != 0:
    detail = f': {process.stderr.strip()}' if process.stderr.strip() else ''
    raise RuntimeError(f'zygon-viewer-mlir failed{detail}')
  try:
    return decode_document(process.stdout)
  except GraphJsonError as error:
    raise RuntimeError(
        f'zygon-viewer-mlir produced invalid Graph JSON: {error}'
    ) from error


def _convert_fx(model_path: str) -> dict:
  source = Path(model_path).read_text(encoding='utf-8')
  document, warnings = parse_fx_code(source)
  for warning in warnings:
    print(f'! Zygon Viewer FX warning: {warning}')
  return decode_document(json.dumps(document))


class ZygonViewerAdapter(Adapter):
  """Project supported Model artifacts to the versioned Viewer Graph schema."""

  metadata = AdapterMetadata(
      id='zygon_viewer',
      name='Zygon Viewer adapter',
      description='Loads MLIR, torch.fx code, and Zygon Viewer Graph JSON',
      fileExts=['mlir', 'fx', 'json'],
  )

  def convert(self, model_path: str, settings: Dict) -> ModelExplorerGraphs:
    del settings

    suffix = Path(model_path).suffix.lower()
    try:
      if suffix == '.mlir':
        document = _convert_mlir(model_path)
      elif suffix == '.fx':
        document = _convert_fx(model_path)
      elif suffix == '.json':
        document = load_document(model_path)
      else:
        raise RuntimeError(f'unsupported Zygon Viewer artifact: {model_path}')
    except GraphJsonError as error:
      raise RuntimeError(f'invalid Zygon Viewer Graph JSON: {error}') from error

    _write_cached_graph(model_path, document)
    return {'graphCollections': [_dict_to_graph_collection(document)]}
