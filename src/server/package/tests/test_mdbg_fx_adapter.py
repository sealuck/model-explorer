"""Tests for the mdbg_fx adapter (FX .code -> Model Explorer graph)."""

import textwrap

import pytest

from model_explorer.mdbg_fx_adapter import (
    MdbgFxAdapter,
    get_cached_graph_json_path,
)

_FX = textwrap.dedent(
    """\
    def forward(self, arg0_1):
        div = torch.ops.aten.div.Tensor(arg0_1, 100.0);  arg0_1 = None
        relu = torch.ops.aten.relu.default(div);  div = None
        return [relu]
    """
)


def test_convert_fx_file_returns_graph_with_op_nodes(tmp_path):
  # Driving an FX .code file through the adapter yields its op nodes.
  path = tmp_path / "model.fx"
  path.write_text(_FX)

  result = MdbgFxAdapter().convert(str(path), {})

  graphs = result["graphCollections"][0].graphs
  node_ids = {node.id for graph in graphs for node in graph.nodes}
  assert "div" in node_ids
  assert "relu" in node_ids


def test_convert_caches_json_for_focus_reuse(tmp_path):
  # The translated JSON is cached so focus/dataflow endpoints reuse it.
  path = tmp_path / "model.fx"
  path.write_text(_FX)

  MdbgFxAdapter().convert(str(path), {})

  cached = get_cached_graph_json_path(str(path))
  assert cached is not None
  assert cached.endswith(".json")
