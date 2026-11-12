"""Thin, layer-local payload checks for the creative assistant.

These only guarantee that an LLM payload has the *shape* the UI expects
(strings where strings belong, lists of {speaker,text} for dialogue). They
deliberately do NOT enforce cross-layer closure, character/scene graphs,
dialogue uniqueness, shot budgets, or any quality rule: those are the user's
call, not the assistant's. The formal `project_json` contract in `model.py`
remains the only hard gate before a shot actually enters the project.
"""
from __future__ import annotations

from typing import Any

from .model import TASK_TYPES

MAX_STORY_CHARS = 6000
MAX_ASSET_ROWS = 50
ASSET_TYPES = ("人物", "场景", "道具")


def _is_dialogue(value: Any) -> bool:
    if not isinstance(value, list):
        return False
    return all(
        isinstance(item, dict)
        and isinstance(item.get("speaker"), str)
        and isinstance(item.get("text"), str)
        for item in value
    )


def _is_string_list(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def string_list(value: Any) -> Any:
    """Accept the common scalar-string LLM variation; preserve other bad shapes for validation."""
    if isinstance(value, str):
        value = value.strip()
        return [value] if value else []
    if value is None:
        return []
    return value


def validate_story(story: Any) -> list[str]:
    """Story is a free-form text block plus an optional dialogue copy list."""
    if not isinstance(story, dict):
        return ["story 必须是对象"]
    errors: list[str] = []
    if not isinstance(story.get("text"), str) or not story.get("text").strip():
        errors.append("story.text 必须是非空字符串")
    if "dialogue" in story and not _is_dialogue(story.get("dialogue")):
        errors.append("story.dialogue 必须是 {speaker,text} 数组")
    if "notes" in story and not _is_string_list(story.get("notes")):
        errors.append("story.notes 必须是字符串数组")
    return errors


def dialogue_list(value: Any) -> list[dict[str, str]]:
    """Normalize the small copy/reference list used by story and one-shot UI."""
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    rows: list[dict[str, str]] = []
    for item in value:
        if isinstance(item, str):
            text = item.strip()
            if text:
                rows.append({"speaker": "", "text": text})
        elif isinstance(item, dict):
            speaker = str(item.get("speaker") or "")
            text = str(item.get("text") or "")
            if speaker.strip() or text.strip():
                rows.append({"speaker": speaker, "text": text})
    return rows


def story_payload(value: Any) -> tuple[dict[str, Any], list[str]]:
    if not isinstance(value, dict):
        raise ValueError("story 必须是对象")
    story = {
        "text": str(value.get("text") or ""),
        "dialogue": dialogue_list(value.get("dialogue") or []),
        "notes": string_list(value.get("notes")),
    }
    errors = validate_story(story)
    if errors:
        raise ValueError("；".join(errors))
    warnings = []
    if len(story["text"]) > MAX_STORY_CHARS:
        warnings.append(f"剧本超过 {MAX_STORY_CHARS} 字，建议按场分批修改；正文未截断")
    return story, warnings


def validate_asset_suggestions(assets: Any) -> list[str]:
    """Each suggested asset needs only the strings a human will edit later."""
    if not isinstance(assets, list):
        return ["assets 必须是数组"]
    errors: list[str] = []
    if len(assets) > MAX_ASSET_ROWS:
        errors.append(f"assets 最多 {MAX_ASSET_ROWS} 条")
    for index, item in enumerate(assets):
        if not isinstance(item, dict):
            errors.append(f"assets[{index}] 必须是对象")
            continue
        unknown = set(item) - {"name", "type", "description", "fixed_features"}
        if unknown:
            errors.append(f"assets[{index}] 含未知字段：{'、'.join(sorted(unknown))}")
        for field in ("name", "type", "description"):
            if not isinstance(item.get(field), str):
                errors.append(f"assets[{index}].{field} 必须是字符串")
        description = item.get("description")
        if isinstance(description, str) and "<asset:" in description.lower():
            errors.append(f"assets[{index}].description 不能包含 <asset:...>")
        if not _is_string_list(item.get("fixed_features")):
            errors.append(f"assets[{index}].fixed_features 必须是字符串数组")
        if isinstance(item.get("type"), str) and item["type"] not in ASSET_TYPES:
            errors.append(f"assets[{index}].type 必须是 人物/场景/道具")
    return errors


def validate_asset_prompt(value: Any) -> list[str]:
    """Single-asset refinement returns only a new non-empty prompt."""
    if not isinstance(value, dict):
        return ["asset_prompt 必须是对象"]
    if not isinstance(value.get("prompt"), str) or not value.get("prompt").strip():
        return ["asset_prompt.prompt 必须是非空字符串"]
    return []


def validate_shot_draft(shot: Any) -> list[str]:
    """One shot at a time: title + editable prompt + optional suggestions."""
    if not isinstance(shot, dict):
        return ["shot 必须是对象"]
    errors: list[str] = []
    for field in ("title", "prompt"):
        if not isinstance(shot.get(field), str):
            errors.append(f"shot.{field} 必须是字符串")
    if "dialogue" in shot and not _is_dialogue(shot.get("dialogue")):
        errors.append("shot.dialogue 必须是 {speaker,text} 数组")
    if "notes" in shot and not _is_string_list(shot.get("notes")):
        errors.append("shot.notes 必须是字符串数组")
    task_type = shot.get("suggested_task_type")
    if task_type not in (None, "") and task_type not in TASK_TYPES:
        errors.append("shot.suggested_task_type 必须是合法任务形态")
    duration = shot.get("suggested_duration_ms")
    if duration not in (None, "") and (
        isinstance(duration, bool) or not isinstance(duration, int) or duration <= 0
    ):
        errors.append("shot.suggested_duration_ms 必须是正整数")
    return errors
