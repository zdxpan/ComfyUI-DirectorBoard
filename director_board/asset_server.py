"""Asset-center JSON routes for the local Director Board."""
from __future__ import annotations

import asyncio
import os
import re
import shutil
import uuid

from .asset_store import AssetStore
from .media_server import resolve_input_file


def register_routes() -> bool:
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return False

    routes = PromptServer.instance.routes

    def response(payload, status=200):
        return web.json_response(payload, status=status)

    def checked_payload(payload):
        image_path = str(payload.get("image_path") or "")
        if not resolve_input_file(image_path):
            raise ValueError("图片不在 ComfyUI input 目录或文件不存在")
        return payload

    @routes.get("/zdx/assets")
    async def list_assets(_request):
        return response({"assets": AssetStore().list()})

    @routes.post("/zdx/assets")
    async def create_asset(request):
        try:
            asset = AssetStore().create(checked_payload(await request.json()))
            return response({"asset": asset}, 201)
        except (ValueError, TypeError) as error:
            return response({"error": str(error)}, 400)

    @routes.put(r"/zdx/assets/{asset_id:\d+}")
    async def update_asset(request):
        try:
            asset = AssetStore().update(int(request.match_info["asset_id"]), checked_payload(await request.json()))
            return response({"asset": asset})
        except KeyError:
            return response({"error": "资产不存在"}, 404)
        except (ValueError, TypeError) as error:
            return response({"error": str(error)}, 400)

    @routes.delete(r"/zdx/assets/{asset_id:\d+}")
    async def delete_asset(request):
        deleted = AssetStore().delete(int(request.match_info["asset_id"]))
        return response({"deleted": deleted}, 200 if deleted else 404)

    @routes.post("/zdx/assets/caption")
    async def caption_asset(request):
        return response({"error": "独立包不包含图片描述模型；请手动填写资产描述"}, 501)

    @routes.post("/zdx/assets/import-generated")
    async def import_generated(request):
        payload = await request.json()
        filename = os.path.basename(str(payload.get("filename") or ""))
        subfolder = str(payload.get("subfolder") or "").replace("\\", "/").strip("/")
        source_type = str(payload.get("type") or "temp")
        if not filename or ".." in subfolder.split("/"):
            return response({"error": "生成图片路径无效"}, 400)
        try:
            import folder_paths
            base = folder_paths.get_temp_directory() if source_type == "temp" else folder_paths.get_output_directory()
            source = os.path.realpath(os.path.join(base, subfolder, filename))
            if os.path.commonpath((source, os.path.realpath(base))) != os.path.realpath(base) or not os.path.isfile(source):
                return response({"error": "生成图片不存在"}, 404)
            target_dir = os.path.join(folder_paths.get_input_directory(), "zdx_assets")
            os.makedirs(target_dir, exist_ok=True)
            stem = re.sub(r"[^A-Za-z0-9_-]+", "_", os.path.splitext(filename)[0]).strip("_") or "asset"
            target_name = f"{stem}_{uuid.uuid4().hex[:8]}{os.path.splitext(filename)[1] or '.png'}"
            shutil.copy2(source, os.path.join(target_dir, target_name))
            return response({"image_path": f"zdx_assets/{target_name}"})
        except Exception as error:
            return response({"error": str(error)}, 500)

    return True


ROUTES_REGISTERED = register_routes()
