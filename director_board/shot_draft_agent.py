"""Thin single-shot draft target: a short fragment -> one editable prompt."""
from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any, Callable

from .assist_contract import dialogue_list, validate_shot_draft
from .llm_json import complete_json


SHOT_DRAFT_MAX_TOKENS = 4096
_SHOT_DRAFT_SKILLS = {
    "free": "shot-draft-free.md",
    "emotional-drama": "shot-draft-emotional-drama.md",
    "martial-arts": "shot-draft-martial-arts.md",
    "time-lapse": "shot-draft-time-lapse.md",
    "transformation-transition": "shot-draft-transformation-transition.md",
    "ink-xianxia": "shot-draft-ink-xianxia.md",
    "dialogue-performance": "shot-draft-dialogue-performance.md",
}
SHOT_BREAKDOWN_MAX_TOKENS = 4096
_BREAKDOWN_STYLE_RULES = {
    "free": "按叙事动作与空间变化自然拆镜。",
    "emotional-drama": "优先保留情绪转折、反应与人物关系变化；避免为每句台词机械切镜。",
    "action": "按空间位置、攻防阶段与动作因果拆镜；一个攻防阶段可包含同一主体连续且因果明确的动作链。",
    "commerce-host": "按商品卖点、展示动作、口播段落和转化动作拆镜；口播不可切断语义。",
}

def _referenced_asset_catalog(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list): return []
    rows = []
    for item in value:
        if not isinstance(item, dict): continue
        asset_id = str(item.get("asset_id") or "").strip()
        if asset_id:
            rows.append({
                "asset_id": asset_id,
                "name": str(item.get("name") or ""),
                "type": str(item.get("type") or ""),
                "description": str(item.get("description") or ""),
                "fixed_features": [str(feature) for feature in item.get("fixed_features") or [] if isinstance(feature, str)],
            })
    return rows


def _available_asset_catalog(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list): return []
    return [
        {"asset_id": str(item.get("asset_id") or ""), "name": str(item.get("name") or "")}
        for item in value if isinstance(item, dict) and str(item.get("asset_id") or "").strip()
    ]


def extract_story_dialogue(story_text: str) -> list[dict[str, str]]:
    rows = []
    ignored = {
        "类型", "标题", "时长", "资产", "提示词", "时间", "地点", "场景", "镜头", "画面",
        "来电显示", "屏幕显示", "手机显示", "信上写着", "信只写了一行",
    }
    for raw_line in str(story_text or "").splitlines():
        match = re.match(r"^\s*([A-Za-z0-9·\u3400-\u9fff]{1,64})[：:]\s*(.+?)\s*$", raw_line)
        if not match:
            continue
        speaker, text = match.group(1).strip(), match.group(2).strip()
        if speaker not in ignored and text:
            rows.append({"speaker": speaker, "text": text})
    return rows


def minimum_dialogue_duration_ms(dialogue: list[dict[str, str]]) -> int:
    chinese_chars = sum(len(re.findall(r"[\u3400-\u9fff]", item.get("text") or "")) for item in dialogue)
    if not chinese_chars:
        return 0
    return int(math.ceil((chinese_chars / 4 * 1000 + 600) / 100) * 100)


def prepare_shot_draft_request(payload: dict[str, Any], capability_provider=None) -> dict[str, Any]:
    if not isinstance(payload, dict) or payload.get("target") != "shot_draft":
        raise ValueError("shot_draft 请求必须使用 target=shot_draft")
    skill_id = str(payload.get("skill_id") or "free")
    if skill_id not in _SHOT_DRAFT_SKILLS:
        raise ValueError(f"不支持的 shot_draft skill_id: {skill_id}")
    current = payload.get("current") or {}
    context = payload.get("context") or {}
    if not isinstance(current, dict) or not isinstance(context, dict):
        raise ValueError("shot_draft current/context 必须是对象")
    fragment = str(context.get("fragment") or current.get("prompt") or "").strip()
    if not fragment:
        raise ValueError("shot_draft 需要一个分镜片段或简短描述")
    dialogue = dialogue_list(context.get("dialogue") or [])
    return {
        "skill_id": skill_id,
        "current": {
            **current,
            "fragment": fragment,
            "dialogue": dialogue,
        },
        "dialogue": dialogue,
        "instruction": str(payload.get("instruction") or "").strip(),
        "referenced_assets": _referenced_asset_catalog(context.get("referenced_assets")),
        "available_assets": _available_asset_catalog(context.get("available_assets")),
    }


def shot_draft_skill(skill_id: str) -> str:
    filename = _SHOT_DRAFT_SKILLS.get(skill_id)
    if not filename:
        raise ValueError(f"不支持的 shot_draft skill_id: {skill_id}")
    return (Path(__file__).with_name("skills") / filename).read_text(encoding="utf-8").strip()


def build_shot_draft_system_prompt(skill_id: str) -> str:
    base = shot_draft_skill("free")
    style = "" if skill_id == "free" else "\n\n## 本镜附加规则\n" + shot_draft_skill(skill_id)
    return (
        "你是分镜提示词草稿助手，一次只处理一镜。必须返回 JSON 对象："
        '{"shot":{...},"warnings":[]}，不得返回 Markdown、patch 或其它字段。\n\n'
        + base
        + style
    )


def build_shot_draft_user_prompt(request: dict[str, Any]) -> str:
    current = request.get("current") or {}
    parts: list[str] = []
    fragment = str(current.get("fragment") or "").strip()
    prompt = str(current.get("prompt") or "").strip()
    if fragment and fragment != prompt:
        parts.append("本镜原始片段：" + fragment)
    if current.get("title"):
        parts.append("当前标题：" + str(current.get("title")))
    if prompt:
        parts.append("当前提示词草稿（在此基础上优化）：\n" + prompt)
    elif fragment:
        parts.append("本镜内容：" + fragment)
    duration = current.get("suggested_duration_ms")
    if isinstance(duration, int) and not isinstance(duration, bool) and duration > 0:
        parts.append(f"当前时长：{duration}ms（保持不变，只按该时长控制动作密度）")
    dialogue = current.get("dialogue") or []
    if dialogue:
        parts.append("本镜台词：" + json.dumps(dialogue, ensure_ascii=False))
    if request.get("instruction"):
        parts.append(f"修改意见：{request['instruction']}")
    if request.get("referenced_assets"):
        parts.append("当前镜已引用资产（保持其稳定特征）：" + json.dumps(request["referenced_assets"], ensure_ascii=False))
    if request.get("available_assets"):
        parts.append("其它可选资产（需要新增引用时只能使用这些 ID）：" + json.dumps(request["available_assets"], ensure_ascii=False))
    return "\n\n".join(parts)


def parse_shot_draft_result(raw: str | dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    try:
        value = raw if isinstance(raw, dict) else json.loads(str(raw).strip())
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError(f"LLM shot_draft response is not valid JSON: {error}") from error
    if not isinstance(value, dict) or set(value) - {"shot", "warnings"}:
        raise ValueError("LLM shot_draft response must contain only shot and warnings")
    shot = value.get("shot")
    warnings = value.get("warnings", [])
    if not isinstance(warnings, list) or not all(isinstance(item, str) for item in warnings):
        raise ValueError("LLM shot_draft response warnings 必须是字符串数组")
    normalized_shot = {**shot, "notes": [], "suggested_task_type": ""} if isinstance(shot, dict) else shot
    diagnostics = validate_shot_draft(normalized_shot)
    if diagnostics:
        message = "；".join(diagnostics).replace("必须是正整数", "必须是正整数毫秒")
        raise ValueError("shot 未通过契约校验：" + message)
    normalized = {
        "title": normalized_shot.get("title", ""),
        "prompt": normalized_shot.get("prompt", ""),
        "suggested_task_type": "",
        "suggested_duration_ms": normalized_shot.get("suggested_duration_ms") or None,
        "notes": [],
        "asset_refs": [str(item) for item in normalized_shot.get("asset_refs", []) if isinstance(item, str)],
    }
    return normalized, warnings


def generate_shot_draft(
    request: dict[str, Any],
    generator: Callable[[str, str, int], str | dict[str, Any]] | None = None,
    max_tokens: int = SHOT_DRAFT_MAX_TOKENS,
) -> tuple[dict[str, Any], list[str]]:
    system_prompt = build_shot_draft_system_prompt(str(request.get("skill_id") or "free"))
    user_prompt = build_shot_draft_user_prompt(request)
    raw = (
        generator(system_prompt, user_prompt, max_tokens)
        if generator else complete_json(system_prompt, user_prompt, max_tokens)
    )
    shot, warnings = parse_shot_draft_result(raw)
    current_duration = (request.get("current") or {}).get("suggested_duration_ms")
    if isinstance(current_duration, int) and not isinstance(current_duration, bool) and current_duration > 0:
        shot["suggested_duration_ms"] = current_duration
    allowed_assets = {
        item["asset_id"]
        for item in [*(request.get("referenced_assets") or []), *(request.get("available_assets") or [])]
    }
    refs = shot.get("asset_refs") or []
    tokens = [match.group(1).upper() for match in re.finditer(r"<asset:([A-Za-z]\d+)>", shot.get("prompt") or "")]
    if any(ref not in allowed_assets for ref in refs): raise ValueError("shot.asset_refs 含未知资产")
    if set(refs) != set(tokens): raise ValueError("shot.asset_refs 与 prompt token 不一致")
    return shot, warnings

#: 分镜段数的取值范围（与助手 pack 的 clamp_segments 对齐）
BREAKDOWN_SEGMENT_RANGE = (1, 12)


def _segment_count(value: Any) -> int | None:
    """``None`` 表示**自动** —— 由模型按叙事节拍决定，即既有行为。

    用户指定段数时走另一条路：不再让模型自由决定切几刀，而是"恰好切成 N 个"。
    """
    if value is None or value == "" or value == "auto":
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("分镜段数必须是整数，或留空表示自动")
    low, high = BREAKDOWN_SEGMENT_RANGE
    if not low <= value <= high:
        raise ValueError(f"分镜段数必须在 {low} 到 {high} 之间")
    return value


def prepare_shot_breakdown_request(payload: dict[str, Any], capability_provider=None) -> dict[str, Any]:
    if not isinstance(payload, dict) or payload.get("target") != "shot_breakdown":
        raise ValueError("shot_breakdown 请求必须使用 target=shot_breakdown")
    context = payload.get("context") or {}
    story_text = str(context.get("story_text") or "").strip()
    if not story_text:
        raise ValueError("shot_breakdown 需要剧本正文")
    skill_id = str(payload.get("skill_id") or "free")
    if skill_id not in _BREAKDOWN_STYLE_RULES:
        raise ValueError(f"不支持的 shot_breakdown skill_id: {skill_id}")
    dialogue = dialogue_list(context.get("dialogue") or []) or extract_story_dialogue(story_text)
    return {
        "skill_id": skill_id,
        "story_text": story_text,
        "dialogue": dialogue,
        "instruction": str(payload.get("instruction") or "").strip(),
        "segment_count": _segment_count(payload.get("segment_count")),
    }


def _breakdown_layout_text(text: str) -> str:
    """Allow indentation, blank lines, CRLF and horizontal space runs only.

    Keep nonblank line boundaries so layout normalization cannot hide/reassign a
    speaker line. Keep word separators so English dialogue cannot lose spaces.
    """
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    return "\n".join(re.sub(r"[ \t]+", " ", line).strip(" ")
                     for line in lines if line.strip(" \t"))


def _validate_breakdown_fidelity(story: str, shots: list[dict[str, Any]]) -> None:
    source = _breakdown_layout_text(story)
    # Protect only dialogue lines recognized by the existing script contract.
    # Keep occurrence offsets: repeated identical dialogue must stay distinct.
    dialogue_spans = []
    line_cursor = 0
    for line in story.splitlines():
        content = _breakdown_layout_text(line)
        if not content:
            continue
        start = source.find(content, line_cursor)
        end = start + len(content)
        if extract_story_dialogue(line):
            dialogue_spans.append((start, end))
        line_cursor = end
    cursor = 0
    for index, shot in enumerate(shots):
        fragment = _breakdown_layout_text(shot["fragment"])
        if not fragment or not source.startswith(fragment, cursor):
            raise ValueError(f"拆镜原文保真失败：分镜 {index + 1} 未按原文顺序连续复制，存在遗漏、重复或改写")
        cursor += len(fragment)
        if any(start < cursor < end for start, end in dialogue_spans):
            raise ValueError(f"拆镜原文保真失败：分镜 {index + 1} 切断了完整台词")
        # A cut may omit the source's layout separator, never an interior word space.
        if cursor < len(source) and source[cursor] in " \n":
            cursor += 1
    if cursor != len(source):
        raise ValueError("拆镜原文保真失败：片段未完整覆盖剧本正文")


def generate_shot_breakdown(request: dict[str, Any], generator=None, max_tokens=SHOT_BREAKDOWN_MAX_TOKENS):
    system = (
        "你是短剧拆镜助手，只决定原剧本在哪里分镜，不负责重写提示词。"
        "返回 JSON 对象，顶层只能包含 shots 和 warnings。"
        "每个 shot 只能输出 title、fragment、suggested_duration_ms 三个字段。"
        "fragment 必须从原剧本连续、逐字复制，包含该镜动作和完整台词；不得总结、改写、遗漏、重复或新增。"
        "只允许缩进、空行、换行符格式和连续空格或 Tab 的排版差异；保留非空行边界、英文词间空格与所有标点。"
        "不要输出 prompt、dialogue、资产 ID、Binding、H3 标签、task type、notes 或执行参数。"
        "每镜只承载一个叙事意图和主要构图。"
        "这里的主动作指一个叙事意图，不是每个动词单独成镜：同一主体在同一空间、同一构图内连续且因果明确的 1–3 个动作应优先合并，"
        "只在空间或时间跳跃、新人物进入、视觉重点或构图明显变化、关键反应必须独立强调，或动作链超过单镜稳定完成能力时拆镜。"
        "输出前检查相邻镜头：如果可以在不换构图的情况下自然连续演完，就合并为一镜。"
        "台词是不可拆分的原文单位：每句台词必须完整放在一个分镜中，禁止把同一句拆成前后半句分配给不同分镜；"
        "不得遗漏、重复、改写或新增台词。普通换镜必须等上一句完整说完后再切；没有台词就不要编造说话内容。"
        "suggested_duration_ms 必须按这一镜实际动作估算为正整数毫秒；避免机械地把所有镜头默认成同一时长，按内容估算，合理时可以相同。"
        "时长预算：静态信息或物体特写 1500–2500ms；简单动作 2000–3000ms；动作加反应 2500–4000ms；"
        "连续因果动作链 3000–5000ms；建立场景或情绪停留 2500–4000ms；双人短对话 4000–7000ms，过长则拆。"
        "含台词时按中文自然语速每秒约 4 个汉字估算，并为开口前和说完后的反应各留约 300–1000ms。"
        "超过 6000ms 且包含多个视觉重点时优先拆镜。"
        "\n题材拆镜规则：" + _BREAKDOWN_STYLE_RULES[request.get("skill_id") or "free"]
    )
    segment_count = request.get("segment_count")
    if segment_count:
        # 用户指定段数 → 不再让模型自由决定切几刀
        system += (
            f"\n**本次必须恰好分成 {segment_count} 个分镜，不多不少。**"
            "原文保真和完整台词优先，在这些约束内调整切点："
            f"若按叙事节拍自然只能拆出多于或少于 {segment_count} 个，请调整切点凑成 {segment_count} 个；"
            "确实凑不出合理切点时保留合理数量，并在 warnings 里说明原因，不得为凑段数遗漏、重复或切断台词。"
        )
    user = "剧本：\n" + request["story_text"]
    if request.get("instruction"):
        user += "\n\n拆镜意见：" + request["instruction"]
    raw = generator(system, user, max_tokens) if generator else complete_json(system, user, max_tokens)
    value = raw if isinstance(raw, dict) else json.loads(str(raw).strip())
    if not isinstance(value, dict) or set(value) - {"shots", "warnings"}:
        raise ValueError("shot_breakdown response must contain only shots and warnings")
    shots, warnings = value.get("shots"), value.get("warnings", [])
    if not isinstance(shots, list) or not shots or not isinstance(warnings, list):
        raise ValueError("shot_breakdown shots/warnings 无效")
    normalized = []
    normalized_warnings = [str(item) for item in warnings if isinstance(item, str)]
    for index, item in enumerate(shots):
        if not isinstance(item, dict):
            raise ValueError(f"shots[{index}] 必须是对象")
        fragment = str(item.get("fragment") or "").strip()
        dialogue = extract_story_dialogue(fragment)
        duration = item.get("suggested_duration_ms")
        minimum_duration = minimum_dialogue_duration_ms(dialogue)
        if isinstance(duration, int) and not isinstance(duration, bool) and duration > 0 and duration < minimum_duration:
            duration = minimum_duration
            normalized_warnings.append(f"分镜 {index + 1} 的时长已按台词预算调整为 {duration}ms")
        normalized_item = {
            "title": str(item.get("title") or f"分镜 {index + 1}"),
            "prompt": fragment,
            "dialogue": dialogue,
            "notes": [],
            "suggested_task_type": "text_to_video",
            "suggested_duration_ms": duration,
        }
        diagnostics = validate_shot_draft(normalized_item)
        if not isinstance(item.get("fragment"), str) or not item["fragment"].strip():
            diagnostics.append(f"shots[{index}].fragment 必须是非空字符串")
        if isinstance(duration, bool) or not isinstance(duration, int) or duration <= 0:
            diagnostics.append(f"shots[{index}].suggested_duration_ms 必须是正整数毫秒")
        tokens = list(dict.fromkeys(
            match.group(1).upper()
            for match in re.finditer(r"<asset:([A-Za-z]\d+)>", fragment)
        ))
        if diagnostics: raise ValueError("；".join(diagnostics))
        normalized.append({
            "title": normalized_item["title"], "fragment": fragment,
            "dialogue": dialogue, "prompt": fragment,
            "suggested_task_type": "text_to_video",
            "suggested_duration_ms": duration,
            "notes": [],
            "asset_refs": tokens,
        })
    try:
        _validate_breakdown_fidelity(request["story_text"], normalized)
    except ValueError as error:
        error.raw_response = raw
        raise
    wanted = request.get("segment_count")
    if wanted and len(normalized) != wanted:
        normalized_warnings.append(
            f"要求 {wanted} 个分镜，实际拆出 {len(normalized)} 个，请人工调整")
    frozen_dialogue = request.get("dialogue") or []
    candidate_dialogue = [line for shot in normalized for line in shot["dialogue"]]
    if candidate_dialogue != frozen_dialogue:
        normalized_warnings.append("拆镜台词与原台词清单不一致，请人工检查")
    return normalized, list(dict.fromkeys(normalized_warnings))
