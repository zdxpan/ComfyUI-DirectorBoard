"""Thin asset targets: suggest a list from the story, or refine one row."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

from .assist_contract import validate_asset_suggestions
from .llm_json import complete_json


ASSET_SUGGEST_MAX_TOKENS = 4096
ASSET_PROMPT_MAX_TOKENS = 2048

_ASSET_TYPES = ("人物", "场景", "道具")
_ASSET_SUGGEST_SKILLS = {"free": "asset-suggest-free.md"}


def prepare_asset_suggest_request(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict) or payload.get("target") != "asset_suggest":
        raise ValueError("asset_suggest 请求必须使用 target=asset_suggest")
    current = payload.get("current") or {}
    context = payload.get("context") or {}
    if not isinstance(current, dict) or not isinstance(context, dict):
        raise ValueError("asset_suggest current/context 必须是对象")
    skill_id = str(payload.get("skill_id") or "free")
    if skill_id not in _ASSET_SUGGEST_SKILLS:
        raise ValueError(f"不支持的 asset_suggest skill_id: {skill_id}")
    story_text = str(context.get("story_text") or "").strip()
    if not story_text:
        raise ValueError("请先写剧本正文")
    return {
        "skill_id": skill_id,
        "story_text": story_text,
        "instruction": str(payload.get("instruction") or "").strip(),
    }


def asset_suggest_skill(skill_id: str) -> str:
    filename = _ASSET_SUGGEST_SKILLS.get(skill_id)
    if not filename:
        raise ValueError(f"不支持的 asset_suggest skill_id: {skill_id}")
    return (Path(__file__).with_name("skills") / filename).read_text(encoding="utf-8").strip()


def build_asset_suggest_system_prompt(skill_id: str) -> str:
    types = " / ".join(_ASSET_TYPES)
    return (
        "你是短剧的资产规划助手。必须返回 JSON 对象："
        '{"assets":[...],"warnings":[]}，不得返回 Markdown 或其它字段。\n\n'
        "从剧本里提取需要准备的图片资产，只输出清单，每项包含：\n"
        f"- name：资产名称；\n- type：只能是 {types}；\n"
        "- description：稳定描述；\n"
        "- fixed_features：容易在画面中识别的固定视觉特征字符串数组。\n"
        "每项只能包含以上四个字段。description 只写稳定身份，不写剧情动作链，禁止出现 <asset:...>。\n"
        "同一实体的不同动作、状态、情绪或机位必须合并。没有明确资产需求就返回空数组。\n"
        "不要输出图片路径、ID、模型参数或生成指令。\n\n"
        + asset_suggest_skill(skill_id)
    )


def build_asset_suggest_user_prompt(request: dict[str, Any]) -> str:
    parts = ["剧本正文：\n" + request["story_text"]]
    if request.get("instruction"):
        parts.append(f"补充意见：{request['instruction']}")
    return "\n\n".join(parts)


def parse_asset_suggest_result(raw: str | dict[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    try:
        value = raw if isinstance(raw, dict) else json.loads(str(raw).strip())
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError(f"LLM asset response is not valid JSON: {error}") from error
    if not isinstance(value, dict) or set(value) - {"assets", "warnings"}:
        raise ValueError("LLM asset response must contain only assets and warnings")
    assets = value.get("assets", [])
    warnings = value.get("warnings", [])
    if not isinstance(warnings, list) or not all(isinstance(item, str) for item in warnings):
        raise ValueError("LLM asset response warnings 必须是字符串数组")
    diagnostics = validate_asset_suggestions(assets)
    if diagnostics:
        raise ValueError("assets 未通过契约校验：" + "；".join(diagnostics))
    return [{
        "name": str(item.get("name") or ""), "type": str(item["type"]),
        "description": str(item.get("description") or ""),
        "fixed_features": [str(value) for value in item.get("fixed_features", []) if isinstance(value, str)],
    } for item in assets], warnings


def generate_asset_suggestions(
    request: dict[str, Any],
    generator: Callable[[str, str, int], str | dict[str, Any]] | None = None,
    max_tokens: int = ASSET_SUGGEST_MAX_TOKENS,
) -> tuple[list[dict[str, Any]], list[str]]:
    system_prompt = build_asset_suggest_system_prompt(str(request.get("skill_id") or "free"))
    raw = (
        generator(system_prompt, build_asset_suggest_user_prompt(request), max_tokens)
        if generator
        else complete_json(system_prompt, build_asset_suggest_user_prompt(request), max_tokens)
    )
    return parse_asset_suggest_result(raw)


def prepare_asset_prompt_request(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict) or payload.get("target") != "asset_prompt":
        raise ValueError("asset_prompt 请求必须使用 target=asset_prompt")
    context = payload.get("context") or {}
    asset = context.get("asset") if isinstance(context, dict) else None
    if not isinstance(asset, dict):
        raise ValueError("asset_prompt context.asset 必须是对象")
    return {
        "asset": {
            "name": str(asset.get("name") or ""),
            "type": str(asset.get("type") or ""),
            "description": str(asset.get("description") or ""),
            "fixed_features": [str(value) for value in asset.get("fixed_features", []) if isinstance(value, str)],
        },
        "instruction": str(payload.get("instruction") or "").strip(),
    }


def build_asset_prompt_system_prompt() -> str:
    return (
        "你是项目资产卡编辑助手，只修改当前资产卡。"
        '必须返回 JSON：{"asset":{"name":"","type":"character|scene|prop","description":"","fixed_features":[]},"warnings":[]}。\n'
        "用户意见优先；不要输出图片路径、资产 ID、模型参数或生成任务。"
    )


def build_asset_prompt_user_prompt(request: dict[str, Any]) -> str:
    asset = request["asset"]
    lines = [
        f"资产名称：{asset['name'] or '（未命名）'}",
        f"资产类型：{asset['type'] or '（未指定）'}",
        f"描述：{asset['description'] or '（无）'}",
        "固定视觉特征：" + json.dumps(asset["fixed_features"], ensure_ascii=False),
    ]
    if request.get("instruction"):
        lines.append("修改意见：" + request["instruction"])
    return "\n".join(lines)


def parse_asset_prompt_result(raw: str | dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    try:
        value = raw if isinstance(raw, dict) else json.loads(str(raw).strip())
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError(f"LLM asset_prompt response is not valid JSON: {error}") from error
    if not isinstance(value, dict):
        raise ValueError("LLM asset_prompt response must be an object")
    unknown = set(value) - {"asset", "warnings"}
    if unknown:
        raise ValueError("LLM asset_prompt 响应含未知字段：" + "、".join(sorted(unknown)))
    warnings = value.get("warnings", [])
    if not isinstance(warnings, list) or not all(isinstance(item, str) for item in warnings):
        raise ValueError("LLM asset_prompt response warnings 必须是字符串数组")
    asset = value.get("asset")
    if not isinstance(asset, dict): raise ValueError("asset_prompt.asset 必须是对象")
    if str(asset.get("type") or "") not in {"character", "scene", "prop"}: raise ValueError("asset_prompt.asset.type 无效")
    if not isinstance(asset.get("fixed_features", []), list): raise ValueError("asset_prompt.asset.fixed_features 必须是数组")
    return {
        "name": str(asset.get("name") or ""), "type": str(asset.get("type")),
        "description": str(asset.get("description") or ""),
        "fixed_features": [str(item) for item in asset.get("fixed_features", []) if isinstance(item, str)],
    }, warnings


def generate_asset_prompt(
    request: dict[str, Any],
    generator: Callable[[str, str, int], str | dict[str, Any]] | None = None,
    max_tokens: int = ASSET_PROMPT_MAX_TOKENS,
) -> tuple[dict[str, Any], list[str]]:
    raw = (
        generator(build_asset_prompt_system_prompt(), build_asset_prompt_user_prompt(request), max_tokens)
        if generator
        else complete_json(build_asset_prompt_system_prompt(), build_asset_prompt_user_prompt(request), max_tokens)
    )
    return parse_asset_prompt_result(raw)
