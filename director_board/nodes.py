"""Director Board nodes: validated project JSON plus the archived dispatch node.

执行路径见 docs/director-board-design.md：前端为每一镜单独构造
`ZDXH3ShotSelect` + `MiniMaxH3VideoShotSample` 子图并逐条提交，
本模块只负责项目 JSON 的校验与归一化（`ZDXDirectorBoard`）。
`DirectorDispatch` 的循环实现已移入 `dispatch_archive.py`（归档，不注册）。
"""
from __future__ import annotations

from .model import SCHEMA, parse_project_json

_DEFAULT_PROJECT = (
    '{"schema":"' + SCHEMA + '","project":{"id":"project","title":"未命名成片","brief":"","template_id":"free","skill_id":"free"},'
    '"canvas":{"aspect_ratio":"16:9","width":1344,"height":768},"global":{"audio_policy":"generated"},'
    '"assets":[],"shots":[{"id":"shot1","title":"分镜 1","task_type":"text_to_video","duration_ms":5000,"prompt":"","selected_for_generation":true,"unselected_policy":"skip","bindings":[]}],"shot_results":{},"selected_shot_id":"shot1"}'
)

class ZDXDirectorBoard:
    """Validate and resolve a Director Board project without loading media."""
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "project_json": ("STRING", {"default": _DEFAULT_PROJECT, "multiline": True})
            },
            # 连线锚点：前端在构造单镜子图时从这里读模型来源。
            # 它们不参与执行、不作为输出，接上也不会自己触发任何调度。
            "optional": {
                "model": ("MODEL",),
                "vae": ("VAE",),
                "clip": ("CLIP",),
                "audio_vae": ("VAE",),
            },
        }
    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("project_json", "shots_json", "selected_shot_json")
    FUNCTION = "build"
    CATEGORY = "zdx/director"
    def build(self, project_json: str, model=None, vae=None, clip=None, audio_vae=None):
        # model/vae/clip/audio_vae 只是锚点，这里刻意忽略；ComfyUI 需要签名能接住它们。
        # Invalid JSON intentionally propagates as a regular node error.
        return parse_project_json(project_json).outputs()


class DirectorDispatch:
    """归档节点：一次执行跑 N 镜的服务端循环调度。

    当前单发架构不使用它：
    前端会为每一镜单独构造 `ZDXH3ShotSelect` + `MiniMaxH3VideoShotSample` 子图、
    逐条提交给 ComfyUI。原循环实现已移到 `dispatch_archive.run_dispatch_loop()`，
    保留原因：对照两种调度行为差异，以及将来"关掉浏览器也能跑完整片"的后台模式。

    本类**不再注册进 NODE_CLASS_MAPPINGS**（画布上不可见）；`generate()` 显式抛错，
    避免被静默当成可用节点。下面的 INPUT_TYPES / RETURN_TYPES 保留为归档契约的文档。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "project_json": ("STRING",),
                "model": ("MODEL",),
                "vae": ("VAE",),
                "clip": ("CLIP",),
            },
            "optional": {
                "shot_index": ("INT", {"default": -1, "min": -1}),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("images", "shot_boundaries")
    FUNCTION = "generate"
    OUTPUT_NODE = True
    CATEGORY = "zdx/director"

    def generate(self, project_json, model, vae, clip, shot_index=-1):
        raise NotImplementedError(
            "DirectorDispatch 已归档：单发架构下请由前端逐镜提交 "
            "ZDXH3ShotSelect + MiniMaxH3VideoShotSample，见 "
            "docs/director-board-design.md；"
            "如需复活循环版，调用 director_board.dispatch_archive.run_dispatch_loop()。"
        )
