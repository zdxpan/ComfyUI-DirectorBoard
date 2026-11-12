"""Read-only media probing and preview transcoding for the Director Board.

Three routes are registered on ComfyUI's PromptServer when it is available:

    GET /zdx/director/file-exists      existence check inside input directory
    GET /zdx/director/media-info       ffprobe metadata for one input file
    GET /zdx/director/preview-video    ffmpeg-produced low-resolution webm clip

Both routes only read files inside ComfyUI's input directory. They never write
into the media folders; proxied previews are streamed straight to the browser.

Registration is best-effort: importing this module outside a running ComfyUI
(unit tests, plain python) must stay quiet, and a missing ffmpeg only disables
the two routes instead of breaking node loading.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
from typing import Any

PROBE_CACHE: dict[str, tuple[float, int, dict[str, Any]]] = {}
MAX_PREVIEW_MS = 60_000


def _resolve_binary(*names: str) -> str | None:
    """Find an already-installed binary; nothing is downloaded or bundled."""
    explicit = os.environ.get("ZDX_MEDIA_FFMPEG_DIR")
    for name in names:
        if explicit:
            candidate = os.path.join(explicit, name)
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                return candidate
        found = shutil.which(name)
        if found:
            return found
    return None


def ffmpeg_path() -> str | None:
    return _resolve_binary("ffmpeg")


def ffprobe_path() -> str | None:
    return _resolve_binary("ffprobe")


def _resolve_inside(root: str, relative_path: str) -> str | None:
    if not isinstance(relative_path, str) or not relative_path.strip():
        return None
    cleaned = relative_path.replace("\\", "/").strip()
    if cleaned.startswith("/") or re.match(r"^[A-Za-z]:", cleaned):
        return None
    cleaned = cleaned.strip("/")
    if not cleaned or ".." in cleaned.split("/"):
        return None
    base = os.path.realpath(root)
    candidate = os.path.realpath(os.path.join(base, cleaned))
    if os.path.commonpath((candidate, base)) != base:
        return None
    return candidate if os.path.isfile(candidate) else None


def resolve_input_file(input_path: str) -> str | None:
    """Map a Director asset path onto a real file inside the input directory."""
    try:
        import folder_paths
    except Exception:
        return None
    return _resolve_inside(folder_paths.get_input_directory(), input_path)


def resolve_output_file(filename: str, subfolder: str = "") -> str | None:
    """Resolve one generated result without allowing traversal outside output/."""
    try:
        import folder_paths
    except Exception:
        return None
    if not isinstance(filename, str) or not filename.strip():
        return None
    relative = "/".join(part for part in (subfolder, filename) if part)
    return _resolve_inside(folder_paths.get_output_directory(), relative)


def _fraction(value: Any) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    if "/" in value:
        numerator, _, denominator = value.partition("/")
        try:
            top, bottom = float(numerator), float(denominator)
        except ValueError:
            return None
        return top / bottom if bottom else None
    try:
        return float(value)
    except ValueError:
        return None


def _positive_int(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def parse_probe(payload: dict[str, Any]) -> dict[str, Any]:
    """Turn an ffprobe JSON payload into the fields the Director Board needs."""
    streams = payload.get("streams") or []
    container = payload.get("format") or {}
    video = next(
        (item for item in streams if item.get("codec_type") == "video"), {},
    )
    audio = next(
        (item for item in streams if item.get("codec_type") == "audio"), {},
    )
    duration = None
    for raw in (video.get("duration"), container.get("duration")):
        try:
            duration = float(raw)
            break
        except (TypeError, ValueError):
            continue
    fps = _fraction(video.get("avg_frame_rate")) or _fraction(
        video.get("r_frame_rate"),
    )
    frames = _positive_int(video.get("nb_frames"))
    if frames is None and duration and fps:
        frames = max(1, round(duration * fps))
    info: dict[str, Any] = {
        "duration_ms": int(round(duration * 1000)) if duration else None,
        "width": _positive_int(video.get("width")),
        "height": _positive_int(video.get("height")),
        "fps": round(fps, 6) if fps else None,
        "frames": frames,
        "codec": video.get("codec_name"),
        "sample_rate": _positive_int(audio.get("sample_rate")),
        "channels": _positive_int(audio.get("channels")),
        "has_video": bool(video),
        "has_audio": bool(audio),
    }
    return info


def probe_media(path: str) -> dict[str, Any]:
    probe = ffprobe_path()
    if not probe:
        return {"error": "ffprobe not found"}
    args = [
        probe, "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", path,
    ]
    try:
        completed = subprocess.run(
            args, capture_output=True, check=True, timeout=30,
        )
    except subprocess.CalledProcessError as error:
        detail = error.stderr.decode("utf-8", "replace").strip()
        return {"error": detail or "ffprobe failed"}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"error": str(error)}
    try:
        return parse_probe(json.loads(completed.stdout.decode("utf-8", "replace")))
    except json.JSONDecodeError as error:
        return {"error": f"invalid ffprobe output: {error}"}


def cached_probe(path: str) -> dict[str, Any]:
    stat = os.stat(path)
    cached = PROBE_CACHE.get(path)
    if cached and cached[0] == stat.st_mtime and cached[1] == stat.st_size:
        return cached[2]
    result = probe_media(path)
    PROBE_CACHE[path] = (stat.st_mtime, stat.st_size, result)
    return result


def _clamp_int(raw: Any, low: int, high: int, fallback: int) -> int:
    try:
        value = int(float(raw))
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, value))


def preview_command(
    path: str, start_ms: int, end_ms: int, width: int, fps: int,
) -> list[str]:
    """Build the ffmpeg command for one proxy clip.

    Long offsets are pre-seeked to four seconds before the in-point and then
    seeked precisely, so trimming the tail of a long video does not decode the
    whole file first.
    """
    duration = max(0.1, (end_ms - start_ms) / 1000)
    pre_seek: list[str] = []
    post_seek: list[str] = []
    if start_ms > 0:
        if start_ms > 4000:
            pre_seek = ["-ss", str((start_ms - 4000) / 1000)]
            post_seek = ["-ss", "4"]
        else:
            post_seek = ["-ss", str(start_ms / 1000)]
    binary = ffmpeg_path() or "ffmpeg"
    return [
        binary, "-v", "error", "-nostdin",
        *pre_seek, "-i", path, *post_seek,
        "-t", f"{duration:.3f}",
        "-vf", f"scale={width}:-2:flags=bilinear",
        "-r", str(fps),
        "-an",
        "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8",
        "-f", "webm", "-",
    ]


def _json_response(payload: dict[str, Any]):
    from aiohttp import web

    return web.json_response(payload)


def register_routes() -> bool:
    """Attach the two read-only routes; returns False when unavailable."""
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return False
    routes = PromptServer.instance.routes

    @routes.get("/zdx/director/file-exists")
    async def director_file_exists(request):
        input_path = request.rel_url.query.get("input_path", "")
        return _json_response({
            "input_path": input_path,
            "exists": resolve_input_file(input_path) is not None,
        })

    @routes.get("/zdx/director/media-info")
    async def director_media_info(request):
        query = request.rel_url.query
        if query.get("type") == "output":
            path = resolve_output_file(query.get("filename", ""), query.get("subfolder", ""))
        else:
            path = resolve_input_file(query.get("input_path", ""))
        if not path:
            return _json_response({"error": "file not found"})
        info = await asyncio.to_thread(cached_probe, path)
        if query.get("type") == "output":
            info.update({"filename": query.get("filename", ""), "subfolder": query.get("subfolder", ""), "type": "output"})
        else:
            info["input_path"] = query.get("input_path", "")
        return _json_response(info)

    @routes.get("/zdx/director/preview-video")
    async def director_preview_video(request):
        query = request.rel_url.query
        path = resolve_input_file(query.get("input_path", ""))
        if not path:
            return web.Response(status=404, text="file not found")
        if not ffmpeg_path():
            return web.Response(status=503, text="ffmpeg not found")
        start_ms = _clamp_int(query.get("start_ms"), 0, 86_400_000, 0)
        end_ms = _clamp_int(query.get("end_ms"), 0, 86_400_000, 0)
        if end_ms <= start_ms:
            return web.Response(status=400, text="invalid range")
        if end_ms - start_ms > MAX_PREVIEW_MS:
            end_ms = start_ms + MAX_PREVIEW_MS
        width = _clamp_int(query.get("width"), 96, 1280, 480)
        fps = _clamp_int(query.get("fps"), 1, 30, 12)
        args = preview_command(path, start_ms, end_ms, width, fps)

        process = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, stdin=asyncio.subprocess.DEVNULL,
        )
        response = web.StreamResponse()
        response.content_type = "video/webm"
        response.headers["Cache-Control"] = "no-store"
        await response.prepare(request)
        try:
            while True:
                chunk = await process.stdout.read(1 << 20)
                if not chunk:
                    break
                await response.write(chunk)
        except (ConnectionResetError, ConnectionError):
            process.kill()
        finally:
            if process.returncode is None:
                await process.wait()
        return response

    return True


ROUTES_REGISTERED = register_routes()
