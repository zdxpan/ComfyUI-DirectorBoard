"""分镜提示词渲染 + 后检（M1：不跑 GPU 即可验收）。

本模块只回答"怎么把已冻结的一镜说给 H3"，不决定镜头怎么拍、也不改任何
任务形态 / 时长 / 绑定 / 资产。调用方必须传入 `shot_capabilities()` 的 task entry
作为能力事实源，标签（`<Picture N>` / `<Video N>` / `<Audio N>`）
必须由系统算好放进 `slots`，LLM 不得自行编号。

严重级别（M1 warning-first）：

- **硬错**：JSON 解析失败、缺 `prompt`、字段类型不对，或自动结果擅自生成半句跨切 / `<cutoff>`——结果不可用；
- **warning**：提示词结构、标签、台词、镜头语言的所有质量问题——照常返回，由人决定；
- 只有调用方显式打开 `dialogue_lock`（台词锁定）或 `strict`（主动严格预检）时，
  对应的 warning 才升级为硬错。
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any, Callable

from .llm_json import complete_json, configured_model
from .model import TASK_CONTRACTS

LOGGER = logging.getLogger(__name__)

M1_SKILL_FILES = {
    "base-h3": "m1-base-h3.md",
    "emotional-drama": "m1-emotional-drama.md",
    "martial-arts": "m1-martial-arts.md",
    "time-lapse": "m1-time-lapse.md",
    "transformation-transition": "m1-transformation-transition.md",
    "ink-xianxia": "m1-ink-xianxia.md",
    "dialogue-performance": "m1-dialogue-performance.md",
}

DIALOGUE_RULES = """## 台词硬规则（优先级最高）
- 输入有台词时，必须把每一条原文完整、逐字复制进一个 `<d>` 标签；不得翻译、改写、合并、拆分或补写。
- 正例：原文“谁在外面？” → `<d>[Chinese]谁在外面？</d>`。
- 反例：不得写 `<d>[Chinese]Who is outside?</d>`，不得写 `<d>外面是谁？</d>`。
- 自动生成不得把半句台词留给另一次采样；普通内部换镜必须等上一句完整说完后，再按确有切镜需要写 `<scenetrans>`。
- 输入没有台词时，不得写发声源、`<d>`、`<scenetrans>` 或 `<cutoff>`。
- 不得自动生成 `<cutoff>`；悬念截断与半句跨切只保留给用户最终手工编辑。
- 每个发声源使用稳定 `(S1)` / `(S2)` / `(S3)` ID，ID 放在 `<d>` 外；一句台词独立成行。
- 画内人物的画外音必须使用 `says in an off-screen voiceover`，并写明 `while his/her lips remain completely closed.`。
- 旁白是独立发声源，使用稳定声音描述和 ID，并写明 `while nobody on screen is speaking.`，不要为旁白虚构 `<Subject N>`。
- 内心独白沿用画外音机制，可加 `as his/her inner thoughts` 说明意图，并保留唇闭合声明。
- `<scenetrans>` 必须位于两个 `<d>` 之外；`<cutoff>` 只能放在 `<d>` 内并紧贴被截断台词末尾。

"""


def structure_rules(capability: dict[str, Any]) -> str:
    required = FIELDS_BY_STRUCTURE.get(str(capability.get("prompt_structure") or ""), ())
    if not required:
        return ""
    first = required[0]
    fields = "、".join(f"`{field}:`" for field in required)
    return (
        "## 输出格式硬规则（优先级最高）\n"
        f"- 提示词第一行必须且只能以 `{first}:` 开始；禁止先写 `[Shot 1]`、标题、Markdown 或解释。\n"
        f"- 必须按此顺序逐行输出字段：{fields}。\n"
        "- 字段名必须使用小写 snake_case 和半角冒号 `:`，不得加 #、** 或翻译字段名。\n\n"
    )


SHARED_RULES = """## 通用写作规则
- 只描述可见可听的内容，禁止抽象情绪或氛围文学描写。
- 当前 task_type、时长、帧数、Binding、素材映射与 operation 全部已冻结；只改提示词正文。
- 严禁括号权重语法（如 word:1.5）。
- 运镜（摄影机语言）只用：Zoom In/Out、Push In/Pull Out、Pan Left/Right、
  Truck Left/Right、Tilt Up/Down、Arc Shot、Tracking Shot、Static Shot、POV；
  幅度用"小幅/大幅"、速度用"慢速/快速"。
- 说话人用稳定 (S1)/(S2)/... 标识，首次出现时给出足够身份信息；台词放 <d> 标签内，
  逐字保留用户原文，严禁翻译或改写。
- 自动生成不得切断一句台词；普通内部换镜应在上一句完整结束后再使用 <scenetrans>，不得自动生成 <cutoff>。
- 输入没有台词时严禁新增 `<d>`；有台词时每句只能完整出现一次，语言标签不属于台词正文。
- `[Shot 1]` 是本次 clip 内部的第一拍且不写时间戳；后续真实切镜必须写成 `[Shot N] At MM:SS.mmm, 内容`，时间戳递增并落在给定时长内，禁止写 `2.0s-6.0s` 等区间格式。
- 单镜只有一个简单动作时保持一拍；内容包含多个连续动作且能在给定时长内完成时，按时长写成连续、不重叠的 `[Shot N]` 时间段，最后时间点不得超过分镜时长。
- 如果内容、构图变化或动作数量明显超过单镜时长能力，不得擅自删减关键内容或创建新 Shot；在 JSON `warnings` 中加入“建议拆镜”，prompt 仍只输出当前镜可执行内容。
- 屏幕可见文字放在英文双引号内，原文逐字保留。
- overall_soundscape：1–4 句环境音、物理动作音、非语言人声，不重复台词/歌词。
- non_diegetic_music：1–3 句只有观众能听到的 BGM，聚焦乐器/速度/节奏/动态；无则 N/A。
- 只能使用“可用标签”清单中的标签及其系统映射，禁止自行创建、改号或交换素材身份。
- 输出标签统一使用带空格的规范形式，如 `<Subject 1>` / `<Picture 1>`；读取历史内容时系统兼容无空格写法。
- 只输出一份提示词，严禁多份、分隔线、编号选项；严禁用 Markdown 代码块包裹，直接以字段名开头。"""


# task_type → 中文短标签（纯 Python，供 context 构造用；不 import comfy/torch）。
_TASK_LABELS = {task: entry["label"] for task, entry in TASK_CONTRACTS.items()}


FIELDS_BY_STRUCTURE = {
    "three_part": (
        "integrated_multimodal_description", "overall_soundscape", "non_diegetic_music",
    ),
    "six_part": (
        "subject_definitions", "summary", "retention_analysis", "detailed_description",
        "overall_soundscape", "non_diegetic_music",
    ),
}
_VISUAL_FIELDS = {"integrated_multimodal_description", "detailed_description"}


def _writing_guidance(value: Any, shot_id: str) -> dict:
    """可选的参考数据；不改变本镜正文、素材或台词真相。"""
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError("context.guidance 必须是对象")
    allowed = {"previous_shot", "story_background", "visual_direction", "music_direction"}
    if set(value) - allowed:
        raise ValueError("context.guidance 包含未知字段")
    result = {}
    for key, limit in (("story_background", 2000), ("visual_direction", 1000), ("music_direction", 1000)):
        text = value.get(key, "")
        if not isinstance(text, str) or len(text) > limit:
            raise ValueError(f"{key} 必须是至多 {limit} 字符的文本")
        if text.strip(): result[key] = text.strip()
    previous = value.get("previous_shot")
    if previous is not None:
        if not isinstance(previous, dict):
            raise ValueError("previous_shot 必须是对象或 null")
        fields = {}
        for key, limit in (("shot_id", 100), ("title", 200), ("prompt", 12000)):
            text = previous.get(key, "")
            if not isinstance(text, str) or len(text) > limit:
                raise ValueError(f"上一镜 {key} 必须是至多 {limit} 字符的文本")
            fields[key] = text
        if not fields["shot_id"] or fields["shot_id"] == shot_id:
            raise ValueError("上一镜必须引用其他镜头")
        if fields["prompt"].strip(): result["previous_shot"] = fields
    return result


def prepare_shot_prompt_request(
    payload: dict[str, Any],
    align_frames: Callable[[int], int],
    capability_provider: Callable[[], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Freeze and validate one formal Director shot before L4 generation."""
    if not isinstance(payload, dict) or payload.get("target") != "shot_prompt":
        raise ValueError("M1 仅支持 target=shot_prompt")
    current = payload.get("current") or {}
    shot = current.get("shot") if isinstance(current, dict) else None
    context = payload.get("context") or {}
    if not isinstance(shot, dict) or not shot.get("task_type") or not isinstance(context, dict):
        raise ValueError("current.shot 必须是含 task_type 的对象")

    from .model import SOURCE_ROLES, validate_task_roles

    if capability_provider is None:
        from ..minimax_h3_shot import shot_capabilities
        capability_provider = shot_capabilities
    task_type = str(shot["task_type"])
    capability = (capability_provider().get("task_types") or {}).get(task_type)
    if not isinstance(capability, dict):
        raise ValueError(f"不支持的 task_type: {task_type}")
    raw_bindings = context.get("bindings") or []
    if not isinstance(raw_bindings, list) or not all(isinstance(item, dict) for item in raw_bindings):
        raise ValueError("context.bindings 必须是对象数组")
    bindings = sorted(
        raw_bindings,
        key=lambda item: (int(item.get("order") or 0), str(item.get("role") or "")),
    )
    roles = [str(item.get("role") or "") for item in bindings]
    validate_task_roles(task_type, roles)
    role_orders = [(role, int(item.get("order") or 0)) for role, item in zip(roles, bindings)]
    if len(set(role_orders)) != len(role_orders):
        raise ValueError("Binding 的 role/order 组合必须唯一")

    duration_ms = int(shot.get("duration_ms") or 0)
    motion_fps = float(shot.get("motion_fps") or 24)
    if duration_ms <= 0 or motion_fps <= 0:
        raise ValueError("分镜时长和 motion_fps 必须为正数")
    for binding in bindings:
        if binding.get("role") not in SOURCE_ROLES:
            continue
        media_range = binding.get("range_ms")
        if not isinstance(media_range, dict):
            raise ValueError(f"{binding['role']} 需要冻结的 range_ms")
        start = int(media_range.get("start") or 0)
        end = int(media_range.get("end") or 0)
        if end - start != duration_ms:
            raise ValueError(f"{binding['role']} range_ms 长度必须等于分镜时长")
    audio_policy = str(context.get("audio_policy") or "generated")
    if audio_policy == "passthrough" and "source_audio" not in roles:
        audio_policy = "generated"
    writing_mode = payload.get("writing_mode", "standard")
    if writing_mode not in ("standard", "mv"):
        raise ValueError("writing_mode 必须是 standard 或 mv")
    if writing_mode == "mv":
        if task_type != "audio_driven":
            raise ValueError("MV写作需要先选择音频驱动任务并绑定源音频")
        if audio_policy != "passthrough":
            raise ValueError("MV需要将导演台音轨策略设为保留原音频（passthrough）")
        if any(item.get("kind") == "video" or item.get("role") == "reference_video" for item in bindings):
            raise ValueError("MV首版支持音频和图片参考，暂不支持视频参考")
        source = next(item for item in bindings if item.get("role") == "source_audio")
        if source.get("kind") != "audio":
            raise ValueError("MV的源音频 Binding 必须指向音频素材")
        if any(isinstance(source["range_ms"].get(key), bool)
               or not isinstance(source["range_ms"].get(key), int)
               or source["range_ms"][key] < 0 for key in ("start", "end")):
            raise ValueError("MV音频选段必须是非负整数毫秒")
        if not re.fullmatch(r"<Audio\s+\d+>", str(source.get("tag") or "")):
            raise ValueError("MV源音频需要系统提供的 Audio 标签")
    guidance = _writing_guidance(context.get("guidance"), str(shot.get("id") or ""))
    dialogue = context.get("dialogue") or []
    if not isinstance(dialogue, list):
        raise ValueError("context.dialogue 必须是数组")
    skill_id = str(payload.get("skill_id") or "base-h3")
    if skill_id not in M1_SKILL_FILES:
        raise ValueError(f"不支持的 M1 skill_id: {skill_id}")
    return {
        **shot,
        "frames": align_frames(round(duration_ms * motion_fps / 1000)),
        "prompt": str(current.get("prompt") or ""),
        "instruction": str(payload.get("instruction") or ""),
        # 两个开关都只保存在创作工作区，不进入正式 project。
        "dialogue_lock": bool(payload.get("dialogue_lock")),
        "strict": bool(payload.get("strict")),
        "inputs": bindings,
        "slots": [item for item in bindings if item.get("tag")],
        "dialogue": [
            item if isinstance(item, dict) else {"speaker": "", "text": str(item)}
            for item in dialogue
        ],
        "audio_policy": audio_policy,
        "canvas": context.get("canvas") or {},
        "capability": capability,
        "skill_id": skill_id,
        "writing_mode": writing_mode,
        "guidance": guidance,
    }


def template_for(task_type: str, capability: dict[str, Any]) -> str:
    slug = str(capability.get("prompt_template") or "")
    if not re.fullmatch(r"h3-[a-z0-9-]+", slug):
        raise ValueError(f"Unsupported prompt template for task_type {task_type!r}")
    path = Path(__file__).with_name("skills") / f"{slug}.md"
    if not path.is_file():
        raise ValueError(f"Prompt template does not exist for task_type {task_type!r}")
    return (
        f"{structure_rules(capability)}{DIALOGUE_RULES}"
        f"{path.read_text(encoding='utf-8').strip()}\n\n{SHARED_RULES}"
    )


def m1_skill_text(skill_id: str) -> str:
    filename = M1_SKILL_FILES.get(skill_id)
    if not filename:
        raise ValueError(f"不支持的 M1 skill_id: {skill_id}")
    path = Path(__file__).with_name("skills") / filename
    if not path.is_file():
        raise ValueError(f"M1 skill 文件不存在: {filename}")
    return path.read_text(encoding="utf-8").strip()


def build_system_prompt(task_type: str, capability: dict[str, Any], skill_id: str = "base-h3") -> str:
    return (
        "你是一位专业的 MiniMax H3 视频提示词撰写专家。"
        "你的任务是把用户给的冻结分镜信息改写成恰好一份合法的 MiniMax H3 提示词。"
        "必须返回 JSON 对象：{\"prompt\":\"完整提示词\",\"warnings\":[]}，不得返回其他字段。\n\n"
        + template_for(task_type, capability)
        + "\n\n## 本次镜头写作 skill\n"
        + m1_skill_text(skill_id)
    )


def build_shot_prompt_context(shot: dict[str, Any]) -> str:
    task_type = str(shot.get("task_type") or "")
    lines = [
        f"任务形态：{task_type}（{_TASK_LABELS.get(task_type, '未知')}）",
        f"分镜标题：{shot.get('title') or '（未命名）'}",
    ]
    duration_ms = shot.get("duration_ms")
    if isinstance(duration_ms, int) and duration_ms > 0:
        lines.append(f"时长：{duration_ms / 1000:.2f} 秒")
    frames = shot.get("frames")
    if isinstance(frames, int) and frames > 0:
        lines.append(f"对齐后帧数：{frames}")

    if shot.get("operation"):
        lines.append(f"编辑类型（operation）：{shot['operation']}")
    if shot.get("audio_policy"):
        lines.append(f"音频策略：{shot['audio_policy']}")
    canvas = shot.get("canvas") or {}
    if canvas.get("aspect_ratio"):
        lines.append(f"项目画幅：{canvas['aspect_ratio']}")

    inputs = shot.get("inputs") or []
    if inputs:
        lines.append("已冻结输入素材与可用标签（无 tag 表示 keyframe 注入，禁止自行编号）：")
        for item in inputs:
            tag = item.get("tag") or "keyframe"
            subject = item.get("subject_tag") or ""
            mapping = f"{subject} = {tag}" if subject else tag
            media_range = item.get("range_ms")
            range_text = (
                f" / range={media_range.get('start')}..{media_range.get('end')}ms"
                if isinstance(media_range, dict) else ""
            )
            lines.append(
                f"  {mapping} / role={item.get('role')} / order={item.get('order', 0)}"
                f"{range_text} → {item.get('name') or '未命名'}（{item.get('description') or '无描述'}）"
            )
    else:
        lines.append("已冻结输入素材与可用标签：（本档无参考素材，不得出现任何引用标签）")

    dialogue = shot.get("dialogue") or []
    if dialogue:
        lines.append("台词逐字复制清单（只能逐字使用以下每句；不得翻译、改写、合并或补写）：")
        for index, line in enumerate(dialogue, 1):
            speaker = line.get("speaker") or ""
            text = line.get("text") or ""
            lines.append(f"  {index}. 说话人={speaker or '未标注'}；原文={text}")

    if shot.get("prompt"):
        lines.append(f"当前提示词（在此基础上优化）：\n{shot['prompt']}")
    if shot.get("instruction"):
        lines.append(f"修改意见：{shot['instruction']}")
    return "\n".join(lines)


_TAG_RE = re.compile(r"<(Picture|Video|Audio|Subject)\s*(\d+)\s*>", re.IGNORECASE)
_OPERATION_TERMS = {
    "edit": ("视频编辑", "edit"), "style_transfer": ("风格转换", "style transfer"),
    "character_replace": ("角色替换", "character replace"),
    "scene_replace": ("场景替换", "scene replace"),
    "outfit_replace": ("服装替换", "outfit replace"),
}


def parse_prompt_fields(
    prompt: str, capability: dict[str, Any]
) -> tuple[dict[str, str], list[str]]:
    structure = str(capability.get("prompt_structure") or "")
    required = FIELDS_BY_STRUCTURE.get(structure)
    if not required:
        return {}, [f"未知提示词结构：{structure or '未提供'}"]
    header = re.compile(
        rf"(?mi)^\s*(?:#{{1,6}}\s*)?(?:\*\*\s*)?"
        rf"({'|'.join(re.escape(field) for field in required)})"
        rf"(?:\s*\*\*)?\s*[:：]\s*"
    )
    matches = list(header.finditer(prompt or ""))
    found = [match.group(1).lower() for match in matches]
    warnings: list[str] = []
    for field in required:
        count = found.count(field)
        if count == 0:
            warnings.append(f"缺少必填字段 {field}:")
        elif count > 1:
            warnings.append(f"必填字段 {field}: 重复出现 {count} 次")
    ordered_unique = [field for index, field in enumerate(found) if field not in found[:index]]
    expected_present = [field for field in required if field in found]
    if ordered_unique != expected_present:
        warnings.append("提示词字段顺序不符合当前 task_type 模板")
    fields: dict[str, str] = {}
    for index, match in enumerate(matches):
        field = match.group(1).lower()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(prompt or "")
        body = (prompt or "")[match.end():end].strip()
        fields.setdefault(field, body)
    for field in required:
        body = fields.get(field, "")
        if not body:
            warnings.append(f"必填字段 {field}: 内容为空")
        elif field in _VISUAL_FIELDS and body.upper() == "N/A":
            warnings.append(f"视觉字段 {field}: 不允许写 N/A")
    return fields, warnings


def check_prompt_structure(
    task_type: str, prompt: str, capability: dict[str, Any]
) -> list[str]:
    del task_type  # task-specific structure is projected by capability.
    return parse_prompt_fields(prompt, capability)[1]


_SHOT_HEADER_RE = re.compile(
    r"\[Shot\s+(\d+)\](?:\s+At\s+(\d{2}):(\d{2})\.(\d{3}),)?",
    re.IGNORECASE,
)


def check_shot_timestamps(prompt: str, duration_ms: int | None = None) -> list[str]:
    """Keep H3 internal-cut syntax visible as warnings instead of rejecting a candidate."""
    warnings: list[str] = []
    previous_ms = -1
    for match in _SHOT_HEADER_RE.finditer(prompt or ""):
        number = int(match.group(1))
        has_timestamp = match.group(2) is not None
        if number == 1:
            if has_timestamp:
                warnings.append("[Shot 1] 不应写时间戳")
            continue
        if not has_timestamp:
            warnings.append(
                f"[Shot {number}] 必须使用 `At MM:SS.mmm,` 时间戳，不能使用秒数区间或省略时间"
            )
            continue
        timestamp_ms = (
            int(match.group(2)) * 60_000
            + int(match.group(3)) * 1000
            + int(match.group(4))
        )
        if timestamp_ms <= previous_ms:
            warnings.append(f"[Shot {number}] 时间戳必须严格递增")
        if isinstance(duration_ms, int) and duration_ms > 0 and timestamp_ms >= duration_ms:
            warnings.append(f"[Shot {number}] 时间戳必须早于当前分镜结束时间")
        previous_ms = timestamp_ms
    return warnings


def check_prompt_tags(
    task_type: str,
    prompt: str,
    slots: list[dict[str, Any]],
    capability: dict[str, Any],
) -> list[str]:
    allowed = {
        str(tag).lower()
        for slot in slots
        for tag in (slot.get("tag"), slot.get("subject_tag"))
        if tag
    }
    used = _TAG_RE.findall(prompt or "")
    warnings: list[str] = []
    allowed_kinds = {str(kind).lower() for kind in (capability.get("allowed_tag_kinds") or [])}
    if not allowed_kinds:
        if used:
            warnings.append(
                f"{task_type} 不写引用标签，但提示词出现了 "
                + "、".join(f"<{kind} {num}>" for kind, num in used)
            )
        return warnings
    for kind, num in used:
        tag = f"<{kind} {num}>"
        if kind.lower() not in allowed_kinds:
            warnings.append(f"{task_type} 不允许使用 {kind} 标签")
            continue
        if tag.lower() not in allowed:
            warnings.append(f"失效标签 {tag}：引用了系统未提供的参考槽位")
    used_tags = {f"<{kind.title()} {num}>".lower() for kind, num in used}
    for slot in slots:
        for field in ("tag", "subject_tag"):
            tag = str(slot.get(field) or "")
            if tag and tag.lower() not in used_tags:
                warnings.append(f"绑定标签 {tag} 未出现在提示词中")
    return warnings


def check_subject_definitions(
    task_type: str,
    prompt: str,
    slots: list[dict[str, Any]],
    capability: dict[str, Any],
) -> list[str]:
    del task_type
    if capability.get("prompt_structure") != "six_part":
        return []
    header = lambda field: (
        rf"^\s*(?:#{{1,6}}\s*)?(?:\*\*\s*)?{re.escape(field)}(?:\s*\*\*)?\s*[:：]\s*"
    )
    match = re.search(
        rf"(?ims){header('subject_definitions')}(.*?){header('summary')}",
        prompt or "",
    )
    block = match.group(1) if match else ""
    defined_tags = {
        f"<{kind.title()} {number}>".lower()
        for kind, number in _TAG_RE.findall(block)
    }
    warnings: list[str] = []
    for slot in slots:
        tag = str(slot.get("tag") or "")
        subject_tag = str(slot.get("subject_tag") or "")
        name = str(slot.get("name") or "").strip()
        if tag and tag.lower() not in defined_tags:
            warnings.append(f"{tag} 未在 subject_definitions 中声明")
        if subject_tag and subject_tag.lower() not in defined_tags:
            warnings.append(f"{subject_tag} 未在 subject_definitions 中声明")
        if name and name not in block:
            warnings.append(f"素材名称「{name}」未在 subject_definitions 中声明")
    return warnings


_DIALOGUE_TAG_RE = re.compile(
    r"<d>\s*(?:\[[^\]]+\])?\s*([\s\S]*?)</d>", re.IGNORECASE
)


def _dialogue_units(prompt: str) -> list[str]:
    """Return authored lines, joining only fragments separated by `<scenetrans>`."""
    matches = list(_DIALOGUE_TAG_RE.finditer(prompt or ""))
    units: list[str] = []
    current = ""
    for index, match in enumerate(matches):
        text = re.sub(r"\s*<cutoff>\s*$", "", match.group(1).strip(), flags=re.IGNORECASE)
        current += text
        if index + 1 < len(matches):
            between = (prompt or "")[match.end():matches[index + 1].start()]
            if re.search(r"<scenetrans>", between, re.IGNORECASE) and re.search(
                r"carries\s+over\s+from\s+the\s+previous\s+shot|continues\s+saying",
                between,
                re.IGNORECASE,
            ):
                continue
        units.append(current)
        current = ""
    if current:
        units.append(current)
    return units


def check_dialogue_verbatim(prompt: str, dialogue: list[dict[str, Any]]) -> list[str]:
    warnings: list[str] = []
    authored = _dialogue_units(prompt)
    expected = [str(line.get("text") or "") for line in dialogue or [] if line.get("text")]
    for line in dialogue or []:
        text = str(line.get("text") or "")
        if not text:
            continue
        occurrences = authored.count(text)
        if occurrences == 0:
            warnings.append(f"台词缺失：「{text}」未逐字出现在 <d> 标签里")
        elif occurrences > 1:
            warnings.append(f"台词重复：「{text}」在 <d> 标签里出现了 {occurrences} 次")
    for text in authored:
        if text and text not in expected:
            warnings.append(f"新增台词：「{text}」不在冻结的当前分镜台词中")
    return warnings


def check_automatic_dialogue_controls(
    prompt: str, dialogue: list[dict[str, Any]] | None = None,
) -> list[str]:
    """Reject advanced dialogue controls that are reserved for final manual editing."""
    text = prompt or ""
    warnings: list[str] = []
    if re.search(r"<cutoff>", text, re.IGNORECASE):
        warnings.append("自动生成不得使用 <cutoff>；如需悬念截断，请在最终提示词中手工添加")
    matches = list(_DIALOGUE_TAG_RE.finditer(text))
    expected = {str(line.get("text") or "") for line in dialogue or [] if line.get("text")}
    for index, match in enumerate(matches[:-1]):
        between = text[match.end():matches[index + 1].start()]
        if not re.search(r"<scenetrans>", between, re.IGNORECASE):
            continue
        current_text = re.sub(r"\s*<cutoff>\s*$", "", match.group(1).strip(), flags=re.IGNORECASE)
        next_text = re.sub(
            r"\s*<cutoff>\s*$", "", matches[index + 1].group(1).strip(), flags=re.IGNORECASE,
        )
        continuity_phrase = re.search(
            r"carries\s+over\s+from\s+the\s+previous\s+shot|continues\s+saying",
            between, re.IGNORECASE,
        )
        if continuity_phrase or current_text not in expected or next_text not in expected:
            warnings.append("自动生成不得把一句台词跨切成前后两段；请让本镜完整说完")
            break
    return warnings


def check_dialogue_syntax(
    prompt: str, dialogue: list[dict[str, Any]] | None = None,
) -> list[str]:
    """Validate the small, deterministic H3 dialogue surface without interpreting prose."""
    text = prompt or ""
    warnings: list[str] = []
    if dialogue is not None and not dialogue and re.search(
        r"<d>|<scenetrans>|<cutoff>|\(S\d+(?:\s*,\s*S\d+)*\)\s*(?:says|shouts?|sings?)",
        text,
        re.IGNORECASE,
    ):
        warnings.append("无台词镜头不得自动添加发声源、<d>、<scenetrans> 或 <cutoff>")
    matches = list(_DIALOGUE_TAG_RE.finditer(text))
    for match in matches:
        line_start = text.rfind("\n", 0, match.start()) + 1
        line_end = text.find("\n", match.end())
        if line_end < 0:
            line_end = len(text)
        line = text[line_start:line_end]
        prefix = text[line_start:match.start()]
        if not re.search(r"\(S\d+(?:\s*,\s*S\d+)*\)", prefix, re.IGNORECASE):
            warnings.append("台词缺少放在 <d> 外的稳定发声源 ID，例如 (S1)")
        if "\n" in match.group(0) or len(_DIALOGUE_TAG_RE.findall(line)) > 1:
            warnings.append("每句台词必须使用一个 <d> 并独立成行")
        exact_voiceover = re.search(r"says\s+in\s+an\s+off-screen\s+voiceover", line, re.IGNORECASE)
        mentions_voiceover = re.search(r"off-screen\s+voiceover", line, re.IGNORECASE)
        narrator = re.search(r"旁白|narrator", line, re.IGNORECASE)
        inner_thought = re.search(r"内心|心声|inner\s+thoughts?", line, re.IGNORECASE)
        if (mentions_voiceover or narrator or inner_thought) and not exact_voiceover:
            warnings.append("画外音、旁白和内心独白必须使用 says in an off-screen voiceover")
        if narrator:
            if not re.search(r"while\s+nobody\s+on\s+screen\s+is\s+speaking", line, re.IGNORECASE):
                warnings.append("旁白必须声明 while nobody on screen is speaking")
            if re.search(r"<Subject\s*\d+\s*>", line, re.IGNORECASE):
                warnings.append("旁白是独立发声源，不得绑定 <Subject N>")
        elif exact_voiceover and not re.search(
            r"while\s+(?:his|her|their)\s+lips\s+remain\s+completely\s+closed",
            line,
            re.IGNORECASE,
        ):
            warnings.append("人物画外音必须声明嘴唇完全闭合")
        if inner_thought and not re.search(
            r"as\s+(?:his|her|their)\s+inner\s+thoughts", line, re.IGNORECASE,
        ):
            warnings.append("内心独白必须使用 as his/her inner thoughts 说明意图")

    dialogue_ranges = [(match.start(), match.end(), match.group(1)) for match in matches]
    for tag in re.finditer(r"<(scenetrans|cutoff)>", text, re.IGNORECASE):
        inside = next((item for item in dialogue_ranges if item[0] < tag.start() < item[1]), None)
        kind = tag.group(1).lower()
        if kind == "scenetrans" and inside:
            warnings.append("<scenetrans> 必须放在两个 <d> 之外")
        elif kind == "cutoff":
            if not inside:
                warnings.append("<cutoff> 必须放在 <d> 内并紧贴台词末尾")
            elif not re.search(r"<cutoff>\s*$", inside[2], re.IGNORECASE):
                warnings.append("<cutoff> 必须紧贴 <d> 内台词末尾")
            elif inside != dialogue_ranges[-1]:
                warnings.append("<cutoff> 只能出现在本段视频的最后一句台词")
    return list(dict.fromkeys(warnings))


def check_dialogue_budget(dialogue: list[dict[str, Any]], duration_ms: int | None) -> list[str]:
    """Warn when frozen Chinese dialogue clearly exceeds the clip's speaking budget."""
    if not isinstance(duration_ms, int) or duration_ms <= 0:
        return []
    chinese_chars = sum(
        len(re.findall(r"[\u3400-\u9fff]", str(line.get("text") or "")))
        for line in dialogue or []
    )
    budget = duration_ms / 1000 * 4.5
    if chinese_chars <= budget:
        return []
    return [
        f"台词时长预算不足：约 {chinese_chars} 个汉字，{duration_ms / 1000:.1f} 秒按 4.5 字/秒约容纳 {budget:.0f} 字；建议延长时长、缩短台词或拆镜"
    ]


def check_operation_semantics(prompt: str, operation: str | None) -> list[str]:
    text = (prompt or "").lower()
    if operation and not any(term.lower() in text for term in _OPERATION_TERMS.get(str(operation), (str(operation),))):
        return [f"编辑类型「{operation}」未在提示词里体现"]
    return []


def validate_shot_prompt(
    task_type: str,
    prompt: str,
    slots: list[dict[str, Any]],
    dialogue: list[dict[str, Any]],
    operation: str | None = None,
    capability: dict[str, Any] | None = None,
    duration_ms: int | None = None,
) -> list[str]:
    capability = capability or {}
    fields, structure_warnings = parse_prompt_fields(prompt, capability)
    visual_prompt = fields.get("integrated_multimodal_description") or fields.get("detailed_description") or ""
    warnings: list[str] = []
    warnings += structure_warnings
    warnings += check_shot_timestamps(visual_prompt, duration_ms)
    warnings += check_prompt_tags(task_type, prompt, slots, capability)
    warnings += check_subject_definitions(task_type, prompt, slots, capability)
    warnings += check_dialogue_verbatim(prompt, dialogue)
    warnings += check_dialogue_syntax(prompt, dialogue)
    warnings += check_dialogue_budget(dialogue, duration_ms)
    warnings += check_operation_semantics(visual_prompt, operation)
    return warnings


def _parse_model_result(raw: str | dict[str, Any]) -> tuple[str, list[str]]:
    try:
        value = raw if isinstance(raw, dict) else json.loads(str(raw).strip())
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError(f"LLM response is not valid JSON: {error}") from error
    if not isinstance(value, dict):
        raise ValueError("LLM response must be a JSON object")
    if set(value) - {"prompt", "warnings"}:
        raise ValueError("LLM response contains unsupported fields")
    prompt = value.get("prompt")
    warnings = value.get("warnings", [])
    if not isinstance(prompt, str) or not prompt.strip() or not isinstance(warnings, list) or not all(isinstance(item, str) for item in warnings):
        raise ValueError("LLM response must be {prompt:string,warnings:string[]}")
    return prompt.strip(), warnings


def _use_new_path() -> bool:
    """正式写作是否走新路径。**读开关失败就当关掉** —— 开关不能变成故障源。

    这里只保"读开关"这一段。新路径**执行中**的失败不归它管：
    那要分"付费前 / 付费后"处理，见 `generate_shot_prompt`。
    """
    try:
        from .assistant_bridge import use_new_path
        return bool(use_new_path())
    except Exception:                                        # noqa: BLE001
        return False


#: 旧路径 JSON 输出的历史上限。新路径不用它，见 `_via_assistant`。
OLD_PATH_MAX_TOKENS = 4096


def _via_assistant(shot: dict[str, Any], *, max_tokens: int | None = None,
                   execution: dict | None = None) -> tuple[str, list[str]]:
    """**新路径**：看图 → 渲染南风规范 → 调用 → 转回导演台的单条 prompt。

    与旧路径的区别只在"提示词从哪来"与"输出怎么解析"：
    后检（`validate_shot_prompt` 等）与调用方完全不变。

    返回值第二项是**过程说明**（看图跳过、资产描述未进提示词、素材名是用户标签…），
    它取代旧路径的"模型自报 warnings" —— 南风的纯文本协议没有 warnings 字段，
    但这些说明必须让用户看见，否则冲突又变成静默的了。

    抛 ``NewPathUnavailable`` 表示**还没花钱**就跑不通了（缺依赖 / 缺凭据 / 渲染失败），
    调用方可以安全退回旧路径。**调用之后**的失败不归这一类：那时钱已经付了，
    退回重跑是双重付费，所以超时、空正文一律硬抛。

    `max_tokens` 是旧路径 JSON 输出的历史参数，**不用于夹取新路径**：
    pack 的预算（1 段 6000、6 段 15000）是写满六段结构所必需的，
    被 4096 这种旧默认值一夹就必然截断。

    只有调用方**显式**传了一个小于预算的值才会报出来（``max_tokens=None`` 表示没传）——
    否则每一条默认请求都会挂一条无意义的说明。
    """
    from . import assistant_bridge as bridge

    reason = bridge.new_path_rejection(shot)
    if reason:
        raise bridge.NewPathUnavailable(reason)
    spec = bridge.text_spec()
    if spec is None:
        raise bridge.NewPathUnavailable("没有写作凭据")
    # 先验证装配，再做可能收费的工作。模型配置在本次请求内保持一致。
    pack_id, data, notes = bridge.to_storyboard_input(shot)
    bridge.build_messages(shot)
    budget = bridge.output_budget(pack_id, data.segment_count)
    try:
        facts, vision_notes = bridge.analyze_shot(shot, allow_calls=True)
        messages, notes = bridge.build_messages(shot, facts=facts)
        raw = bridge.text_call(messages, budget, spec=spec)
    except bridge.NewPathUnavailable as exc:
        raise RuntimeError(f"新写作执行失败，未重试旧路径：{exc}") from exc
    if execution is not None:
        execution.update(model=spec.model, generation_path="assistant")
    if max_tokens is not None and max_tokens < budget:
        notes = [*notes,
                 f"max_tokens={max_tokens} 低于该 pack 的输出预算 {budget}，"
                 f"新路径按预算走（旧路径的 4096 默认值夹不住六段结构）"]
    prompt = bridge.as_single_prompt(raw, data.segment_count)
    if not prompt.strip():
        # 已经付过钱了：报硬错，绝不静默退回再付一次。
        raise ValueError("写作模型返回为空，未生成提示词")
    return prompt, [*vision_notes, *notes]


def generate_shot_prompt(
    shot: dict[str, Any],
    max_tokens: int | None = None,
    generator=None,
    dialogue_lock: bool | None = None,
    strict: bool | None = None,
    execution: dict | None = None,
) -> tuple[str, list[str]]:
    """返回 (提示词, warnings)；只有硬错才抛 ValueError。

    `dialogue_lock`：台词锁定，台词缺失 / 改写 / 新增升级为硬错。
    `strict`：主动严格预检，所有质量提醒升级为硬错。
    两者为 None 时读 shot 上由 `prepare_shot_prompt_request()` 冻结的请求开关。

    `max_tokens` 只管**旧路径**（JSON 输出），``None`` 表示用历史上的 4096。
    新路径的输出上限由 pack 的预算公式决定，不夹取 —— 详见 `_via_assistant`。

    新路径若在**付费调用之前**跑不通（缺依赖 / 缺凭据 / 渲染失败），退回旧路径，
    并在 warnings 里留一条说明；调用之后的失败不退回，避免双重付费。
    """
    task_type = str(shot.get("task_type") or "")
    capability = shot.get("capability") or {}
    if dialogue_lock is None:
        dialogue_lock = bool(shot.get("dialogue_lock"))
    if strict is None:
        strict = bool(shot.get("strict"))
    from . import assistant_bridge as bridge
    if bridge.shadow_enabled():
        bridge.shadow(shot,
                      build_system_prompt(task_type, capability, str(shot.get("skill_id") or "base-h3")),
                      build_shot_prompt_context(shot))
    # 走哪条路：注入了 generator 就是测试/调用方要旧路径；否则看开关。
    prompt: str | None = None
    model_warnings: list[str] = []
    fallback_note = ""
    has_guidance = bool(shot.get("guidance")) or shot.get("writing_mode") == "mv"
    if generator is None and has_guidance and not _use_new_path():
        raise ValueError("背景/创作指导与MV需要新写作路径；本次未发起模型调用")
    if generator is None and _use_new_path():
        try:
            prompt, model_warnings = _via_assistant(shot, max_tokens=max_tokens, execution=execution)
        except bridge.NewPathUnavailable as exc:
            if has_guidance:
                raise ValueError(f"新写作路径不可用，未忽略指导或降级调用：{exc}") from exc
            # 只吞这一类：到此为止一分钱没花，退回旧路径是安全的。
            # 其它异常（含 ValueError 硬错）照旧往上抛 —— 吞掉会让后检失效。
            LOGGER.warning("新写作路径不可用，退回旧路径：%s: %s", type(exc).__name__, exc)
            fallback_note = f"新写作路径不可用，已退回旧路径（{exc}）"
    if prompt is None:
        system_prompt = build_system_prompt(task_type, capability, str(shot.get("skill_id") or "base-h3"))
        user_prompt = build_shot_prompt_context(shot)
        old_max_tokens = OLD_PATH_MAX_TOKENS if max_tokens is None else max_tokens
        if generator is None:
            bridge._ensure_llm_env()
        model = configured_model()
        raw = (
            generator(system_prompt, user_prompt, old_max_tokens)
            if generator else complete_json(system_prompt, user_prompt, old_max_tokens, model=model)
        )
        if execution is not None:
            execution.update(model=model, generation_path="old")
        prompt, model_warnings = _parse_model_result(raw)
        if fallback_note:
            # 退回不能是静默的 —— 否则用户永远不知道自己用的是哪条路。
            model_warnings = [fallback_note, *model_warnings]
    warnings = validate_shot_prompt(
        task_type,
        prompt,
        shot.get("slots") or [],
        shot.get("dialogue") or [],
        shot.get("operation"),
        capability,
        shot.get("duration_ms"),
    )
    blockers = check_automatic_dialogue_controls(prompt, shot.get("dialogue") or [])
    if dialogue_lock:
        blockers.extend(check_dialogue_verbatim(prompt, shot.get("dialogue") or []))
    if strict:
        blockers = [*blockers, *warnings]
    if blockers:
        raise ValueError("；".join(dict.fromkeys(blockers)))
    return prompt, [*model_warnings, *warnings]
