"""分镜连续性：把上一镜的尾部（画面 + 声音）钉进这一镜。

## 机制（ComfyUI 0.34.0 起官方支持，不需要给 ComfyUI 打补丁）

官方 `MiniMaxH3AddGuide` 写的 keyframe 就是 `{"resolved_frame_index", "latent",
"audio_latent"}`；模型的 `PackedLayout` 把它当作**条件行**（永不参与去噪）放在目标
时间轴的指定位置，而 `model_base` 又把 keyframes 与 `minimax_refs` 的
`cond_video_latents` **相加而不覆盖**——所以"参考图/参考视频 + 钉住的头部"可以并存。

## 关键恒等式

    token 数 t 覆盖的像素帧数 = 4t − 3·ceil(t/5)
    ⇒ 17m+5 帧 ⇔ 5m+2 token ⇔ 尾部切片起点 ≡ 0 (mod 5)

也就是：只要前后两镜的长度都对齐到 17k+5（`align_h3_frame_count` 保证），**相位自动
对齐**，窗口 5/22/39/56 恰好等于 token 2/7/12/17，钉多少帧正好是那个窗口，不会多钉
一帧。这就是官方与社区都只提供这四档的原因。

## 边界

本模块只做数学与组装：不认识"上一镜"从哪来（磁盘/前端），也不碰文件系统。
"""

from __future__ import annotations

from .h3_video_latent import av_streams

CONTEXT_FRAME_CHOICES = (5, 22, 39, 56)
DEFAULT_CONTEXT_FRAMES = 22
DEFAULT_AUDIO_CONTEXT_FRAMES = 24  # 整整 1 秒，且落在模型 40Hz 音频网格上
H3_FPS = 24.0  # 模型内部时间轴；交付播放帧率由上游决定，不影响裁剪位置
_EXPECTED_FRAME_PER_TOKEN = (1, 4, 4, 4, 4)
_EXPECTED_FRAME_RESCALE = 5.0 / 3.0


def _reject(reason, fix):
    """拒绝时统一句式：出了什么问题 + 该怎么改。"""
    return ValueError(f"{reason}；{fix}")


def snap_context_frames(raw):
    """窗口吸附到官方四档；<= 0 表示不钉。"""
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = DEFAULT_CONTEXT_FRAMES
    if value <= 0:
        return 0
    return int(min(CONTEXT_FRAME_CHOICES, key=lambda choice: (abs(choice - value), -choice)))


def pixel_frames_for_latent_t(latent_t):
    """token 数 → 像素帧数（周期 5 的 1/4/4/4/4）。"""
    latent_t = max(0, int(latent_t))
    return 4 * latent_t - 3 * ((latent_t + 4) // 5)


def latent_t_for_frames(frames):
    """>= frames 的最小 token 数（尾部切片只能落在整数 token 上）。"""
    frames = max(1, int(frames))
    total = 0
    for tokens in range(1, 4096):
        total += 1 if (tokens - 1) % 5 == 0 else 4
        if total >= frames:
            return tokens
    raise ValueError(f"context frames {frames} is out of range")


def verify_official_frame_math():
    """核对官方帧/token 换算，而不是假设它没变（变了就拒跑，不按旧值算相位）。"""
    from comfy.ldm.minimax.model import FRAME_PER_TOKEN, FRAME_RESCALE
    if (
        tuple(int(item) for item in FRAME_PER_TOKEN) != _EXPECTED_FRAME_PER_TOKEN
        or float(FRAME_RESCALE) != _EXPECTED_FRAME_RESCALE
    ):
        raise ValueError(
            f"官方 H3 的帧/token 换算已变化（FRAME_PER_TOKEN={tuple(FRAME_PER_TOKEN)}, "
            f"FRAME_RESCALE={FRAME_RESCALE}）：连续性 pin 的相位算法需要重新核对，本次拒绝 pin。"
        )


def plan_context_pin(
    *,
    context_latent,
    context_frames=DEFAULT_CONTEXT_FRAMES,
    audio_context_length=DEFAULT_AUDIO_CONTEXT_FRAMES,
    width,
    height,
    length,
    has_first_frame=False,
    latent_upscale=False,
    audio_driving=False,
):
    """算出要钉的 keyframe 与要裁的帧数；窗口 <= 0 时返回 None。

    返回 `{"keyframe", "pinned_frames", "pinned_tokens", "audio_steps"}`。
    这些拒绝条件都是"宁可拒跑，不静默退化"：首帧锚点冲突、装不下窗口、与 upscale /
    音频驱动冲突、画幅不同、上一镜素材不够。
    """
    window = snap_context_frames(context_frames)
    if window <= 0:
        return None
    if has_first_frame:
        raise _reject(
            "本镜已有首帧锚点，与钉住上一镜尾部冲突（那几帧归钉住的头部所有）",
            "链上的镜请改用 text_to_video / reference_video，首帧只在链的起点用",
        )
    if latent_upscale:
        raise _reject(
            "连续性 pin 与 latent_upscale 不能同时开",
            "第二遍会把画布放大，而钉进去的 latent 不能缩放",
        )
    if audio_driving:
        raise _reject(
            "连续性 pin 与音频驱动不能同时开",
            "驱动音频锁住整条音轨，与钉进上一镜声音是两套冲突的音频上下文",
        )
    # 这里按**对齐后**的提交帧数判断（调用方传进来的就是 align 过的值）：至少窗口 + 5 帧，
    # 也就是交付段不能短于 H3 自己的最短长度。
    if int(length) < window + 5:
        raise _reject(
            f"对齐后的提交帧数 {int(length)} 装不下 {window} 帧的衔接窗口",
            f"链上的镜应当提交 align(交付帧数 + {window})，至少要 {window + 5} 帧",
        )
    verify_official_frame_math()
    video, audio = av_streams(context_latent)
    # 用 -3: 取 (t,h,w)：与 h3_video_latent.H3InjectVideoLatent 同一套索引，兼容带不带 batch 维
    tokens_available, latent_h, latent_w = (int(size) for size in video.shape[-3:])
    canvas = (latent_w * 16, latent_h * 16)
    if canvas != (int(width), int(height)):
        raise _reject(
            f"上一镜画幅 {canvas[0]}×{canvas[1]} 与本镜 {width}×{height} 不一致",
            "latent 不能缩放，连续性要求全片画幅一致",
        )
    tokens = latent_t_for_frames(window)
    if tokens_available < tokens:
        raise _reject(
            f"上一镜只有 {tokens_available} 个 latent token，取不到 {tokens} 个做衔接窗口",
            "上一镜太短或没有真的跑过",
        )
    keyframe = {"resolved_frame_index": 0, "latent": video[:, :, -tokens:].contiguous()}
    try:
        wanted_audio = int(audio_context_length)
    except (TypeError, ValueError):
        wanted_audio = DEFAULT_AUDIO_CONTEXT_FRAMES
    audio_steps = 0
    if wanted_audio > 0:
        audio_steps = max(1, round(wanted_audio * _EXPECTED_FRAME_RESCALE))
        available = int(audio.shape[-1])
        if available < audio_steps:
            raise _reject(
                f"上一镜只有 {available} 步音频，取不到 {audio_steps} 步做声音衔接窗口",
                f"把 audio_context_length 降到 {available / _EXPECTED_FRAME_RESCALE:.0f} 帧以内",
            )
        keyframe["audio_latent"] = audio[..., -audio_steps:].contiguous()
    return {
        "keyframe": keyframe,
        "pinned_frames": pixel_frames_for_latent_t(tokens),
        "pinned_tokens": tokens,
        "audio_steps": audio_steps,
    }


def append_context_keyframe(conditioning, keyframe):
    """把 keyframe 追加到**每条** conditioning 自己的 minimax_keyframes 上。

    必须逐条读写而不是"读第 0 条、写给所有条"：官方 helper 只支持共享同一个值，
    那样会丢掉其它条目已有的锚点（fl2v 的尾帧锚点就在那里）。空 conditioning 直接拒绝，
    否则 helper 会返回空列表、钉的 keyframe 静默消失。
    """
    if not conditioning:
        raise ValueError("conditioning 为空：连续性 pin 无处挂载")
    merged = []
    for entry in conditioning:
        meta = entry[1] if len(entry) > 1 else None
        if not isinstance(meta, dict):
            raise ValueError(f"conditioning 条目结构异常（第二项应是 metadata 字典）：{type(meta)!r}")
        existing = list(meta.get("minimax_keyframes") or [])
        # 保留条目原有字段与尾部元素，只替换 minimax_keyframes
        merged.append([entry[0], {**meta, "minimax_keyframes": existing + [keyframe]}, *entry[2:]])
    return merged


def trim_context_head(images, audio, trim_frames, fps=H3_FPS):
    """从解码结果里裁掉钉住的那段头部（画面与声音裁在同一时刻）。"""
    trim_frames = max(0, int(trim_frames))
    if trim_frames <= 0:
        return images, audio
    images = images[trim_frames:]
    if isinstance(audio, dict) and audio.get("waveform") is not None:
        sample_rate = int(audio.get("sample_rate") or 0)
        cut = round(trim_frames / float(fps) * sample_rate)
        if sample_rate > 0 and 0 < cut < audio["waveform"].shape[-1]:
            audio = dict(audio)
            audio["waveform"] = audio["waveform"][..., cut:]
    return images, audio


def with_context_report(latent, plan):
    """把实际用掉的数字挂回 LATENT：调用方用它规划提交帧数与上一镜裁尾。"""
    if not isinstance(latent, dict) or plan is None:
        return latent
    out = dict(latent)
    out["zdx_continuity"] = {
        "pinned_frames": plan["pinned_frames"],
        "pinned_tokens": plan["pinned_tokens"],
        "audio_steps": plan["audio_steps"],
        "output_trim_frames": plan.get("output_trim_frames", plan["pinned_frames"]),
    }
    return out
