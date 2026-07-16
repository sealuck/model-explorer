"""Tests for the unified Zygon Viewer Model Explorer adapter."""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from model_explorer.zygon_viewer_adapter import (
    ZygonViewerAdapter,
    get_cached_graph_json_path,
)

_GRAPH = {
    'schemaVersion': 'zygon-viewer/graph/v1',
    'label': 'model',
    'graphs': [{
        'id': 'main',
        'nodes': [{
            'id': 'node',
            'label': 'arith.addf',
            'attrs': [{'key': 'viewer.source_ssa', 'value': '%result'}],
        }],
    }],
}

_FX = """\
def forward(self, arg0):
    result = torch.ops.aten.relu.default(arg0)
    return [result]
"""


def test_should_load_schema_v1_graph_json(tmp_path):
  model = tmp_path / 'model.json'
  model.write_text(json.dumps(_GRAPH))

  result = ZygonViewerAdapter().convert(str(model), {})

  collection = result['graphCollections'][0]
  assert collection.label == 'model'
  assert collection.graphs[0].nodes[0].label == 'arith.addf'
  assert get_cached_graph_json_path(str(model)) == str(model)


def test_should_reject_graph_json_without_schema_version(tmp_path):
  model = tmp_path / 'model.json'
  model.write_text(json.dumps({'graphs': []}))

  with pytest.raises(RuntimeError, match='schemaVersion is required'):
    ZygonViewerAdapter().convert(str(model), {})


def test_should_project_fx_without_spawning_process(monkeypatch, tmp_path):
  model = tmp_path / 'model.fx'
  model.write_text(_FX)

  monkeypatch.setattr(
      'model_explorer.zygon_viewer_adapter.subprocess.run',
      lambda *args, **kwargs: pytest.fail('FX projection spawned a process'),
  )

  result = ZygonViewerAdapter().convert(str(model), {})

  labels = [node.label for node in result['graphCollections'][0].graphs[0].nodes]
  assert 'relu.default' in labels
  assert Path(get_cached_graph_json_path(str(model))).is_file()


def test_should_invoke_parse_only_viewer_tool_for_mlir(monkeypatch, tmp_path):
  model = tmp_path / 'model.mlir'
  model.write_text('module {}')
  calls = []

  monkeypatch.setattr(
      'model_explorer.zygon_viewer_adapter.find_viewer_tool',
      lambda name: f'/tools/{name}',
  )

  def run(args, **kwargs):
    calls.append((args, kwargs))
    return SimpleNamespace(returncode=0, stdout=json.dumps(_GRAPH), stderr='')

  monkeypatch.setattr('model_explorer.zygon_viewer_adapter.subprocess.run', run)

  ZygonViewerAdapter().convert(str(model), {})

  assert calls[0][0] == ['/tools/zygon-viewer-mlir', str(model), '-o', '-']
  assert 'mdbg' not in ' '.join(calls[0][0])
