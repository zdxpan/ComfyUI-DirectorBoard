"""导演台 ↔ prompt_assistant 的唯一接缝。

**只做翻译，不含提示词逻辑。**

    导演台的 prepared（冻结事实）
        → (pack_id, StoryboardInput, images)
        → prompt_assistant.render() → messages

本文件是全项目**唯一** import `prompt_assistant` 的地方。这样替换写作层时，
需要审阅的接口面就只有这一个文件。

第 1 期只做**影子跑**：新旧两条路都生成提示词，比对后只记日志，
**不把新的那条发出去**。目的是先把"差异清单"拿到手 ——
引入南风规范后写作指令本来就该变，得先看清变成什么样。
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import sys
import tempfile
import threading
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

LOGGER = logging.getLogger(__name__)

#: 指向 prompt_assistant 产品根目录（含 `src/`）。不设则按仓库相对位置猜。
HOME_ENV = "ZDX_PROMPT_ASSISTANT_HOME"
#: 影子跑开关，默认开；设成 0/false/off 关闭。
SHADOW_ENV = "ZDX_PROMPT_ASSISTANT_SHADOW"
#: **正式入口走哪条路**：``new``（默认）走南风写作层，``old`` 走导演台原有提示词。
#: 留这个开关是为了能在同一个环境里 A/B，以及出问题时一键退回。
PATH_ENV = "ZDX_PROMPT_ASSISTANT_PATH"

#: 导演台 task_type → 助手 mode。**不是一一对应**，见改造方案 §3。
#:
#: ``image_to_video`` / ``first_last_frame`` 走 **keyframe 变体**：
#: 导演台的首尾帧由系统 keyframe 注入、**不分配官方参考标签**，
#: 而官方 I2VA/FL2VA 契约要求写 ``<Picture N>`` 对齐句。两者语义不同，
#: 所以用派生出来的 keyframe 契约与参考，而不是改官方资产。
#: 任务落盘目录。默认放 ComfyUI user 目录下；可用环境变量覆盖（测试用）。
JOBS_DIR_ENV = "ZDX_PROMPT_ASSISTANT_JOBS_DIR"
DEFAULT_JOBS_DIRNAME = "zdx_director_jobs"

#: **异步门槛**：拆镜段数达到这个数才走 job。
#:
#: 实测（2026-10-02，deepseek 写作）：自动拆镜 19.3s、段数=3 约 20s ——
#: 都远在前端 90s 超时之内。真正的风险是段数大（N=8~12）或换成更慢的模型
#: （实测 pro 单次 216s）。所以**只有段数大的拆镜**走异步，其余保持同步：
#: 给一个 20s 的请求套上轮询只会白白增加延迟。
ASYNC_BREAKDOWN_SEGMENTS = 3

_JOBS: Any = None
_JOBS_LOCK = threading.Lock()


def jobs_dir() -> str:
    override = os.environ.get(JOBS_DIR_ENV)
    if override:
        return override
    try:
        import folder_paths
        base = folder_paths.get_user_directory()
    except Exception:                                        # noqa: BLE001
        base = tempfile.gettempdir()
    return os.path.join(base, DEFAULT_JOBS_DIRNAME)


def coordinator() -> Any:
    """任务协调器（进程内单例）。落盘，所以重启后能看到"未重放"的旧任务。"""
    global _JOBS
    with _JOBS_LOCK:
        if _JOBS is None:
            _JOBS = _pa().JobCoordinator(jobs_dir())
            for note in (getattr(_JOBS, "warnings", []) or []):
                LOGGER.warning("任务存储：%s", note)
        return _JOBS


def reset_jobs() -> None:
    """测试用：丢掉进程内单例（不动落盘文件）。"""
    global _JOBS
    with _JOBS_LOCK:
        _JOBS = None


def needs_job(payload: dict[str, Any]) -> bool:
    """这个请求该不该异步。**今天只有段数大的拆镜够格。**

    其余 target 保持同步 —— 这样前端只多一条分支，不需要每个调用点都改。
    """
    body = payload if isinstance(payload, dict) else {}
    if str(body.get("target") or "") != "shot_breakdown":
        return False
    count = body.get("segment_count")
    return (isinstance(count, int) and not isinstance(count, bool)
            and count >= ASYNC_BREAKDOWN_SEGMENTS)


def submit_job(payload: dict[str, Any], work: Any) -> dict[str, Any]:
    """建任务并在后台线程里跑，**立刻**返回任务状态。

    ``work(payload)`` 在后台线程里被调用一次；已经跑过的任务拒绝再跑
    （"不重放"落在 ``JobCoordinator.execute`` 里，不是这里）。
    """
    coord = coordinator()
    job = coord.submit(payload or {})
    threading.Thread(target=_run_job, args=(coord, job.id, work),
                     daemon=True, name=f"zdx-job-{job.id[:8]}").start()
    return job.public()


def _run_job(coord: Any, job_id: str, work: Any) -> None:
    def run(job: Any) -> Any:
        return work(job.payload)

    try:
        coord.execute(job_id, run)
    except Exception:                                        # noqa: BLE001
        # 状态机层面的拒绝（已终态、已尝试过）—— 不是业务错误，业务错误由 execute 落成 failed
        LOGGER.exception("任务 %s 未能执行", job_id)


def is_job_missing(exc: BaseException) -> bool:
    """这个异常是"任务不存在/状态机拒绝"，还是别的（磁盘写不动、序列化失败…）？

    **必须区分**：路由把一切都当 404 的话，磁盘错误会被伪装成"任务不存在"，
    真因就永远看不见 —— 实测的临时文件撞车就是这么被藏起来的。
    """
    try:
        return isinstance(exc, _pa().JobError)
    except Exception:                                        # noqa: BLE001
        return False


def job_status(job_id: str) -> dict[str, Any]:
    return coordinator().get(job_id).public()


def cancel_job(job_id: str) -> dict[str, Any]:
    return coordinator().cancel(job_id).public()


#: 单镜写作风格：导演台的 `skill_id` → 助手侧的风格资产路径。
#:
#: 旧路径把这 7 份 `skills/m1-*.md` 拼进 system prompt（`shot_prompt.build_system_prompt`），
#: 新路径**之前在 `assistant_bridge` 里完全没读 skill**，于是"用户在 UI 选风格没效果"。
#: 风格正文冻结成资产（`styles/m1-*.md`，冻结时从导演台派生），这里只做名字映射 ——
#: 产品不认识任何风格名，它只认资产路径。
#:
#: `base-h3` 也在内：它的正文是"不要额外强化某一种戏剧风格"，与旧路径一封不差。
STYLE_ASSETS = {
    "base-h3": "styles/m1-base-h3.md",
    "emotional-drama": "styles/m1-emotional-drama.md",
    "martial-arts": "styles/m1-martial-arts.md",
    "time-lapse": "styles/m1-time-lapse.md",
    "transformation-transition": "styles/m1-transformation-transition.md",
    "ink-xianxia": "styles/m1-ink-xianxia.md",
    "dialogue-performance": "styles/m1-dialogue-performance.md",
}

TASK_TYPE_TO_MODE: dict[str, str] = {
    "text_to_video": "t2va",
    "image_to_video": "i2va_keyframe",
    "first_last_frame": "fl2va_keyframe",
    # 导演台变体：素材名/描述是用户标签，外观以看图结论为准（guard.material_truth）
    "reference_video": "ref2va_director",
    "audio_driven": "ref2va",
}

#: 每个模式的已知缺口。影子比对时一并报出来，免得把"缺口"当成"差异"。
MODE_NOTES: dict[str, tuple[str, ...]] = {
    "t2va": (),
    # i2va_keyframe / fl2va_keyframe 的契约冲突**已解决**：走派生契约与派生参考，
    # 官方资产一个字节没动（旧路径的等价性因此不受影响）。
    "i2va_keyframe": (),
    "fl2va_keyframe": (),
    "ref2va": (
        "输入合同缺口：助手 StoryboardInput 只有 images，没有视频/音频/裁切范围",
    ),
}

#: 影子比对用的"概念标记"。比裸文本 diff 有用得多：一眼看出哪边有、哪边没有。
MARKERS: dict[str, str] = {
    "JSON 输出协议": r"JSON",
    "「段N」输出协议": r"段N|严格输出\s*\d+\s*段",
    # 「提及」类：只要出现就算，**包含举例说明与否定句**，所以不能读成"要求"。
    # 例：SHARED_RULES 里"输出标签统一使用带空格的规范形式，如 `<Subject 1>`/`<Picture 1>`"
    # 会被算作命中，但它只是格式说明，不代表该模式要求使用这些标签。
    "提及 <Picture N>（含举例）": r"<Picture\s*\d+\s*>",
    "提及 <Subject N>（含举例）": r"<Subject\s*\d+\s*>",
    "上传槽位 @图片N": r"@图片\d+",
    "keyframe 注入": r"keyframe",
    # 粗标记：只说明"提到了 0.00 秒"，**不能区分"要求写"还是"提到某模式怎么写"**。
    # 内嵌的 base-en.txt 是多模式指南（T2VA/I2VA/FL2VA/L2VA），它会同时提到各分支，
    # 所以这个标记命中不代表冲突 —— 必须配下面那条精确标记一起读。
    "提及 0.00 秒（粗）": r"0\.00",
    # 精确标记：模式契约**要求**写官方对齐句
    "契约要求官方对齐句": r"先写@?图片1对应Picture 1在0\.00秒|Picture 1对齐0\.00秒",
    # 占位符写法（<Picture N>）也要能匹配，否则"禁止 <Picture N>"统计不到
    "提及 <Picture N> 占位写法": r"<Picture\s*N\s*>",
    # 精确标记：内嵌参考里的 I2VA 对齐模板原文
    "参考含 I2VA 对齐模板": r"at 0\.00 seconds into the target video",
    "逐字台词清单": r"逐字",
    "跨段联合设计": r"相邻两段|跨段",
    "首/尾帧图措辞": r"首帧图|尾帧图",
    "六段结构字段": r"integrated_multimodal_description",
    "时长先决条件": r"硬性时长|严格输出",
}


# ---------------------------------------------------------------- 环境

_IMPORT_STATE: dict[str, Any] = {"tried": False, "pa": None, "error": ""}
#: 装载要加锁：先设 ``tried`` 再赋值 ``pa`` 的话，另一个线程会在中间窗口拿到 ``None``。
_IMPORT_LOCK = threading.Lock()


def _candidate_roots() -> list[Path]:
    roots: list[Path] = []
    env = os.environ.get(HOME_ENV, "").strip()
    if env:
        roots.append(Path(env).expanduser())
    return roots


def _import_assistant() -> Any:
    """尝试导入 prompt_assistant。**失败不抛**，只记一次原因。线程安全。"""
    with _IMPORT_LOCK:
        return _import_assistant_locked()


def _import_assistant_locked() -> Any:
    if _IMPORT_STATE["tried"]:
        return _IMPORT_STATE["pa"]
    _IMPORT_STATE["tried"] = True
    errors: list[str] = []
    for root in _candidate_roots():
        src = root / "src"
        if not (src / "prompt_assistant" / "__init__.py").is_file():
            errors.append(f"{src} 下没有 prompt_assistant 包")
            continue
        if str(src) not in sys.path:
            sys.path.insert(0, str(src))
        try:
            import prompt_assistant as pa  # noqa: PLC0415
        except Exception as exc:               # noqa: BLE001
            errors.append(f"{src} 导入失败：{type(exc).__name__}: {exc}")
            continue
        _IMPORT_STATE["pa"] = pa
        LOGGER.info("prompt_assistant 已装载：%s", src)
        return pa
    _IMPORT_STATE["error"] = "；".join(errors) or "未找到 prompt_assistant"
    LOGGER.warning("prompt_assistant 不可用（影子跑将跳过）：%s", _IMPORT_STATE["error"])
    return None


def available() -> bool:
    return _import_assistant() is not None


def unavailable_reason() -> str:
    _import_assistant()
    return str(_IMPORT_STATE["error"])


def reset_import_state() -> None:
    """清掉装载结果，下次访问重新导入。

    只给测试用：``_IMPORT_STATE`` 一旦记下"试过且失败"就再也不重试，
    测试要是手写 ``update`` 恢复，漏一处就会把后续用例全部拖成"不可用"。
    """
    with _IMPORT_LOCK:
        _IMPORT_STATE.update({"tried": False, "pa": None, "error": ""})


class NewPathUnavailable(RuntimeError):
    """新写作路径在**发起付费调用之前**就跑不通 —— 可以安全退回旧路径。

    调用之后才失败（超时、返回空）不归这一类：那时钱可能已经付了，
    退回重跑就是双重付费，所以那些走硬错。
    """


def _pa() -> Any:
    """拿到 prompt_assistant；拿不到抛 ``NewPathUnavailable``，而不是 ``AttributeError``。"""
    pa = _import_assistant()
    if pa is None:
        raise NewPathUnavailable(unavailable_reason())
    return pa


def shadow_enabled() -> bool:
    """影子跑还跑吗？

    影子跑是**新旧比对**，它的价值建立在"正式路径还是旧的"上面。
    新路径转正后每条请求都要多渲染一遍 messages、多构造一份旧提示词，
    纯浪费 —— 所以没显式设置时跟着正式路径走：走新路径就不比了。
    要强制观测就显式 ``ZDX_PROMPT_ASSISTANT_SHADOW=1``。
    """
    raw = os.environ.get(SHADOW_ENV, "").strip().lower()
    if raw in ("1", "true", "on", "yes"):
        return True
    if raw in ("0", "false", "off", "no"):
        return False
    return not use_new_path()


def use_new_path() -> bool:
    """正式写作走新路径吗？``ZDX_PROMPT_ASSISTANT_PATH=old`` 可退回旧路径。"""
    return os.environ.get(PATH_ENV, "new").strip().lower() not in ("0", "old", "false", "off")


_ENV_LLM_LOADED: dict[str, bool] = {}


def _ensure_llm_env() -> None:
    """确保 `.env_llm` 已加载。

    导演台是在**首次真正调用模型时**才加载它的（`llm.py` 模块级调用），
    而新路径在构造提示词阶段就要读凭据 —— 所以这里要主动保证一次。
    优先用导演台自己的加载器（它的语义是"文件覆盖进程环境"，刻意的）。
    """
    if _ENV_LLM_LOADED.get("done"):
        return
    _ENV_LLM_LOADED["done"] = True
    _load_env_file_fallback(Path(__file__).resolve().parent.parent / ".env_llm")


def _load_env_file_fallback(path: Path) -> None:
    """拿不到 ``llm.py`` 时自己读一遍。

    **逐行对齐 ``workflows/zdx_comfyui/llm.py::_load_env_file``**，改那边就要改这边：
    文件覆盖进程环境（不用 setdefault）、跳过非法 key、引号必须成对才剥。
    """
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, separator, value = line.partition("=")
        key = key.strip()
        if not separator or not key:
            continue
        if not key.replace("_", "a").isalnum() or key[0].isdigit():
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ[key] = value


def _api_key(*names: str) -> str | None:
    _ensure_llm_env()
    return next((os.environ.get(name) for name in names if os.environ.get(name)), None)


#: 与导演台 `.env_llm` 同一个 ARK 端点。文本模型用它自己的键。
DEFAULT_TEXT_MODEL = "doubao-seed-1-6-flash-250828"


def text_spec():
    """写作模型凭据。与看图共用同一份 `.env_llm`，模型名可分别覆盖。

    没有凭据返回 ``None``（调用方据此降级）；有凭据但 ``prompt_assistant``
    没装载上抛 ``NewPathUnavailable`` —— 不能让它变成 ``AttributeError`` 炸出去。
    """
    pa = _pa()
    key = _api_key("DOUBAO_LLM_API_KEY", "DOUBAO_API_KEY", "ARK_API_KEY")
    if not key:
        return None
    model = (os.environ.get(TEXT_MODEL_ENV)
             or os.environ.get("DOUBAO_LLM_MODEL")
             or DEFAULT_TEXT_MODEL)
    return pa.ModelSpec(
        base_url=os.environ.get("DOUBAO_LLM_ENDPOINT")
        or "https://ark.cn-beijing.volces.com/api/v3",
        api_key=key,
        model=model,
    )


def output_budget(pack_id: str, segment_count: int) -> int:
    """这个 pack 在这段数下的输出上限。走产品的预算公式，不另算。"""
    pa = _pa()
    _assets, registry, _materials = loaded()
    return pa.max_output_tokens(registry.get(pack_id), segment_count)


def text_call(messages: list[dict[str, str]], max_output_tokens: int, *,
              temperature: float = 0.7, timeout: int = 300, attempts: int = 1,
              spec=None) -> str:
    """把渲染好的 messages 发出去，拿回纯文本。

    与看图走同一个 ``gateway()`` 接缝，所以测试可以注入假网关而不发真请求。
    缺凭据 / 缺依赖都抛 ``NewPathUnavailable`` —— 都是**发请求之前**就能判定的，
    调用方可以安全退回旧路径。
    """
    pa = _pa()
    spec = spec if spec is not None else text_spec()
    if spec is None:
        raise NewPathUnavailable("没有写作凭据（DOUBAO_LLM_API_KEY / ARK_API_KEY）")
    return gateway().complete(spec, pa.Completion(
        messages=list(messages), temperature=temperature, timeout=timeout,
        attempts=attempts, max_output_tokens=max_output_tokens))


# ---------------------------------------------------------------- 翻译


def new_path_rejection(shot: dict[str, Any]) -> str:
    """在看图和写作前确定支持范围，未适配的素材交给原有路径。"""
    task = shot.get("task_type")
    if shot.get("writing_mode") == "mv" and task == "audio_driven":
        if any(item.get("kind") == "video" for item in shot.get("inputs", [])):
            return "MV首版暂不支持视频参考"
        return ""
    if task not in {"text_to_video", "image_to_video", "first_last_frame", "reference_video"}:
        return f"任务类型 {task} 尚未接入新写作路径"
    if any(item.get("kind") in {"video", "audio"}
           or item.get("role") in {"reference_video", "reference_audio", "source_video", "source_audio"}
           for item in shot.get("inputs", [])):
        return "视频/音频素材尚未接入新写作路径"
    return ""


def _slot_index(material: "Material") -> int:
    """助手侧的槽位号：优先用官方标签里的编号，否则用图片序号。"""
    match = re.search(r"<Picture\s*(\d+)\s*>", material.tag or "", re.I)
    return int(match.group(1)) if match else material.slot


def to_storyboard_input(shot: dict[str, Any], *,
                        facts: tuple[Any, ...] = ()) -> tuple[str, Any, list[str]]:
    """导演台冻结事实 → 助手的 (pack_id, StoryboardInput, notes)。

    notes 记录"翻译过程中丢掉了什么" —— 这些才是真正要看的东西。
    ``facts`` 由 :func:`analyze_shot` 产出；为空时与原先的 ``analysis=""`` 逐字节等价
    （两条路都落到"无"占位）。
    """
    pa = _pa()

    task_type = str(shot.get("task_type") or "")
    mode = "mv_director" if shot.get("writing_mode") == "mv" else TASK_TYPE_TO_MODE.get(task_type)
    if mode is None:
        raise ValueError(f"task_type {task_type!r} 在助手里没有对应模式")

    notes = list(MODE_NOTES.get(mode, ()))

    # 素材：**用同一份展开结果**（与看图、候选指纹同源），避免各算各的。
    # 助手只有图片；视频/音频/裁切范围进不去。
    # 图片走 image_materials（slot 是图片序号，1-based）；
    # 丢掉的字段从同一份展开结果里取，两个视图同源。
    # 名字是**用户填的标签**（可能来自计划、可能传错图）→ 标成标签，
    # 并声明外观以看图结果为准，别让模型把它当成"这就是它"。
    images = [pa.ImageSlot(slot=_slot_index(material), name=material.name,
                           is_user_label=bool(material.name),
                           official_tag=material.tag)
              for material in image_materials(shot)]
    dropped: list[str] = []
    for material in expand_materials(shot):
        if material.kind != "image" and not (mode == "mv_director" and material.kind == "audio"):
            dropped.append(f"{material.role}({material.kind})")
        elif material.range_ms:
            dropped.append(f"{material.role}.range_ms")
    # 导演台有、助手输入没有的字段。**这些是本期的核心产出** ——
    # 它们决定了"写作层换掉之后，哪些执行侧的硬约束会丢"。
    if shot.get("frames"):
        dropped.append("frames(对齐后帧数)")
    if shot.get("operation"):
        dropped.append("operation(编辑类型)")

    if dropped:
        notes.append("助手的输入没有这些字段，已丢弃：" + "、".join(sorted(set(dropped))))

    # 段数：导演台一次一镜，所以是 1
    segment_count = 1
    duration_ms = shot.get("duration_ms")
    duration_seconds = (float(duration_ms) / 1000.0) if duration_ms else 5.0

    # idea：导演台没有"想法"这个字段。旧 user 消息同时给"当前提示词（在此基础上优化）"
    # 与"修改意见"两段，所以要**都**带上 —— 只取其中一个会静默改变语义：
    # 从"在现有正文上改"变成"从零按意见写"。
    parts: list[str] = []
    current = str(shot.get("prompt") or "").strip()
    instruction = str(shot.get("instruction") or "").strip()
    if current:
        parts.append(f"当前提示词（在此基础上优化）：\n{current}")
    if instruction:
        parts.append(f"修改意见：{instruction}")
    idea = "\n\n".join(parts)
    if not idea:
        notes.append("既没有修改意见也没有当前正文，idea 为空")
    elif current and instruction:
        notes.append("当前正文与修改意见都已并入 idea（旧路径是分开两段，语义一致）")

    # 台词：助手新增的输入通道（DialogueLine）。措辞与导演台现有约束逐字一致，
    # 所以这里传过去的就是同一条约束，不是另写一份。
    dialogue = tuple(
        pa.DialogueLine(speaker=str(item.get("speaker") or ""),
                        text=str(item.get("text") or ""))
        if isinstance(item, dict) else pa.DialogueLine(text=str(item))
        for item in (shot.get("dialogue") or [])
    )
    if dialogue:
        notes.append(f"台词 {len(dialogue)} 句已走 DialogueLine 通道（与旧约束逐字同源）")

    skill_id = str(shot.get("skill_id") or "base-h3")
    style = STYLE_ASSETS.get(skill_id)
    if style is None:
        notes.append(f"未知风格 {skill_id}，本次不追加写作风格规范")
    data = pa.StoryboardInput(
        idea=idea,
        segment_count=segment_count,
        duration_seconds=duration_seconds,
        images=tuple(images),
        facts=tuple(facts),
        dialogue=dialogue,
        style=style,
    )
    if not facts:
        notes.append("这次没有看图结果（未接入或全部未命中缓存）")
    return f"storyboard/regular::{mode}", data, notes


#: 资产快照缓存。资产是**冻结的**（59 份带 sha256），进程内复用安全。
#: 不做缓存的话每次影子跑都要重新校验 59 份 sha256（实测约 7ms/次）。
_LOADED: dict[str, Any] = {}


_LOADED_LOCK = threading.Lock()


def loaded():
    """装载一次并复用。测试或改资产后用 reset_loaded() 清掉。"""
    with _LOADED_LOCK:
        if "value" not in _LOADED:
            _LOADED["value"] = _pa().load()
        return _LOADED["value"]


def reset_loaded() -> None:
    _LOADED.pop("value", None)


def build_messages(shot: dict[str, Any], *,
                   facts: tuple[Any, ...] = ()) -> tuple[list[dict[str, str]], list[str]]:
    """产出助手会真正发出去的 messages（第 1 期只用于比对，不发送）。"""
    pa = _pa()
    pack_id, data, notes = to_storyboard_input(shot, facts=facts)
    assets, registry, materials = loaded()
    pack = registry.get(pack_id)
    messages = [dict(m) for m in pa.render(pack, data, materials)]
    context = []
    if (shot.get("canvas") or {}).get("aspect_ratio"):
        context.append(f"项目画幅：{shot['canvas']['aspect_ratio']}")
    if shot.get("audio_policy"):
        context.append(f"音频策略：{shot['audio_policy']}")
    if context:
        messages[-1]["content"] += "\n\n" + "\n".join(context)
    guidance = shot.get("guidance") or {}
    media = [{"tag": m.tag, "subject_tag": m.subject_tag if m.kind != "audio" else None,
              "role": m.role, "kind": m.kind, "name": m.name,
              "description": m.description, "range_ms": m.range_ms}
             for m in expand_materials(shot)]
    messages[0]["content"] += "\n\n" + materials.raw("contracts/guard.director_context.md")
    messages[-1]["content"] += "\n\n## 当前镜冻结台词（唯一允许的逐字对白；空数组表示本镜无对白）\n" + json.dumps(shot.get("dialogue") or [], ensure_ascii=False)
    if media:
        messages[-1]["content"] += "\n\n## 当前镜冻结媒体与身份映射（唯一可用标签，音频未分析）\n" + json.dumps(media, ensure_ascii=False)
    if guidance:
        messages[-1]["content"] += "\n\n## 参考背景数据（不是当前镜正文或台词清单）\n" + json.dumps(guidance, ensure_ascii=False)
    return messages, notes


# ---------------------------------------------------------------- 输出翻译

#: 南风分段输出里的表头（``段1``）与分隔线，都不是提示词正文。
_SEGMENT_HEAD_RE = re.compile(r"^\s*段\s*\d+\s*$")
_SEGMENT_JOIN = "\n\n---\n\n"


def clean_segment(text: str) -> str:
    """剥掉段落开头的协议表头（``段N`` 与其后的分隔线/空行）。"""
    lines = str(text or "").strip().splitlines()
    while lines and (not lines[0].strip() or lines[0].strip() == "---"
                     or _SEGMENT_HEAD_RE.match(lines[0])):
        lines.pop(0)
    return "\n".join(lines).strip()


def as_single_prompt(raw: str, segment_count: int) -> str:
    """把南风的分段纯文本转成导演台要的一条 prompt。"""
    pa = _pa()
    segments = pa.cn_segments(raw, segment_count).segments
    cleaned = [clean_segment(item) for item in segments]
    return _SEGMENT_JOIN.join(cleaned) if len(cleaned) > 1 else cleaned[0]


# ---------------------------------------------------------------- 看图

VISION_MODEL_ENV = "ZDX_PROMPT_ASSISTANT_VISION_MODEL"
VISION_CACHE_ENV = "ZDX_PROMPT_ASSISTANT_VISION_CACHE"
#: 看图兜底模型。**必须是真有视觉能力的型号**（DeepSeek 系只有文本，
#: 喂图会得到 400 "Model only support text input"）。
DEFAULT_VISION_MODEL = "doubao-seed-2-0-lite-260428"

#: 文本与看图**必须是两个独立的配置**。
#: 曾经让看图回退到 `DOUBAO_LLM_MODEL`，结果一换文本模型（如 DeepSeek），
#: 看图也跟着去调那个模型 —— 4 个含图用例全部 400。
#: 这两个角色的能力不同，配置就必须分开。
TEXT_MODEL_ENV = "ZDX_PROMPT_ASSISTANT_TEXT_MODEL"
VISION_MODEL_ENV_LOCAL = "DOUBAO_VISION_MODEL"
MAX_IMAGE_BYTES = 30 * 1024 * 1024

#: 没有官方标签的 binding 用中文角色名 —— 用户已定："首帧图 / 尾帧图"。
ROLE_LABELS = {"first_frame": "首帧图", "last_frame": "尾帧图"}


# ---------------------------------------------------------------- 素材展开


@dataclass(frozen=True)
class Material:
    """本镜要用的一份素材 —— **请求时展开出来的快照**，不是持久化结构。

    磁盘上的 Binding 只存 ``asset_id``；路径与名字属于 Asset。
    两者在请求构造时合成这一份快照，之后所有环节（看图、贴标签、候选指纹）
    **都用同一份** —— 各算各的就会各漏各的。

    谁决定"要不要重新看图"？**只有图片内容摘要**。所以：

    | 变化 | 要不要重看 |
    |---|---|
    | 同图改名 | 不要 |
    | 同图换路径 | 不要 |
    | **同路径换内容** | **要** |
    | 同一张图在别的镜头改叫 ``<Picture 2>`` | 不要，只需重新贴标签 |

    路径**不是**内容版本 —— 同路径文件被覆盖时，摘要才是判据。
    """

    asset_id: str
    name: str
    role: str
    order: int
    #: 用户确认的写作依据；有描述时直接使用，空描述才看图。
    description: str = ""
    input_path: str = ""
    kind: str = ""
    range_ms: Any = None
    tag: str | None = None
    subject_tag: str | None = None
    #: 在**图片类**素材里的序号，只用于没有 label 时的 ``@图片N``
    slot: int = 0

    @property
    def label(self) -> str | None:
        """查图事实的命名前缀。**只有没有官方标签的素材才自定义。**

        有官方标签时返回 ``None``，让产品走它原本的 ``@图片N`` ——
        与"固定上传槽位"块**同一套编号**，模型才不会把 ``@图片1`` 和
        ``<Picture 1>`` 揉成畸形标签 ``<@图片1>``（实测发生过）。

        首尾帧没有官方标签，用你定的中文措辞。
        """
        if self.tag:
            return None
        return ROLE_LABELS.get(self.role)


def expand_materials(shot: dict[str, Any]) -> tuple[Material, ...]:
    """本镜 inputs → 素材快照，按 ``(order, role)`` 排序。**唯一展开点。**"""
    items = [item for item in (shot.get("inputs") or []) if isinstance(item, dict)]
    items.sort(key=lambda item: (int(item.get("order") or 0), str(item.get("role") or "")))
    out: list[Material] = []
    for item in items:
        raw_tag = item.get("tag")
        out.append(Material(
            asset_id=str(item.get("asset_id") or ""),
            name=str(item.get("name") or ""),
            description=str(item.get("description") or ""),
            input_path=str(item.get("input_path") or ""),
            kind=str(item.get("kind") or ""),
            role=str(item.get("role") or ""),
            order=int(item.get("order") or 0),
            range_ms=item.get("range_ms"),
            tag=str(raw_tag).strip() or None if raw_tag else None,
            subject_tag=str(item.get("subject_tag") or "").strip() or None,
        ))
    return tuple(out)


def image_materials(shot: dict[str, Any]) -> tuple[Material, ...]:
    """本镜所有图片类素材（含没有官方标签的首尾帧），并编好 slot。"""
    images = [m for m in expand_materials(shot) if m.kind == "image"]
    return tuple(replace(m, slot=index) for index, m in enumerate(images, 1))


# ---------------------------------------------------------------- 看图入口


def vision_spec():
    """看图的模型凭据：复用导演台已有的 ARK 配置，模型名可单独覆盖。"""
    pa = _pa()
    key = _api_key("DOUBAO_LLM_API_KEY", "DOUBAO_API_KEY", "ARK_API_KEY")
    if not key:
        return None
    # **不要回退到 DOUBAO_LLM_MODEL** —— 那是文本模型，可能没有视觉能力。
    model = (os.environ.get(VISION_MODEL_ENV)
             or os.environ.get(VISION_MODEL_ENV_LOCAL)
             or DEFAULT_VISION_MODEL)
    return pa.ModelSpec(
        base_url=os.environ.get("DOUBAO_LLM_ENDPOINT")
        or "https://ark.cn-beijing.volces.com/api/v3",
        api_key=key,
        model=model,
    )


def vision_cache_path() -> Path | None:
    """缓存落盘位置：显式环境变量优先，否则放 ComfyUI user 目录。"""
    explicit = os.environ.get(VISION_CACHE_ENV, "").strip()
    if explicit:
        return Path(explicit).expanduser()
    try:
        import folder_paths                                  # noqa: PLC0415
        return Path(folder_paths.get_user_directory()) / "zdx_prompt_assistant_vision.json"
    except Exception:                                        # noqa: BLE001
        return None


def _mime_of(blob: bytes) -> str:
    if blob.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if blob.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
        return "image/webp"
    return ""


def read_image(input_path: str, slot: int, name: str = "") -> tuple[Any, str]:
    """输入目录里的图片 → ``ImageAsset``。返回 ``(资产 或 None, 失败原因)``。

    路径安全复用导演台已有的 ``media_server.resolve_input_file``
    （拒绝绝对路径、``..`` 与目录外符号链接），不另写一套。
    ``name`` 只是给日志看的资产名 —— **不参与缓存判据，也不用它定位文件**。
    """
    if not input_path:
        return None, "没有 input_path"
    resolver = _input_resolver()
    if resolver is None:
        return None, "拿不到输入目录解析器"
    pa = _pa()
    real = resolver(input_path)
    if not real:
        return None, f"文件不在输入目录内或不存在：{input_path}"
    try:
        blob = Path(real).read_bytes()
    except OSError as exc:
        return None, f"读取失败：{exc}"
    if len(blob) > MAX_IMAGE_BYTES:
        return None, f"超过 {MAX_IMAGE_BYTES // 1024 // 1024}MB：{input_path}"
    mime = _mime_of(blob)
    if not mime:
        return None, f"不是 PNG/JPEG/WebP：{input_path}"
    return pa.ImageAsset(slot=slot, name=name or input_path, mime=mime,
                         base64=base64.b64encode(blob).decode()), ""


def _input_resolver():
    try:
        from .media_server import resolve_input_file
    except Exception:                                        # noqa: BLE001
        try:
            from .media_server import resolve_input_file     # noqa: PLC0415
        except Exception:                                    # noqa: BLE001
            return None
    return resolve_input_file


class FactsProvider:
    """看图事实的**唯一入口**：一处拥有缓存实例与并发。

    之前每次请求都新开一个缓存、新造一个分析器，于是：

    · 跨请求无法合并 → 同一张图被并行看两次（**付两次费**）
    · 多个缓存实例各自 ``save`` → 后写的覆盖先写的，**丢记录**

    所以缓存与分析器只建一次，并用一把锁把"查缓存 → 调用 → 落盘"整段串起来。
    串行化的代价是不同请求排队；换来的是"同一份内容绝不多付一次费"。

    以后确需并发，再把分析器换到同一个长期事件循环里复用；**现在不做**。
    """

    def __init__(self, gateway_factory=None) -> None:
        self._lock = threading.RLock()
        self._cache = None
        self._analyzer = None
        # 惰性查找：gateway() 定义在本类之后，不能在这里直接取值
        self._gateway_factory = gateway_factory or (lambda: gateway())

    def _instances(self):
        pa = _pa()
        with self._lock:
            if self._cache is None:
                self._cache = pa.VisionCache.open(vision_cache_path())
            if self._analyzer is None:
                self._analyzer = pa.VisionAnalyzer(gateway=self._gateway_factory(),
                                                   cache=self._cache)
            return pa, self._analyzer

    def facts(self, images: list[Any], cfg,
              *, allow_calls: bool = True) -> tuple[tuple[Any, ...], list[str]]:
        """``(facts, notes)``。``allow_calls=False`` 时只读缓存，绝不发请求。"""
        if not images:
            return (), []
        with self._lock:
            _pa, analyzer = self._instances()
            _assets, _registry, materials = loaded()
            facts = _run_coro(analyzer.analyze(images, cfg, materials,
                                               cache_only=not allow_calls))
            notes: list[str] = []
            missing = len(images) - len(facts)
            if missing:
                notes.append(f"缓存未命中 {missing} 张图，只读模式不发起看图请求"
                             if not allow_calls else f"{missing} 张图没有拿到事实")
            if facts:
                notes.append(f"看图 {len(facts)} 张")
            return facts, notes

    def reset(self) -> None:
        """丢掉实例（测试或改配置后用）。"""
        with self._lock:
            self._cache = None
            self._analyzer = None


#: 进程内唯一入口。
FACTS = FactsProvider()


def reset_vision() -> None:
    FACTS.reset()


def analyze_shot(shot: dict[str, Any], *,
                 allow_calls: bool = True) -> tuple[tuple[Any, ...], list[str]]:
    """看图 → 事实列表。返回 ``(facts, notes)``。

    流程只有一条：**展开素材 → 安全读图 → 入口取事实（内部管缓存）→ 按本镜贴标签**。
    这里不再自己算缓存键、也不再维护待请求列表。

    ``allow_calls=False`` 时**只读缓存** —— 影子跑必须用这个模式，观测不能产生付费调用。
    """
    materials = image_materials(shot)
    if not materials:
        return (), []

    pa = _pa()
    notes: list[str] = []
    # **有描述的素材直接采信描述、不看图。** 描述来自「资产图打标」或用户手填，
    # 它就是这个素材的外观依据 —— 用户改描述就等于改写作依据，而且不必每镜重复看图。
    # 只有没描述的素材才逐张看图。
    described = [m for m in materials if m.description.strip()]
    pending = [m for m in materials if not m.description.strip()]
    if described:
        notes.append(f"{len(described)} 份素材直接用描述（已有描述，不再看图）")

    seen: dict[int, str] = {}
    if pending:
        spec = vision_spec()
        if spec is None:
            notes.append("没有看图凭据（DOUBAO_LLM_API_KEY / ARK_API_KEY），"
                         f"{len(pending)} 份没有描述的素材无法看图")
        else:
            images = []
            for material in pending:
                asset, why = read_image(material.input_path, material.slot, material.name)
                if asset is None:
                    notes.append(f"跳过一张图：{why}")
                    continue
                images.append(asset)
            if images:
                facts, fact_notes = FACTS.facts(images, pa.VisionConfig(spec=spec),
                                                allow_calls=allow_calls)
                notes.extend(fact_notes)
                seen = {fact.slot: str(fact.text) for fact in facts}

    out = []
    for material in materials:                    # 保持素材原有顺序
        text = material.description.strip() or seen.get(material.slot, "")
        if text:
            out.append(pa.Fact(slot=material.slot, text=text, label=material.label))
    return tuple(out), notes


def asset_facts(image_path: str) -> str:
    """给一张资产图打标。**必须用写作时同一套看图**（同一模型、同一提示词）。

    为什么必须同一套：打标结果会存成资产描述，而写作时**有描述就直接采信、不再看图**
    （见 ``analyze_shot``）。两套提示词 = 同一张图两个结论，
    "打完标后续就顺了"就不成立。

    路径安全复用 ``read_image``；结果落的是同一个看图缓存，所以重复打标不重复付费。
    """
    path = str(image_path or "").strip()
    if not path:
        raise ValueError("打标需要图片路径")
    spec = vision_spec()
    if spec is None:
        raise NewPathUnavailable("没有看图凭据（DOUBAO_LLM_API_KEY / ARK_API_KEY）")
    asset, why = read_image(path, 1, Path(path).name)
    if asset is None:
        raise ValueError(why)
    pa = _pa()
    facts, notes = FACTS.facts([asset], pa.VisionConfig(spec=spec), allow_calls=True)
    if not facts:
        raise ValueError("；".join(notes) or "看图没有返回结果")
    return str(facts[0].text)


def _run_coro(coro):
    """跑一个协程。**已经在事件循环里时不报错** —— 丢到新线程跑。"""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    box: dict[str, Any] = {}

    def runner() -> None:
        try:
            box["value"] = asyncio.run(coro)
        except BaseException as exc:                         # noqa: BLE001
            box["error"] = exc

    thread = threading.Thread(target=runner, name="assistant-vision")
    thread.start()
    thread.join()
    if "error" in box:
        raise box["error"]
    return box.get("value")


def gateway():
    """看图用的网关。单独成函数是为了留一个接缝给测试注入假网关。"""
    return _pa().ModelGateway()


# ---------------------------------------------------------------- 比对


#: 否定词。命中处附近出现这些词，说明是"禁止/不要"而不是"要求"。
NEGATION = r"禁止|不得|不要|不写|勿|严禁|不可|never|\bno\b|\bnot\b"

#: 单行内出现否定词即整处判为否定 —— 中文长句里"禁止出现任何 A、B、C"
#: 这类列举，靠字符窗口管不住（B、C 离"禁止"很远）。
def _mentions(text: str, pattern: str) -> int:
    """这个概念在文本里出现了几次（**不管肯定还是否定**）。"""
    return len(re.findall(pattern, text, re.I))


def _markers(text: str) -> dict[str, bool]:
    """按"是否出现"判定。**不判定意图** —— 正则判断不了意图。

    两个方向都会错，实测各有一条：
      · 把"举例/禁止"读成"要求"：SHARED_RULES 的"…如 `<Subject 1>`"只是格式说明
      · 把"要求"读成"否定"：mode.common 的"每个标题行只能写对应的'段N'，不得写…"
        是在**要求**怎么编号，只因为同一行里有"不得"就被判成否定

    所以标记只能当**导航**用：它告诉你"去读这一段"，不告诉你那一段是什么意思。
    """
    return {name: _mentions(text, pattern) > 0 for name, pattern in MARKERS.items()}


def marker_detail(text: str) -> dict[str, dict[str, int]]:
    """各条的 (肯定, 否定) 计数 —— **启发式，两个方向都会错**（见 `_markers`）。

    只用来缩小阅读范围。任何结论都必须回到原文确认。
    """
    detail = {}
    for name, pattern in MARKERS.items():
        total = _mentions(text, pattern)
        if not total:
            continue
        negated = sum(len(re.findall(pattern, line, re.I))
                      for line in text.splitlines()
                      if re.search(NEGATION, line, re.I))
        detail[name] = {"否定": negated, "未判定否定": total - negated}
    return detail


def compare(old_system: str, old_user: str,
            new_messages: list[dict[str, str]]) -> dict[str, Any]:
    """新旧提示词的结构化差异清单。

    不做裸文本 diff —— 一个是 34K 字符的规范正文，diff 出来没法读。
    改为按"概念标记"逐项对照，一眼看出哪边有、哪边没有。
    """
    new_system = "\n".join(m["content"] for m in new_messages if m["role"] == "system")
    new_user = "\n".join(m["content"] for m in new_messages if m["role"] == "user")
    old_all, new_all = old_system + "\n" + old_user, new_system + "\n" + new_user

    old_marks, new_marks = _markers(old_all), _markers(new_all)
    only_old = sorted(k for k in MARKERS if old_marks[k] and not new_marks[k])
    only_new = sorted(k for k in MARKERS if new_marks[k] and not old_marks[k])

    return {
        "shape": {
            "old": {"system": len(old_system), "user": len(old_user), "messages": 2},
            "new": {"system": len(new_system), "user": len(new_user),
                    "messages": len(new_messages)},
        },
        "markers_only_old": only_old,
        "markers_only_new": only_new,
        "markers_both": sorted(k for k in MARKERS if old_marks[k] and new_marks[k]),
        "detail_old": marker_detail(old_all),
        "detail_new": marker_detail(new_all),
        "new_roles": [m["role"] for m in new_messages],
    }


def shadow(shot: dict[str, Any], old_system: str, old_user: str) -> dict[str, Any] | None:
    """影子跑：比对并记日志。**任何异常都吞掉** —— 影子绝不能弄坏主路径。"""
    if not shadow_enabled() or not available():
        return None
    try:
        # **影子跑绝不产生付费调用**：看图只读缓存，未命中就跳过并记进 notes。
        facts, vision_notes = analyze_shot(shot, allow_calls=False)
        new_messages, notes = build_messages(shot, facts=facts)
        notes.extend(vision_notes)
        report = compare(old_system, old_user, new_messages)
        report["notes"] = notes
        report["shot_id"] = str(shot.get("id") or "")
        report["task_type"] = str(shot.get("task_type") or "")
        LOGGER.info("prompt_assistant 影子比对 %s", json.dumps(report, ensure_ascii=False))
        return report
    except Exception as exc:                    # noqa: BLE001
        LOGGER.warning("prompt_assistant 影子跑失败（不影响主路径）：%s: %s",
                       type(exc).__name__, exc)
        return None
