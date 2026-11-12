"""Persist MiniMax H3 joint AV latents for cross-prompt shot continuity."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import tempfile

import torch


STORE_VERSION = 1


def safe_project_key(project_id: str) -> str:
    raw = str(project_id or "project")
    label = re.sub(r"[^A-Za-z0-9._-]+", "_", raw).strip("._-") or "project"
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]
    return f"{label[:48]}__{digest}"


def continuity_path(project_id: str, sequence_index: int, user_dir=None) -> Path:
    index = int(sequence_index)
    if index < 0:
        raise ValueError("continuity sequence_index must be non-negative")
    if user_dir is None:
        import folder_paths
        user_dir = folder_paths.get_user_directory()
    return Path(user_dir) / "zdx_continuity" / safe_project_key(project_id) / f"{index:04d}.pt"


def save_continuity_latent(
    latent,
    *,
    project_id: str,
    sequence_index: int,
    shot_id: str,
    execution_fingerprint: str,
    user_dir=None,
    streams_fn=None,
) -> Path:
    if streams_fn is None:
        from .h3_video_latent import av_streams
        streams_fn = av_streams
    video, audio = streams_fn(latent)
    target = continuity_path(project_id, sequence_index, user_dir)
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": STORE_VERSION,
        "project_id": str(project_id),
        "sequence_index": int(sequence_index),
        "shot_id": str(shot_id),
        "execution_fingerprint": str(execution_fingerprint),
        "video": video.detach().cpu(),
        "audio": audio.detach().cpu(),
    }
    temp_name = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=f".{target.name}.", suffix=".tmp", dir=target.parent, delete=False,
        ) as handle:
            temp_name = handle.name
        torch.save(payload, temp_name)
        os.replace(temp_name, target)
    finally:
        if temp_name and os.path.exists(temp_name):
            os.unlink(temp_name)
    return target


def load_continuity_latent(
    *,
    project_id: str,
    sequence_index: int,
    expected_shot_id: str,
    expected_execution_fingerprint: str,
    user_dir=None,
    nested_factory=None,
):
    source = continuity_path(project_id, sequence_index, user_dir)
    if not source.is_file():
        raise ValueError(
            f"上一镜连续性 latent 不存在：{source.name}；请先运行上一镜"
        )
    payload = torch.load(source, map_location="cpu", weights_only=True)
    if payload.get("version") != STORE_VERSION:
        raise ValueError("上一镜连续性 latent 版本不兼容；请重新运行上一镜")
    if payload.get("project_id") != str(project_id):
        raise ValueError("上一镜连续性 latent 项目不匹配；请重新运行上一镜")
    if int(payload.get("sequence_index", -1)) != int(sequence_index):
        raise ValueError("上一镜连续性 latent 序号不匹配；请重新运行上一镜")
    if payload.get("shot_id") != str(expected_shot_id):
        raise ValueError(
            f"上一镜连续性 latent 属于 {payload.get('shot_id')!r}，"
            f"当前需要 {expected_shot_id!r}；时间轴已变化，请重新运行上一镜"
        )
    if payload.get("execution_fingerprint") != str(expected_execution_fingerprint):
        raise ValueError(
            "上一镜连续性 latent 已过期（提示词、引用或参数已变化）；请重新运行上一镜"
        )
    video, audio = payload.get("video"), payload.get("audio")
    if not isinstance(video, torch.Tensor) or not isinstance(audio, torch.Tensor):
        raise ValueError("上一镜连续性 latent 文件损坏；请重新运行上一镜")
    if nested_factory is None:
        import comfy.nested_tensor
        nested_factory = comfy.nested_tensor.NestedTensor
    return {"samples": nested_factory((video, audio))}
