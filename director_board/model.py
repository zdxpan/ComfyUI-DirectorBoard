"""Pure, versioned data contract for the phase-one Director Board."""
from __future__ import annotations

import copy
import json
import random
import re
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any, Mapping

from .contract_data import DIRECTOR_PROJECT_CONTRACT


SCHEMA = DIRECTOR_PROJECT_CONTRACT["schema"]
TASK_CONTRACTS = DIRECTOR_PROJECT_CONTRACT["task_types"]
TASK_TYPES = frozenset(TASK_CONTRACTS)
OPERATIONS = frozenset(DIRECTOR_PROJECT_CONTRACT["operations"])
ROLES = {
    role: entry["kind"]
    for role, entry in DIRECTOR_PROJECT_CONTRACT["roles"].items()
}
ROLE_LIMITS = {
    role: int(entry["limit"])
    for role, entry in DIRECTOR_PROJECT_CONTRACT["roles"].items()
}
MEDIA_LIMITS = dict(DIRECTOR_PROJECT_CONTRACT["media_limits"])
AGENT_FRAME_RANGE = tuple(DIRECTOR_PROJECT_CONTRACT["agent_frame_range"])
TASK_ALLOWED_ROLES = {
    task: set(entry["allowed_roles"])
    for task, entry in TASK_CONTRACTS.items()
}
TASK_REQUIRED_ROLES = {
    task: dict(entry["required_roles"])
    for task, entry in TASK_CONTRACTS.items()
}
SOURCE_ROLES = frozenset(("source_audio", "source_video"))
DISPATCH_PARAM_SPECS = DIRECTOR_PROJECT_CONTRACT["dispatch"]["parameters"]
DEFAULT_DISPATCH_PARAMS = {
    key: entry["default"] for key, entry in DISPATCH_PARAM_SPECS.items()
}
# `seed_mode` 决定每镜实际 seed：fixed 共用、increment = seed + 镜序号、random 每镜随机。
SEED_MODES = tuple(DISPATCH_PARAM_SPECS["seed_mode"]["choices"])
# `ref_image_size` 是项目级默认（`global.ref_image_size`），不是每镜参数；
# 上游 MiniMaxH3VideoSample 只接受 match / max。
GLOBAL_DEFAULTS = DIRECTOR_PROJECT_CONTRACT["global"]["defaults"]
DEFAULT_REF_IMAGE_SIZE = GLOBAL_DEFAULTS["ref_image_size"]
REF_IMAGE_SIZES = tuple(DIRECTOR_PROJECT_CONTRACT["global"]["ref_image_sizes"])
PROJECT_META_DEFAULTS = DIRECTOR_PROJECT_CONTRACT["project_meta_defaults"]
SHOT_DEFAULTS = DIRECTOR_PROJECT_CONTRACT["shot"]["defaults"]
FPS_RANGE = tuple(DIRECTOR_PROJECT_CONTRACT["shot"]["fps_range"])
CONTINUITY_TASK_TYPES = frozenset(DIRECTOR_PROJECT_CONTRACT["continuity"]["task_types"])
ASSET_KINDS = tuple(DIRECTOR_PROJECT_CONTRACT["asset"]["kinds"])
ASSET_SCOPES = tuple(DIRECTOR_PROJECT_CONTRACT["asset"]["scopes"])
BINDING_ORIGINS = tuple(DIRECTOR_PROJECT_CONTRACT["binding"]["origins"])
AUDIO_POLICIES = tuple(DIRECTOR_PROJECT_CONTRACT["global"]["audio_policies"])
UNSELECTED_POLICIES = tuple(DIRECTOR_PROJECT_CONTRACT["shot"]["unselected_policies"])
_ID = re.compile(DIRECTOR_PROJECT_CONTRACT["id_pattern"])


def _fail(message: str) -> ValueError:
    return ValueError(f"Director project: {message}")


def _obj(value: Any, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise _fail(f"{field} must be an object")
    return value


def _id(value: Any, field: str) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise _fail(f"{field} must be an ID")
    return value


def _string(value: Any, field: str, default: str | None = None) -> str:
    if value is None and default is not None:
        return default
    if not isinstance(value, str):
        raise _fail(f"{field} must be a string")
    return value


def _integer(value: Any, field: str, *, zero: bool = False) -> int:
    is_valid = (
        not isinstance(value, bool)
        and isinstance(value, int)
        and value >= 0
        and (zero or value > 0)
    )
    if not is_valid:
        qualifier = "non-negative" if zero else "positive"
        raise _fail(f"{field} must be a {qualifier} integer")
    return value


def _unique(items: list[str], field: str) -> None:
    if len(items) != len(set(items)):
        raise _fail(f"{field} must be unique")


def media_limits_for_roles(roles) -> dict[str, int]:
    """Project the maximum media counts for a set of allowed binding roles."""
    role_set = set(roles)
    return {
        kind: min(
            maximum,
            sum(
                ROLE_LIMITS[role]
                for role in role_set
                if ROLES[role] == kind
            ),
        )
        for kind, maximum in MEDIA_LIMITS.items()
    }


def resolve_dispatch_params(shot: dict, global_params: dict) -> dict:
    base = {**global_params}
    for k, v in (shot.get("dispatch_params") or {}).items():
        if v is not None and k in base:
            base[k] = v
    return base


def resolve_actual_seed(params: Mapping[str, Any], index: int) -> int:
    """按 `seed_mode` 决定本镜实际使用的 seed。

    `fixed` 所有分镜共用 base；`increment` = base + 本镜在本次运行内的序号；
    `random` 每镜独立随机（不可复现，只能靠记录回溯）。
    前端 `resolveActualSeed()` 是同一语义的实现，两处必须保持一致。
    """
    mode = str(params.get("seed_mode", DEFAULT_DISPATCH_PARAMS["seed_mode"]))
    base = int(params.get("seed", 0) or 0)
    if mode == "fixed":
        return base
    if mode == "random":
        return random.randint(0, 2147483647)
    return base + max(int(index), 0)


@dataclass(frozen=True)
class ProjectMeta:
    id: str
    title: str
    brief: str
    template_id: str
    skill_id: str

    @classmethod
    def parse(cls, data: Any) -> "ProjectMeta":
        value = _obj(data, "project")
        return cls(
            _id(value.get("id"), "project.id"),
            _string(value.get("title", PROJECT_META_DEFAULTS["title"]), "project.title"),
            _string(value.get("brief", PROJECT_META_DEFAULTS["brief"]), "project.brief"),
            _id(value.get("template_id", PROJECT_META_DEFAULTS["template_id"]), "project.template_id"),
            _id(value.get("skill_id", PROJECT_META_DEFAULTS["skill_id"]), "project.skill_id"),
        )


@dataclass(frozen=True)
class Canvas:
    aspect_ratio: str
    width: int
    height: int

    @classmethod
    def parse(cls, data: Any) -> "Canvas":
        value = _obj(data, "canvas")
        ratio = _string(value.get("aspect_ratio"), "canvas.aspect_ratio")
        match = re.fullmatch(r"([1-9]\d*):([1-9]\d*)", ratio)
        if not match:
            raise _fail("canvas.aspect_ratio must look like 16:9")

        width = _integer(value.get("width"), "canvas.width")
        height = _integer(value.get("height"), "canvas.height")
        ratio_width, ratio_height = (int(part) for part in match.groups())

        # H3's native 1344x768 is conventionally presented as 16:9 even
        # though encoder alignment makes it 1.56% narrower. Accept aligned
        # production canvases within a small 3% ratio tolerance.
        requested_ratio = ratio_width / ratio_height
        actual_ratio = width / height
        if abs(actual_ratio / requested_ratio - 1) > 0.03:
            raise _fail("canvas width/height must match aspect_ratio")
        return cls(ratio, width, height)

    def output(self) -> dict[str, Any]:
        return {
            "aspect_ratio": self.aspect_ratio,
            "width": self.width,
            "height": self.height,
        }


@dataclass(frozen=True)
class Range:
    start: int
    end: int

    @classmethod
    def parse(cls, data: Any, field: str) -> "Range":
        value = _obj(data, field)
        start = _integer(value.get("start"), f"{field}.start", zero=True)
        end = _integer(value.get("end"), f"{field}.end", zero=True)
        if start >= end:
            raise _fail(f"{field} must satisfy start < end")
        return cls(start, end)

    def output(self) -> dict[str, int]:
        return {"start": self.start, "end": self.end}


@dataclass(frozen=True)
class Asset:
    id: str
    kind: str
    input_path: str
    scope: str
    owner_shot_id: str | None
    duration_ms: int | None
    description: str | None

    @classmethod
    def parse(cls, data: Any) -> "Asset":
        value = _obj(data, "asset")
        kind = value.get("kind")
        if kind not in ASSET_KINDS:
            raise _fail("asset.kind must be image, video, or audio")

        input_path = _string(value.get("input_path"), "asset.input_path")
        path = PurePosixPath(input_path)
        invalid_path = (
            not input_path
            or "\\" in input_path
            or path.is_absolute()
            or any(part in ("", ".", "..") for part in path.parts)
        )
        if invalid_path:
            raise _fail("asset.input_path must be an input-relative path")

        scope = value.get("scope")
        owner_shot_id = value.get("owner_shot_id")
        if scope not in ASSET_SCOPES:
            raise _fail("asset.scope must be global or shot")
        if scope == "shot":
            owner_shot_id = _id(owner_shot_id, "asset.owner_shot_id")
        elif owner_shot_id is not None:
            raise _fail("global asset cannot define owner_shot_id")

        raw_duration = value.get("duration_ms")
        duration_ms = None if raw_duration is None else _integer(
            raw_duration, "asset.duration_ms"
        )
        if duration_ms is not None and kind == "image":
            raise _fail("image asset cannot define duration_ms")

        description = value.get("description")
        if description is not None:
            description = _string(description, "asset.description")

        return cls(
            _id(value.get("id"), "asset.id"),
            kind,
            input_path,
            scope,
            owner_shot_id,
            duration_ms,
            description,
        )


@dataclass(frozen=True)
class Binding:
    id: str
    asset_id: str
    role: str
    order: int
    range: Range | None
    origin: str

    @classmethod
    def parse(cls, data: Any) -> "Binding":
        value = _obj(data, "binding")
        role = value.get("role")
        if role not in ROLES:
            raise _fail(f"binding.role is unsupported: {role!r}")

        raw_range = value.get("range_ms")
        origin = value.get("origin", BINDING_ORIGINS[0])
        if origin not in BINDING_ORIGINS:
            raise _fail("binding.origin must be manual or prompt")
        return cls(
            _id(value.get("id"), "binding.id"),
            _id(value.get("asset_id"), "binding.asset_id"),
            role,
            _integer(value.get("order", 0), "binding.order", zero=True),
            None if raw_range is None else Range.parse(raw_range, "binding.range_ms"),
            origin,
        )


@dataclass(frozen=True)
class Shot:
    id: str
    title: str
    task_type: str
    operation: str | None
    duration_ms: int
    motion_fps: float
    output_fps: float
    audio_policy: str | None
    prompt: str
    selected_for_generation: bool
    continuity_from_prev: bool
    continuity_index: int | None
    continuity_prev_shot_id: str | None
    execution_fingerprint: str | None
    continuity_prev_fingerprint: str | None
    unselected_policy: str
    bindings: tuple[Binding, ...]

    @classmethod
    def parse(cls, data: Any) -> "Shot":
        value = _obj(data, "shot")
        task_type = value.get("task_type")
        if task_type not in TASK_TYPES:
            allowed_tasks = ", ".join(sorted(TASK_TYPES))
            raise _fail(f"shot.task_type must be one of {allowed_tasks}")

        operation = value.get("operation")
        if task_type == "video_to_video":
            if operation not in OPERATIONS:
                raise _fail("video_to_video shot.operation is required and unsupported")
        elif operation is not None:
            raise _fail("shot.operation is only valid for video_to_video")

        selected_for_generation = value.get(
            "selected_for_generation", SHOT_DEFAULTS["selected_for_generation"]
        )
        if not isinstance(selected_for_generation, bool):
            raise _fail("shot.selected_for_generation must be a boolean")
        continuity_from_prev = value.get(
            "continuity_from_prev", SHOT_DEFAULTS["continuity_from_prev"]
        )
        if not isinstance(continuity_from_prev, bool):
            raise _fail("shot.continuity_from_prev must be a boolean")
        raw_continuity_index = value.get("continuity_index")
        continuity_index = None if raw_continuity_index is None else _integer(
            raw_continuity_index, "shot.continuity_index", zero=True,
        )
        raw_prev_shot_id = value.get("continuity_prev_shot_id")
        continuity_prev_shot_id = (
            None if raw_prev_shot_id is None
            else _id(raw_prev_shot_id, "shot.continuity_prev_shot_id")
        )
        raw_execution_fingerprint = value.get("execution_fingerprint")
        execution_fingerprint = (
            None if raw_execution_fingerprint is None
            else _string(raw_execution_fingerprint, "shot.execution_fingerprint")
        )
        raw_prev_fingerprint = value.get("continuity_prev_fingerprint")
        continuity_prev_fingerprint = (
            None if raw_prev_fingerprint is None
            else _string(raw_prev_fingerprint, "shot.continuity_prev_fingerprint")
        )

        unselected_policy = value.get("unselected_policy", SHOT_DEFAULTS["unselected_policy"])
        if unselected_policy not in UNSELECTED_POLICIES:
            raise _fail("shot.unselected_policy must be skip or passthrough")
        if task_type != "video_to_video" and unselected_policy == "passthrough":
            raise _fail("passthrough is only valid for video_to_video")

        raw_bindings = value.get("bindings", SHOT_DEFAULTS["bindings"])
        if not isinstance(raw_bindings, list):
            raise _fail("shot.bindings must be a list")
        bindings = tuple(Binding.parse(item) for item in raw_bindings)
        _unique([item.id for item in bindings], "binding IDs")
        _unique(
            [f"{item.role}:{item.order}" for item in bindings],
            "binding role/order pairs",
        )

        def fps(name: str, default: float) -> float:
            raw = value.get(name, default)
            if isinstance(raw, bool) or not isinstance(raw, (int, float)):
                raise _fail(f"shot.{name} must be a number")
            result = float(raw)
            if not FPS_RANGE[0] <= result <= FPS_RANGE[1]:
                raise _fail(f"shot.{name} must be between {FPS_RANGE[0]} and {FPS_RANGE[1]}")
            return result

        motion_fps = fps("motion_fps", SHOT_DEFAULTS["motion_fps"])
        output_fps = fps("output_fps", motion_fps)
        audio_policy = value.get("audio_policy")
        if audio_policy is not None and audio_policy not in AUDIO_POLICIES:
            raise _fail("shot.audio_policy must be passthrough, generated, or mute")

        return cls(
            _id(value.get("id"), "shot.id"),
            _string(value.get("title", SHOT_DEFAULTS["title"]), "shot.title"),
            task_type,
            operation,
            _integer(value.get("duration_ms"), "shot.duration_ms"),
            motion_fps,
            output_fps,
            audio_policy,
            _string(value.get("prompt", SHOT_DEFAULTS["prompt"]), "shot.prompt"),
            selected_for_generation,
            continuity_from_prev,
            continuity_index,
            continuity_prev_shot_id,
            execution_fingerprint,
            continuity_prev_fingerprint,
            unselected_policy,
            bindings,
        )


@dataclass(frozen=True)
class GlobalSettings:
    audio_policy: str
    dispatch_params: Mapping[str, Any]
    ref_image_size: str = DEFAULT_REF_IMAGE_SIZE

    @classmethod
    def parse(cls, data: Any) -> "GlobalSettings":
        value = _obj(data, "global")
        audio_policy = value.get("audio_policy", GLOBAL_DEFAULTS["audio_policy"])
        if audio_policy not in AUDIO_POLICIES:
            raise _fail("global.audio_policy must be passthrough, generated, or mute")

        dispatch_params = _parse_dispatch_params(
            value.get("dispatch_params"), "global.dispatch_params",
        )
        ref_image_size = str(value.get("ref_image_size", DEFAULT_REF_IMAGE_SIZE))
        if ref_image_size not in REF_IMAGE_SIZES:
            raise _fail("global.ref_image_size must be match or max")
        return cls(
            audio_policy, dispatch_params, ref_image_size,
        )


DISPATCH_PARAM_KEYS = tuple(DEFAULT_DISPATCH_PARAMS)


def _parse_dispatch_params(data: Any, field: str) -> dict[str, Any]:
    """Validate an optional sampler-parameter override block.

    Both `global.dispatch_params` and `shot.dispatch_params` share this shape.
    Unknown keys are rejected so a typo cannot silently change sampling.
    """
    if data is None:
        return {}
    value = _obj(data, field)
    parsed: dict[str, Any] = {}
    for key, raw in value.items():
        if key not in DISPATCH_PARAM_KEYS:
            raise _fail(f"{field} has unknown key {key!r}")
        spec = DISPATCH_PARAM_SPECS[key]
        kind = spec["kind"]
        if kind == "integer":
            parsed[key] = _integer(
                raw, f"{field}.{key}", zero=int(spec.get("minimum", 1)) == 0,
            )
        elif kind == "number":
            if isinstance(raw, bool) or not isinstance(raw, (int, float)):
                raise _fail(f"{field}.{key} must be a number")
            parsed[key] = float(raw)
            minimum = spec.get("minimum")
            maximum = spec.get("maximum")
            if minimum is not None and maximum is not None and not minimum <= parsed[key] <= maximum:
                raise _fail(f"{field}.{key} must be between {minimum:g} and {maximum:g}")
        elif kind == "boolean":
            if not isinstance(raw, bool):
                raise _fail(f"{field}.{key} must be a boolean")
            parsed[key] = raw
        elif kind == "choice":
            choices = tuple(spec["choices"])
            if str(raw) not in choices:
                raise _fail(f"{field}.{key} must be {', '.join(choices[:-1])}, or {choices[-1]}")
            parsed[key] = str(raw)
        elif kind == "string":
            if not isinstance(raw, str) or not raw.strip():
                raise _fail(f"{field}.{key} must be a non-empty string")
            parsed[key] = raw
        else:  # pragma: no cover - generated-contract tests guard supported kinds
            raise _fail(f"{field}.{key} has unsupported contract kind {kind!r}")
    return parsed


def _validate_shot_results(data: Any, shot_ids: set[str]) -> None:
    value = {} if data is None else _obj(data, "shot_results")
    if set(value) - shot_ids:
        raise _fail("shot_results must reference existing shots")
    for shot_id, raw in value.items():
        result = _obj(raw, f"shot_results.{shot_id}")
        for name in ("filename", "promptId", "executionFingerprint"):
            if not isinstance(result.get(name), str) or not result[name]:
                raise _fail(f"shot_results.{shot_id}.{name} must be a non-empty string")
        for name in ("subfolder", "fullpath"):
            if result.get(name) is not None and not isinstance(result[name], str):
                raise _fail(f"shot_results.{shot_id}.{name} must be a string")
        if result.get("type") is not None and not isinstance(result["type"], str):
            raise _fail(f"shot_results.{shot_id}.type must be a string")
        _integer(result.get("seed"), f"shot_results.{shot_id}.seed", zero=True)
        frame_rate = result.get("frameRate")
        if isinstance(frame_rate, bool) or not isinstance(frame_rate, (int, float)) or frame_rate <= 0:
            raise _fail(f"shot_results.{shot_id}.frameRate must be positive")
        if not isinstance(result.get("continuityFromPrev", False), bool):
            raise _fail(f"shot_results.{shot_id}.continuityFromPrev must be a boolean")
        previous_shot_id = result.get("continuityPreviousShotId")
        if previous_shot_id is not None:
            _id(previous_shot_id, f"shot_results.{shot_id}.continuityPreviousShotId")
        _integer(
            result.get("continuityContextFrames", 0),
            f"shot_results.{shot_id}.continuityContextFrames", zero=True,
        )
        filename = result["filename"]
        subfolder = str(result.get("subfolder") or "")
        fullpath = str(result.get("fullpath") or "")
        normalized_subfolder = subfolder.replace("\\", "/")
        normalized_fullpath = fullpath.replace("\\", "/")
        subfolder_parts = normalized_subfolder.split("/")
        absolute = normalized_fullpath.startswith("/") or (
            len(normalized_fullpath) > 2
            and normalized_fullpath[0].isalpha()
            and normalized_fullpath[1:3] == ":/"
        )
        if (
            not subfolder
            or any(part in ("", ".", "..") for part in subfolder_parts)
            or any(char in filename for char in ("/", "\\", "\0"))
            or filename in (".", "..")
            or not absolute
            or "\0" in fullpath
            or ".." in normalized_fullpath.split("/")
            or not normalized_fullpath.endswith(
                f"/{normalized_subfolder}/{filename}"
            )
        ):
            raise _fail(f"shot_results.{shot_id} has unsafe output path")


@dataclass(frozen=True)
class DirectorProject:
    meta: ProjectMeta
    canvas: Canvas
    global_settings: GlobalSettings
    assets: tuple[Asset, ...]
    authored_shots: tuple[Shot, ...]
    selected_shot_id: str
    authored_document: Mapping[str, Any]

    @classmethod
    def parse(cls, document: Any) -> "DirectorProject":
        value = _obj(document, "project_json")
        if value.get("schema") != SCHEMA:
            raise _fail(f"schema must equal {SCHEMA!r}")

        raw_assets = value.get("assets", [])
        raw_shots = value.get("shots", [])
        if not isinstance(raw_assets, list) or not isinstance(raw_shots, list):
            raise _fail("assets and shots must be lists")

        assets = tuple(Asset.parse(item) for item in raw_assets)
        shots = tuple(Shot.parse(item) for item in raw_shots)
        _unique([item.id for item in assets], "asset IDs")
        _unique([item.id for item in shots], "shot IDs")
        if not shots:
            raise _fail("shots must contain at least one shot")

        selected_shot_id = _id(value.get("selected_shot_id"), "selected_shot_id")
        shot_ids = {item.id for item in shots}
        asset_map = {item.id: item for item in assets}
        if selected_shot_id not in shot_ids:
            raise _fail("selected_shot_id must reference a shot")
        _validate_shot_results(value.get("shot_results"), shot_ids)

        for asset in assets:
            if asset.scope == "shot" and asset.owner_shot_id not in shot_ids:
                raise _fail(
                    f"asset {asset.id!r} owner_shot_id must reference a shot"
                )

        global_settings = GlobalSettings.parse(value.get("global", {}))
        for index, (shot, raw_shot) in enumerate(zip(shots, raw_shots)):
            _validate_binding_assets(shot, asset_map)
            # Shot-level overrides share the global shape; validate them here so
            # a typo cannot silently fall back to the default.
            if isinstance(raw_shot, dict):
                shot_dispatch_params = _parse_dispatch_params(
                    raw_shot.get("dispatch_params"),
                    f"shot {shot.id!r} dispatch_params",
                )
                if shot.continuity_from_prev:
                    sequence_index = (
                        shot.continuity_index
                        if shot.continuity_index is not None else index
                    )
                    previous_id = (
                        shot.continuity_prev_shot_id
                        if shot.continuity_prev_shot_id is not None
                        else (shots[index - 1].id if index else None)
                    )
                    if sequence_index <= 0 or not previous_id:
                        raise _fail(
                            f"shot {shot.id!r} continuity_from_prev requires a previous shot"
                        )
                    if shot.continuity_index is not None and (
                        not shot.continuity_prev_fingerprint
                        or not shot.execution_fingerprint
                    ):
                        raise _fail(
                            f"shot {shot.id!r} continuity execution snapshot requires fingerprints"
                        )
                    if shot.task_type not in CONTINUITY_TASK_TYPES:
                        raise _fail(
                            f"shot {shot.id!r} continuity_from_prev only supports "
                            "text_to_video or reference_video"
                        )
                    effective_dispatch = {
                        **global_settings.dispatch_params,
                        **shot_dispatch_params,
                    }
                    if effective_dispatch.get("latent_upscale", False):
                        raise _fail(
                            f"shot {shot.id!r} continuity_from_prev cannot use latent_upscale"
                        )

        authored_document = copy.deepcopy(dict(value))
        authored_document.setdefault("shot_results", {})
        if isinstance(authored_document.get("global"), dict):
            authored_document["global"].pop("global_apply", None)
            authored_document["global"].pop("continuity", None)
        for authored_shot in authored_document.get("shots", []):
            if isinstance(authored_shot, dict):
                authored_shot.pop("camera", None)
        return cls(
            ProjectMeta.parse(value.get("project")),
            Canvas.parse(value.get("canvas")),
            global_settings,
            assets,
            shots,
            selected_shot_id,
            authored_document,
        )

    def resolved_shots(self) -> list[dict[str, Any]]:
        asset_map = {item.id: item for item in self.assets}
        resolved_shots = list(self.authored_shots)
        for shot in resolved_shots:
            _validate_binding_assets(shot, asset_map)
            _validate_task(shot)

        output = []
        for index, shot in enumerate(resolved_shots):
            previous_id = resolved_shots[index - 1].id if index else None
            output.append(_shot_output(
                shot, asset_map, self.canvas, self.global_settings,
                self.meta.template_id, self.meta.id, index, previous_id,
            ))
        return output

    def outputs(self) -> tuple[str, str, str]:
        resolved_shots = self.resolved_shots()
        selected_shot = next(
            shot
            for shot in resolved_shots
            if shot["shot_id"] == self.selected_shot_id
        )
        return (
            _dump(self.authored_document),
            _dump(resolved_shots),
            _dump(selected_shot),
        )


def _validate_binding_assets(shot: Shot, assets: Mapping[str, Asset]) -> None:
    asset_ids = [binding.asset_id for binding in shot.bindings]
    if len(asset_ids) != len(set(asset_ids)):
        raise _fail(f"shot {shot.id!r} cannot bind one asset more than once")
    for binding in shot.bindings:
        asset = assets.get(binding.asset_id)
        if asset is None:
            raise _fail(
                f"binding {binding.id!r} references unknown asset {binding.asset_id!r}"
            )
        if asset.kind != ROLES[binding.role]:
            raise _fail(
                f"binding {binding.id!r} role {binding.role!r} requires "
                f"{ROLES[binding.role]}"
            )
        if asset.scope == "shot" and asset.owner_shot_id != shot.id:
            raise _fail(
                f"shot {shot.id!r} cannot use shot-scoped asset {asset.id!r}"
            )
        if asset.kind == "image" and binding.range is not None:
            raise _fail("image binding cannot define range_ms")
        if (
            binding.range is not None
            and asset.duration_ms is not None
            and binding.range.end > asset.duration_ms
        ):
            raise _fail(
                f"binding {binding.id!r} range_ms exceeds asset duration_ms"
            )


def _validate_task(shot: Shot) -> None:
    roles = [binding.role for binding in shot.bindings]
    validate_task_roles(shot.task_type, roles)

    for binding in shot.bindings:
        if binding.role not in SOURCE_ROLES:
            continue
        if binding.range is None:
            raise _fail(f"{binding.role} requires range_ms")
        if binding.range.end - binding.range.start != shot.duration_ms:
            raise _fail(
                f"{binding.role} range_ms duration must equal shot.duration_ms"
            )


def validate_task_roles(task_type: str, roles) -> None:
    if task_type not in TASK_ALLOWED_ROLES:
        raise _fail(f"unsupported task_type {task_type!r}")
    roles = list(roles)
    allowed_roles = TASK_ALLOWED_ROLES[task_type]
    illegal_roles = set(roles) - allowed_roles
    if illegal_roles:
        unsupported_roles = ", ".join(sorted(illegal_roles))
        raise _fail(
            f"task_type {task_type!r} cannot use role(s): "
            f"{unsupported_roles}"
        )

    role_counts = {role: roles.count(role) for role in ROLES}
    kind_counts = {
        kind: sum(role_counts[role] for role, role_kind in ROLES.items() if role_kind == kind)
        for kind in MEDIA_LIMITS
    }
    if any(kind_counts[kind] > maximum for kind, maximum in MEDIA_LIMITS.items()):
        raise _fail(
            f"task_type {task_type!r} supports at most {MEDIA_LIMITS['image']} images, "
            f"{MEDIA_LIMITS['video']} video, and {MEDIA_LIMITS['audio']} audio"
        )
    for role, count in role_counts.items():
        if count > ROLE_LIMITS[role]:
            raise _fail(
                f"task_type {task_type!r} supports at most {ROLE_LIMITS[role]} {role}"
            )

    for role, count in TASK_REQUIRED_ROLES[task_type].items():
        if role_counts[role] != count:
            raise _fail(
                f"task_type {task_type!r} requires "
                f"{count} {role}"
            )

    if task_type == "reference_video" and not any(
        role_counts[role]
        for role in ("reference_image", "reference_video", "reference_audio")
    ):
        raise _fail(
            "task_type reference_video requires a reference binding"
        )


def _media(asset: Asset, binding: Binding | None) -> Any:
    if binding is None:
        return None
    media: dict[str, Any] = {
        "asset_id": asset.id,
        "input_path": asset.input_path,
    }
    if binding.range is not None:
        media["range_ms"] = binding.range.output()
    if asset.duration_ms is not None:
        media["duration_ms"] = asset.duration_ms
    return media


def _shot_output(
    shot: Shot,
    assets: Mapping[str, Asset],
    canvas: Canvas,
    settings: GlobalSettings,
    template_id: str,
    project_id: str,
    sequence_index: int,
    previous_shot_id: str | None,
) -> dict[str, Any]:
    bindings_by_role: dict[str, list[Binding]] = {role: [] for role in ROLES}
    for binding in shot.bindings:
        bindings_by_role[binding.role].append(binding)
    for bindings in bindings_by_role.values():
        bindings.sort(key=lambda binding: (binding.order, binding.id))

    def one(role: str) -> Any:
        bindings = bindings_by_role[role]
        if not bindings:
            return None
        binding = bindings[0]
        return _media(assets[binding.asset_id], binding)

    audio_policy = shot.audio_policy or settings.audio_policy
    if audio_policy == "passthrough" and not bindings_by_role["source_audio"]:
        audio_policy = "generated"

    return {
        "shot_id": shot.id,
        "project_id": project_id,
        "task_type": shot.task_type,
        "operation": shot.operation,
        "duration_ms": shot.duration_ms,
        "motion_fps": shot.motion_fps,
        "output_fps": shot.output_fps,
        "canvas": canvas.output(),
        "prompt": shot.prompt,
        "selected_for_generation": shot.selected_for_generation,
        "continuity": {
            "enabled": shot.continuity_from_prev,
            "context_frames": 22,
            "audio_context_length": 24,
            "sequence_index": (
                shot.continuity_index
                if shot.continuity_index is not None else sequence_index
            ),
            "previous_shot_id": (
                shot.continuity_prev_shot_id
                if shot.continuity_prev_shot_id is not None else previous_shot_id
            ),
            "previous_execution_fingerprint": shot.continuity_prev_fingerprint,
        },
        "execution_fingerprint": shot.execution_fingerprint,
        "unselected_policy": shot.unselected_policy,
        "inputs": {
            "first_frame": one("first_frame"),
            "last_frame": one("last_frame"),
            "reference_images": [
                _media(assets[binding.asset_id], binding)
                for binding in bindings_by_role["reference_image"]
            ],
            "source_video": one("source_video"),
            "reference_video": one("reference_video"),
            "reference_videos": [
                _media(assets[binding.asset_id], binding)
                for binding in bindings_by_role["reference_video"]
            ],
            "source_audio": one("source_audio"),
            "reference_audio": one("reference_audio"),
            "reference_audios": [
                _media(assets[binding.asset_id], binding)
                for binding in bindings_by_role["reference_audio"]
            ],
        },
        "audio_policy": audio_policy,
        "project_template_id": template_id,
    }


def parse_project_json(project_json: str) -> DirectorProject:
    if not isinstance(project_json, str):
        raise _fail("project_json must be a JSON string")
    try:
        return DirectorProject.parse(json.loads(project_json))
    except json.JSONDecodeError as exc:
        raise _fail(f"project_json is invalid JSON: {exc.msg}") from exc


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
