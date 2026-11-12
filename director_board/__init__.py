"""Director Board nodes: validated project JSON (dispatch node is archived)."""

from .nodes import ZDXDirectorBoard

# Registers the read-only media probe / preview routes when ComfyUI's web
# server is present. Import failures are already handled inside the module so
# node loading never depends on aiohttp, ffmpeg, or a running server.
try:
    from . import media_server  # noqa: F401
except Exception as error:  # pragma: no cover - defensive, mirrors other nodes
    print(f"## zdx_comfyui director media routes load failed: {error}")

try:
    from . import asset_server  # noqa: F401
except Exception as error:  # pragma: no cover
    print(f"## zdx_comfyui director asset routes load failed: {error}")

try:
    from . import agent_server  # noqa: F401
except Exception as error:  # pragma: no cover
    print(f"## zdx_comfyui director agent routes load failed: {error}")

NODE_CLASS_MAPPINGS = {
    "ZDXDirectorBoard": ZDXDirectorBoard,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "ZDXDirectorBoard": "ZDX 导演台",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
