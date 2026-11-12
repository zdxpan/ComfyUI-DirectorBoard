"""Director-shot adapter and compact MiniMax H3 sampling entry point."""
from __future__ import annotations

import json
from typing import Any

import comfy.samplers
import torch
import nodes as _nodes

from .h3_video_latent import H3InjectVideoLatent
from .h3_continuity_store import load_continuity_latent, save_continuity_latent
from .minimax_h3_video_sample import MiniMaxH3VideoSample, align_h3_frame_count, use_h3_two_pass
from .director_board.contract_data import DIRECTOR_PROJECT_CONTRACT


TASK_CONTRACTS = DIRECTOR_PROJECT_CONTRACT["task_types"]
DISPATCH_CONTRACT = DIRECTOR_PROJECT_CONTRACT["dispatch"]["parameters"]
GLOBAL_CONTRACT = DIRECTOR_PROJECT_CONTRACT["global"]
TASK_MODE = {task: entry["mode"] for task, entry in TASK_CONTRACTS.items()}
H3_FPS = 24.0

QUALITY_SINGLE_SIGMAS = (1, .99, .975, .95, .91, .85, .76, .64, .5, .36, .24, .14, .07, .02, 0)
# 备选质量单采调度：11 个 sigma 对应 10 步，可留作后续效果/耗时对比。
# 1, .9882, .973, .9524, .9231, .878, .8, .6316, .4737, .1579, 0


# 帧策略：17k+5（k 为非负整数）。Agent 用秒表达，系统负责对齐；训练区间仅作提示。
H3_FRAME_STEP = 17
H3_FRAME_OFFSET = 5
H3_TRAINED_MIN_FRAMES = 124  # 官方训练区间约 5s 起；实测 2s/3s 仍可用
H3_ABSOLUTE_MAX_FRAMES = 3600

def apply_h3_attention(model):
    """Use the reference workflow's dense backend and H3-safe sparse attention."""
    from comfy_extras.nodes_model_advanced import ModelAttentionBackend
    from comfy_extras.nodes_sparse_attention import BlockSparseAttention

    model = ModelAttentionBackend.execute(model, "comfy kitchen attention").result[0]
    return BlockSparseAttention.execute(
        model=model,
        selection={"selection": "sol-attn", "tau": 1.3},
        start_percent=0.2,
        end_percent=1.0,
        dense_blocks="",
        min_tokens=12288,
        extra_tokens=256,
        sink_conditioning="exact_kv_and_rows",
        verbose=True,
    ).result[0]


def shot_capabilities(
    allowed_roles=None,
    required_roles=None,
    role_limits=None,
    media_limits_for_roles_fn=None,
    agent_frame_range=None,
) -> dict[str, Any]:
    """投影每一档 task_type 真正能跑什么，与消费端同源。"""
    if any(value is None for value in (
        allowed_roles, required_roles, role_limits, media_limits_for_roles_fn,
        agent_frame_range,
    )):
        from .director_board.model import (
            AGENT_FRAME_RANGE,
            ROLE_LIMITS,
            TASK_ALLOWED_ROLES,
            TASK_REQUIRED_ROLES,
            media_limits_for_roles,
        )
        allowed_roles = TASK_ALLOWED_ROLES
        required_roles = TASK_REQUIRED_ROLES
        role_limits = ROLE_LIMITS
        media_limits_for_roles_fn = media_limits_for_roles
        agent_frame_range = AGENT_FRAME_RANGE
    frame_policy = {
        "formula": "17k+5", "fps": H3_FPS,
        "hard_range_frames": [H3_FRAME_OFFSET, H3_ABSOLUTE_MAX_FRAMES],
        "hard_max_frames": H3_ABSOLUTE_MAX_FRAMES,
        "trained_range_frames": [H3_TRAINED_MIN_FRAMES, 362],
        "agent_range_frames": list(agent_frame_range),
        "agent_default_max_frames": agent_frame_range[1],
        "agent_duration_range_s": [2, 15],
        "alignment_tolerance_ms": 700,
        "note": "Agent 用秒表达；系统向上吸附到 17k+5，训练区间仅供提示，实测 2s/3s 可用。",
    }

    task_types = {}
    for task, mode in TASK_MODE.items():
        allowed = sorted(allowed_roles[task])
        required = dict(required_roles[task])
        media_limits = media_limits_for_roles_fn(allowed)
        contract = TASK_CONTRACTS[task]
        entry = {
            "task_type": task,
            "runnable": True,
            "agent_enabled": bool(contract["agent_enabled"]),
            "mode": mode,
            "required_roles": required,
            "requires_any_roles": list(contract["requires_any_roles"]),
            "allowed_roles": allowed,
            "role_limits": {role: role_limits[role] for role in allowed},
            "requires_anchor": list(contract["requires_anchor"]),
            "max_images": media_limits["image"],
            "max_videos": media_limits["video"],
            "max_audios": media_limits["audio"],
            "duration_source": contract["duration_source"],
            "prompt_template": contract["prompt_template"],
            "meaning": contract["meaning"],
            "use_when": contract["use_when"],
            "prompt_structure": contract["prompt_structure"],
            "allowed_tag_kinds": list(contract["allowed_tag_kinds"]),
            "frame_policy": frame_policy,
        }
        if not entry["agent_enabled"]:
            entry["reason"] = "导演 agent 第一阶段不规划视频二创；渲染器仍支持（人工构造的镜头会遇到）"
        task_types[task] = entry

    return {
        "task_types": task_types,
        "frame_policy": frame_policy,
    }


def node_result_items(result):
    if hasattr(result, "result"):
        return result.result
    if isinstance(result, dict):
        return result["result"]
    return result


def select_director_shot(shots_json: str, shot_index: int) -> dict[str, Any]:
    try:
        shots = json.loads(shots_json)
    except (TypeError, json.JSONDecodeError) as exc:
        raise ValueError(f"Director shots_json is invalid JSON: {exc}") from exc
    if not isinstance(shots, list) or not shots:
        raise ValueError("Director shots_json must be a non-empty list")
    if shot_index < 0 or shot_index >= len(shots):
        raise ValueError(
            f"Director shot_index {shot_index} is outside 0..{len(shots) - 1}"
        )
    shot = shots[shot_index]
    if not isinstance(shot, dict):
        raise ValueError(f"Director shot {shot_index} must be an object")
    shot_id = shot.get("shot_id")
    is_continuity_source = bool(shot_id) and any(
        isinstance(next_shot, dict)
        and (next_shot.get("continuity") or {}).get("enabled")
        and (next_shot.get("continuity") or {}).get("previous_shot_id") == shot_id
        for next_shot in shots[shot_index + 1:]
    )
    return {**shot, "continuity_source": is_continuity_source}


def director_shot_spec(shot: dict[str, Any], shot_index: int | None = None) -> dict[str, Any]:
    task = shot.get("task_type")
    if task not in TASK_MODE:
        raise ValueError(f"Unsupported Director task_type: {task!r}")
    if not shot.get("selected_for_generation", True):
        raise ValueError(f"Director shot {shot.get('shot_id', '?')} is not selected")

    inputs = shot.get("inputs") or {}
    references = inputs.get("reference_images") or []
    # 源视频与参考视频进入同一个官方 ref_videos 条件序列，角色只表达业务用途。
    edit_source_video = inputs.get("source_video")
    reference_videos = list(
        inputs.get("reference_videos")
        or ([inputs.get("reference_video")] if inputs.get("reference_video") else [])
    )
    source_audio = inputs.get("source_audio")
    reference_audios = list(
        inputs.get("reference_audios")
        or ([inputs.get("reference_audio")] if inputs.get("reference_audio") else [])
    )
    audios = ([source_audio] if source_audio else []) + reference_audios
    audio_policy = str(shot.get("audio_policy") or "passthrough")
    audio_driving = task == "audio_driven" and source_audio is not None
    passthrough_input_audio = (
        audio_policy == "passthrough"
        and source_audio is not None
    )
    output_generated_audio = audio_policy == "generated"
    mode = TASK_MODE[task]

    duration_ms = int(shot.get("duration_ms") or 0)
    motion_fps = float(shot.get("motion_fps") or H3_FPS)
    output_fps = float(shot.get("output_fps") or motion_fps)
    if duration_ms <= 0 or motion_fps <= 0 or output_fps <= 0:
        raise ValueError("Director shot duration and frame rates must be positive")
    canvas = shot.get("canvas") or {}
    continuity = shot.get("continuity") or {}
    continuity_enabled = bool(continuity.get("enabled", False))
    context_frames = int(continuity.get("context_frames", 22))
    delivery_length = align_h3_frame_count(round(duration_ms * motion_fps / 1000))
    sample_length = (
        align_h3_frame_count(delivery_length + context_frames)
        if continuity_enabled else delivery_length
    )
    sequence_index = int(continuity.get(
        "sequence_index", shot_index if shot_index is not None else 0,
    ))
    previous_shot_id = continuity.get("previous_shot_id")
    spec = {
        "shot_id": str(shot.get("shot_id") or ""),
        "project_id": str(shot.get("project_id") or ""),
        "continuity_source": bool(shot.get("continuity_source", False)),
        "mode": mode,
        "prompt": str(shot.get("prompt") or ""),
        "width": int(canvas.get("width") or 0),
        "height": int(canvas.get("height") or 0),
        "length": sample_length,
        "delivery_length": delivery_length,
        "motion_fps": motion_fps,
        "output_fps": output_fps,
        "h3_internal_fps": H3_FPS,
        "requested_duration_ms": duration_ms,
        "first_frame": inputs.get("first_frame"),
        "last_frame": inputs.get("last_frame"),
        **{
            f"reference_image_{index + 1}": (
                references[index] if len(references) > index else None
            )
            for index in range(6)
        },
        "edit_source_video": edit_source_video,
        "reference_video_1": reference_videos[0] if reference_videos else None,
        "reference_video_2": reference_videos[1] if len(reference_videos) > 1 else None,
        "audio": audios[0] if audios else None,
        "audio_2": audios[1] if len(audios) > 1 else None,
        "audio_3": audios[2] if len(audios) > 2 else None,
        "audio_driving": audio_driving,
        "passthrough_input_audio": passthrough_input_audio,
        "output_generated_audio": output_generated_audio,
        "continuity": {
            "enabled": continuity_enabled,
            "context_frames": context_frames,
            "audio_context_length": int(continuity.get("audio_context_length", 24)),
            "sequence_index": sequence_index,
            "previous_shot_id": previous_shot_id,
            "previous_execution_fingerprint": continuity.get("previous_execution_fingerprint"),
            "output_trim_frames": sample_length - delivery_length,
        },
        "execution_fingerprint": shot.get("execution_fingerprint"),
    }
    if spec["width"] <= 0 or spec["height"] <= 0:
        raise ValueError("Director shot canvas is invalid")
    spec["effective_model_duration_ms"] = round(
        spec["length"] * 1000 / H3_FPS
    )
    delivered_frames = delivery_length
    spec["effective_output_duration_ms"] = round(delivered_frames * 1000 / output_fps)
    return spec


class ZDXH3ShotSelect:
    """Select one resolved Director shot and materialize its H3 inputs."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "shots_json": ("STRING", {"multiline": True}),
                "shot_index": ("INT", {"default": 0, "min": 0, "max": 9999}),
            }
        }

    RETURN_TYPES = ("H3_SHOT",)
    RETURN_NAMES = ("shot",)
    FUNCTION = "select"
    CATEGORY = "zdx/director"

    def __init__(self):
        self.load_image = None
        self.load_video = None
        self.get_video_components = None
        self.load_audio = None
        self.trim_audio = None

    _NODE_DEPS = {
        "load_image": "LoadImage",
        "load_video": "LoadVideo",
        "get_video_components": "GetVideoComponents",
        "load_audio": "LoadAudio",
        "trim_audio": "TrimAudioDuration",
    }

    def _inject(self):
        for attr, node_name in self._NODE_DEPS.items():
            if getattr(self, attr, None) is None:
                setattr(self, attr, _nodes.NODE_CLASS_MAPPINGS[node_name]())

    @staticmethod
    def _items(result):
        return node_result_items(result)

    @classmethod
    def _first(cls, result):
        return cls._items(result)[0]

    def _image(self, media):
        if not media:
            return None
        return self._first(self.load_image.load_image(image=media["input_path"]))

    def _video(self, media, motion_fps, duration_ms):
        """把导演侧的视频绑定物化成帧序列——**源视频与参考视频是同一条路**。

        - 有 `range_ms`（源视频 / 被编辑的那条）：按入出点裁剪，裁剪范围必须落在素材内；
        - 没有 `range_ms`（多参考里的参考视频）：从开头取，长度按分镜时长，
          素材不够就短（不拉伸时间），后面的补齐交给采样器。

        两者都只是"这一镜的那一个视频"，进 `ref_videos["ref_video_0"]`、编号 `<Video 1>`。
        """
        if not media:
            return None
        frame_range = media.get("range_ms")
        video = self._first(self.load_video.execute(file=media["input_path"]))
        if frame_range:
            start = float(frame_range.get("start", 0)) / 1000
            duration = float(frame_range.get("end", 0) - frame_range.get("start", 0)) / 1000
            video = video.as_trimmed(start, duration, strict_duration=True)
            if video is None:
                raise ValueError("Director source-video range is outside the video duration")
            requested_ms = frame_range.get("end", 0) - frame_range.get("start", 0)
        else:
            requested_ms = max(1, int(duration_ms))
        components = self._items(self.get_video_components.execute(video=video))
        frames, source_fps = components[0], components[2]
        if frames.shape[0] < 1:
            raise ValueError("Director source-video range contains no frames")
        source_fps = float(source_fps)
        if source_fps <= 0:
            raise ValueError("Director source video has an invalid frame rate")
        target_count = max(1, round(requested_ms * motion_fps / 1000))
        if not frame_range:
            # 参考视频：素材比这一镜短就按素材长度走，不拉长时间轴
            target_count = min(target_count, max(1, round(frames.shape[0] / source_fps * motion_fps)))
        return self._resample(frames, source_fps, motion_fps, target_count)

    def _audio(self, media, requested_duration_ms, effective_duration_ms):
        if not media:
            return None
        audio = self._first(self.load_audio.execute(audio=media["input_path"]))
        frame_range = media.get("range_ms")
        start = float((frame_range or {}).get("start", 0)) / 1000
        requested_ms = (
            float(frame_range["end"] - frame_range["start"])
            if frame_range
            else float(requested_duration_ms)
        )
        audio = self._first(
            self.trim_audio.EXECUTE_NORMALIZED(
                audio=audio,
                start_index=start,
                duration=requested_ms / 1000,
            )
        )
        waveform = audio["waveform"]
        sample_rate = int(audio["sample_rate"])
        target_samples = round(float(effective_duration_ms) * sample_rate / 1000)
        if waveform.shape[-1] < target_samples:
            padding = waveform.new_zeros(
                *waveform.shape[:-1], target_samples - waveform.shape[-1]
            )
            waveform = torch.cat((waveform, padding), dim=-1)
        elif waveform.shape[-1] > target_samples:
            waveform = waveform[..., :target_samples]
        return {"waveform": waveform, "sample_rate": sample_rate}

    @staticmethod
    def _resample(frames, source_fps, target_fps, target_count):
        """按目标帧率抽帧（不做时间拉伸：最后一帧会重复指向同一张，和源视频一致）。"""
        indices = torch.floor(
            torch.arange(target_count, device=frames.device) * source_fps / target_fps
        ).long().clamp(max=frames.shape[0] - 1)
        return frames[indices]

    def select(self, shots_json, shot_index):
        self._inject()
        spec = director_shot_spec(select_director_shot(shots_json, shot_index), shot_index)
        spec["first_frame"] = self._image(spec["first_frame"])
        spec["last_frame"] = self._image(spec["last_frame"])
        spec["reference_image_1"] = self._image(spec["reference_image_1"])
        spec["reference_image_2"] = self._image(spec["reference_image_2"])
        for index in range(3, 7):
            key = f"reference_image_{index}"
            spec[key] = self._image(spec.get(key))
        spec["edit_source_video"] = self._video(
            spec["edit_source_video"], spec["motion_fps"],
            spec["requested_duration_ms"],
        )
        spec["reference_video_1"] = self._video(
            spec.get("reference_video_1"), spec["motion_fps"],
            spec["requested_duration_ms"],
        )
        spec["reference_video_2"] = self._video(
            spec.get("reference_video_2"), spec["motion_fps"],
            spec["requested_duration_ms"],
        )
        for key in ("audio", "audio_2", "audio_3"):
            output_duration = (
                spec["requested_duration_ms"]
                if key == "audio" and spec.get("audio_driving")
                else spec["effective_model_duration_ms"]
            )
            spec[key] = self._audio(
                spec.get(key), spec["requested_duration_ms"], output_duration,
            )
        return (spec,)


class MiniMaxH3VideoShotSample:
    """Sample a materialized H3_SHOT through one of two explicit paths.

    Generation delegates to `MiniMaxH3VideoSample` and starts from its empty AV latent.
    `video_edit` conditions on `<Video 1>`, injects the same edit-source frames into the
    initial video latent, then samples with `denoise` as edit strength. Reference videos
    remain conditioning-only. Face/mask-local repaint stays in the dedicated refiner nodes
    until the formal Shot schema has an explicit reference-face or mask input.

    中文职责边界：

    - `full_frame`：当前已接通。源视频既作为 `<Video 1>` 条件，也注入初始 video latent；
      `denoise` 决定保留原视频与重新生成之间的强度。
    - `face`：人脸重绘预留。未来把 `edit_source_video + reference_face` 交给
      `H3FaceRefiner`，由它做人脸检测、跨帧追踪、局部重绘和回贴。
    - `mask`：语义区域重绘预留。未来优先读取正式 mask；没有 mask 时，可用
      `mask_prompt` 调 SAM3 得到逐帧/传播 mask，再交给 `H3MaskRefiner`。

    后两支现在故意明确报错，而不是退回全帧编辑。这样后续补齐 Shot schema 与测试前，
    不会把“只改脸/只改衣服”的请求误执行成整段视频重绘。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "vae": ("VAE",),
                "clip": ("CLIP",),
                "shot": ("H3_SHOT",),
                "seed": ("INT", {"default": DISPATCH_CONTRACT["seed"]["default"], "min": DISPATCH_CONTRACT["seed"]["minimum"], "max": 0xffffffffffffffff}),
                "steps": ("INT", {"default": DISPATCH_CONTRACT["steps"]["default"], "min": DISPATCH_CONTRACT["steps"]["minimum"], "max": DISPATCH_CONTRACT["steps"]["maximum"], "tooltip": "一阶段采样步数；默认 6 步，开启二采后追加默认 4 步。"}),
                "denoise": ("FLOAT", {"default": DISPATCH_CONTRACT["denoise"]["default"], "min": DISPATCH_CONTRACT["denoise"]["minimum"], "max": DISPATCH_CONTRACT["denoise"]["maximum"], "step": 0.01}),
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {"default": DISPATCH_CONTRACT["sampler_name"]["default"]}),
                "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {"default": DISPATCH_CONTRACT["scheduler"]["default"]}),
                "ref_image_size": (GLOBAL_CONTRACT["ref_image_sizes"], {"default": GLOBAL_CONTRACT["defaults"]["ref_image_size"]}),
                "output_generated_audio": ("BOOLEAN", {"default": False}),
                "latent_upscale": ("BOOLEAN", {"default": DISPATCH_CONTRACT["latent_upscale"]["default"]}),
                "latent_upscale_scale": ("FLOAT", {
                    "default": DISPATCH_CONTRACT["latent_upscale_scale"]["default"],
                    "min": DISPATCH_CONTRACT["latent_upscale_scale"]["minimum"],
                    "max": DISPATCH_CONTRACT["latent_upscale_scale"]["maximum"],
                    "step": 0.05,
                }),
            },
            "optional": {
                "sampling_profile": (["fast", "quality"], {"default": "fast", "tooltip": "quality 自动选择质量调度；需上游提供未加载 Turbo LoRA 的模型。二采仅由 latent_upscale 开启。"}),
                "auto_latent_upscale": ("BOOLEAN", {"default": True}),
                "second_pass_steps": ("INT", {
                    "default": 4, "min": 1, "max": 100,
                    "tooltip": "一阶段完成后追加的二采步数；默认 6 + 4，共 10 步。",
                }),
                "transition_step": ("INT", {
                    "default": 0, "min": 0, "max": 199,
                    "tooltip": "0 根据二采步数自动计算切换位置；非零指定第几步放大，两段各至少一步。",
                }),
                "preserve_audio_trajectory": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "二采延续生成音频的采样状态；驱动音频保持锁定。",
                }),
                "upscaler_unload": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "放大后卸载外部放大器（支持时）；关闭允许缓存，但显存不足时仍可能卸载。",
                }),
                "audio_vae": ("VAE",),
            },
        }

    RETURN_TYPES = ("IMAGE", "LATENT", "AUDIO")
    RETURN_NAMES = ("images", "sampled_latent", "audio")
    FUNCTION = "sample"
    CATEGORY = "zdx/sampling"

    @classmethod
    def IS_CHANGED(cls, **_kwargs):
        return float("nan")

    def __init__(self):
        self.sampler = MiniMaxH3VideoSample()
        self.video_injector = H3InjectVideoLatent()

    def _sample_face_repaint(self, *, shot, **_kwargs):
        """TODO：接入 H3FaceRefiner；正式启用前不做隐式全帧降级。"""
        if shot.get("reference_face") is None:
            raise ValueError("face repaint requires reference_face")
        raise NotImplementedError(
            "face repaint is reserved for H3FaceRefiner and is not enabled yet"
        )

    def _sample_mask_repaint(self, *, shot, **_kwargs):
        """TODO：正式 mask 优先；否则 mask_prompt → SAM3 → H3MaskRefiner。"""
        if shot.get("mask") is None and not str(shot.get("mask_prompt") or "").strip():
            raise ValueError("mask repaint requires mask or mask_prompt")
        # TODO(video-edit-mask):
        # 1. 有 shot["mask"]：校验帧数与 edit_source_video 一致；
        # 2. 只有 mask_prompt：调用 SAM3 对首帧/关键帧分割，并沿时间轴传播；
        # 3. 将 images / masks / optional reference_image 交给 H3MaskRefiner.refine；
        # 4. 跟踪或分割失败必须显式报错，不自动扩大成全帧编辑。
        raise NotImplementedError(
            "mask repaint is reserved for SAM3 + H3MaskRefiner and is not enabled yet"
        )

    def _sample_video_edit(
        self,
        *,
        model,
        vae,
        clip,
        audio_vae,
        shot,
        seed,
        steps,
        denoise,
        sampler_name,
        scheduler,
        ref_image_size,
        latent_upscale,
        latent_upscale_scale,
        output_generated_audio,
        auto_latent_upscale=True,
        second_pass_steps=4,
        transition_step=0,
        preserve_audio_trajectory=True,
        upscaler_unload=True,
        sigmas=None,
    ):
        source = shot.get("edit_source_video")
        if source is None:
            raise ValueError("video_edit requires edit_source_video")
        prepared_source = self.sampler._prepare_reference_video(
            source, shot["width"], shot["height"], shot["length"],
        )
        conditioning, latent, _ = self.sampler.build_conditioning(
            mode="r2v", clip=clip, vae=vae, audio_vae=audio_vae,
            prompt=shot["prompt"], width=shot["width"], height=shot["height"],
            length=shot["length"], ref_image_size=ref_image_size,
            reference_image_1=shot.get("reference_image_1"),
            reference_image_2=shot.get("reference_image_2"),
            reference_image_3=shot.get("reference_image_3"),
            reference_image_4=shot.get("reference_image_4"),
            reference_image_5=shot.get("reference_image_5"),
            reference_image_6=shot.get("reference_image_6"),
            reference_video_1=prepared_source,
            reference_video_2=shot.get("reference_video_1"),
            audio=shot.get("audio"), audio_2=shot.get("audio_2"),
            audio_3=shot.get("audio_3"),
        )
        latent = self.video_injector.run(latent, prepared_source, vae)[0]
        if shot.get("audio") is not None and shot.get("audio_driving"):
            latent = self.sampler.lock_audio_latent(latent, shot["audio"], audio_vae)
        sampling = dict(
            model=model, conditioning=conditioning, latent=latent, seed=seed,
            steps=steps, denoise=denoise, sampler_name=sampler_name,
            scheduler=scheduler,
        )
        if sigmas is not None:
            sampling["sigmas"] = sigmas
        if use_h3_two_pass(
            latent_upscale,
            shot["width"],
            shot["height"],
            auto_latent_upscale=auto_latent_upscale,
            total_steps=steps + second_pass_steps,
            second_pass_steps=second_pass_steps,
            transition_step=transition_step,
        ):
            sampling["total_steps"] = sampling.pop("steps") + second_pass_steps
            sampled = self.sampler.sample_latent_upscaled(
                **sampling,
                upscale_scale=latent_upscale_scale,
                second_pass_steps=second_pass_steps,
                transition_step=transition_step,
                preserve_audio_trajectory=preserve_audio_trajectory,
                upscaler_unload=upscaler_unload,
            )
        else:
            sampled = self.sampler.sample_latent(**sampling)
        generated = shot.get("output_generated_audio", output_generated_audio)
        output_audio = (
            shot.get("audio")
            if shot.get("passthrough_input_audio") else None
        )
        audio_source = "input" if output_audio is not None else "generated"
        if output_audio is None and generated:
            output_audio = self.sampler.decode_audio(sampled, audio_vae)
        if output_audio is not None:
            output_audio = self.sampler.checked_output_audio(output_audio, source=audio_source)
        return self.sampler.decode_video(sampled, vae), sampled, output_audio

    def sample(
        self, model, vae, clip, shot, seed, steps, denoise,
        sampler_name, scheduler, ref_image_size, output_generated_audio=False,
        latent_upscale=False,
        auto_latent_upscale=True,
        latent_upscale_scale=1.5,
        audio_vae=None,
        second_pass_steps=4,
        transition_step=0,
        preserve_audio_trajectory=True,
        upscaler_unload=True,
        context_latent=None,
        sampling_profile="fast",
    ):
        if sampling_profile not in ("fast", "quality"):
            raise ValueError("sampling_profile must be fast or quality")
        sigmas = None
        if sampling_profile == "quality":
            steps = len(QUALITY_SINGLE_SIGMAS) - 1
            sampler_name = "er_sde"
            scheduler = "beta"
            auto_latent_upscale = False
            if latent_upscale:
                # 一条16步beta调度切为10+6，不使用完整到0的手动一采。
                steps = 10
                second_pass_steps = 6
                transition_step = 0
            else:
                sigmas = torch.tensor(QUALITY_SINGLE_SIGMAS)
        required = {"mode", "prompt", "width", "height", "length"}
        missing = required - set(shot or {})
        if missing:
            raise ValueError(f"H3_SHOT is missing: {', '.join(sorted(missing))}")
        generated_audio = shot.get("output_generated_audio", output_generated_audio)
        continuity = shot.get("continuity") or {}
        continuity_enabled = bool(continuity.get("enabled", False))
        auto_latent_upscale = (
            auto_latent_upscale and not continuity_enabled
            and not shot.get("continuity_source", False)
        )
        project_id = str(shot.get("project_id") or "")
        sequence_index = int(continuity.get("sequence_index", 0))
        previous_shot_id = continuity.get("previous_shot_id")
        previous_fingerprint = continuity.get("previous_execution_fingerprint")
        if not continuity_enabled:
            context_latent = None
        if continuity_enabled:
            if shot["mode"] == "video_edit":
                raise ValueError("视频二创暂不支持帧间连续性；请关闭该分隔线的 ↔")
            if context_latent is None:
                if (
                    not project_id or sequence_index <= 0 or not previous_shot_id
                    or not previous_fingerprint
                ):
                    raise ValueError("帧间连续性缺少项目、序号或上一镜身份；请关闭后重新开启 ↔")
                context_latent = load_continuity_latent(
                    project_id=project_id,
                    sequence_index=sequence_index - 1,
                    expected_shot_id=str(previous_shot_id),
                    expected_execution_fingerprint=str(previous_fingerprint),
                )
        if shot["mode"] == "video_edit":
            # `edit_mode` 目前只由内部/测试夹具使用；正式 project schema 尚未开放。
            # 缺省始终走已经验证的全帧编辑，绝不凭 operation 猜测局部 mask。
            edit_mode = str(shot.get("edit_mode") or "full_frame")
            route = {
                "full_frame": self._sample_video_edit,
                "face": self._sample_face_repaint,
                "mask": self._sample_mask_repaint,
            }.get(edit_mode)
            if route is None:
                raise ValueError(f"unsupported video edit_mode: {edit_mode!r}")
            result = route(
                model=model, vae=vae, clip=clip, audio_vae=audio_vae,
                shot=shot, seed=seed, steps=steps, denoise=denoise,
                sampler_name=sampler_name, scheduler=scheduler,
                ref_image_size=ref_image_size, latent_upscale=latent_upscale,
                auto_latent_upscale=auto_latent_upscale,
                latent_upscale_scale=latent_upscale_scale,
                second_pass_steps=second_pass_steps,
                transition_step=transition_step,
                preserve_audio_trajectory=preserve_audio_trajectory,
                upscaler_unload=upscaler_unload,
                output_generated_audio=generated_audio,
                sigmas=sigmas,
            )
        else:
            result = self.sampler.sample(
                model=model,
                vae=vae,
                clip=clip,
                audio_vae=audio_vae,
                audio=shot.get("audio"),
                audio_2=shot.get("audio_2"),
                audio_3=shot.get("audio_3"),
                mode=shot["mode"],
                prompt=shot["prompt"],
                width=shot["width"],
                height=shot["height"],
                length=shot["length"],
                seed=seed,
                steps=steps,
                first_pass_steps=steps,
                denoise=denoise,
                sampler_name=sampler_name,
                scheduler=scheduler,
                ref_image_size=ref_image_size,
                audio_driving=bool(shot.get("audio_driving", True)),
                passthrough_input_audio=bool(shot.get("passthrough_input_audio", False)),
                output_generated_audio=generated_audio,
                latent_upscale=latent_upscale,
                auto_latent_upscale=auto_latent_upscale,
                latent_upscale_scale=latent_upscale_scale,
                second_pass_steps=second_pass_steps,
                transition_step=transition_step,
                preserve_audio_trajectory=preserve_audio_trajectory,
                upscaler_unload=upscaler_unload,
                context_latent=context_latent,
                context_frames=int(continuity.get("context_frames", 22)),
                audio_context_length=int(continuity.get("audio_context_length", 24)),
                output_trim_frames=int(continuity.get("output_trim_frames", 22)),
                first_frame=shot.get("first_frame"),
                last_frame=shot.get("last_frame"),
                reference_image_1=shot.get("reference_image_1"),
                reference_image_2=shot.get("reference_image_2"),
                reference_image_3=shot.get("reference_image_3"),
                reference_image_4=shot.get("reference_image_4"),
                reference_image_5=shot.get("reference_image_5"),
                reference_image_6=shot.get("reference_image_6"),
                reference_video_1=shot.get("reference_video_1"),
                reference_video_2=shot.get("reference_video_2"),
                sigmas=sigmas,
            )
        if project_id:
            save_continuity_latent(
                result[1], project_id=project_id, sequence_index=sequence_index,
                shot_id=str(shot.get("shot_id") or ""),
                execution_fingerprint=str(shot.get("execution_fingerprint") or ""),
            )
        return result


NODE_CLASS_MAPPINGS = {
    "ZDXH3ShotSelect": ZDXH3ShotSelect,
    "MiniMaxH3VideoShotSample": MiniMaxH3VideoShotSample,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "ZDXH3ShotSelect": "ZDX H3 Shot Select",
    "MiniMaxH3VideoShotSample": "ZDX MiniMax H3 Video Shot Sample",
}
