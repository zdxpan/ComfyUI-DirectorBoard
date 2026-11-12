"""Stable, implementation-free capability projection for Director LLM prompts."""
from __future__ import annotations

import copy


AGENT_CAPABILITY_FIELDS = (
    "task_type", "meaning", "use_when", "agent_enabled",
    "required_roles", "allowed_roles", "max_images", "max_videos", "max_audios",
    "duration_source", "frame_policy", "requires_anchor",
    "prompt_structure", "allowed_tag_kinds",
)


def agent_capability_view(capability: dict) -> dict:
    if not isinstance(capability, dict) or not capability.get("task_type"):
        raise ValueError("capability must contain task_type")
    return {
        key: copy.deepcopy(capability[key])
        for key in AGENT_CAPABILITY_FIELDS
        if key in capability
    }


# 给模型看的顺序：从最常用到最专门，避免每次调用顺序漂移。
AGENT_TASK_ORDER = (
    "text_to_video", "image_to_video", "first_last_frame", "reference_video", "audio_driven",
)


def agent_shot_capabilities(provider=None) -> list[dict]:
    """只投影 Agent 可规划的档位，供单镜草稿读取“能跑什么”。"""
    if provider is None:
        from ..minimax_h3_shot import shot_capabilities as provider
    tasks = (provider() or {}).get("task_types") or {}
    entries = [
        agent_capability_view(entry)
        for entry in tasks.values()
        if isinstance(entry, dict) and entry.get("agent_enabled")
    ]
    order = {task: index for index, task in enumerate(AGENT_TASK_ORDER)}
    return sorted(
        entries,
        key=lambda item: (order.get(str(item.get("task_type")), len(order)), str(item.get("task_type"))),
    )
