"""mdbg MLIR adapter — loads pre-built graph.json directly.

mdbg translate already produces Model Explorer GraphCollection JSON,
so this adapter just reads it and converts to dataclass instances.
"""

import json
from typing import Dict

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


def _dict_to_graph_node(d: dict) -> GraphNode:
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
      nodes=[_dict_to_graph_node(n) for n in d.get("nodes", [])],
      groupNodeAttributes=d.get("groupNodeAttributes"),
  )


def _dict_to_graph_collection(d: dict) -> GraphCollection:
  return GraphCollection(
      label=d["label"],
      graphs=[_dict_to_graph(g) for g in d.get("graphs", [])],
  )


class MdbgMlirAdapter(Adapter):
  """Adapter that loads mdbg translate output (graph.json) directly."""

  metadata = AdapterMetadata(
      id='mdbg_mlir',
      name='mdbg MLIR adapter',
      description='Loads MLIR computation graph produced by mdbg translate',
      fileExts=['json', 'mlir'],
  )

  def __init__(self):
    super().__init__()

  def convert(self, model_path: str, settings: Dict) -> ModelExplorerGraphs:
    with open(model_path, 'r') as f:
      data = json.load(f)
    # mdbg translate produces {'label': ..., 'graphs': [...]}
    # which maps to a single GraphCollection.
    return {'graphCollections': [_dict_to_graph_collection(data)]}
