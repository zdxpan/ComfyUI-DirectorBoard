"""Standalone Director Board ComfyUI custom nodes."""

WEB_DIRECTORY = "js"

from .director_board import NODE_CLASS_MAPPINGS as BOARD_NODES
from .director_board import NODE_DISPLAY_NAME_MAPPINGS as BOARD_NAMES
from .minimax_h3_shot import NODE_CLASS_MAPPINGS as SHOT_NODES
from .minimax_h3_shot import NODE_DISPLAY_NAME_MAPPINGS as SHOT_NAMES

NODE_CLASS_MAPPINGS = {**BOARD_NODES, **SHOT_NODES}
NODE_DISPLAY_NAME_MAPPINGS = {**BOARD_NAMES, **SHOT_NAMES}
