"""Tests for the unified Zygon Viewer Model Explorer adapter."""

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from model_explorer.config import ModelExplorerConfig
from model_explorer.zygon_viewer_adapter import (
    ZygonViewerAdapter,
    _memory_access_label,
    _memory_region_label,
    find_compiler_overlay,
    get_cached_graph_json_path,
    is_run_manifest,
    materialize_run_manifest,
)
from model_explorer.zygon_viewer_tools import find_viewer_tool

_GRAPH = {
    "schemaVersion": "zygon-viewer/graph/v5",
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


@pytest.mark.parametrize(
    ("access", "label"),
    [
        ({"writeRegion": {}}, "W"),
        ({"readRegion": {}}, "R"),
        ({"readRegion": {}, "writeRegion": {}}, "R+W"),
        ({}, ""),
    ],
)
def test_should_derive_memory_access_badges_from_region_presence(access, label):
    assert _memory_access_label(access) == label


def test_should_label_strided_memory_region_in_bytes():
    region = {
        "kind": "strided",
        "offsetBytes": {"kind": "constant", "value": 16},
        "sizes": [2, 4],
        "stridesBytes": [32, 8],
        "elementBytes": 4,
    }

    assert _memory_region_label(region) == (
        "strided(offset=16 bytes, sizes=[2, 4], strides=[32, 8] bytes, element=4"
        " bytes)"
    )


def test_should_load_schema_v5_graph_json(tmp_path):
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


def test_should_reject_v1_graph_json(tmp_path):
    model = tmp_path / "model.json"
    document = dict(_GRAPH)
    document["schemaVersion"] = "zygon-viewer/graph/v1"
    model.write_text(json.dumps(document))

    with pytest.raises(RuntimeError, match="unsupported Graph JSON schemaVersion"):
        ZygonViewerAdapter().convert(str(model), {})


def test_should_project_writer_to_reader_content_flow(tmp_path):
    document = {
        "schemaVersion": "zygon-viewer/graph/v5",
        "label": "bufferized",
        "graphs": [
            {
                "id": "main",
                "nodes": [
                    {
                        "id": "alloc",
                        "label": "memref.alloc",
                        "outputsMetadata": [{"id": "0", "attrs": []}],
                    },
                    {
                        "id": "store",
                        "label": "memref.store",
                        "outputsMetadata": [],
                        "incomingEdges": [
                            {
                                "id": "edge-0",
                                "sourceNodeId": "alloc",
                                "sourceNodeOutputId": "0",
                                "targetNodeInputId": "1",
                                "metadata": {
                                    "memory": {
                                        "storageId": "storage:alloc:0",
                                        "viewRegion": {
                                            "kind": "contiguous",
                                            "offsetBytes": {
                                                "kind": "constant",
                                                "value": 16,
                                            },
                                            "lengthBytes": {
                                                "kind": "constant",
                                                "value": 32,
                                            },
                                        },
                                        "access": {
                                            "writeRegion": {
                                                "kind": "contiguous",
                                                "offsetBytes": {
                                                    "kind": "constant",
                                                    "value": 20,
                                                },
                                                "lengthBytes": {
                                                    "kind": "constant",
                                                    "value": 4,
                                                },
                                            }
                                        },
                                        "copy": {
                                            "role": "target",
                                            "overlapKind": "overlap",
                                            "overlapRegion": {
                                                "kind": "contiguous",
                                                "offsetBytes": {
                                                    "kind": "constant",
                                                    "value": 24,
                                                },
                                                "lengthBytes": {
                                                    "kind": "constant",
                                                    "value": 8,
                                                },
                                            },
                                        },
                                    }
                                },
                            }
                        ],
                    },
                    {
                        "id": "load",
                        "label": "memref.load",
                        "incomingEdges": [
                            {
                                "id": "edge-1",
                                "sourceNodeId": "alloc",
                                "sourceNodeOutputId": "0",
                                "targetNodeInputId": "0",
                                "metadata": {
                                    "memory": {
                                        "storageId": "storage:alloc:0",
                                        "viewRegion": {
                                            "kind": "contiguous",
                                            "offsetBytes": {
                                                "kind": "constant",
                                                "value": 16,
                                            },
                                            "lengthBytes": {
                                                "kind": "constant",
                                                "value": 32,
                                            },
                                        },
                                        "access": {
                                            "readRegion": {
                                                "kind": "contiguous",
                                                "offsetBytes": {
                                                    "kind": "constant",
                                                    "value": 20,
                                                },
                                                "lengthBytes": {
                                                    "kind": "constant",
                                                    "value": 4,
                                                },
                                            }
                                        },
                                    }
                                },
                            },
                        ],
                    },
                ],
                "memoryDependencies": [
                    {
                        "id": "dependency-0",
                        "storageId": "storage:alloc:0",
                        "sourceNodeId": "store",
                        "targetNodeId": "load",
                        "region": {
                            "kind": "contiguous",
                            "offsetBytes": {"kind": "constant", "value": 20},
                            "lengthBytes": {"kind": "constant", "value": 4},
                        },
                        "certainty": "must",
                    }
                ],
                "storages": [
                    {
                        "id": "storage:alloc:0",
                        "rootSsa": "@main::%alloc",
                        "paletteSlot": 0,
                        "origin": {
                            "kind": "allocation",
                            "nodeId": "alloc",
                            "outputId": "0",
                        },
                        "region": {
                            "kind": "contiguous",
                            "offsetBytes": {"kind": "constant", "value": 0},
                            "lengthBytes": {"kind": "constant", "value": 64},
                        },
                        "memorySpace": "default",
                    }
                ],
            }
        ],
    }
    model = tmp_path / "bufferized.json"
    model.write_text(json.dumps(document))

    result = ZygonViewerAdapter().convert(str(model), {})

    graph = result["graphCollections"][0].graphs[0]
    load = next(node for node in graph.nodes if node.id == "load")
    assert load.incomingEdges == []
    assert [(edge.sourceNodeId, edge.targetNodeId) for edge in graph.layoutEdges] == [
        ("store", "load")
    ]
    tasks = graph.tasksData.edgeOverlaysDataListLeftPane
    assert len(tasks) == 1
    assert tasks[0].name == "Memory content"
    assert tasks[0].selectByDefault is True
    assert tasks[0].selectionMode == "single_highlight"
    assert tasks[0].graphName == "main"
    assert len(tasks[0].overlays) == 1
    overlay = tasks[0].overlays[0]
    assert overlay.name == "%alloc"
    assert overlay.edgeColor == "#4477AA"
    assert overlay.dimNonOverlayNodes is False
    assert overlay.alwaysVisible is True
    assert overlay.storageFocusSelector == "@main::%alloc"
    assert overlay.memberNodeIds == ["store", "load"]
    assert [edge.label for edge in overlay.edges] == [
        "content [20, 24) bytes",
    ]
    assert all(node.id != "alloc" for node in graph.nodes)

    store = next(node for node in graph.nodes if node.id == "store")
    assert store.outputsMetadata == []
    assert store.incomingEdges == []
    store_details = {attr.key: attr.value for attr in store.attrs}
    assert store_details["%alloc Storage"] == "storage:alloc:0"
    assert store_details["%alloc Root SSA"] == "@main::%alloc"
    assert "%alloc Origin node" not in store_details
    assert store_details["%alloc View"] == "input 1: [16, 48) bytes"
    assert store_details["%alloc Access"] == (
        "input 1: W [20, 24) bytes; copy target overlap=[24, 32) bytes"
    )
    assert store_details["%alloc Content consumers"].nodeIds == ["load"]
    assert "S1 Region" not in store_details

    load_details = {attr.key: attr.value for attr in load.attrs}
    assert load_details["%alloc Content producers"].nodeIds == ["store"]


def test_should_keep_model_output_connected_when_allocation_is_hidden(tmp_path):
    region = {
        "kind": "contiguous",
        "offsetBytes": {"kind": "constant", "value": 0},
        "lengthBytes": {"kind": "constant", "value": 16},
    }

    def memory_edge(edge_id, target_id, access_kind):
        return {
            "id": edge_id,
            "sourceNodeId": "alloc",
            "sourceNodeOutputId": "0",
            "targetNodeInputId": target_id,
            "metadata": {
                "memory": {
                    "storageId": "storage:alloc:0",
                    "viewRegion": region,
                    "access": {access_kind: region},
                }
            },
        }

    document = {
        "schemaVersion": "zygon-viewer/graph/v5",
        "label": "bufferized-output",
        "graphs": [
            {
                "id": "main",
                "nodes": [
                    {
                        "id": "alloc",
                        "label": "memref.alloc",
                        "outputsMetadata": [{"id": "0", "attrs": []}],
                    },
                    {
                        "id": "fill",
                        "label": "linalg.fill",
                        "incomingEdges": [
                            memory_edge("write-edge", "1", "writeRegion")
                        ],
                    },
                    {
                        "id": "outputs0",
                        "label": "outputs0",
                        "inputsMetadata": [{"id": "0", "attrs": []}],
                        "incomingEdges": [
                            memory_edge("return-edge", "0", "readRegion")
                        ],
                    },
                ],
                "memoryDependencies": [
                    {
                        "id": "output-content",
                        "storageId": "storage:alloc:0",
                        "sourceNodeId": "fill",
                        "targetNodeId": "outputs0",
                        "region": region,
                        "certainty": "must",
                    }
                ],
                "storages": [
                    {
                        "id": "storage:alloc:0",
                        "rootSsa": "@main::%alloc",
                        "paletteSlot": 0,
                        "origin": {
                            "kind": "allocation",
                            "nodeId": "alloc",
                            "outputId": "0",
                        },
                        "region": region,
                        "memorySpace": "default",
                    }
                ],
            }
        ],
    }
    model = tmp_path / "bufferized-output.json"
    model.write_text(json.dumps(document))

    result = ZygonViewerAdapter().convert(str(model), {})

    graph = result["graphCollections"][0].graphs[0]
    assert {node.id for node in graph.nodes} == {"fill", "outputs0"}
    output = next(node for node in graph.nodes if node.id == "outputs0")
    assert output.incomingEdges == []
    assert [
        (edge.sourceNodeId, edge.targetNodeId) for edge in graph.layoutEdges
    ] == [("fill", "outputs0")]
    overlay = graph.tasksData.edgeOverlaysDataListLeftPane[0].overlays[0]
    assert set(overlay.memberNodeIds) == {"fill", "outputs0"}
    assert [
        (edge.sourceNodeId, edge.targetNodeId, edge.label)
        for edge in overlay.edges
    ] == [("fill", "outputs0", "content [0, 16) bytes")]


def test_should_coalesce_repeated_dps_view_and_preserve_operand_roles(tmp_path):
    region = {
        "kind": "contiguous",
        "offsetBytes": {"kind": "constant", "value": 0},
        "lengthBytes": {"kind": "constant", "value": 64},
    }
    edges = []
    for edge_id, input_id, kind in (
        ("input-edge", "0", "input"),
        ("init-edge", "1", "init"),
    ):
        access_key = "readRegion" if kind == "input" else "writeRegion"
        edges.append(
            {
                "id": edge_id,
                "sourceNodeId": "alloc",
                "sourceNodeOutputId": "0",
                "targetNodeInputId": input_id,
                "metadata": {
                    "memory": {
                        "storageId": "storage",
                        "viewRegion": region,
                        "access": {access_key: region},
                        "dpsRole": {"kind": kind, "index": 0},
                    }
                },
            }
        )
    document = {
        "schemaVersion": "zygon-viewer/graph/v5",
        "label": "dps",
        "graphs": [
            {
                "id": "main",
                "nodes": [
                    {
                        "id": "alloc",
                        "label": "memref.alloc",
                        "outputsMetadata": [{"id": "0", "attrs": []}],
                    },
                    {
                        "id": "generic",
                        "label": "linalg.generic",
                        "incomingEdges": edges,
                    },
                ],
                "storages": [
                    {
                        "id": "storage",
                        "rootSsa": "@main::%alloc",
                        "paletteSlot": 3,
                        "origin": {
                            "kind": "allocation",
                            "nodeId": "alloc",
                            "outputId": "0",
                        },
                        "region": region,
                        "memorySpace": "default",
                    }
                ],
            }
        ],
    }
    model = tmp_path / "dps.json"
    model.write_text(json.dumps(document))

    graph = ZygonViewerAdapter().convert(str(model), {})["graphCollections"][
        0
    ].graphs[0]

    assert all(node.id != "alloc" for node in graph.nodes)
    generic = next(node for node in graph.nodes if node.id == "generic")
    assert generic.incomingEdges == []
    overlay = graph.tasksData.edgeOverlaysDataListLeftPane[0].overlays[0]
    assert overlay.edges == []
    assert overlay.memberNodeIds == ["generic"]
    details = {attr.key: attr.value for attr in generic.attrs}
    assert details["%alloc Root SSA"] == "@main::%alloc"
    assert details["%alloc Access"] == (
        "ins[0]: R [0, 64) bytes; outs[0]: W [0, 64) bytes"
    )
    assert generic.style.accentColors == ["#CCBB44"]


def test_should_keep_argument_storage_origin_visible(tmp_path):
    region = {
        "kind": "contiguous",
        "offsetBytes": {"kind": "constant", "value": 0},
        "lengthBytes": {"kind": "constant", "value": 16},
    }
    document = {
        "schemaVersion": "zygon-viewer/graph/v5",
        "label": "argument",
        "graphs": [
            {
                "id": "main",
                "nodes": [
                    {
                        "id": "arg0",
                        "label": "arg0",
                        "outputsMetadata": [{"id": "0", "attrs": []}],
                    },
                    {
                        "id": "load",
                        "label": "memref.load",
                        "incomingEdges": [
                            {
                                "id": "arg-to-load",
                                "sourceNodeId": "arg0",
                                "sourceNodeOutputId": "0",
                                "targetNodeInputId": "0",
                                "metadata": {
                                    "memory": {
                                        "storageId": "argument-storage",
                                        "viewRegion": region,
                                        "access": {"readRegion": region},
                                    }
                                },
                            }
                        ],
                    },
                ],
                "storages": [
                    {
                        "id": "argument-storage",
                        "rootSsa": "@main::%arg0",
                        "paletteSlot": 0,
                        "origin": {
                            "kind": "argument",
                            "nodeId": "arg0",
                            "outputId": "0",
                        },
                        "region": region,
                        "memorySpace": "default",
                    }
                ],
            }
        ],
    }
    model = tmp_path / "argument.json"
    model.write_text(json.dumps(document))

    graph = ZygonViewerAdapter().convert(str(model), {})["graphCollections"][
        0
    ].graphs[0]

    assert [node.id for node in graph.nodes] == ["arg0", "load"]
    load = graph.nodes[1]
    assert [edge.id for edge in load.incomingEdges] == ["arg-to-load"]
    details = {attr.key: attr.value for attr in load.attrs}
    assert details["%arg0 Origin node"].nodeIds == ["arg0"]


def test_should_show_may_dependency_only_for_primary_storage_focus(tmp_path):
    region = {
        "kind": "unknown",
        "reason": "dynamic access",
    }
    graph = {
        "id": "main",
        "nodes": [
            {
                "id": "alloc",
                "label": "memref.alloc",
                "outputsMetadata": [{"id": "0", "attrs": []}],
            },
            {"id": "writer", "label": "memref.store", "outputsMetadata": []},
            {"id": "reader", "label": "memref.load"},
        ],
        "memoryDependencies": [
            {
                "id": "may-0",
                "storageId": "storage",
                "sourceNodeId": "writer",
                "targetNodeId": "reader",
                "region": region,
                "certainty": "may",
            }
        ],
        "storages": [
            {
                "id": "storage",
                "rootSsa": "@main::%alloc",
                "paletteSlot": 2,
                "origin": {
                    "kind": "allocation",
                    "nodeId": "alloc",
                    "outputId": "0",
                },
                "region": region,
                "memorySpace": "default",
            }
        ],
    }

    def convert(primary: bool):
        current = dict(graph)
        if primary:
            current["primaryStorageId"] = "storage"
        document = {
            "schemaVersion": "zygon-viewer/graph/v5",
            "label": "may",
            "graphs": [current],
        }
        model = tmp_path / ("focused.json" if primary else "full.json")
        model.write_text(json.dumps(document))
        return ZygonViewerAdapter().convert(str(model), {})["graphCollections"][0].graphs[0]

    full_graph = convert(False)
    assert next(node for node in full_graph.nodes if node.id == "reader").incomingEdges == []
    assert full_graph.layoutEdges == []
    assert full_graph.tasksData is None

    focused_graph = convert(True)
    reader = next(node for node in focused_graph.nodes if node.id == "reader")
    assert reader.incomingEdges == []
    assert [edge.id for edge in focused_graph.layoutEdges] == ["content:may-0"]
    assert reader.style.tintColor == "#228833"
    overlay = focused_graph.tasksData.edgeOverlaysDataListLeftPane[0].overlays[0]
    assert overlay.dimNonOverlayNodes is True
    assert overlay.edges[0].label == "may content unknown (dynamic access)"


def test_should_recognize_only_v2_run_manifest(tmp_path):
    manifest = tmp_path / "run_manifest.json"
    manifest.write_text(json.dumps({"schema": "zygon/run-manifest/v1"}))
    assert not is_run_manifest(str(manifest))

    manifest.write_text(json.dumps({"schema": "zygon/run-manifest/v2"}))
    assert is_run_manifest(str(manifest))


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
        json.dumps(
            {
                "schema": "zygon-viewer/overlay-cache/v2",
                "graph": {"path": "graph.json"},
                "layers": {
                    "anomaly": {"present": True},
                    "timing": {"present": False},
                    "memory": {"present": False},
                    "crash": {"present": False},
                },
            }
        )
    )
    manifest = run_dir / "run_manifest.json"
    manifest.write_text(json.dumps({"schema": "zygon/run-manifest/v2"}))
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

    assert config.model_sources == [
        {
            "url": str(tmp_path / "overlay" / "graph.json"),
            "adapterId": "zygon_viewer",
        }
    ]
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
        json.dumps(
            {
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
            }
        )
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

    assert config.model_sources == [
        {
            "url": str(tmp_path / "model.overlay" / "graph.json"),
            "adapterId": "zygon_viewer",
        }
    ]
    assert config.node_data_sources == [str(tmp_path / "model.overlay" / "timing.json")]
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
