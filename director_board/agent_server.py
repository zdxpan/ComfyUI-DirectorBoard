"""Thin HTTP transport for the creative-assistant targets.

只做三件事：按 target 路由、解析请求、把结果/硬错打包成三态响应。
任何创作决定、质量检查与正式项目校验都不在这里，而在各自的薄 adapter 里。

三态响应契约（前端据此决定是否允许"接受"）：
- 成功：`{<target key>: payload, "warnings": [], "valid": true}`
- 成功但有质量警告：同上，warnings 非空
- 硬错：`{"error": "...", "hard_error": "...", "valid": false}`
"""
from __future__ import annotations

import asyncio
import logging
import time

from .asset_agent import (
    generate_asset_prompt,
    generate_asset_suggestions,
    prepare_asset_prompt_request,
    prepare_asset_suggest_request,
)
from .shot_draft_agent import generate_shot_breakdown, generate_shot_draft, prepare_shot_breakdown_request, prepare_shot_draft_request
from .shot_prompt import (
    generate_shot_prompt, prepare_shot_prompt_request,
)
from .story_agent import generate_story, prepare_story_request
from .picture_plan_agent import generate_picture_plan, prepare_picture_plan_request

from . import assistant_bridge as bridge


LOGGER = logging.getLogger(__name__)
TARGET_NAMES = (
    "story", "picture_plan", "asset_suggest", "asset_prompt", "shot_draft", "shot_breakdown", "shot_prompt",
)


def run_target(target: str, adapter: dict, prepared: dict) -> dict:
    """prepare 之后的完整执行（**阻塞**）。同步路由与异步 job 共用这一份。

    共用是必须的：各写一遍就会各漏一遍字段，出现"同样是拆镜，同步与异步结果不同"。
    """
    execution = {}
    result = (adapter["generate"](prepared, execution=execution)
              if target == "shot_prompt" else adapter["generate"](prepared))
    response = adapter["response"](result)
    response["model"] = execution.get("model") or current_llm_model()
    if execution.get("generation_path"):
        response["generation_path"] = execution["generation_path"]
    return response


def response_item_count(target: str, response: dict) -> int:
    """Return a safe result-size metric without logging generated content."""
    field = {
        "story": "story",
        "picture_plan": "pictures",
        "asset_suggest": "assets",
        "asset_prompt": "asset",
        "shot_draft": "shot",
        "shot_breakdown": "shots",
        "shot_prompt": "prompt",
    }.get(target)
    value = response.get(field) if field else None
    if isinstance(value, list):
        return len(value)
    if isinstance(value, str):
        return len(value)
    if isinstance(value, dict):
        text = value.get("text")
        return len(text) if isinstance(text, str) else 1
    return 0

def llm_failure_message(error: Exception, fallback: str) -> str:
    text = str(error)
    if "SetLimitExceeded" in text:
        return "豆包模型已达到账号设定用量上限，请在火山方舟调整安全体验模式或更换模型。"
    if "RateLimitExceeded" in text or "429" in text:
        return "豆包请求频率已达到 RPM 上限，请稍后重试。"
    if "401" in text or "Unauthorized" in text:
        return "豆包 API key 或 endpoint 无效，请检查 .env_llm。"
    return fallback


def current_llm_model() -> str:
    """Return the configured model for the standalone assistant."""
    from .llm_json import configured_model
    return configured_model()


def capability_payload(provider=None):
    if provider is None:
        from ..minimax_h3_shot import shot_capabilities as provider
    return provider()


def _prepare_shot_prompt(payload):
    from ..minimax_h3_video_sample import align_h3_frame_count
    return prepare_shot_prompt_request(payload, align_h3_frame_count)


def _prepare_shot_draft(payload):
    return prepare_shot_draft_request(payload)


def _story_response(result):
    story, warnings = result
    return {"story": story, "warnings": warnings, "valid": True}


def _picture_plan_response(result):
    pictures, warnings = result
    return {"pictures": pictures, "warnings": warnings, "valid": True}


def _asset_suggest_response(result):
    assets, warnings = result
    return {"assets": assets, "warnings": warnings, "valid": True}


def _asset_prompt_response(result):
    asset, warnings = result
    return {"asset": asset, "warnings": warnings, "valid": True}


def _shot_draft_response(result):
    shot, warnings = result
    return {"shot": shot, "warnings": warnings, "valid": True}

def _shot_breakdown_response(result):
    shots, warnings = result
    return {"shots": shots, "warnings": warnings, "valid": True}


def _shot_prompt_response(result):
    prompt, warnings = result
    return {"prompt": prompt, "warnings": warnings, "valid": True}


TARGETS = {
    "story": {
        "prepare": prepare_story_request,
        "generate": generate_story,
        "response": _story_response,
        "failure": "剧本生成失败，请检查模型配置或稍后重试",
    },
    "picture_plan": {
        "prepare": prepare_picture_plan_request,
        "generate": generate_picture_plan,
        "response": _picture_plan_response,
        "failure": "画面构思失败，请检查模型配置或稍后重试",
    },
    "asset_suggest": {
        "prepare": prepare_asset_suggest_request,
        "generate": generate_asset_suggestions,
        "response": _asset_suggest_response,
        "failure": "资产建议生成失败，请检查模型配置或稍后重试",
    },
    "asset_prompt": {
        "prepare": prepare_asset_prompt_request,
        "generate": generate_asset_prompt,
        "response": _asset_prompt_response,
        "failure": "资产提示词优化失败，请检查模型配置或稍后重试",
    },
    "shot_draft": {
        "prepare": _prepare_shot_draft,
        "generate": generate_shot_draft,
        "response": _shot_draft_response,
        "failure": "单镜草稿生成失败，请检查模型配置或稍后重试",
    },
    "shot_breakdown": {
        "prepare": prepare_shot_breakdown_request,
        "generate": generate_shot_breakdown,
        "response": _shot_breakdown_response,
        "failure": "剧本拆镜失败，请检查模型配置或稍后重试",
    },
    "shot_prompt": {
        "prepare": _prepare_shot_prompt,
        "generate": generate_shot_prompt,
        "response": _shot_prompt_response,
        "failure": "提示词优化失败，请检查模型配置或稍后重试",
    },
}


def register_routes() -> bool:
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return False

    routes = PromptServer.instance.routes

    @routes.get("/zdx/director/capabilities")
    async def director_capabilities(_request):
        try:
            return web.json_response(capability_payload())
        except Exception:
            LOGGER.exception("Director capabilities projection failed")
            return web.json_response({"error": "导演台能力读取失败"}, status=500)

    @routes.post("/zdx/director/asset-facts")
    async def director_asset_facts(request):
        """资产图打标：用写作层**同一套**看图给一张图生成描述。

        结果由前端写进资产描述（用户可改）；写作时**有描述就直接采信、不再看图**。
        """
        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"error": "请求解析失败，请检查 JSON 格式"}, status=400)
        image_path = str((payload or {}).get("image_path") or "").strip() \
            if isinstance(payload, dict) else ""
        if not image_path:
            return web.json_response({"error": "打标需要 image_path"}, status=400)
        try:
            from .assistant_bridge import asset_facts as _asset_facts
            facts = await asyncio.to_thread(_asset_facts, image_path)
        except Exception as exc:                             # noqa: BLE001
            LOGGER.warning("Asset facts failed image=%s error=%s", image_path, exc)
            return web.json_response({"error": f"图片识别失败：{exc}"}, status=500)
        return web.json_response({"facts": facts, "valid": True})

    async def _prepare_or_error(request):
        """解析 + 校验 + 冻结。返回 ``(payload, target, adapter, prepared, error_response)``。"""
        try:
            payload = await request.json()
        except Exception:
            return None, None, None, None, web.json_response({
                "error": "请求解析失败，请检查 JSON 格式",
                "hard_error": "请求体不是合法 JSON", "valid": False}, status=400)
        target = payload.get("target") if isinstance(payload, dict) else None
        adapter = TARGETS.get(target)
        if adapter is None:
            return payload, target, None, None, web.json_response({
                "error": "未知的 target",
                "hard_error": f"当前仅支持 {', '.join(sorted(TARGETS))}",
                "valid": False}, status=400)
        try:
            prepared = adapter["prepare"](payload)
        except (TypeError, ValueError) as error:
            return payload, target, adapter, None, web.json_response({
                "error": str(error), "hard_error": str(error), "valid": False}, status=400)
        return payload, target, adapter, prepared, None

    @routes.post("/zdx/director/assist/jobs")
    async def director_assist_job(request):
        """会跑很久的请求的**异步入口**。**服务端决定同步还是异步**：

        - 够格（段数大的拆镜）→ 建任务、后台跑、立刻返回 ``job_id``
        - 不够格 → 当场跑完，结果直接放进 ``result``

        客户端只需看返回里有没有 ``job_id``：有就轮询，没有就直接用。
        这让"门槛调高调低"只改服务端一处，前端不用跟着改。
        """
        payload, target, adapter, prepared, failure = await _prepare_or_error(request)
        if failure is not None:
            return failure
        if not bridge.needs_job(payload):
            try:
                response = await asyncio.to_thread(run_target, target, adapter, prepared)
            except ValueError as error:
                return web.json_response({"error": str(error), "hard_error": str(error),
                                          "valid": False}, status=422)
            except Exception as error:                       # noqa: BLE001
                message = llm_failure_message(error, adapter["failure"])
                return web.json_response({"error": message, "hard_error": message,
                                          "valid": False}, status=500)
            return web.json_response({"status": "completed", "result": response, "valid": True})

        def work(_payload):
            return run_target(target, adapter, prepared)

        try:
            job = bridge.submit_job(payload, work)
        except Exception as error:                           # noqa: BLE001
            LOGGER.exception("Director job submit failed target=%s", target)
            return web.json_response({"error": str(error), "hard_error": str(error),
                                      "valid": False}, status=500)
        LOGGER.info("Director job submitted target=%s job_id=%s", target, job.get("job_id"))
        return web.json_response({**job, "valid": True})

    def _job_error(where: str, job_id: str, error: Exception):
        """**404 只留给"任务真的不在"**；别的错误一律 500 并记日志。

        曾经这里把所有异常都当 404，于是磁盘写失败（临时文件撞车）被伪装成
        "任务不存在"，真因看不见 —— 排查时多花了很多时间。
        """
        if bridge.is_job_missing(error):
            return web.json_response({"error": str(error), "valid": False}, status=404)
        LOGGER.exception("Director job %s failed job_id=%s", where, job_id)
        return web.json_response({"error": f"任务{where}失败：{error}", "valid": False}, status=500)

    @routes.get("/zdx/director/assist/jobs/{job_id}")
    async def director_job_status(request):
        job_id = request.match_info["job_id"]
        try:
            job = bridge.job_status(job_id)
        except Exception as error:                           # noqa: BLE001
            return _job_error("查询", job_id, error)
        return web.json_response({**job, "valid": True})

    @routes.post("/zdx/director/assist/jobs/{job_id}/cancel")
    async def director_job_cancel(request):
        job_id = request.match_info["job_id"]
        try:
            job = bridge.cancel_job(job_id)
        except Exception as error:                           # noqa: BLE001
            return _job_error("取消", job_id, error)
        return web.json_response({**job, "valid": True})

    @routes.post("/zdx/director/assist")
    async def director_assist(request):
        try:
            payload = await request.json()
        except Exception:
            return web.json_response({
                "error": "请求解析失败，请检查 JSON 格式",
                "hard_error": "请求体不是合法 JSON",
                "valid": False,
            }, status=400)
        target = payload.get("target") if isinstance(payload, dict) else None
        request_id = str(payload.get("requestId") or request.headers.get("x-request-id") or "-") if isinstance(payload, dict) else "-"
        adapter = TARGETS.get(target)
        if adapter is None:
            return web.json_response({
                "error": "未知的 target",
                "hard_error": f"当前仅支持 {', '.join(sorted(TARGETS))}",
                "valid": False,
            }, status=400)
        try:
            prepared = adapter["prepare"](payload)
        except (TypeError, ValueError) as error:
            return web.json_response({
                "error": str(error),
                "hard_error": str(error),
                "valid": False,
            }, status=400)
        started = time.monotonic()
        LOGGER.info("Director request started request_id=%s target=%s", request_id, target)
        try:
            response = await asyncio.to_thread(run_target, target, adapter, prepared)
            LOGGER.info(
                "Director request completed request_id=%s target=%s elapsed_ms=%d result_size=%d warnings=%d model=%s",
                request_id,
                target,
                round((time.monotonic() - started) * 1000),
                response_item_count(target, response),
                len(response.get("warnings") or []),
                response.get("model") or "-",
            )
            return web.json_response(response)
        except ValueError as error:
            LOGGER.warning(
                "Director request rejected request_id=%s target=%s elapsed_ms=%d error_type=%s",
                request_id, target, round((time.monotonic() - started) * 1000), type(error).__name__,
            )
            return web.json_response({
                "error": str(error),
                "hard_error": str(error),
                "valid": False,
            }, status=422)
        except Exception as error:
            LOGGER.exception(
                "Director request failed request_id=%s target=%s elapsed_ms=%d",
                request_id, target, round((time.monotonic() - started) * 1000),
            )
            message = llm_failure_message(error, adapter["failure"])
            return web.json_response({
                "error": message,
                "hard_error": message,
                "valid": False,
            }, status=500)

    return True


ROUTES_REGISTERED = register_routes()
