"""Thin L1 story target: inspiration + optional edits -> editable plain text."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

from .assist_contract import story_payload
from .llm_json import complete_json


STORY_MAX_TOKENS = 8192
_STORY_SKILLS = {
    "free": "story-free.md",
    "emotional-drama": "story-emotional-drama.md",
    "action": "story-action.md",
    "commerce-host": "story-commerce-host.md",
}


def prepare_story_request(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict) or payload.get("target") != "story":
        raise ValueError("story 请求必须使用 target=story")
    skill_id = str(payload.get("skill_id") or "free")
    if skill_id not in _STORY_SKILLS:
        raise ValueError(f"不支持的 story skill_id: {skill_id}")
    current = payload.get("current") or {}
    context = payload.get("context") or {}
    if not isinstance(current, dict) or not isinstance(context, dict):
        raise ValueError("story current/context 必须是对象")
    inspiration = str(context.get("inspiration") or "").strip()
    text = str(current.get("text") or "").strip()
    if not inspiration and not text:
        raise ValueError("首次生成 story 必须提供灵感或已有文本")
    duration = context.get("duration_seconds")
    if duration is not None and (isinstance(duration, bool) or not isinstance(duration, (int, float)) or not 1 <= duration <= 15):
        raise ValueError("单镜剧情时长必须在 1 至 15 秒之间")
    return {
        **({"duration_seconds": duration} if duration is not None else {}),
        "skill_id": skill_id,
        "text": text,
        "instruction": str(payload.get("instruction") or "").strip(),
        "inspiration": inspiration,
    }


def story_skill(skill_id: str) -> str:
    filename = _STORY_SKILLS.get(skill_id)
    if not filename:
        raise ValueError(f"不支持的 story skill_id: {skill_id}")
    return (Path(__file__).with_name("skills") / filename).read_text(encoding="utf-8").strip()


def build_story_system_prompt(skill_id: str, duration_seconds: float | None = None) -> str:
    base = story_skill("free") if duration_seconds is None else (
        "你写的是单镜短剧情，正文为简短、可表演的连续叙事。只写谁做了什么、造成什么结果。"
        "根据指定时长选择能演完的动作：通常 3 至 4 个简短节拍；不足 6 秒只保留 1 至 2 个动作。"
        "默认单场景、最多两个在场角色；用户已有更复杂情节时只截取核心小段，在 notes 说明取舍。"
        "简单扩写只补足动作因果、表演和收尾，不增加支线。用户要求反转时，只加一个由前文动作引出的可见或可听反转；"
        "不靠新身世、奖励制度、神奇道具解释反转，不要求每个故事都反转。"
        "严格保留用户的主体物种、设备与行为：拟人猫仍是猫头猫身的猫，不擅改猫耳少女；手机斗地主不能改电脑斗地主。"
        "不擅自添加姓名、公司部门、品牌、复杂道具、时间跳跃；不写气味、抽象内心、形容词堆叠。"
        "台词可省略；反转通常一句不超过12个汉字，不靠长解释。不编造游戏、平台的转账、赠送、白金卡等功能规则。"
        "不要写分镜、机位、运镜、秒数时间轴或图片提示词。"
        "物件摆放和动作必须物理可演：普通键盘下没有藏整部手机的空间，不让爪子穿过家具；藏手机可放腿上或抽屉。"
        "若两名角色同物种，用明确称呼区分其动作，不让主语混淆。"
        "有对白时必须先在 text 写出说话者及完整台词，dialogue 只逐字复制 text 已出现的台词，不能把结尾关键台词只放进 dialogue。"
        "notes 仅放真实取舍或待确认事实，无则为空数组。"
    )
    style = "" if skill_id == "free" else "\n\n## 题材附加规则\n" + story_skill(skill_id)
    return (
        "你是短剧剧本编剧。必须且只能返回下面这个 JSON 形状：\n"
        '{"story":{"text":"完整剧本文本","dialogue":[{"speaker":"角色称呼","text":"逐字台词"}],'
        '"notes":["待确认事实"]},"warnings":[]}\n'
        "story 只能包含 text、dialogue、notes；dialogue 每项只能包含 speaker、text。"
        "不得使用 title、setting、characters、character、line、ending 等替代字段。"
        "不得返回 Markdown、patch 或 JSON 之外的解释。\n\n"
        + base
        + style
    )


def build_story_user_prompt(request: dict[str, Any]) -> str:
    parts = [
        f"创作灵感：{request.get('inspiration') or '（未提供）'}",
    ]
    if request.get("duration_seconds") is not None:
        parts.append(f"单镜可用时长：{request['duration_seconds']} 秒。控制动作量，写完整的一小段即可。")
    text = str(request.get("text") or "").strip()
    if text:
        parts.append("当前剧本（在此基础上完整重写）：\n" + text)
    if request.get("instruction"):
        parts.append(f"本轮修改意见：{request['instruction']}")
    parts.append("只返回完整 story 文本；不要输出分镜、资产计划或提示词。")
    return "\n\n".join(parts)


def parse_story_result(raw: str | dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    try:
        value = raw if isinstance(raw, dict) else json.loads(str(raw).strip())
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError(f"LLM story 响应不是合法 JSON：{error}") from error
    if not isinstance(value, dict) or set(value) - {"story", "warnings"}:
        raise ValueError("LLM story response must contain only story and warnings")
    story = value.get("story")
    warnings = value.get("warnings", [])
    if not isinstance(warnings, list) or not all(isinstance(item, str) for item in warnings):
        raise ValueError("LLM story response must be {story:object,warnings:string[]}")
    story, shape_warnings = story_payload(story)
    return story, [*warnings, *shape_warnings]


def generate_story(
    request: dict[str, Any],
    generator: Callable[[str, str, int], str | dict[str, Any]] | None = None,
    max_tokens: int = STORY_MAX_TOKENS,
) -> tuple[dict[str, Any], list[str]]:
    system_prompt = build_story_system_prompt(str(request.get("skill_id") or "free"), request.get("duration_seconds"))
    user_prompt = build_story_user_prompt(request)
    raw = (
        generator(system_prompt, user_prompt, max_tokens)
        if generator else complete_json(system_prompt, user_prompt, max_tokens, temperature=0.5)
    )
    return parse_story_result(raw)
