"""Tests for the unified Zygon Viewer Model Explorer adapter."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

from model_explorer.zygon_viewer_adapter import (
    ZygonViewerAdapter,
    find_compiler_overlay,
    get_cached_graph_json_path,
    materialize_run_manifest,
)
from model_explorer.config import ModelExplorerConfig
from model_explorer.zygon_viewer_tools import find_viewer_tool

_GRAPH = {
    "schemaVersion": "zygon-viewer/graph/v1",
    "label": "model",
    "graphs": [
        {
            "id": "main",
            "nodes": [
                {
                    "id": "node",
                    "label": "arith.addf",
                    "attrs": [{"key": "viewer.source_ssa", "value": "%result"}],
                }
            ],
        }
    ],
}

_FX = """\
def forward(self, arg0):
    result = torch.ops.aten.relu.default(arg0)
    return [result]
"""


def test_should_load_schema_v1_graph_json(tmp_path):
    model = tmp_path / "model.json"
    model.write_text(json.dumps(_GRAPH))

    result = ZygonViewerAdapter().convert(str(model), {})

    collection = result["graphCollections"][0]
    assert collection.label == "model"
    assert collection.graphs[0].nodes[0].label == "arith.addf"
    assert get_cached_graph_json_path(str(model)) == str(model)


def test_should_reject_graph_json_without_schema_version(tmp_path):
    model = tmp_path / "model.json"
    model.write_text(json.dumps({"graphs": []}))

    with pytest.raises(RuntimeError, match="schemaVersion is required"):
        ZygonViewerAdapter().convert(str(model), {})


def test_should_project_fx_without_spawning_process(monkeypatch, tmp_path):
    model = tmp_path / "model.fx"
    model.write_text(_FX)

    monkeypatch.setattr(
        "model_explorer.zygon_viewer_adapter.subprocess.run",
        lambda *args, **kwargs: pytest.fail("FX projection spawned a process"),
    )

    result = ZygonViewerAdapter().convert(str(model), {})

    labels = [node.label for node in result["graphCollections"][0].graphs[0].nodes]
    assert "relu.default" in labels
    assert Path(get_cached_graph_json_path(str(model))).is_file()


def test_should_invoke_parse_only_viewer_tool_for_mlir(monkeypatch, tmp_path):
    model = tmp_path / "model.mlir"
    model.write_text("module {}")
    calls = []

    monkeypatch.setattr(
        "model_explorer.zygon_viewer_adapter.find_viewer_tool",
        lambda name: f"/tools/{name}",
    )

    def run(args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(returncode=0, stdout=json.dumps(_GRAPH), stderr="")

    monkeypatch.setattr("model_explorer.zygon_viewer_adapter.subprocess.run", run)

    ZygonViewerAdapter().convert(str(model), {})

    assert calls[0][0] == ["/tools/zygon-viewer-mlir", str(model), "-o", "-"]
    assert "mdbg" not in " ".join(calls[0][0])


def test_should_find_viewer_tool_in_python_environment(monkeypatch, tmp_path):
    scripts_dir = tmp_path / "python-bin"
    scripts_dir.mkdir()
    tool = scripts_dir / "zygon-viewer-focus"
    tool.touch()

    monkeypatch.delenv("ZYGON_VIEWER_FOCUS", raising=False)
    monkeypatch.setenv("PATH", "")
    monkeypatch.setattr(
        "model_explorer.zygon_viewer_tools.sysconfig.get_path",
        lambda name: str(scripts_dir) if name == "scripts" else "",
    )
    find_viewer_tool.cache_clear()

    assert find_viewer_tool("zygon-viewer-focus") == str(tool)


def test_should_find_overlay_tool_in_python_environment(monkeypatch, tmp_path):
    scripts_dir = tmp_path / "python-bin"
    scripts_dir.mkdir()
    tool = scripts_dir / "zygon-viewer-overlay"
    tool.touch()

    monkeypatch.delenv("ZYGON_VIEWER_OVERLAY", raising=False)
    monkeypatch.setenv("PATH", "")
    monkeypatch.setattr(
        "model_explorer.zygon_viewer_tools.sysconfig.get_path",
        lambda name: str(scripts_dir) if name == "scripts" else "",
    )
    find_viewer_tool.cache_clear()

    assert find_viewer_tool("zygon-viewer-overlay") == str(tool)


def _write_materialized_run(run_dir: Path) -> Path:
    cache = run_dir / "overlay"
    cache.mkdir()
    (cache / "graph.json").write_text(json.dumps(_GRAPH))
    (cache / "anomaly.json").write_text("{}")
    (cache / "metadata.json").write_text(
        json.dumps({
            "schema": "zygon-viewer/overlay-cache/v2",
            "graph": {"path": "graph.json"},
            "layers": {
                "anomaly": {"present": True},
                "timing": {"present": False},
                "memory": {"present": False},
                "crash": {"present": False},
            },
        })
    )
    manifest = run_dir / "run_manifest.json"
    manifest.write_text(json.dumps({"schema": "zygon/run-manifest/v1"}))
    return manifest


def test_should_materialize_run_manifest_into_persistent_overlay(monkeypatch, tmp_path):
    manifest = _write_materialized_run(tmp_path)
    calls = []
    monkeypatch.setattr(
        "model_explorer.zygon_viewer_adapter.find_viewer_tool",
        lambda name: f"/tools/{name}",
    )

    def run(args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr("model_explorer.zygon_viewer_adapter.subprocess.run", run)

    materialized = materialize_run_manifest(str(manifest))

    assert calls[0][0] == ["/tools/zygon-viewer-overlay", str(manifest)]
    assert materialized.graph_path == str(tmp_path / "overlay" / "graph.json")
    assert materialized.node_data_paths == [str(tmp_path / "overlay" / "anomaly.json")]


def test_should_expand_run_manifest_in_model_explorer_config(monkeypatch, tmp_path):
    manifest = _write_materialized_run(tmp_path)
    monkeypatch.setattr(
        "model_explorer.zygon_viewer_adapter.find_viewer_tool",
        lambda name: f"/tools/{name}",
    )
    monkeypatch.setattr(
        "model_explorer.zygon_viewer_adapter.subprocess.run",
        lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout="", stderr=""),
    )

    config = ModelExplorerConfig().add_model_from_path(str(manifest))

    assert config.model_sources == [{
        "url": str(tmp_path / "overlay" / "graph.json"),
        "adapterId": "zygon_viewer",
    }]
    assert config.node_data_sources == [str(tmp_path / "overlay" / "anomaly.json")]
    assert config.node_data_target_models == ["model"]


def _write_compiler_overlay(tmp_path: Path) -> Path:
    model = tmp_path / "model.mlir"
    model.write_text("module {}\n")
    cache = tmp_path / "model.overlay"
    cache.mkdir()
    (cache / "graph.json").write_text(json.dumps(_GRAPH))
    (cache / "timing.json").write_text("{}")
    (cache / "metadata.json").write_text(
        json.dumps({
            "schema": "zygon-viewer/overlay-cache/v2",
            "source": {
                "kind": "compiler_telemetry",
                "model_sha256": hashlib.sha256(model.read_bytes()).hexdigest(),
                "input_sha256": "telemetry",
            },
            "graph": {"path": "graph.json"},
            "layers": {
                "anomaly": {"present": False},
                "timing": {"present": True},
                "memory": {"present": False},
                "crash": {"present": False},
            },
        })
    )
    return model


def test_should_discover_compiler_overlay_beside_mlir(tmp_path):
    model = _write_compiler_overlay(tmp_path)

    materialized = find_compiler_overlay(str(model))

    assert materialized is not None
    assert materialized.graph_path == str(tmp_path / "model.overlay" / "graph.json")
    assert materialized.node_data_paths == [
        str(tmp_path / "model.overlay" / "timing.json")
    ]


def test_should_expand_compiler_overlay_in_model_explorer_config(tmp_path):
    model = _write_compiler_overlay(tmp_path)

    config = ModelExplorerConfig().add_model_from_path(str(model))

    assert config.model_sources == [{
        "url": str(tmp_path / "model.overlay" / "graph.json"),
        "adapterId": "zygon_viewer",
    }]
    assert config.node_data_sources == [
        str(tmp_path / "model.overlay" / "timing.json")
    ]
    assert config.node_data_target_models == ["model"]


def test_should_reject_stale_compiler_overlay(tmp_path):
    model = _write_compiler_overlay(tmp_path)
    model.write_text("module { /* changed */ }\n")

    with pytest.raises(RuntimeError, match="Overlay is stale"):
        find_compiler_overlay(str(model))


def test_should_import_model_explorer_without_viewer_distribution():
    package_root = Path(__file__).resolve().parents[1] / "src"
    script = """
import importlib.abc
import sys

class RejectViewer(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path, target=None):
        if fullname == "zygon_viewer" or fullname.startswith("zygon_viewer."):
            raise ModuleNotFoundError(fullname)
        return None

sys.meta_path.insert(0, RejectViewer())
import model_explorer
import model_explorer.zygon_viewer_adapter
"""
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(package_root)

    result = subprocess.run(
        [sys.executable, "-c", script],
        env=environment,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
