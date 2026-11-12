/** 执行前唯一校验等级与降级计划；不修改正式 DirectorProject。 */
import { CONTINUITY_TASK_TYPES, deep, officialSlots, promptTags, validateShot } from "./model.js";
import { executionPromptErrors } from "./shot-assist.js";

function levelFor(blocked, warnings) {
  return blocked.length ? "blocked" : warnings.length ? "warning" : "ok";
}

export function preflightShot(project, assistant, shot, {
  anchors = {},
  missingAssetPaths = new Set(),
} = {}) {
  const blocked = [], warnings = [], assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  for (const name of ["model", "vae", "clip"]) {
    if (!anchors[name]) blocked.push(`${name.toUpperCase()} 锚点未连接`);
  }
  const boundAssets = [];
  for (const binding of shot.bindings || []) {
    const asset = assets.get(binding.asset_id);
    if (!asset) {
      blocked.push(`Binding ${binding.id || binding.role} 指向不存在的素材 ${binding.asset_id}`);
      continue;
    }
    boundAssets.push(asset);
    if (missingAssetPaths.has(asset.id)) blocked.push(`素材文件不存在：${asset.name || asset.id}`);
  }
  const roles = new Set((shot.bindings || []).map((binding) => binding.role));
  if (shot.continuity_from_prev) {
    if (!CONTINUITY_TASK_TYPES.includes(shot.task_type)) {
      blocked.push("帧间连续性仅支持文生视频或多参考生成");
    }
    const dispatchParams = {
      ...(project.global?.dispatch_params || {}),
      ...(shot.dispatch_params || {}),
    };
    if (dispatchParams.latent_upscale) {
      blocked.push("帧间连续性不能与 latent upscale 同时使用");
    }
  }
  const audioPolicy = shot.audio_policy ?? project.global.audio_policy ?? "generated";
  if (audioPolicy === "passthrough" && !roles.has("source_audio")) {
    blocked.push("输入原声需要为当前分镜绑定源音频");
  }
  const needsAudio = roles.has("source_audio") || roles.has("reference_audio") || audioPolicy === "generated";
  if (needsAudio && !anchors.audio_vae) blocked.push("AUDIO_VAE 锚点未连接");
  if (shot.task_type === "video_to_video" && !roles.has("source_video")) blocked.push("视频二创缺少源视频");
  if (shot.task_type === "first_last_frame") {
    if (!roles.has("first_frame")) blocked.push("首尾帧模式缺少首帧");
    if (!roles.has("last_frame")) blocked.push("首尾帧模式缺少尾帧");
  }
  if (shot.task_type === "audio_driven" && !roles.has("source_audio")) blocked.push("音频驱动缺少源音频");

  const effectiveShot = deep(shot);
  if (shot.task_type === "image_to_video" && !roles.has("first_frame")) {
    warnings.push("图生视频缺首帧：本次按文生视频执行");
    effectiveShot.task_type = "text_to_video";
    effectiveShot.bindings = [];
  } else if (shot.task_type === "reference_video" &&
    !["reference_image", "reference_video", "reference_audio"].some((role) => roles.has(role))) {
    warnings.push("多参考模式没有参考素材：本次按文生视频执行");
    effectiveShot.task_type = "text_to_video";
    effectiveShot.bindings = [];
  }

  const usedTags = new Set(promptTags(shot.prompt).map((item) => item.tag));
  const unmentioned = officialSlots(shot, project.assets)
    .map((slot) => slot.tag)
    .filter((tag) => !usedTags.has(tag));
  if (unmentioned.length) warnings.push(`绑定未在提示词引用：${unmentioned.join(" ")}；仍可生成`);
  const structural = [];
  validateShot(effectiveShot, assets, (message) => structural.push(message));
  blocked.push(...structural);
  blocked.push(...executionPromptErrors({ project, assistant }, shot));
  return {
    shot_id: shot.id,
    title: shot.title || shot.id,
    level: levelFor(blocked, warnings),
    blocked: [...new Set(blocked)],
    warnings: [...new Set(warnings)],
    effective_task_type: effectiveShot.task_type,
    effectiveShot,
    bound_asset_ids: [...new Set(boundAssets.map((asset) => asset.id))],
  };
}

export function preflightFingerprint(project, assistant) {
  return JSON.stringify({ project, assistant: assistant || null });
}

export function materializeExecutionProject(sourceProject, plan, fingerprintShot) {
  if (typeof fingerprintShot !== "function") throw new Error("执行快照需要 Shot 指纹函数");
  const project = deep(sourceProject),
    runnable = plan.filter((item) => item.level !== "blocked"),
    runnableIds = new Set(runnable.map((item) => item.shot_id));
  project.shots = runnable.map((item) => {
    const originalIndex = sourceProject.shots.findIndex((shot) => shot.id === item.shot_id);
    if (originalIndex < 0) throw new Error(`执行计划引用不存在的分镜 ${item.shot_id}`);
    const sourceShot = sourceProject.shots[originalIndex],
      previous = originalIndex > 0 ? sourceProject.shots[originalIndex - 1] : null;
    return {
      ...deep(item.effectiveShot),
      continuity_index: Math.max(0, originalIndex),
      continuity_prev_shot_id: previous?.id ?? null,
      execution_fingerprint: fingerprintShot(sourceProject, sourceShot),
      continuity_prev_fingerprint: previous ? fingerprintShot(sourceProject, previous) : null,
    };
  });
  project.selected_shot_id = project.shots[0]?.id || project.selected_shot_id;
  const referencedAssetIds = new Set(project.shots
    .flatMap((shot) => shot.bindings || []).map((binding) => binding.asset_id));
  project.assets = project.assets.filter((asset) => referencedAssetIds.has(asset.id));
  project.shot_results = Object.fromEntries(Object.entries(project.shot_results || {})
    .filter(([shotId]) => runnableIds.has(shotId)));
  return project;
}

export function buildPreflightPlan(project, assistant, shotIds, options = {}) {
  const wanted = new Set(shotIds);
  const plan = project.shots.filter((shot) => wanted.has(shot.id))
    .map((shot) => preflightShot(project, assistant, shot, options));
  const byId = new Map(plan.map((item) => [item.shot_id, item]));
  for (let index = 0; index < project.shots.length; index++) {
    const shot = project.shots[index], item = byId.get(shot.id);
    if (!item || !shot.continuity_from_prev) continue;
    const previous = project.shots[index - 1], previousPlan = previous && byId.get(previous.id);
    const predecessorUnavailable = options.requireContinuityPredecessor
      ? !previousPlan || previousPlan.level === "blocked"
      : options.continuityReadyShotIds instanceof Set
        && (!previous || !options.continuityReadyShotIds.has(previous.id));
    if (predecessorUnavailable) {
      item.blocked.push("帧间连续性要求上一镜在本次队列中可运行");
      if (!options.requireContinuityPredecessor) {
        item.blocked.push("请先运行上一镜，或在上一镜修改后重新运行它");
      }
      item.blocked = [...new Set(item.blocked)];
      item.level = "blocked";
    }
  }
  return plan;
}
