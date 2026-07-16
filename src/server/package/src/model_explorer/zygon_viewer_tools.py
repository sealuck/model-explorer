"""Locate native Zygon Viewer tools without depending on mdbg."""

from functools import lru_cache
import os
from pathlib import Path
import shutil
import sysconfig

_ENV_BY_TOOL = {
    "zygon-viewer-focus": "ZYGON_VIEWER_FOCUS",
    "zygon-viewer-mlir": "ZYGON_VIEWER_MLIR",
}
_SOURCE_ROOT = Path(__file__).resolve().parents[7]


@lru_cache(maxsize=None)
def find_viewer_tool(name: str) -> str:
    """Resolve a packaged, installed, or source-checkout Viewer executable."""
    env_name = _ENV_BY_TOOL.get(name)
    explicit = os.environ.get(env_name, "") if env_name else ""
    if explicit:
        if Path(explicit).is_file():
            return explicit
        raise RuntimeError(f"{env_name} points to missing file: {explicit}")

    # The Zygon Viewer wheel installs native tools into the active Python
    # environment's scripts directory. Resolve that directory explicitly so a
    # server launched through an absolute path still works with PATH cleared.
    environment_tool = Path(sysconfig.get_path("scripts")) / name
    if environment_tool.is_file():
        return str(environment_tool)

    installed = shutil.which(name)
    if installed:
        return installed

    working_tree_tool = Path.cwd() / "build" / "bin" / name
    if working_tree_tool.is_file():
        return str(working_tree_tool)

    source_tool = _SOURCE_ROOT / "build" / "bin" / name
    if source_tool.is_file():
        return str(source_tool)

    env_hint = f" or set {env_name}" if env_name else ""
    raise RuntimeError(f"{name} not found; build the Viewer{env_hint}")
