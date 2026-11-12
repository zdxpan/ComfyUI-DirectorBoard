"""Shared MiniMax H3 video-latent utilities."""

import comfy.nested_tensor


def av_streams(latent):
    """取出 H3 成对 AV latent 的 `(视频 [B,24,T,H,W], 音频)` 两条流。

    用 `unbind()` 而不是 `pack_latents`：后者会把两条流拍平，之后就没法分别往回取尾部。
    严格要两条流、且视频流必须是 5 维带 batch——下游按 `shape[2]` 取时间轴，四维输入会
    静默切错轴，所以这里就拒掉，而不是让调用方各自猜。
    """
    samples = (latent or {}).get("samples")
    if samples is None:
        raise KeyError('LATENT is missing "samples".')
    is_nested = isinstance(samples, comfy.nested_tensor.NestedTensor) or getattr(
        samples, "is_nested", False
    )
    if not is_nested:
        raise ValueError(
            "Expected a MiniMax H3 joint AV latent (NestedTensor). Feed the LATENT output "
            "of MiniMaxH3ReferenceToVideo / EmptyMiniMaxH3LatentAV."
        )
    members = list(samples.unbind())
    if len(members) != 2:
        raise ValueError(
            f"Expected a joint AV latent with exactly 2 streams, got {len(members)}. "
            "Do not pack the picture and sound streams into one tensor."
        )
    video = members[0]
    if video.ndim != 5:
        raise ValueError(
            f"Expected the video stream as [B,24,T,H,W], got {tuple(video.shape)}. "
            "The temporal axis is shape[2]; a 4-D stream would be sliced on the wrong axis."
        )
    return video, members[1]


class H3InjectVideoLatent:
    """Replace the video stream of an H3 joint AV latent with encoded frames."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "av_latent": ("LATENT",),
                "images": ("IMAGE",),
                "vae": ("VAE",),
            },
        }

    RETURN_TYPES = ("LATENT", "STRING")
    RETURN_NAMES = ("av_latent", "report")
    FUNCTION = "run"
    CATEGORY = "MiniMax H3/Video"
    DESCRIPTION = "Encode real frames into the video stream of an H3 joint AV latent."

    def run(self, av_latent, images, vae):
        samples = av_latent.get("samples")
        if samples is None:
            raise KeyError('LATENT is missing "samples".')
        is_nested = isinstance(samples, comfy.nested_tensor.NestedTensor) or getattr(
            samples, "is_nested", False
        )
        if not is_nested:
            raise ValueError(
                "Expected a MiniMax H3 joint AV latent (NestedTensor). Feed the LATENT output "
                "of MiniMaxH3ReferenceToVideo / EmptyMiniMaxH3LatentAV."
            )

        members = list(samples.unbind())
        video_template = members[0]
        encoded = vae.encode(images[..., :3])
        if encoded.ndim == 4:
            encoded = encoded.unsqueeze(0).movedim(1, 2)

        target_t, target_h, target_w = video_template.shape[-3:]
        actual_t, actual_h, actual_w = encoded.shape[-3:]
        if (actual_h, actual_w) != (target_h, target_w):
            raise ValueError(
                f"Spatial latent mismatch: encoded {actual_h}x{actual_w} but the AV latent "
                f"expects {target_h}x{target_w}. Use a matching 32-aligned canvas."
            )

        if actual_t != target_t:
            raise ValueError(
                f"Temporal latent mismatch: encoded t={actual_t} but the H3 latent expects "
                f"t={target_t}. Use the same 17k+5 frame count and MiniMax H3 video VAE "
                "for conditioning and source-video injection."
            )

        members[0] = encoded.to(video_template.device, video_template.dtype)
        out = dict(av_latent)
        out["samples"] = comfy.nested_tensor.NestedTensor(tuple(members))
        report = (
            f"injected video latent {tuple(encoded.shape)} into AV latent "
            f"(streams={len(members)})\n"
            f"frames_in={images.shape[0]}  {images.shape[2]}x{images.shape[1]}px"
        )
        return out, report
