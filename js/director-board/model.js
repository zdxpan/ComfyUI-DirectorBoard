import { DIRECTOR_PROJECT_CONTRACT } from "./director-project-contract-data.js";

export { DIRECTOR_PROJECT_CONTRACT };
export const SCHEMA = DIRECTOR_PROJECT_CONTRACT.schema;
export const TASKS = Object.entries(DIRECTOR_PROJECT_CONTRACT.task_types)
  .map(([id, entry]) => [id, entry.label]);
export const OPS = Object.entries(DIRECTOR_PROJECT_CONTRACT.operations);
export const ROLE_KIND = Object.fromEntries(Object.entries(DIRECTOR_PROJECT_CONTRACT.roles)
  .map(([role, entry]) => [role, entry.kind]));
export const ROLE_NAME = Object.fromEntries(Object.entries(DIRECTOR_PROJECT_CONTRACT.roles)
  .map(([role, entry]) => [role, entry.label]));
export const ROLE_LIMITS = Object.fromEntries(Object.entries(DIRECTOR_PROJECT_CONTRACT.roles)
  .map(([role, entry]) => [role, entry.limit]));
export const MEDIA_LIMITS = { ...DIRECTOR_PROJECT_CONTRACT.media_limits };
export const ALLOWED = Object.fromEntries(Object.entries(DIRECTOR_PROJECT_CONTRACT.task_types)
  .map(([task, entry]) => [task, [...entry.allowed_roles]]));
export const REQUIRED = Object.fromEntries(Object.entries(DIRECTOR_PROJECT_CONTRACT.task_types)
  .map(([task, entry]) => [task, { ...entry.required_roles }]));
export const CONTINUITY_TASK_TYPES = [...DIRECTOR_PROJECT_CONTRACT.continuity.task_types];
export const FPS_RANGE = [...DIRECTOR_PROJECT_CONTRACT.shot.fps_range];
export const PROJECT_META_DEFAULTS = { ...DIRECTOR_PROJECT_CONTRACT.project_meta_defaults };
export const SHOT_DEFAULTS = structuredClone(DIRECTOR_PROJECT_CONTRACT.shot.defaults);
export const GLOBAL_DEFAULTS = { ...DIRECTOR_PROJECT_CONTRACT.global.defaults };
export const DEFAULT_DISPATCH_PARAMS = Object.fromEntries(
  Object.entries(DIRECTOR_PROJECT_CONTRACT.dispatch.parameters).map(([key, entry]) => [key, entry.default]),
);
export const NO_TEXT_PROMPT_SUFFIX = "画面不要额外字幕、文字、水印或Logo。";

export function withNoTextConstraint(prompt) {
  const source = String(prompt || "").trimEnd();
  if (source.includes(NO_TEXT_PROMPT_SUFFIX)) return source;
  return `${source}${source.trim() ? "\n" : ""}${NO_TEXT_PROMPT_SUFFIX}`;
}

const slotsForTask = (entry) => {
  const remaining = { ...MEDIA_LIMITS };
  return entry.slot_order.flatMap((role) => {
    const definition = DIRECTOR_PROJECT_CONTRACT.roles[role],
      count = Math.min(definition.limit, remaining[definition.kind] ?? 0);
    remaining[definition.kind] -= count;
    return Array.from({ length: count }, (_, index) => [
      definition.kind,
      role,
      role.startsWith("reference_")
        ? `${definition.slot_label || definition.label}${index + 1}`
        : definition.slot_label || definition.label,
    ]);
  });
};
export const TASK_SLOTS = Object.fromEntries(Object.entries(DIRECTOR_PROJECT_CONTRACT.task_types)
  .map(([task, entry]) => [task, slotsForTask(entry)]));
for (const [task, slots] of Object.entries(TASK_SLOTS)) {
  if (!Object.hasOwn(ALLOWED, task) || slots.some(([kind, role]) =>
    ROLE_KIND[role] !== kind || !ALLOWED[task].includes(role)
  )) throw new Error(`Invalid Director slot contract for ${task}`);
}
export const ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"];
export const SLICE_KINDS_BY_TEMPLATE = {
  mv: ["audio"],
  long_video: ["video"],
  long_video_edit: ["video"],
};
export const MEGAPIXEL_PRESETS = [
  [0.2, 608, 352], [0.3, 736, 416], [0.4, 864, 480],
  [0.5, 960, 544], [0.6, 1056, 608], [0.7, 1152, 640],
  [0.8, 1216, 672], [0.9, 1280, 736], [0.98, 1344, 768],
  [1.0, 1376, 768], [1.2, 1504, 832], [1.5, 1664, 928],
  [1.8, 1824, 1024], [2.0, 1920, 1088],
];
export function canvasSizeFor(aspectRatio, megapixels) {
  const preset = MEGAPIXEL_PRESETS.reduce((best, row) =>
    Math.abs(row[0] - megapixels) < Math.abs(best[0] - megapixels) ? row : best
  );
  if (aspectRatio === "16:9") return [preset[1], preset[2]];
  if (aspectRatio === "9:16") return [preset[2], preset[1]];
  const [wide, high] = aspectRatio.split(":").map(Number),
    targetPixels = preset[1] * preset[2];
  let best = null;
  for (let width = 32; width <= 4096; width += 32) {
    const height = Math.max(32, Math.round(width * high / wide / 32) * 32),
      ratioError = Math.abs((width / height) / (wide / high) - 1);
    if (ratioError > .03) continue;
    const areaError = Math.abs(width * height - targetPixels) / targetPixels,
      score = areaError + ratioError;
    if (!best || score < best.score) best = { width, height, score };
  }
  return best ? [best.width, best.height] : [preset[1], preset[2]];
}

export function nearestMegapixel(width, height) {
  const area = width * height;
  return MEGAPIXEL_PRESETS.reduce((best, row) =>
    Math.abs(row[1] * row[2] - area) < Math.abs(best[1] * best[2] - area) ? row : best
  )[0];
}
export const ID = new RegExp(DIRECTOR_PROJECT_CONTRACT.id_pattern);
export const BINDING_ORIGINS = [...DIRECTOR_PROJECT_CONTRACT.binding.origins];

export function deep(v) {
  return JSON.parse(JSON.stringify(v));
}
export function uid(p) {
  return `${p}_${Date.now().toString(36)}${
    Math.random().toString(36).slice(2, 8)
  }`;
}

export function bindingForSlot(bindings, role, order) {
  return bindings.find((binding) =>
    binding.role === role && binding.order === order
  );
}

export function validId(v) {
  return typeof v === "string" && ID.test(v);
}

export const DISPATCH_PARAM_KEYS = [
  ...Object.keys(DIRECTOR_PROJECT_CONTRACT.dispatch.parameters),
];

/** 每镜 seed 策略：共用 / 递增 / 每镜随机。 */
export const SEED_MODES = [...DIRECTOR_PROJECT_CONTRACT.dispatch.parameters.seed_mode.choices];

/** seed 策略的中文标签（参数弹窗与时间轴运行入口共用一份）。 */
export const SEED_MODE_LABELS = { fixed: "固定", increment: "递增", random: "随机" };

/** `ref_image_size` 是项目级默认（`global.ref_image_size`），上游只接受 match / max。 */
export const REF_IMAGE_SIZES = [...DIRECTOR_PROJECT_CONTRACT.global.ref_image_sizes];

/**
 * 按 `seed_mode` 解析本镜实际使用的 seed，语义与 Python `resolve_actual_seed` 一致
 * （见 docs/director-board-design.md）：
 * `fixed` 全部共用、`increment` = base + 本镜在本次运行内的序号、`random` 每镜随机。
 */
export function resolveActualSeed(params, index) {
  const mode = params?.seed_mode ?? DEFAULT_DISPATCH_PARAMS.seed_mode;
  const base = Number(params?.seed) || 0;
  if (mode === "fixed") return base;
  if (mode === "random") return Math.floor(Math.random() * 2147483647);
  return base + (Number(index) || 0);
}

/**
 * Validate an optional sampler-parameter override block.
 *
 * Shared by `global.dispatch_params` (project defaults) and
 * `shot.dispatch_params` (per-shot overrides); unknown keys are rejected so a
 * typo cannot silently change sampling.
 */
export function checkDispatchParams(params, field, fail) {
  if (params == null) return;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    fail(`${field} 必须是对象。`);
    return;
  }
  for (const [key, value] of Object.entries(params)) {
    const spec = DIRECTOR_PROJECT_CONTRACT.dispatch.parameters[key];
    if (!spec) fail(`${field} 含未知字段 ${key}。`);
    else if (spec.kind === "integer") {
      const minimum = spec.minimum ?? 1;
      if (!Number.isInteger(value) || value < minimum) {
        fail(`${field}.${key} 必须是${minimum ? "正" : "非负"}整数。`);
      }
    } else if (spec.kind === "number") {
      if (typeof value !== "number" || Number.isNaN(value)) fail(`${field}.${key} 必须是数字。`);
      else if ((spec.minimum !== undefined && value < spec.minimum)
        || (spec.maximum !== undefined && value > spec.maximum)) {
        fail(`${field}.${key} 必须在 ${spec.minimum} 到 ${spec.maximum} 之间。`);
      }
    } else if (spec.kind === "boolean") {
      if (typeof value !== "boolean") fail(`${field}.${key} 必须是布尔值。`);
    } else if (spec.kind === "choice") {
      if (!spec.choices.includes(String(value))) {
        fail(`${field}.${key} 取值无效。`);
      }
    } else if (spec.kind === "string" && (typeof value !== "string" || !value.trim())) {
      fail(`${field}.${key} 必须是非空字符串。`);
    }
  }
}

export function defaultShot(id = "shot_01", title = "分镜 1") {
  return {
    id,
    title,
    task_type: "text_to_video",
    duration_ms: 5000,
    prompt: SHOT_DEFAULTS.prompt,
    selected_for_generation: SHOT_DEFAULTS.selected_for_generation,
    continuity_from_prev: SHOT_DEFAULTS.continuity_from_prev,
    unselected_policy: SHOT_DEFAULTS.unselected_policy,
    bindings: [...SHOT_DEFAULTS.bindings],
  };
}
export function blank() {
  const first = defaultShot();
  return {
    schema: SCHEMA,
    project: {
      id: "project_01",
      title: "未命名成片",
      brief: "",
      template_id: PROJECT_META_DEFAULTS.template_id,
      skill_id: PROJECT_META_DEFAULTS.skill_id,
    },
    canvas: { aspect_ratio: "9:16", width: 480, height: 864 },
    global: {
      audio_policy: GLOBAL_DEFAULTS.audio_policy,
      ref_image_size: GLOBAL_DEFAULTS.ref_image_size,
    },
    assets: [],
    shots: [first],
    shot_results: {},
    selected_shot_id: first.id,
  };
}
export function choiceOk(items, v) {
  return items.some(([id]) => id === v);
}

// A deliberately strict mirror of director_board/model.py. Invalid authored
// JSON is blocked in place; this reader never supplies defaults or deletes old
// fields before the author explicitly repairs it.
export function validate(project) {
  const errors = [], fail = (m) => errors.push(m);
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    return ["project_json 必须是对象。"];
  }
  project = {
    ...project,
    assets: project.assets === undefined ? [] : project.assets,
    shots: project.shots === undefined ? [] : project.shots,
  };
  if (project.schema !== SCHEMA) fail(`schema 必须为 ${SCHEMA}。`);
  const meta = project.project,
    canvas = project.canvas,
    global = project.global === undefined ? {} : project.global;
  if (
    !meta || typeof meta !== "object" || !validId(meta.id) ||
    !validId(meta.template_id === undefined ? PROJECT_META_DEFAULTS.template_id : meta.template_id) ||
    !validId(meta.skill_id === undefined ? PROJECT_META_DEFAULTS.skill_id : meta.skill_id) ||
    typeof (meta.title === undefined ? PROJECT_META_DEFAULTS.title : meta.title) !== "string" ||
    typeof (meta.brief === undefined ? PROJECT_META_DEFAULTS.brief : meta.brief) !== "string"
  ) fail("project 元数据无效。");
  if (
    !canvas || typeof canvas !== "object" ||
    typeof canvas.aspect_ratio !== "string" ||
    !/^([1-9]\d*):([1-9]\d*)$/.test(canvas.aspect_ratio) ||
    !Number.isInteger(canvas.width) || canvas.width <= 0 ||
    !Number.isInteger(canvas.height) || canvas.height <= 0
  ) fail("canvas 宽高比或尺寸无效。");
  else {
    const [a, b] = canvas.aspect_ratio.split(":").map(Number);
    if (Math.abs((canvas.width / canvas.height) / (a / b) - 1) > .03) {
      fail("canvas 宽高必须匹配宽高比。");
    }
  }
  if (
    !Array.isArray(project.assets) || !Array.isArray(project.shots) ||
    !project.shots.length
  ) {
    fail("assets、shots 必须是列表且至少有一个分镜。");
    return errors;
  }
  const shotIds = new Set(), assetIds = new Set();
  for (const a of project.assets) {
    if (!a || !validId(a.id) || assetIds.has(a.id)) {
      fail("素材 ID 必须唯一且合法。");
      continue;
    }
    assetIds.add(a.id);
    if (
      !DIRECTOR_PROJECT_CONTRACT.asset.kinds.includes(a.kind) ||
      typeof a.input_path !== "string" || !a.input_path ||
      a.input_path.startsWith("/") || a.input_path.includes("\\") ||
      a.input_path.split("/").some((p) => p === "..") ||
      !DIRECTOR_PROJECT_CONTRACT.asset.scopes.includes(a.scope)
    ) fail(`素材 ${a.id} 无效。`);
    if (a.scope === "shot" && !validId(a.owner_shot_id)) {
      fail(`专属素材 ${a.id} 缺少 owner_shot_id。`);
    }
    if (a.scope === "global" && a.owner_shot_id != null) {
      fail(`全局素材 ${a.id} 不能有 owner_shot_id。`);
    }
    if (
      a.duration_ms != null &&
      (!Number.isInteger(a.duration_ms) || a.duration_ms <= 0 || a.kind === "image")
    ) fail(`素材 ${a.id} 的 duration_ms 无效。`);
    if (a.description != null && typeof a.description !== "string") {
      fail(`素材 ${a.id} 的 description 必须是字符串。`);
    }
  }
  for (const s of project.shots) {
    if (!s || !validId(s.id) || shotIds.has(s.id)) {
      fail("分镜 ID 必须唯一且合法。");
    } else shotIds.add(s.id);
  }
  if (
    !validId(project.selected_shot_id) || !shotIds.has(project.selected_shot_id)
  ) fail("selected_shot_id 必须指向现有分镜。");
  const shotResults = project.shot_results ?? {};
  if (!shotResults || typeof shotResults !== "object" || Array.isArray(shotResults)) {
    fail("shot_results 必须是对象。");
  } else {
    for (const [shotId, result] of Object.entries(shotResults)) {
      if (!shotIds.has(shotId)) {
        fail("shot_results 必须指向现有分镜。");
        continue;
      }
      if (
        !result || typeof result !== "object" || Array.isArray(result) ||
        typeof result.filename !== "string" || !result.filename ||
        typeof (result.subfolder ?? "") !== "string" ||
        typeof (result.type ?? "output") !== "string" ||
        typeof (result.fullpath ?? "") !== "string" ||
        typeof result.promptId !== "string" || !result.promptId ||
        !Number.isInteger(result.seed) || result.seed < 0 ||
        typeof result.frameRate !== "number" || result.frameRate <= 0 ||
        typeof result.executionFingerprint !== "string" || !result.executionFingerprint ||
        (result.hasAudio != null && typeof result.hasAudio !== "boolean") ||
        (result.durationMs != null && (!Number.isInteger(result.durationMs) || result.durationMs <= 0)) ||
        typeof (result.continuityFromPrev === undefined ? false : result.continuityFromPrev) !== "boolean" ||
        (result.continuityPreviousShotId != null && !validId(result.continuityPreviousShotId)) ||
        !Number.isInteger(result.continuityContextFrames === undefined ? 0 : result.continuityContextFrames) ||
        (result.continuityContextFrames === undefined ? 0 : result.continuityContextFrames) < 0 ||
        !isSafeResultFile(result)
      ) fail(`shot_results.${shotId} 无效。`);
    }
  }
  for (const a of project.assets) {
    if (a?.scope === "shot" && !shotIds.has(a.owner_shot_id)) {
      fail(`专属素材 ${a.id} 的 owner_shot_id 不存在。`);
    }
  }
  if (
    !global || typeof global !== "object" || Array.isArray(global) ||
    !DIRECTOR_PROJECT_CONTRACT.global.audio_policies.includes(
      global.audio_policy === undefined ? GLOBAL_DEFAULTS.audio_policy : global.audio_policy,
    )
  ) fail("global.audio_policy 无效。");
  // 缺失（undefined）才走默认值；显式 null / 非法值必须和 Python 一样报错，
  // 否则前端会误报「配置有效」（见 docs/director-board-ui.md 的字段集合约定）。
  const refImageSize = global?.ref_image_size;
  if (refImageSize !== undefined && !REF_IMAGE_SIZES.includes(String(refImageSize))) {
    fail("global.ref_image_size 取值无效。");
  }
  checkDispatchParams(global?.dispatch_params, "global.dispatch_params", fail);
  const assets = new Map(
    project.assets.filter((a) => a?.id).map((a) => [a.id, a]),
  );
  for (const [index, s] of project.shots.entries()) {
    validateShot(s, assets, fail, { index, global });
  }
  return [...new Set(errors)];
}
export function validateShot(s, assets, fail, { index = null, global = {} } = {}) {
  checkDispatchParams(s?.dispatch_params, `分镜 ${s?.id ?? "?"} dispatch_params`, fail);
  if (!s || typeof s !== "object" || Array.isArray(s)) {
    fail(`分镜 ${s?.id || "?"} 基础字段无效。`);
    return;
  }
  s = {
    ...SHOT_DEFAULTS,
    ...s,
    bindings: s.bindings === undefined ? SHOT_DEFAULTS.bindings : s.bindings,
  };
  if (s.audio_policy !== undefined && !DIRECTOR_PROJECT_CONTRACT.global.audio_policies.includes(s.audio_policy)) {
    fail(`分镜 ${s.id} audio_policy 无效。`);
  }
  const motionFps = s.motion_fps === undefined ? SHOT_DEFAULTS.motion_fps : s.motion_fps,
    outputFps = s.output_fps === undefined ? motionFps : s.output_fps,
    validFps = (value) => typeof value === "number" && !Number.isNaN(value)
      && value >= FPS_RANGE[0] && value <= FPS_RANGE[1];
  if (
    !validId(s.id) || typeof s.title !== "string" ||
    !Object.hasOwn(ALLOWED, s.task_type) || !Number.isInteger(s.duration_ms) ||
    s.duration_ms <= 0 || typeof s.prompt !== "string" ||
    typeof s.selected_for_generation !== "boolean" ||
    typeof s.continuity_from_prev !== "boolean" ||
    !DIRECTOR_PROJECT_CONTRACT.shot.unselected_policies.includes(s.unselected_policy) ||
    !Array.isArray(s.bindings) || !validFps(motionFps) || !validFps(outputFps)
  ) {
    fail(`分镜 ${s?.id || "?"} 基础字段无效。`);
    return;
  }
  if (
    s.continuity_index != null &&
    (!Number.isInteger(s.continuity_index) || s.continuity_index < 0)
  ) fail(`分镜 ${s.id} continuity_index 无效。`);
  if (
    s.continuity_prev_shot_id != null &&
    !validId(s.continuity_prev_shot_id)
  ) fail(`分镜 ${s.id} continuity_prev_shot_id 无效。`);
  for (const field of ["execution_fingerprint", "continuity_prev_fingerprint"]) {
    if (s[field] != null && typeof s[field] !== "string") {
      fail(`分镜 ${s.id} ${field} 无效。`);
    }
  }
  if (s.continuity_from_prev) {
    if (index != null || s.continuity_index != null || s.continuity_prev_shot_id != null) {
      const sequenceIndex = s.continuity_index ?? index,
        previousId = s.continuity_prev_shot_id ?? (index > 0 ? "timeline_previous" : null);
      if (sequenceIndex == null || sequenceIndex <= 0 || !previousId) {
        fail(`分镜 ${s.id} 缺少可承接的上一镜。`);
      }
    }
    if (!CONTINUITY_TASK_TYPES.includes(s.task_type)) {
      fail(`分镜 ${s.id} 的任务形态不支持帧间连续性。`);
    }
    if (s.continuity_index != null && DIRECTOR_PROJECT_CONTRACT.continuity.snapshot_required_fields
      .some((field) => !s[field])) {
      fail(`分镜 ${s.id} 的连续性执行快照缺少指纹。`);
    }
    const effectiveDispatch = { ...(global?.dispatch_params || {}), ...(s.dispatch_params || {}) };
    if (DIRECTOR_PROJECT_CONTRACT.continuity.incompatible_dispatch_flags
      .some((field) => Boolean(effectiveDispatch[field]))) {
      fail(`分镜 ${s.id} 的帧间连续性不能使用 latent upscale。`);
    }
  }
  if (
    s.task_type === "video_to_video"
      ? !choiceOk(OPS, s.operation)
      : s.operation != null
  ) fail(`分镜 ${s.id} operation 无效。`);
  if (
    s.task_type !== "video_to_video" && s.unselected_policy === "passthrough"
  ) fail(`分镜 ${s.id} 只有视频二创可原样通过。`);
  const ids = new Set(),
    assetIds = new Set(),
    pairs = new Set(),
    count = Object.fromEntries(Object.keys(ROLE_KIND).map((x) => [x, 0])),
    kinds = { image: 0, video: 0, audio: 0 };
  for (const b of s.bindings) {
    if (
      !b || !validId(b.id) || ids.has(b.id) || !validId(b.asset_id) || assetIds.has(b.asset_id) ||
      !Object.hasOwn(ROLE_KIND, b.role) || !Number.isInteger(b.order) ||
      b.order < 0 || pairs.has(`${b.role}:${b.order}`) ||
      (b.origin !== undefined && !BINDING_ORIGINS.includes(b.origin))
    ) {
      fail(`分镜 ${s.id} 有无效或重复绑定。`);
      continue;
    }
    ids.add(b.id);
    assetIds.add(b.asset_id);
    pairs.add(`${b.role}:${b.order}`);
    count[b.role]++;
    const a = assets.get(b.asset_id);
    if (!a || a.kind !== ROLE_KIND[b.role]) {
      fail(`分镜 ${s.id} 的 ${b.role} 素材无效。`);
    } else {
      kinds[a.kind]++;
      if (a.scope === "shot" && a.owner_shot_id !== s.id) {
        fail(`分镜 ${s.id} 不能使用其他分镜专属素材。`);
      }
    }
    if (b.range_ms != null) {
      const r = b.range_ms;
      if (
        !r || !Number.isInteger(r.start) || !Number.isInteger(r.end) ||
        r.start < 0 || r.end <= r.start
      ) fail(`分镜 ${s.id} 素材范围无效。`);
    }
    if (
      ["source_audio", "source_video"].includes(b.role) &&
      (!b.range_ms || b.range_ms.end - b.range_ms.start !== s.duration_ms)
    ) fail(`分镜 ${s.id} 源媒体时长必须等于分镜时长。`);
    if (a?.kind === "image" && b.range_ms != null) {
      fail(`分镜 ${s.id} 图片不能有时间范围。`);
    }
    if (a?.duration_ms && b.range_ms?.end > a.duration_ms) {
      fail(`分镜 ${s.id} 的素材范围超过源文件时长。`);
    }
  }
  if (Object.entries(MEDIA_LIMITS).some(([kind, maximum]) => kinds[kind] > maximum)) {
    fail(`分镜 ${s.id} 最多 ${MEDIA_LIMITS.image} 图、${MEDIA_LIMITS.video} 视频、${MEDIA_LIMITS.audio} 音频。`);
  }
  for (const role of Object.keys(count)) {
    if (count[role] && !ALLOWED[s.task_type].includes(role)) {
      fail(`分镜 ${s.id} 当前任务不支持 ${role}。`);
    }
  }
  for (const [role, n] of Object.entries(REQUIRED[s.task_type])) {
    if (count[role] !== n) {
      fail(`分镜 ${s.id} 需要 ${n} 个${ROLE_NAME[role]}。`);
    }
  }
  const requiresAny = DIRECTOR_PROJECT_CONTRACT.task_types[s.task_type].requires_any_roles;
  if (requiresAny.length && !requiresAny.some((role) => count[role])) {
    fail(`分镜 ${s.id} 至少需要一个可用参考素材。`);
  }
  for (const [role, maximum] of Object.entries(ROLE_LIMITS)) {
    if (count[role] > maximum) {
      fail(`分镜 ${s.id} 的${ROLE_NAME[role]}最多 ${maximum} 个。`);
    }
  }
}
export function canPassThroughAudio(project, shot = null) {
  const audioAssets = (project.assets || []).filter(
    (asset) => asset?.kind === "audio" && typeof asset.input_path === "string" && asset.input_path.trim(),
  );
  if (!shot) return audioAssets.length > 0;
  return (shot.bindings || []).some(
    (binding) => binding.role === "source_audio" && audioAssets.some((asset) => asset.id === binding.asset_id),
  );
}

export function effectiveAudioPolicy(project, shot = null) {
  const policy = shot?.audio_policy || project.global?.audio_policy || GLOBAL_DEFAULTS.audio_policy;
  return policy === "passthrough" && !canPassThroughAudio(project, shot) ? "generated" : policy;
}

export function hydrateValidProject(project) {
  // Backend defaults are legal input. Materialize them only after validation,
  // so the interactive controls have a complete draft without ever repairing
  // malformed authored data.
  const value = deep(project);
  value.assets ??= [];
  value.global ??= {};
  value.project.title ??= PROJECT_META_DEFAULTS.title;
  value.project.brief ??= PROJECT_META_DEFAULTS.brief;
  value.project.template_id ??= PROJECT_META_DEFAULTS.template_id;
  value.project.skill_id ??= PROJECT_META_DEFAULTS.skill_id;
  value.global.audio_policy ??= GLOBAL_DEFAULTS.audio_policy;
  value.global.audio_policy = effectiveAudioPolicy(value);
  value.global.ref_image_size ??= GLOBAL_DEFAULTS.ref_image_size;
  value.shot_results = value.shot_results && typeof value.shot_results === "object" && !Array.isArray(value.shot_results)
    ? value.shot_results : {};
  delete value.global.continuity;
  delete value.global.global_apply;
  for (const asset of value.assets) {
    if (asset && typeof asset === "object") delete asset.library_id;
  }
  for (const shot of value.shots) {
    shot.title ??= SHOT_DEFAULTS.title;
    shot.prompt ??= SHOT_DEFAULTS.prompt;
    shot.selected_for_generation ??= SHOT_DEFAULTS.selected_for_generation;
    shot.continuity_from_prev ??= SHOT_DEFAULTS.continuity_from_prev;
    shot.unselected_policy ??= SHOT_DEFAULTS.unselected_policy;
    shot.bindings ??= [...SHOT_DEFAULTS.bindings];
    if (shot.audio_policy === "passthrough") shot.audio_policy = effectiveAudioPolicy(value, shot);
    shot.motion_fps ??= SHOT_DEFAULTS.motion_fps;
    shot.output_fps ??= shot.motion_fps;
    delete shot.camera;
    // 历史提示词里的 @素材名 → 官方标签（一次性迁移，见 normalizePromptMentions）
    shot.prompt = normalizePromptMentions(shot, value.assets);
    for (const binding of shot.bindings) {
      if (binding.mention === true && binding.origin === undefined) {
        binding.origin = "prompt";
        delete binding.mention;
      }
    }
  }
  return value;
}
/**
 * 只补**结构性默认值**：数组/对象的槽位缺失时给空壳，绝不删改用户已有数据。
 *
 * 宽松打开（老项目 / 手改过的 JSON）必须先过这一层，否则渲染代码会在
 * `shot.bindings.map(...)` 这类地方直接崩掉——"能打开"的前提是能渲染。
 */
export function structuralDefaults(project) {
  const value = project && typeof project === "object" && !Array.isArray(project) ? project : {};
  const obj = (candidate) =>
    candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : {};
  value.project = obj(value.project);
  value.canvas = obj(value.canvas);
  value.global = obj(value.global);
  value.assets = Array.isArray(value.assets) ? value.assets : [];
  value.shots = Array.isArray(value.shots) ? value.shots : [];
  value.shot_results = obj(value.shot_results);
  for (const shot of value.shots) {
    if (!shot || typeof shot !== "object") continue;
    shot.bindings = Array.isArray(shot.bindings) ? shot.bindings : [];
  }
  return value;
}

/**
 * 参与官方标签编号的角色：`[角色, 官方标签名]`，**顺序就是官方呈现顺序**（images → videos → audios）。
 *
 * `reference_video`（r2v 参考视频）与 `source_video`（v2v 源视频）共用同一个 `Video` 计数——
 * 官方所有视频是**一条** `<Video k>` 序列；源视频与参考视频共用计数，合计最多两个。
 *
 * 首/尾帧不在其中：它们已经在输入里，官方不给它们编号；
 * 音频排在图片、视频之后；source/reference 两种角色在执行层共用一条 Audio 编号序列。
 */
export const TAGGED_ROLES = Object.freeze([
  ["reference_image", "Picture"],
  ["source_video", "Video"],
  ["reference_video", "Video"],
  ["source_audio", "Audio"],
  ["reference_audio", "Audio"],
]);

/** 这个角色能不能拿到官方号（`@` 下拉与「引用」按钮用它过滤）。 */
export function isTaggedRole(role) {
  return TAGGED_ROLES.some(([name]) => name === role);
}

/**
 * 官方参考槽位表：槽位序号 ↔ MiniMax H3 官方标签（媒体标签 + 系统分配的 `<Subject N>`）。
 *
 * 官方节点（`comfy_extras/nodes_minimax_h3.py:239-252`）规定参考素材按**提交顺序**编号：
 * images → `<Picture i>`，videos → `<Video k>`（带音轨的视频，其 `<Audio j>` 紧挨在前），
 * 独立音频 → `<Audio j>`；序号 1-based 且**按类型分别计数**。
 *
 * 我们当前的采样器喂三种：参考图（`ref_image_0/1`）、参考视频与 v2v 源视频（都进
 * `ref_video_0`，二者互斥、共用一个 `Video` 号），以及统一的音频参考输入。
 *
 * **序号按绑定顺序算，不按提示词里标签出现的顺序**——否则用户把 `<Picture 2>` 写在
 * `<Picture 1>` 前面就会张冠李戴。首/尾帧（i2v / fl2v）不走标签。
 * Subject 只分配给视觉参考（Picture / Video），按系统槽位顺序单独连续编号；Audio 不分配 Subject。
 *
 * 装饰层（缩略图）、失效判定、素材框上的号牌共用这一份规则，避免多处序号算法漂移。
 */
export function officialSlots(shot, assets = []) {
  const byId = new Map((assets ?? []).map((asset) => [asset.id, asset]));
  const bindings = Array.isArray(shot?.bindings) ? shot.bindings : [];
  const roleOrder = (role) =>
    bindings
      .filter((binding) => binding?.role === role)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const slots = [];
  const counter = {};
  let subjectCounter = 0;
  for (const [role, label] of TAGGED_ROLES) {
    for (const binding of roleOrder(role)) {
      const asset = byId.get(binding.asset_id);
      if (!asset) continue; // 指向不存在的素材：交给 validate() 报
      counter[label] = (counter[label] || 0) + 1;
      const subjectTag = label === "Picture" || label === "Video"
        ? `<Subject ${++subjectCounter}>` : null;
      slots.push({
        tag: `<${label} ${counter[label]}>`,
        subjectTag,
        mention: `@${asset.name || asset.id}`,
        asset,
        binding,
        role,
        order: binding.order ?? 0,
      });
    }
  }
  return slots;
}

/**
 * 提示词里出现的**官方标签**（按出现顺序，保留重复计数所需的原样形式）。
 *
 * `kind` 归一化成 `Picture` / `Video` / `Audio`，`ordinal` 是 1-based 序号；
 * 大小写与空格随意（`< picture 1 >` 也算），因为官方解析本身不敏感。
 *
 * `Audio` 与图片、视频一样参与正式编号；source/reference 两种音频角色共用同一序列。
 */
export function promptTags(text) {
  return [...String(text ?? "").matchAll(/<(Picture|Video|Audio)\s*(\d+)\s*>/gi)].map((match) => ({
    tag: `<${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()} ${Number(match[2])}>`,
    kind: `${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()}`,
    ordinal: Number(match[2]),
  }));
}

export function creativeAssetTokens(text) {
  return [...new Set(
    [...String(text ?? "").matchAll(/<asset:([A-Za-z]\d+)>/gi)]
      .map((match) => `<asset:${match[1].toUpperCase()}>`),
  )];
}

export function isSafeResultFile(result) {
  if (!result || typeof result !== "object") return false;
  const filename = String(result.filename || ""),
    subfolder = String(result.subfolder || ""),
    fullpath = String(result.fullpath || ""),
    relativeParts = subfolder.replaceAll("\\", "/").split("/"),
    normalizedFullpath = fullpath.replaceAll("\\", "/");
  if (
    !filename || /[\\/\u0000]/.test(filename) || [".", ".."].includes(filename) ||
    !subfolder || subfolder.includes("\u0000") || relativeParts.some((part) => !part || part === "." || part === "..") ||
    !fullpath || fullpath.includes("\u0000") ||
    !(normalizedFullpath.startsWith("/") || /^[A-Za-z]:\//.test(normalizedFullpath)) ||
    normalizedFullpath.split("/").some((part) => part === "..")
  ) return false;
  return normalizedFullpath.endsWith(`/${relativeParts.join("/")}/${filename}`);
}

/** Current authored dialogue is the exact text already inside H3 <d> tags. */
export function promptDialogues(text) {
  return [...String(text ?? "").matchAll(/<d>\s*(?:\[[^\]]+\])?\s*([\s\S]*?)<\/d>/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

/**
 * 提示词里**对不上任何槽位**的标签（去重、按出现顺序）。
 *
 * 这是"删除参考图 → 文本不动、标失效"的判定：序号是位置，槽位没了标签就悬空，
 * 我们只把它指出来（装饰位画 `!`、状态条列一行），不改写用户的文本。
 */
export function danglingTags(shot, assets = []) {
  const known = new Set(officialSlots(shot, assets).map((slot) => slot.tag.toLowerCase()));
  const seen = new Set(),
    out = [];
  for (const item of promptTags(shot?.prompt)) {
    if (known.has(item.tag.toLowerCase()) || seen.has(item.tag)) continue;
    seen.add(item.tag);
    out.push(item.tag);
  }
  return out;
}

/**
 * 把历史提示词里的 `@素材名` 归一化成官方标签（一次性迁移）。
 *
 * 新约定：**提示词文本就是官方格式**（`<Picture i>` / `<Video k>`），提交时原样透传。
 * 但老项目里存的是 `@素材名`，这里在装载时按"名字 → 槽位"换算；
 * 找不到槽位的 `@名字` 原样保留（不猜、不删），由用户在提示词里自己处理。
 */
export function normalizePromptMentions(shot, assets = []) {
  const text = String(shot?.prompt ?? "");
  if (!text.includes("@")) return text;
  const mapping = new Map(officialSlots(shot, assets).map((slot) => [slot.mention, slot.tag]));
  let result = text;
  // 长键优先替换：否则 @girl 会命中 @girl2 的前缀
  for (const mention of [...mapping.keys()].sort((a, b) => b.length - a.length)) {
    result = result.split(mention).join(mapping.get(mention));
  }
  return result;
}

export function read(raw) {
  try {
    const value = JSON.parse(raw);
    const errors = validate(value);
    // 打开宽松：语义不通过（老项目 / 手改过的 JSON）也照常打开，由用户在界面里修。
    // "是否有效"仍由 validate() 表示（标题栏的配置状态药丸就是它算的），
    // 运行仍由服务端严格校验兜底。语法坏（JSON 都解析不了）才真的打不开。
    return {
      project: hydrateValidProject(errors.length ? structuralDefaults(deep(value)) : value),
      error: "",
    };
  } catch (e) {
    return { project: null, error: `project_json 无效：${e.message}` };
  }
}
