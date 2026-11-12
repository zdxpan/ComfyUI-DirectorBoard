"""Static picture candidates for the single-shot creation assistant."""
from __future__ import annotations

import json
import re
from typing import Any, Callable

from .llm_json import complete_json

_TYPES = ("人物", "场景", "道具", "关键帧")
_DEFAULT_COUNTS = {"frame": 2, "asset": 3, "sequence": 3}


def _text(value: Any, label: str, limit: int, required: bool = False) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label}必须是文字")
    value = value.strip()
    if (required and not value) or len(value) > limit:
        raise ValueError(f"{label}不能为空且不能超过 {limit} 字" if required else f"{label}不能超过 {limit} 字")
    return value


def prepare_picture_plan_request(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict) or payload.get("target") != "picture_plan":
        raise ValueError("画面构思请求必须使用 target=picture_plan")
    if payload.get("skill_id", "free") != "free":
        raise ValueError("不支持的 picture_plan skill_id")
    context = payload.get("context", {})
    if not isinstance(context, dict):
        raise ValueError("context 必须是对象")
    kind = payload.get("kind", "frame")
    if not isinstance(kind, str) or kind not in _DEFAULT_COUNTS:
        raise ValueError("kind 必须是 frame/asset/sequence")
    count = payload.get("count", _DEFAULT_COUNTS[kind])
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= 6:
        raise ValueError("候选数量必须是 1 到 6 的整数")
    idea = _text(context.get("idea_text", ""), "想法", 12000)
    instruction = _text(payload.get("instruction", ""), "补充要求", 4000)
    if not idea and not instruction:
        raise ValueError("请先写下想法或剧情")
    mode = context.get("mode", "text")
    if mode not in ("text", "edit"):
        raise ValueError("mode 必须是 text/edit")
    assets = context.get("assets", [])
    if not isinstance(assets, list) or len(assets) > 2:
        raise ValueError("参考素材最多 2 项")
    prepared_assets = []
    roles = set()
    for asset in assets:
        if not isinstance(asset, dict) or asset.get("type") not in _TYPES:
            raise ValueError("参考素材必须有合法类型")
        role = asset.get("input_role", "")
        if role not in ("", "init_image", "reference_image") or (role and role in roles):
            raise ValueError("参考素材图像槽位无效或重复")
        if role:
            roles.add(role)
        prepared_assets.append({
            "name": _text(asset.get("name", ""), "素材名称", 80, True),
            "type": asset["type"],
            "description": _text(asset.get("description", ""), "素材描述", 4000),
            "input_role": role,
        })
    if mode == "edit" and not roles:
        raise ValueError("改图构思需要实际绑定的图片槽位")
    return {"kind": kind, "count": count, "idea_text": idea, "instruction": instruction,
            "mode": mode, "assets": prepared_assets}


def build_picture_plan_system_prompt(request: dict[str, Any]) -> str:
    task = {
        "frame": "给出同一想法的完整静态画面候选；候选可改变构图，不改变角色身份和画风。type 必须是关键帧。",
        "asset": "从想法或剧情提取实际需要的人物、场景或道具，每项 type 只能是人物、场景或道具。"
                 "数量是上限，不为凑数生成同一角色的多种互斥外观。人物写可跨镜复用的识别特征：物种、头身比例、体型、毛色或肤色、"
                 "发型、稳定服装及少量识别标记；未定细节只选择一个明确版本，不列或者选项。"
                 "对拟人动物，拟人只表示直立、穿衣和行为，不等于换成人体：明确完整动物头、毛茸茸的四肢与爪足、尾巴、"
                 "自然动物体型的直立适配，不写正常成年人比例，不出现裸露人手、人脚或猫头拼接真人躯干。"
                 "人物不含本镜动作、情绪、所在工位或故事过程；给出中性站姿、完整主体和简洁背景，便于后续改图。"
                 "场景资产使用环境空镜：提示词开头明确空无一人的空间、所有座椅空置，只展示建筑和物件；"
                 # 这张空场景会被当原图去改图，机位一旦是全景，后面的关键帧就永远是全景 ——
                 # 实测三张关键帧都成了"整间办公室 + 猫占 1/4"，文字里的中近景根本压不住原图机位。
                 "取景必须按后续主体的机位出，不要出整间办公室的大全景：写清机位高度、景别（中近景或近景）"
                 "和主体在画面中的占比，让工位桌沿、椅背或挡板占据前景，远处办公区只作虚化背景；"
                 "写空间布局、主要固定物件、人物活动通道、统一时间光线，不把剧情人物或忙碌员工固化进空场景。"
                 "道具写形状、材质、颜色与用途，不依赖可读的小字。",
        "sequence": "按情节顺序挑选有叙事价值的静态画面，type 必须是关键帧；每张只是一瞬间可按下快门的状态。"
                    "不能把抬手、藏手机、回头等多个连续动作塞进一张图。把反应写成可见姿势、视线和表情，声音或气味不写入图。"
                    "例如不要写听见脚步声快速把手机塞进文件堆；改为手机半露在文件堆下，一只爪压住文件，双耳后贴，视线朝过道。"
                    "不要写正在、快速、突然、听见等时间过程词；输出前逐条把过程改成结果姿势。"
                    # 光写"可见姿势"不够：实测生成出"耳尖放松、平静看手机"，把剧情里的心虚写没了。
                    "每张除了姿势结果和视线落点，还要写出表达这一瞬情绪的身体细节：耳朵朝向、肩颈松紧、"
                    "尾巴状态、手指力度；不要用放松、平静、自然、微笑这类词描述主角，除非这一帧本身"
                    "就是收尾的松弛瞬间。"
                    "各帧角色外观、服装、设备、工位布局、时间光线和画风必须一致；不用新增道具填充画面。",
    }[request["kind"]]
    edit = request.get("mode") == "edit" and request["kind"] != "asset"
    output_rule = (
        "本次输出改图指令。只有素材 input_role 标明的图片会传给图像模型；init_image 称为原图，reference_image 称为参考图。"
        "角色图可能是原图也可能是参考图，按素材type和input_role判断，不能假定原图一定是角色；"
        "用明确的保留与修改指令，保留角色图的物种、毛色、体型和服装，采用场景图的空间、光线和透视。"
        "每条指令都是独立的一次改图，始终收到同样的原图/参考图，并没有前一帧结果；"
        "禁止写上一帧、前一帧、前两帧、同上、原有画面，必须每条都根据素材input_role明确使用哪张图的角色、哪张图的场景。"
        "面向用户的prompt只用原图/参考图称呼，不输出init_image或reference_image字段名。"
        "说明最终坐或站的姿态、物件关系、视线、景别与主体占画面大小，以及光照和透视融合。"
        "主角应清晰可辨，不缩成远处小人；允许围绕同一场景重新取景，不必复制参考图的全景机位。"
        "当叙事动作集中在脸和手时，优先侧前方中近景，胸部以上入画，让桌沿遮住下半身，省去无关全身姿态；"
        "工位坐姿明确坐在椅面、身体位于桌子后方，不能坐桌面、站在过道或穿过椅背。"
        "不要把角色身份重新设计，也不要复制完整外观长文。"
        "没提供第二个角色的图时，优先选择仅含主角的可成立画面，用画外视线表达对方；确需新增角色则给清晰不同外观，不能复制主角当另一个人。"
        "没有对应槽位时不提那张图。素材描述是文字设定，不等于看过图片；不得声称识别了图片细节。"
        if edit else
        "本次输出可独立文生图的提示词。必要外观和场景须在每条完整写明，不能只写同上、同一角色或参考图。"
    )
    example_type = "人物" if request["kind"] == "asset" else "关键帧"
    return (
        "你是把故事转为可用图像输入的美术助手。" + task + "\n" + output_rule + "\n"
        f"返回 1 至 {request['count']} 项，不为凑数添加无关资产或剧情。只返回 JSON："
        '{"pictures":[{"name":"名称","type":"' + example_type + '","prompt":"图片提示词或改图指令"}],"warnings":[]}。\n'
        "name 为 1 至 80 字，prompt 为 1 至 4000 字，优先简洁具体；warnings 是字符串数组。不要输出其它字段。"
        "先遵守用户明确设定，再继承提供的素材描述；未指定画风时为整组选择一种统一风格，不在插画、写实、平涂间切换。"
        "保留用户给出的物种、设备、行为与身份，例如手机斗地主不能改成电脑斗地主；拟人猫仍保留猫头猫身，不能变成猫耳少女。"
        "不依赖屏幕精确文字、手指精细操作或嗅觉说明剧情；清楚安排主体、姿态、物件相对位置和可见视线，避免遮挡核心动作。"
        "看手机场景明确普通掌心大小手机而非平板，屏幕朝角色眼睛，镜头看到手机背壳或侧边；"
        "不为展示游戏界面让角色看手机背面，不要求画出可读游戏UI。"
        "不输出视频动作链、时长、运镜过程、模型参数、图片 URL 或 <Picture>/<Image>/<asset:...> 等媒体引用标记。"
    )


def parse_picture_plan_result(raw: str | dict[str, Any], request: dict[str, Any]) -> tuple[list[dict[str, str]], list[str]]:
    try:
        value = raw if isinstance(raw, dict) else json.loads(str(raw).strip())
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError("画面候选不是有效 JSON") from error
    if not isinstance(value, dict) or set(value) - {"pictures", "warnings"}:
        raise ValueError("画面候选只能包含 pictures 和 warnings")
    pictures, warnings = value.get("pictures"), value.get("warnings", [])
    if not isinstance(pictures, list) or not 1 <= len(pictures) <= request["count"]:
        raise ValueError("画面候选数量不符合请求")
    if not isinstance(warnings, list) or len(warnings) > 20:
        raise ValueError("warnings 必须是字符串数组")
    warnings = [_text(item, "提示", 1000) for item in warnings]
    allowed = _TYPES[:3] if request["kind"] == "asset" else ("关键帧",)
    result = []
    for item in pictures:
        if not isinstance(item, dict) or set(item) != {"name", "type", "prompt"}:
            raise ValueError("每个画面必须包含 name/type/prompt")
        if item["type"] not in allowed:
            raise ValueError("画面资产类型与当前模式不符")
        name = _text(item["name"], "名称", 80, True)
        prompt = _text(item["prompt"], "图片提示词", 4000, True)
        if re.search(r"https?://|<(?:picture|subject|image|asset|video|audio)\b", name + prompt, re.I):
            raise ValueError("画面候选不能包含媒体地址或引用标记")
        result.append({"name": name, "type": item["type"], "prompt": prompt})
    return result, warnings


def generate_picture_plan(
    request: dict[str, Any],
    generator: Callable[[str, str, int], str | dict[str, Any]] | None = None,
) -> tuple[list[dict[str, str]], list[str]]:
    user = "用户想法或剧情：\n" + request["idea_text"]
    if request.get("assets"):
        user += "\n\n已确定素材（有 input_role 才有实际图片输入，保持这些设定）：\n" + json.dumps(request["assets"], ensure_ascii=False)
    if request["instruction"]:
        user += "\n\n补充要求：\n" + request["instruction"]
    raw = (generator or complete_json)(build_picture_plan_system_prompt(request), user, 8192)
    return parse_picture_plan_result(raw, request)
