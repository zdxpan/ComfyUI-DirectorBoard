"""Tensor-level MiniMax H3 progressive sampling transitions (native VAE space)."""

import torch
import torch.nn.functional as F


def resize_keyframe_conditioning(conditioning, h, w):
    """Copy keyframes onto a spatial grid, preserving each channel/frame mean."""
    result = []
    for entry in conditioning:
        tensor, metadata, *trailing = entry
        if metadata.get("minimax_keyframes") is None:
            result.append(type(entry)((tensor, metadata, *trailing)))
            continue
        metadata = metadata.copy()
        keyframes = []
        for original in metadata["minimax_keyframes"]:
            keyframe = original.copy()
            latent = keyframe.get("latent")
            if latent is not None and latent.shape[-2:] != (h, w):
                if latent.ndim == 5:
                    b, c, t, lh, lw = latent.shape
                    frames = latent.float().permute(0, 2, 1, 3, 4).reshape(b * t, c, lh, lw)
                    resized = F.interpolate(frames, (h, w), mode="bilinear", align_corners=False)
                    resized = resized.reshape(b, t, c, h, w).permute(0, 2, 1, 3, 4)
                else:
                    resized = F.interpolate(latent.float(), (h, w), mode="bilinear", align_corners=False)
                resized += latent.float().mean((-2, -1), keepdim=True) - resized.mean((-2, -1), keepdim=True)
                keyframe["latent"] = resized.to(latent)
            keyframes.append(keyframe)
        metadata["minimax_keyframes"] = keyframes
        result.append(type(entry)((tensor, metadata, *trailing)))
    return result


def resize_video_mask(mask, samples):
    """Resize a video mask spatially, retaining singleton or per-channel masks."""
    if mask is None:
        return None
    if getattr(mask, "is_nested", False):
        mask = mask.unbind()[0]
    if mask.ndim == 3:
        mask = mask[:, None, None]
    elif mask.ndim == 4:
        mask = mask[:, None]
    if mask.ndim != 5 or mask.shape[1] not in (1, samples.shape[1]):
        raise ValueError("Video mask must have shape [B,H,W], [B,T,H,W], or [B,C,T,H,W] (C=1 or video channels)")
    if mask.shape[0] not in (1, samples.shape[0]) or mask.shape[2] not in (1, samples.shape[2]):
        raise ValueError("Video mask batch/time dimensions must match the video or be singleton")
    if not torch.isfinite(mask).all():
        raise ValueError("Video mask must be finite")
    b, c, t, h, w = mask.shape
    resized = F.interpolate(mask.float().reshape(b * c * t, 1, h, w), samples.shape[-2:], mode="bilinear", align_corners=False)
    return resized.reshape(b, c, t, *samples.shape[-2:]).to(samples.device).clamp(0, 1)


class _AudioResumeNoise:
    def __init__(self, noise, resume):
        self.noise = noise
        self.seed = noise.seed
        self.resume = resume

    def generate_noise(self, latent):
        generated = self.noise.generate_noise(latent)
        streams = list(generated.unbind())
        streams[1] = torch.where(self.resume.to(streams[1].device), torch.zeros_like(streams[1]), streams[1])
        return type(generated)(streams)


def prepare_audio_resume(first_state, upscaled_av, noise):
    """Resume generated audio from Comfy's inverse-scaled flow sampler output.

    H3's process_latent_out/in scaling cancels across the two passes. CONST
    noise scaling with zero new noise restores the split state:
    (1-sigma) * (state / (1-sigma)). Locked
    audio retains its clean anchor and normal noise for the inpaint wrapper.
    Partial audio masks cannot share a clean anchor and a resumed state in the
    standard sampler interface; reject them rather than corrupting the anchor.
    """
    samples = upscaled_av["samples"]
    if not getattr(samples, "is_nested", False):
        return upscaled_av, noise
    streams = list(samples.unbind())
    previous = first_state["samples"].unbind()
    if len(streams) != 2 or len(previous) != 2 or streams[1].shape != previous[1].shape:
        raise ValueError("Audio resume requires matching two-stream AV latent shapes")
    audio = streams[1]
    resume = torch.ones((audio.shape[0],) + (1,) * (audio.ndim - 1), dtype=torch.bool, device=audio.device)
    mask = upscaled_av.get("noise_mask")
    if mask is not None and getattr(mask, "is_nested", False):
        audio_mask = mask.unbind()[1].to(audio.device)
        if not torch.isfinite(audio_mask).all():
            raise ValueError("Audio mask must be finite")
        try:
            audio_mask = torch.broadcast_to(audio_mask, audio.shape)
        except RuntimeError as exc:
            raise ValueError("Audio resume requires an audio mask broadcastable to its latent") from exc
        flat = audio_mask.reshape(audio.shape[0], -1)
        locked, generated = (flat == 0).all(1), (flat == 1).all(1)
        if not (locked | generated).all():
            raise ValueError("Audio resume supports fully generated or fully locked audio per video; partial audio masks are unsupported")
        resume = generated.reshape(resume.shape)
    streams[1] = torch.where(resume, previous[1].to(audio), audio)
    result = upscaled_av.copy()
    result["samples"] = type(samples)(streams)
    return result, _AudioResumeNoise(noise, resume)
