"""mdbg FX adapter: render a torch.fx .code dump as a Model Explorer graph.

Shells out to the main repo's `python -m mdbg.viewer.fx_translate`, which parses
the .code text into viewer/v0 JSON; needs no torch. The translated JSON is
cached so the focus/dataflow endpoints can reuse it via mdbg dataflow.
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Dict

from .adapter import Adapter, AdapterMetadata
from .mdbg_mlir_adapter import _parse_graph_collection_json
from .types import ModelExplorerGraphs

# Cache: fx model_path -> path of the translated graph JSON temp file. Consumed
# by server.py focus/dataflow endpoints so the JSON is reused without reparsing.
_translate_cache: dict[str, str] = {}

# Repo root is seven parents up from this file (.../src/model_explorer/<file>).
_REPO_ROOT = Path(__file__).resolve().parents[7]
_PYTHON_PKG = _REPO_ROOT / "python"


def get_cached_graph_json_path(model_path: str) -> str | None:
  """Return the cached graph JSON path for an fx model, or None if absent."""
  return _translate_cache.get(model_path)


def _translate_fx(model_path: str) -> str:
  env = dict(os.environ)
  env["PYTHONPATH"] = str(_PYTHON_PKG) + os.pathsep + env.get("PYTHONPATH", "")
  proc = subprocess.run(
      [sys.executable, "-m", "mdbg.viewer.fx_translate", model_path, "-o", "-"],
      check=False,
      capture_output=True,
      text=True,
      env=env,
  )
  if proc.returncode != 0:
    stderr = proc.stderr.strip()
    detail = f": {stderr}" if stderr else ""
    raise RuntimeError(f"fx_translate failed{detail}")
  return proc.stdout


class MdbgFxAdapter(Adapter):
  """Adapter that translates a torch.fx .code dump into a viewer/v0 graph."""

  metadata = AdapterMetadata(
      id="mdbg_fx",
      name="mdbg FX adapter",
      description="Loads a torch.fx GraphModule .code dump (viewer/v0 graph)",
      fileExts=["fx"],
  )

  def __init__(self):
    super().__init__()

  def convert(self, model_path: str, settings: Dict) -> ModelExplorerGraphs:
    del settings

    stdout = _translate_fx(model_path)

    # Cache translated JSON to disk; reused by focus/dataflow endpoints.
    tmp = tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", prefix="mdbg_fx_graph_", delete=False
    )
    tmp.write(stdout)
    tmp.close()
    _translate_cache[model_path] = tmp.name

    return {"graphCollections": [_parse_graph_collection_json(stdout)]}
