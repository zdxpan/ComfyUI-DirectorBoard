"""Unified MiniMax H3 video conditioning, sampling, and video decode node."""

import logging
import math
import time

import torch
import comfy.samplers
import nodes as _nodes
from nodes import MAX_RESOLUTION

from . import h3_sampling_transition as h3_transition

from .h3_context_pin import (
    append_context_keyframe,
    plan_context_pin,
    trim_context_head,
    with_context_report,
)

H3_MODES = ("t2v", "i2v", "fl2v", "r2v")
H3_LATENT_UPSCALE_SECOND_PASS_STEPS = 4
H3_LATENT_UPSCALE_MODEL = "minimax_h3_latent_upscaler_3d_fp16.safetensors"
H3_AUTO_TWO_PASS_MAX_PIXELS = 600_000


def use_h3_two_pass(
    latent_upscale, width, height, *, auto_latent_upscale=True,
    has_context=False, has_keyframes=False, total_steps=None,
    second_pass_steps=4, transition_step=0,
):
    """Honor forced two-pass requests; automatic selection needs a split budget."""
    if latent_upscale:
        return True
    if total_steps is not None and transition_step == 0 and total_steps <= second_pass_steps:
        return False
    return (
        auto_latent_upscale and not has_context and not has_keyframes
        and int(width) * int(height) < H3_AUTO_TWO_PASS_MAX_PIXELS
    )


def _value(result, index=0):
    try:
        return result[index]
    except KeyError:
        return result["result"][index]


def align_h3_frame_count(length):
    length = max(5, int(length))
    return length + (5 - length % 17) % 17


def pad_h3_video_frames(images, target_count):
    if images.shape[0] >= target_count:
        return images[:target_count]
    return torch.cat(
        (
            images,
            images[-1:].repeat(
                target_count - images.shape[0],
                *([1] * (images.ndim - 1)),
            ),
        ),
        dim=0,
    )


def validate_h3_mode_inputs(
    mode,
    first_frame=None,
    last_frame=None,
    reference_image_1=None,
    reference_image_2=None,
    reference_image_3=None,
    reference_image_4=None,
    reference_image_5=None,
    reference_image_6=None,
    reference_video_1=None,
    reference_video_2=None,
    audio=None,
    audio_2=None,
    audio_3=None,
):
    """校验"这一镜给了哪些输入"和模式是否自洽。

    两层判断，别混：

    1. `allowed` 是**白名单**——多给就报错（比如 t2v 收到参考图）；
    2. `required` 是**底线**——少给才报错。参考模式 r2v 的底线很低：

       | mode | 允许给 | 必须给 |
       |------|--------|--------|
       | t2v  | 无 | — |
       | i2v  | first_frame | first_frame |
       | fl2v | first_frame, last_frame | 两个都要 |
       | r2v  | 参考图 1–6、参考视频 1–2、音频 1–3 | **图、视频、音频至少一个** |

    也就是说 r2v 里参考图、参考视频、驱动音频可以组合，也可以只给其中一种。
    视频编辑不属于本节点；由 MiniMaxH3VideoShotSample 注入源视频 latent。
    """
    if mode not in H3_MODES:
        raise ValueError(f"Unsupported MiniMax H3 mode: {mode}")

    provided = {
        "first_frame": first_frame is not None,
        "last_frame": last_frame is not None,
        "reference_image_1": reference_image_1 is not None,
        "reference_image_2": reference_image_2 is not None,
        "reference_image_3": reference_image_3 is not None,
        "reference_image_4": reference_image_4 is not None,
        "reference_image_5": reference_image_5 is not None,
        "reference_image_6": reference_image_6 is not None,
        "reference_video_1": reference_video_1 is not None,
        "reference_video_2": reference_video_2 is not None,
        "audio": audio is not None,
        "audio_2": audio_2 is not None,
        "audio_3": audio_3 is not None,
    }
    reference_images = {f"reference_image_{index}" for index in range(1, 7)}
    reference_media = reference_images | {
        "reference_video_1", "reference_video_2", "audio", "audio_2", "audio_3",
    }
    allowed = {
        "t2v": set(),
        "i2v": {"first_frame"},
        "fl2v": {"first_frame", "last_frame"},
        "r2v": reference_media,
    }[mode]
    unexpected = [name for name, value in provided.items() if value and name not in allowed]
    if unexpected:
        raise ValueError(
            f"{mode} does not accept: {', '.join(unexpected)}"
        )

    if mode == "i2v" and first_frame is None:
        raise ValueError("i2v requires first_frame")
    if mode == "fl2v" and (first_frame is None or last_frame is None):
        raise ValueError("fl2v requires both first_frame and last_frame")
    if mode == "r2v" and reference_image_1 is None and reference_video_1 is None and audio is None:
        raise ValueError("r2v requires reference_image_1, reference_video_1, or audio")
    images = [
        reference_image_1, reference_image_2, reference_image_3,
        reference_image_4, reference_image_5, reference_image_6,
    ]
    for index, image in enumerate(images[1:], start=2):
        if image is not None and images[index - 2] is None:
            raise ValueError(f"reference_image_{index} requires reference_image_{index - 1}")
    if reference_video_2 is not None and reference_video_1 is None:
        raise ValueError("reference_video_2 requires reference_video_1")
    if audio_2 is not None and audio is None:
        raise ValueError("audio_2 requires audio")
    if audio_3 is not None and audio_2 is None:
        raise ValueError("audio_3 requires audio_2")
    for name, video in (("reference_video_1", reference_video_1), ("reference_video_2", reference_video_2)):
        if video is not None and (video.ndim != 4 or video.shape[0] < 5):
            raise ValueError(f"{name} must be an IMAGE batch with at least 5 frames")


class MiniMaxH3VideoSample:
    """Run generation modes with externally supplied reference resources."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "vae": ("VAE",),
                "clip": ("CLIP",),
                "mode": (H3_MODES, {"default": "t2v"}),
                "prompt": ("STRING", {"default": "", "multiline": True}),
                "width": ("INT", {"default": 768, "min": 32, "max": MAX_RESOLUTION, "step": 32}),
                "height": ("INT", {"default": 768, "min": 32, "max": MAX_RESOLUTION, "step": 32}),
                "length": ("INT", {"default": 73, "min": 5, "max": 3600, "step": 17}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "steps": ("INT", {"default": 10, "min": 1, "max": 100, "tooltip": "Total sampling steps; default two-pass allocation is 6 + 4."}),
                # 预留的扩展位：生成路径（从空 AV latent 出发、不注入原视频）只在 1.0 有意义，
                # <1 是给以后"注入原视频 latent 的重绘/精修"分支准备的，先不限制取值。
                "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {"default": "euler"}),
                "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {"default": "beta"}),
                "ref_image_size": (["match", "max"], {"default": "match"}),
                "audio_driving": ("BOOLEAN", {"default": True}),
                "passthrough_input_audio": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Return the primary input audio unchanged. Director enables this only for MV source audio.",
                }),
                "output_generated_audio": ("BOOLEAN", {"default": False}),
                "latent_upscale": ("BOOLEAN", {"default": False}),
                "latent_upscale_scale": ("FLOAT", {
                    "default": 1.5, "min": 1.0, "max": 2.0, "step": 0.05,
                }),
                # 分镜连续性：0 = 不钉。窗口只提供官方四档（5/22/39/56 都满足 17m+5，
                # 与 17k+5 的段长相减是 17 的倍数 → 相位自动对齐）。写字面量而不是常量，
                # 因为 INPUT_TYPES 会被测试单独 exec（那里没有模块级名字）。
                "context_frames": ("INT", {
                    "default": 22, "min": 0, "max": 56, "step": 17,
                    "tooltip": "钉上一镜尾部多少帧（0 = 关）。只支持 5/22/39/56，其它值就近吸附；"
                               "22 = 官方基线。本镜提交帧数应为「交付帧数 + 本窗口」，钉住那段解码后裁掉。",
                }),
                "audio_context_length": ("INT", {
                    "default": 24, "min": 0, "max": 240,
                    "tooltip": "声音往回够多少帧（0 = 不接声音）。24 = 正好 1 秒，落在模型 40Hz 音频网格上。",
                }),
            },
            "optional": {
                "auto_latent_upscale": ("BOOLEAN", {"default": True}),
                "sigmas": ("SIGMAS",),
                "second_pass_steps": ("INT", {
                    "default": 4, "min": 1, "max": 100,
                    "tooltip": "总步数中留给二采的步数；默认总共 10 步，分为一采 6 步、二采 4 步。",
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
                "context_latent": ("LATENT", {
                    "tooltip": "上一镜的成对 AV latent（画面+声音）：尾部钉在本镜开头当条件，解码后裁掉。",
                }),
                "audio": ("AUDIO",),
                "first_frame": ("IMAGE",),
                "last_frame": ("IMAGE",),
                "reference_image_1": ("IMAGE",),
                "reference_image_2": ("IMAGE",),
                "reference_image_3": ("IMAGE",),
                "reference_image_4": ("IMAGE",),
                "reference_image_5": ("IMAGE",),
                "reference_image_6": ("IMAGE",),
                "reference_video_1": ("IMAGE", {
                    "tooltip": "First reference clip, exposed as <Video 1>. FPS is controlled upstream."
                }),
                "reference_video_2": ("IMAGE", {"tooltip": "Second reference clip, exposed as <Video 2>."}),
                "audio_2": ("AUDIO",),
                "audio_3": ("AUDIO",),
            },
        }

    RETURN_TYPES = ("IMAGE", "LATENT", "AUDIO")
    RETURN_NAMES = ("images", "sampled_latent", "audio")
    FUNCTION = "sample"
    CATEGORY = "zdx/sampling"
    DESCRIPTION = (
        "Unified MiniMax H3 video sampler. t2v/i2v/fl2v require an FL2VA model; "
        "r2v requires a Ref2VA model. Models, LoRAs, and FPS are managed upstream. "
        "An optional audio input is always a Ref2VA reference. With audio_driving enabled it "
        "is also locked into the AV latent and returned exactly; otherwise the sampled audio "
        "is decoded only when output_generated_audio is enabled. "
        "Video inputs are references or the source clip being edited, as described by the prompt. "
        "They ride through the same reference encoder as <Video N>; no video latent is injected "
        "(local repaint lives in the refiner "
        "nodes, which do inject the source frames)."
    )

    def __init__(self):
        self.image_to_video = None
        self.reference_to_video = None
        self.image_scale = None
        self.random_noise = None
        self.sampler_select = None
        self.scheduler_node = None
        self.guider = None
        self.sampler = None
        self.vae_decode = None
        self.audio_encode = None
        self.audio_decode = None
        self.split_sigmas = None
        self.separate_av = None
        self.latent_upscaler = None
        self.concat_av = None

    _SAMPLING_DEPS = {
        "scheduler_node": "BasicScheduler",
        "guider": "BasicGuider",
        "sampler_select": "KSamplerSelect",
        "random_noise": "RandomNoise",
        "sampler": "SamplerCustomAdvanced",
    }
    _DECODE_DEPS = {
        "vae_decode": "VAEDecode",
    }
    _AUDIO_ENCODE_DEPS = {
        "audio_encode": "LTXVAudioVAEEncode",
    }
    _AUDIO_DECODE_DEPS = {
        "audio_decode": "VAEDecodeAudio",
        "separate_av": "LTXVSeparateAVLatent",
    }
    _LATENT_UPSCALE_DEPS = {
        "split_sigmas": "SplitSigmas",
        "separate_av": "LTXVSeparateAVLatent",
        "latent_upscaler": "MinimaxH3LatentUpscaler3D",
        "concat_av": "LTXVConcatAVLatent",
    }

    def _inject(self, deps):
        for attr, node_name in deps.items():
            if getattr(self, attr, None) is None:
                setattr(self, attr, _nodes.NODE_CLASS_MAPPINGS[node_name]())

    def _prepare_reference_video(self, source_video, width, height, length):
        self._inject({"image_scale": "ImageScale"})
        source_video = _value(
            self.image_scale.upscale(
                image=source_video,
                upscale_method="lanczos",
                width=width,
                height=height,
                crop="center",
            )
        )
        return pad_h3_video_frames(source_video, length)

    def build_conditioning(
        self,
        *,
        mode,
        clip,
        vae,
        prompt,
        width,
        height,
        length,
        ref_image_size="match",
        first_frame=None,
        last_frame=None,
        reference_image_1=None,
        reference_image_2=None,
        reference_image_3=None,
        reference_image_4=None,
        reference_image_5=None,
        reference_image_6=None,
        reference_video_1=None,
        reference_video_2=None,
        audio_vae=None,
        audio=None,
        audio_2=None,
        audio_3=None,
    ):
        self._inject({"image_to_video": "MiniMaxH3ImageToVideo", "reference_to_video": "MiniMaxH3ReferenceToVideo"})
        if width < 32 or height < 32 or width > MAX_RESOLUTION or height > MAX_RESOLUTION:
            raise ValueError(
                f"MiniMax H3 width and height must be between 32 and {MAX_RESOLUTION}"
            )
        if width % 32 or height % 32:
            raise ValueError("MiniMax H3 width and height must be divisible by 32")
        length = align_h3_frame_count(length)
        if length > 3600:
            raise ValueError("MiniMax H3 aligned frame count exceeds 3600")
        validate_h3_mode_inputs(
            mode,
            first_frame,
            last_frame,
            reference_image_1,
            reference_image_2,
            reference_image_3,
            reference_image_4,
            reference_image_5,
            reference_image_6,
            reference_video_1,
            reference_video_2,
            audio,
            audio_2,
            audio_3,
        )
        if audio is not None and audio_vae is None:
            raise ValueError("audio requires audio_vae")

        if mode in {"t2v", "i2v", "fl2v"}:
            result = self.image_to_video.EXECUTE_NORMALIZED(
                clip=clip,
                vae=vae,
                prompt=prompt,
                width=width,
                height=height,
                length=length,
                first_frame=first_frame if mode != "t2v" else None,
                last_frame=last_frame if mode == "fl2v" else None,
            )
            return _value(result, 0), _value(result, 1), length

        reference_images = (
            reference_image_1, reference_image_2, reference_image_3,
            reference_image_4, reference_image_5, reference_image_6,
        )
        references = {
            f"ref_image_{index}": image
            for index, image in enumerate(reference_images)
            if image is not None
        }
        # source/reference 视频走同一个官方 ref_videos 编码器和同一条 <Video N> 序列；
        # 是否是待编辑源视频由任务与提示词表达，不额外注入视频 latent。
        ref_videos = {
            f"ref_video_{index}": self._prepare_reference_video(video, width, height, length)
            for index, video in enumerate((reference_video_1, reference_video_2))
            if video is not None
        }
        ref_audios = {
            f"ref_audio_{index}": value
            for index, value in enumerate((audio, audio_2, audio_3))
            if value is not None
        }

        result = self.reference_to_video.EXECUTE_NORMALIZED(
            clip=clip,
            vae=vae,
            audio_vae=audio_vae,
            prompt=prompt,
            width=width,
            height=height,
            length=length,
            ref_image_size=ref_image_size,
            ref_images=references or None,
            ref_videos=ref_videos or None,
            ref_audios=ref_audios or None,
        )
        # 这里仍不注入视频 latent；audio 驱动会在 conditioning 建好后只替换并锁定音频流。
        # 局部重绘/增强才会把原视频 crop 编码后盖进视频 latent。
        return _value(result, 0), _value(result, 1), length

    def lock_audio_latent(self, latent, audio, audio_vae):
        """Replace and freeze the audio stream while leaving video fully denoisable."""
        samples = latent.get("samples")
        if samples is None or not getattr(samples, "is_nested", False):
            raise ValueError("audio driving requires a joint MiniMax H3 AV latent")
        streams = samples.unbind()
        if len(streams) < 2:
            raise ValueError("audio driving requires both video and audio latent streams")

        self._inject(self._AUDIO_ENCODE_DEPS)
        encoded = _value(
            self.audio_encode.EXECUTE_NORMALIZED(audio=audio, audio_vae=audio_vae)
        )["samples"]
        video_latent, audio_template = streams[:2]
        if encoded.shape[:-1] != audio_template.shape[:-1]:
            raise ValueError(
                "Encoded audio latent shape does not match the H3 audio template: "
                f"{tuple(encoded.shape)} vs {tuple(audio_template.shape)}"
            )
        target_length = audio_template.shape[-1]
        if encoded.shape[-1] > target_length:
            encoded = encoded[..., :target_length]
        elif encoded.shape[-1] < target_length:
            padding = encoded.new_zeros(*encoded.shape[:-1], target_length - encoded.shape[-1])
            encoded = torch.cat((encoded, padding), dim=-1)

        nested_type = type(samples)
        locked = dict(latent)
        locked["samples"] = nested_type((video_latent, encoded))
        locked["noise_mask"] = nested_type(
            (torch.ones_like(video_latent), torch.zeros_like(encoded))
        )
        return locked

    @staticmethod
    def _validate_explicit_sigmas(sigmas, name):
        if (
            not isinstance(sigmas, torch.Tensor) or sigmas.ndim != 1
            or sigmas.numel() < 2 or not torch.isfinite(sigmas).all()
            or (sigmas < 0).any() or (sigmas > 1).any()
            or (sigmas[1:] > sigmas[:-1]).any()
            or float(sigmas[0]) <= 0 or float(sigmas[-1]) != 0
        ):
            raise ValueError(f"{name} must be a finite descending H3 schedule in [0, 1], ending at zero")

    def sample_latent(
        self,
        *,
        model,
        conditioning,
        latent,
        seed,
        steps,
        denoise,
        sampler_name,
        scheduler,
        sigmas=None,
    ):
        sampling_deps = dict(self._SAMPLING_DEPS)
        if sigmas is not None:
            sampling_deps.pop("scheduler_node")
        self._inject(sampling_deps)
        if sigmas is None:
            sigmas = _value(self.scheduler_node.EXECUTE_NORMALIZED(
                scheduler=scheduler, steps=steps, denoise=denoise, model=model,
            ))
        else:
            self._validate_explicit_sigmas(sigmas, "sigmas")
        guider = self.guider.EXECUTE_NORMALIZED(
            model=model,
            conditioning=conditioning,
        )
        sampler = _value(
            self.sampler_select.EXECUTE_NORMALIZED(sampler_name=sampler_name)
        )
        sampled = self.sampler.EXECUTE_NORMALIZED(
            noise=_value(self.random_noise.EXECUTE_NORMALIZED(noise_seed=seed)),
            guider=_value(guider),
            sampler=sampler,
            sigmas=sigmas,
            latent_image=latent,
        )
        return _value(sampled, 0)

    @staticmethod
    def _has_keyframe_conditioning(conditioning):
        for item in conditioning:
            if (
                isinstance(item, (list, tuple))
                and len(item) >= 2
                and isinstance(item[1], dict)
                and item[1].get("minimax_keyframes")
            ):
                return True
        return False

    def _upscale_video_latent(self, video_latent, *, scale, unload):
        """Adapt the installed upscaler's optional version-specific inputs."""
        if scale == 1.0:
            return video_latent.copy()

        import inspect

        # Older nodes expose enable_chunking; newer versions use the temporal name.
        # An unavailable signature only permits the stable, required arguments.
        try:
            parameters = set(inspect.signature(self.latent_upscaler.execute).parameters)
        except (AttributeError, TypeError, ValueError):
            parameters = set()
        kwargs = {
            "latent": video_latent,
            "model_name": H3_LATENT_UPSCALE_MODEL,
            "mode": {"mode": "scale by multiplier", "scale": float(scale)},
            "align": 32,
            "device": "cuda",
            "precision": "fp16",
        }
        if "enable_temporal_chunking" in parameters:
            kwargs["enable_temporal_chunking"] = True
        elif "enable_chunking" in parameters:
            kwargs["enable_chunking"] = True
        if "force_unload" in parameters:
            kwargs["force_unload"] = bool(unload)
        elif not unload:
            logging.warning(
                "[H3 two-pass] installed upscaler has no force_unload option; "
                "residency is controlled by that node"
            )
        return _value(self.latent_upscaler.EXECUTE_NORMALIZED(**kwargs))

    def sample_latent_upscaled(
        self,
        *,
        model,
        conditioning,
        latent,
        seed,
        denoise,
        sampler_name,
        scheduler,
        upscale_scale,
        total_steps=None,
        steps=None,
        second_pass_steps=4,
        transition_step=0,
        preserve_audio_trajectory=True,
        upscaler_unload=True,
    ):
        """Sample a total step budget across the original and enlarged canvas.

        Internal callers supply total_steps. The legacy steps keyword means
        first-pass steps and is converted once at this compatibility boundary.
        Supplying both step conventions is ambiguous and rejected.
        """
        if total_steps is not None and steps is not None:
            raise ValueError("Specify total_steps or legacy steps, not both")
        if not isinstance(second_pass_steps, int) or second_pass_steps < 1:
            raise ValueError("second_pass_steps must be a positive integer")
        if total_steps is None:
            if not isinstance(steps, int) or steps < 1:
                raise ValueError("legacy steps must be a positive integer")
            total_steps = steps + second_pass_steps
        if not isinstance(total_steps, int) or total_steps < 1:
            raise ValueError("total_steps must be a positive integer")
        first_pass_steps = total_steps - second_pass_steps
        split_step = transition_step if transition_step != 0 else first_pass_steps
        if not math.isfinite(upscale_scale) or upscale_scale < 1.0:
            raise ValueError("latent_upscale_scale must be finite and at least 1")
        if not isinstance(split_step, int) or not 1 <= split_step < total_steps:
            raise ValueError(
                "transition_step must leave at least one step in each pass; "
                "when transition_step=0, total_steps must exceed second_pass_steps"
            )
        if denoise == 0:
            return latent
        self._inject(self._SAMPLING_DEPS)
        deps = dict(self._LATENT_UPSCALE_DEPS)
        if upscale_scale == 1.0:
            # Same-size refinement must not load a learned upscaler or its weights.
            deps.pop("latent_upscaler")
        try:
            self._inject(deps)
        except KeyError as exc:
            raise RuntimeError(
                "MiniMax H3 two-pass sampling requires SplitSigmas, LTXV AV latent nodes, "
                "and (for scale > 1) MinimaxH3LatentUpscaler3D"
            ) from exc

        sigmas = _value(self.scheduler_node.EXECUTE_NORMALIZED(
            scheduler=scheduler,
            steps=total_steps,
            denoise=denoise,
            model=model,
        ))
        if sigmas.ndim != 1 or sigmas.numel() != total_steps + 1:
            raise ValueError("H3 two-pass scheduler must return total_steps + 1 sigmas")
        if (
            not torch.isfinite(sigmas).all()
            or (sigmas < 0).any()
            or (sigmas[1:] > sigmas[:-1]).any()
        ):
            raise ValueError("H3 two-pass sigmas must be finite, nonnegative and non-increasing")
        if not 0 < float(sigmas[split_step]) < 1:
            raise ValueError("H3 two-pass transition sigma must lie strictly between 0 and 1")
        split = self.split_sigmas.EXECUTE_NORMALIZED(step=split_step, sigmas=sigmas)
        first_sigmas = _value(split, 0)
        second_sigmas = _value(split, 1)
        noise = _value(self.random_noise.EXECUTE_NORMALIZED(noise_seed=seed))
        sampler = _value(self.sampler_select.EXECUTE_NORMALIZED(sampler_name=sampler_name))
        has_keyframes = self._has_keyframe_conditioning(conditioning)
        first_conditioning = conditioning
        if has_keyframes:
            input_video = latent["samples"].unbind()[0]
            first_conditioning = h3_transition.resize_keyframe_conditioning(
                conditioning, *input_video.shape[-2:],
            )
        first_guider = _value(self.guider.EXECUTE_NORMALIZED(
            model=model,
            conditioning=first_conditioning,
        ))
        logging.info(
            "[H3 two-pass] low_steps=%d high_steps=%d transition_sigma=%.6f scale=%.3f "
            "preserve_audio=%s upscaler_unload=%s",
            split_step, total_steps - split_step, float(sigmas[split_step]), upscale_scale,
            preserve_audio_trajectory, upscaler_unload,
        )
        started = time.perf_counter()
        first = self.sampler.EXECUTE_NORMALIZED(
            noise=noise,
            guider=first_guider,
            sampler=sampler,
            sigmas=first_sigmas,
            latent_image=latent,
        )
        sampled_at = time.perf_counter()
        first_state = _value(first, 0)
        first_denoised = _value(first, 1)
        separated = self.separate_av.EXECUTE_NORMALIZED(av_latent=first_denoised)
        video_latent, audio_latent = _value(separated, 0), _value(separated, 1)
        upscaled_video = self._upscale_video_latent(
            video_latent,
            scale=upscale_scale,
            unload=upscaler_unload,
        )
        if video_latent.get("noise_mask") is not None:
            upscaled_video = dict(upscaled_video)
            upscaled_video["noise_mask"] = h3_transition.resize_video_mask(
                video_latent["noise_mask"], upscaled_video["samples"],
            )
        upscaled_av = _value(self.concat_av.EXECUTE_NORMALIZED(
            video_latent=upscaled_video,
            audio_latent=audio_latent,
        ))
        second_noise = noise
        if preserve_audio_trajectory:
            upscaled_av, second_noise = h3_transition.prepare_audio_resume(
                first_state, upscaled_av, noise,
            )
        del first, first_state, first_denoised  # Release the low-resolution sampled video state.
        second_conditioning = conditioning
        if has_keyframes:
            second_conditioning = h3_transition.resize_keyframe_conditioning(
                conditioning, *upscaled_video["samples"].shape[-2:],
            )
        # Reuse the guider unless keyframe resizing changed its conditioning.
        # ComfyUI retains the denoiser when memory allows; do not globally pin VRAM.
        second_guider = first_guider
        if second_conditioning is not first_conditioning:
            second_guider = _value(self.guider.EXECUTE_NORMALIZED(
                model=model,
                conditioning=second_conditioning,
            ))
        lifted_at = time.perf_counter()
        second = self.sampler.EXECUTE_NORMALIZED(
            noise=second_noise,
            guider=second_guider,
            sampler=sampler,
            sigmas=second_sigmas,
            latent_image=upscaled_av,
        )
        logging.info(
            "[H3 two-pass] host elapsed: low=%.2fs transition=%.2fs high=%.2fs; video=%s -> %s",
            sampled_at - started, lifted_at - sampled_at, time.perf_counter() - lifted_at,
            tuple(video_latent["samples"].shape), tuple(upscaled_video["samples"].shape),
        )
        return _value(second, 1)

    def decode_video(self, sampled_latent, vae):
        self._inject(self._DECODE_DEPS)
        return _value(self.vae_decode.decode(samples=sampled_latent, vae=vae))

    def decode_audio(self, sampled_latent, audio_vae):
        self._inject(self._AUDIO_DECODE_DEPS)
        # VAEDecodeAudio needs the audio stream, not the joint AV latent.
        audio_latent = _value(
            self.separate_av.EXECUTE_NORMALIZED(av_latent=sampled_latent), 1
        )
        return _value(
            self.audio_decode.EXECUTE_NORMALIZED(
                samples=audio_latent,
                vae=audio_vae,
            )
        )

    @staticmethod
    def checked_output_audio(audio, *, source):
        """Drop audio that VHS cannot safely pass to its f32le AAC encoder."""
        def omit(reason):
            logging.warning("H3 %s audio omitted: %s; video will export without audio", source, reason)
            return None

        if not isinstance(audio, dict):
            return omit("AUDIO value is not a dictionary")
        waveform = audio.get("waveform")
        sample_rate = audio.get("sample_rate")
        if not isinstance(waveform, torch.Tensor) or not waveform.is_floating_point():
            return omit("waveform is not a floating-point tensor")
        if waveform.ndim != 3 or waveform.shape[0] != 1 or not 1 <= waveform.shape[1] <= 8 or waveform.shape[2] == 0:
            return omit(f"invalid waveform shape {tuple(waveform.shape)}")
        if not isinstance(sample_rate, int) or sample_rate <= 0:
            return omit(f"invalid sample rate {sample_rate!r}")
        if not torch.isfinite(waveform).all().item():
            return omit("waveform contains NaN or Inf")
        peak = waveform.detach().abs().max().item()
        if peak > 16:
            return omit(f"waveform peak {peak:.3g} exceeds safe range")
        if waveform.dtype != torch.float32 or waveform.device.type != "cpu" or waveform.requires_grad:
            return {**audio, "waveform": waveform.detach().to(device="cpu", dtype=torch.float32)}
        return audio

    @torch.no_grad()
    def sample(
        self,
        model,
        vae,
        clip,
        mode,
        prompt,
        width,
        height,
        length,
        seed,
        steps,
        denoise,
        sampler_name,
        scheduler,
        ref_image_size,
        audio_driving=True,
        passthrough_input_audio=True,
        output_generated_audio=False,
        latent_upscale=False,
        auto_latent_upscale=True,
        latent_upscale_scale=1.5,
        audio_vae=None,
        audio=None,
        audio_2=None,
        audio_3=None,
        context_latent=None,
        context_frames=None,
        audio_context_length=None,
        output_trim_frames=None,
        first_frame=None,
        last_frame=None,
        reference_image_1=None,
        reference_image_2=None,
        reference_image_3=None,
        reference_image_4=None,
        reference_image_5=None,
        reference_image_6=None,
        reference_video_1=None,
        reference_video_2=None,
        second_pass_steps=4,
        transition_step=0,
        preserve_audio_trajectory=True,
        upscaler_unload=True,
        first_pass_steps=None,
        sigmas=None,
    ):
        if (any(value is not None for value in (audio, audio_2, audio_3)) or output_generated_audio) and audio_vae is None:
            raise ValueError("audio_vae is required for audio driving or generated audio output")
        context = None
        if context_latent is not None:
            context = plan_context_pin(
                context_latent=context_latent,
                context_frames=context_frames,
                audio_context_length=audio_context_length,
                width=width, height=height,
                # 传对齐后的帧数：build_conditioning 内部也会对齐，用请求值会过度拒绝
                length=align_h3_frame_count(length),
                has_first_frame=first_frame is not None,
                latent_upscale=latent_upscale,
                audio_driving=audio is not None and audio_driving,
            )
        conditioning, latent, _ = self.build_conditioning(
            mode=mode,
            clip=clip,
            vae=vae,
            prompt=prompt,
            width=width,
            height=height,
            length=length,
            ref_image_size=ref_image_size,
            first_frame=first_frame,
            last_frame=last_frame,
            reference_image_1=reference_image_1,
            reference_image_2=reference_image_2,
            reference_image_3=reference_image_3,
            reference_image_4=reference_image_4,
            reference_image_5=reference_image_5,
            reference_image_6=reference_image_6,
            reference_video_1=reference_video_1,
            reference_video_2=reference_video_2,
            audio_vae=audio_vae,
            audio=audio,
            audio_2=audio_2,
            audio_3=audio_3,
        )
        if context is not None:
            conditioning = append_context_keyframe(conditioning, context["keyframe"])
        if audio is not None and audio_driving:
            latent = self.lock_audio_latent(latent, audio, audio_vae)
        sampling_kwargs = {
            "model": model,
            "conditioning": conditioning,
            "latent": latent,
            "seed": seed,
            "steps": steps,
            "denoise": denoise,
            "sampler_name": sampler_name,
            "scheduler": scheduler,
        }
        # Manual sigmas are single-pass only; never silently discard them.
        if sigmas is not None:
            self._validate_explicit_sigmas(sigmas, "sigmas")
            if latent_upscale:
                raise ValueError("Explicit sigmas are supported only for single-pass sampling")
            auto_latent_upscale = False
        # Shot Sample supplies a first-stage budget; the standalone node keeps
        # its total-budget interface. Resolve only after conditioning is ready.
        two_pass_total = steps if first_pass_steps is None else first_pass_steps + second_pass_steps
        if use_h3_two_pass(
            latent_upscale, width, height,
            auto_latent_upscale=auto_latent_upscale,
            total_steps=two_pass_total,
            second_pass_steps=second_pass_steps,
            transition_step=transition_step,
            has_context=context is not None,
            has_keyframes=mode in ("i2v", "fl2v") or first_frame is not None or last_frame is not None,
        ):
            sampling_kwargs.pop("steps")
            sampling_kwargs["total_steps"] = two_pass_total
            sampled_latent = self.sample_latent_upscaled(
                **sampling_kwargs,
                upscale_scale=latent_upscale_scale,
                second_pass_steps=second_pass_steps,
                transition_step=transition_step,
                preserve_audio_trajectory=preserve_audio_trajectory,
                upscaler_unload=upscaler_unload,
            )
        else:
            if sigmas is not None:
                sampling_kwargs["sigmas"] = sigmas
            sampled_latent = self.sample_latent(**sampling_kwargs)
        output_audio = (
            audio
            if audio is not None and audio_driving and passthrough_input_audio
            else None
        )
        audio_source = "input" if output_audio is not None else "generated"
        if output_audio is None and output_generated_audio:
            output_audio = self.decode_audio(sampled_latent, audio_vae)
        images = self.decode_video(sampled_latent, vae)
        if context is not None:
            # 钉住的头部是上一镜的条件行、不是这一镜的内容：整段裁掉（画面与声音同一时刻）。
            trim_frames = max(
                context["pinned_frames"],
                int(output_trim_frames or context["pinned_frames"]),
            )
            images, output_audio = trim_context_head(images, output_audio, trim_frames)
            sampled_latent = with_context_report(
                sampled_latent, {**context, "output_trim_frames": trim_frames},
            )
        if output_audio is not None:
            output_audio = self.checked_output_audio(output_audio, source=audio_source)
        return images, sampled_latent, output_audio


NODE_CLASS_MAPPINGS = {"MiniMaxH3VideoSample": MiniMaxH3VideoSample}
NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3VideoSample": "ZDX MiniMax H3 Video Sample"
}
