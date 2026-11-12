import { ALLOWED, deep, defaultShot, uid, validate } from "./model.js";

export function normalizeMediaRange(start, end, total = 0) {
  const rawStart = Number.isFinite(Number(start)) ? Number(start) : 0,
    rawEnd = Number.isFinite(Number(end)) ? Number(end) : rawStart + 1,
    length = Math.max(1, Math.round(rawEnd - rawStart)),
    available = Math.max(0, Math.round(Number(total) || 0));
  if (!available) {
    const safeStart = Math.max(0, Math.round(rawStart));
    return { start: safeStart, end: safeStart + length };
  }
  if (length >= available) return { start: 0, end: available };
  const safeStart = Math.max(0, Math.min(Math.round(rawStart), available - length));
  return { start: safeStart, end: safeStart + length };
}

export function applyShotFields(project, sourceId, targetIds, fields, idFactory = uid) {
  const next = deep(project), source = next.shots.find((shot) => shot.id === sourceId),
    targets = new Set(targetIds || []), selected = new Set(fields || []);
  if (!source) throw new Error("批量应用的来源分镜不存在");
  for (const shot of next.shots) {
    if (shot.id === sourceId || !targets.has(shot.id)) continue;
    if (selected.has("task")) {
      shot.task_type = source.task_type;
      shot.duration_ms = source.duration_ms;
      if (source.operation === undefined || source.operation === null) delete shot.operation;
      else shot.operation = source.operation;
      shot.bindings = source.bindings.map((binding) => ({ ...deep(binding), id: idFactory("binding") }));
    }
    if (selected.has("prompt")) shot.prompt = source.prompt;
    if (selected.has("fps")) {
      shot.motion_fps = source.motion_fps ?? 24;
      shot.output_fps = source.output_fps ?? shot.motion_fps;
    }
  }
  return next;
}

export function sourceRole(asset) {
  return asset?.kind === "audio" ? "source_audio" : "source_video";
}

export function sourceRanges(project, asset) {
  const role = sourceRole(asset);
  return project.shots.flatMap((shot) => shot.bindings.filter((binding) =>
    binding.asset_id === asset.id && binding.role === role && binding.range_ms
  ).map((binding) => ({ ...binding.range_ms, shot, binding })))
    .sort((left, right) => left.start - right.start);
}

export function normalizeSourceRanges(project, assetId, durationMs) {
  const shortened = [];
  for (const shot of project.shots) {
    const binding = shot.bindings.find((item) =>
      item.asset_id === assetId &&
      ["source_audio", "source_video"].includes(item.role) && item.range_ms
    );
    if (!binding) continue;
    if (shot.duration_ms > durationMs) {
      // No padding or freeze frames: when the media is shorter than the shot we
      // follow the media and shorten the shot, keeping range length == duration.
      shot.duration_ms = Math.max(1, Math.round(durationMs));
      binding.range_ms = { start: 0, end: shot.duration_ms };
      shortened.push(shot);
      continue;
    }
    const start = Math.max(0, Math.min(binding.range_ms.start, durationMs - shot.duration_ms));
    binding.range_ms = { start, end: start + shot.duration_ms };
  }
  return shortened;
}

export function mediaRangeErrors(project, durationForAsset) {
  const errors = [];
  for (const shot of project.shots) {
    for (const binding of shot.bindings) {
      if (binding.role !== "source_audio" || !binding.range_ms) continue;
      const duration = durationForAsset(binding.asset_id);
      if (duration && shot.duration_ms > duration) {
        errors.push(`分镜“${shot.title}”比所选音频更长。`);
      } else if (duration && binding.range_ms.end > duration) {
        errors.push(`分镜“${shot.title}”的音频切片超过素材结尾。`);
      }
    }
  }
  return errors;
}

export function planFullTimelineSlices(shots, asset, cuts, idFactory = uid) {
  const role = sourceRole(asset),
    task = asset.kind === "audio" ? "audio_driven" : "video_to_video",
    old = sourceRanges({ shots }, asset),
    overlap = (range, start, end) => Math.max(0, Math.min(range.end, end) - Math.max(range.start, start)),
    next = [];
  for (let index = 0; index < cuts.length - 1; index++) {
    const start = cuts[index], end = cuts[index + 1];
    if (end <= start) continue;
    const exact = old.find((range) => range.start === start && range.end === end);
    if (exact) {
      next.push(exact.shot);
      continue;
    }
    const best = old.reduce((winner, range) =>
        !winner || overlap(range, start, end) > overlap(winner, start, end) ? range : winner, null),
      shotId = idFactory("shot"),
      shot = best ? deep(best.shot) : defaultShot(shotId, `${asset.name || asset.kind} · ${index + 1}`);
    shot.id = shotId;
    shot.title = best ? `${best.shot.title} · ${index + 1}` : shot.title;
    shot.task_type = task;
    if (task === "video_to_video") shot.operation = best?.shot.operation || "edit";
    else delete shot.operation;
    shot.duration_ms = end - start;
    shot.bindings = shot.bindings.filter((binding) =>
      !(binding.asset_id === asset.id && ["source_audio", "source_video"].includes(binding.role))
    ).map((binding) => ({ ...binding, id: idFactory("binding") }));
    shot.bindings.push({
      id: idFactory("binding"), asset_id: asset.id, role, order: 0,
      origin: "manual", range_ms: { start, end },
    });
    next.push(shot);
  }
  return next;
}

/** Preview a single source audio against the authored shot order without editing shots. */
export function previewAudioForShots(project, asset, durationMs = asset?.duration_ms || 0) {
  const duration = Math.max(0, Math.round(Number(durationMs) || 0));
  let cursor = 0;
  const rows = project.shots.map((shot) => {
    const start = cursor, end = cursor += shot.duration_ms,
      current = shot.bindings.find((binding) => binding.role === "source_audio"),
      otherUse = shot.bindings.some((binding) =>
        binding.asset_id === asset?.id && binding.role !== "source_audio"),
      compatible = Boolean(ALLOWED[shot.task_type]?.includes("source_audio")) && !otherUse,
      covered = duration > 0 && end <= duration;
    return {
      shot, start, end, covered, compatible, current,
      reason: !compatible
        ? otherUse ? "此音频已作为本镜的其他参考；不能同时绑定为驱动音频"
          : "当前任务不支持源音频；请先在原镜选择音频驱动任务"
        : !duration ? "尚未读到音频时长"
        : !covered ? "音频不足，未完整覆盖" : "",
    };
  });
  return { rows, duration, unusedMs: Math.max(0, duration - cursor), canApply: rows.length > 0 && rows.every((row) => row.compatible && row.covered) };
}

/** Change only the source_audio Binding for each compatible authored shot. */
export function applyAudioToExistingShots(project, asset, durationMs = asset?.duration_ms || 0, idFactory = uid) {
  const preview = previewAudioForShots(project, asset, durationMs);
  if (!asset || asset.kind !== "audio" || asset.scope !== "global" || !preview.canApply) {
    throw new Error("音频未完整覆盖所有分镜，或当前任务不支持源音频。");
  }
  const next = deep(project);
  for (const [index, row] of preview.rows.entries()) {
    const shot = next.shots[index], binding = shot.bindings.find((item) => item.role === "source_audio");
    if (binding) {
      binding.asset_id = asset.id;
      binding.range_ms = { start: row.start, end: row.end };
    } else {
      shot.bindings.push({
        id: idFactory("binding"), asset_id: asset.id, role: "source_audio", order: 0,
        origin: "manual", range_ms: { start: row.start, end: row.end },
      });
    }
  }
  const errors = validate(next);
  if (errors.length) throw new Error(errors.join(" "));
  return next;
}

export function audioPreparationCuts(durationMs, { strategy = "approx", seconds = 15, count = 2 } = {}) {
  const duration = Math.round(Number(durationMs) || 0);
  if (duration <= 0) return [];
  if (strategy === "equal") {
    const parts = Number(count);
    if (!Number.isInteger(parts) || parts < 1 || parts > 100 || parts > duration) return [];
    return Array.from({ length: parts + 1 }, (_, index) => Math.round(duration * index / parts));
  }
  const step = Math.round(Number(seconds) * 1000);
  if (!Number.isInteger(step) || step < 1000) return [];
  const cuts = [0];
  for (let at = step; at < duration; at += step) cuts.push(at);
  cuts.push(duration);
  return cuts;
}

/** Explicit fresh replacement: no overlap lookup, old binding, or old prompt inheritance. */
export function replaceShotsFromAudio(project, asset, cuts, idFactory = uid) {
  if (!asset || asset.kind !== "audio" || asset.scope !== "global" ||
    cuts.length < 2 || cuts[0] !== 0 || cuts.at(-1) !== asset.duration_ms ||
    cuts.some((cut, index) => index && cut <= cuts[index - 1])) {
    throw new Error("请先选择有有效时长的全局音频并预览完整分段。");
  }
  const next = deep(project), oldIds = new Set(next.shots.map((shot) => shot.id));
  next.shots = planFullTimelineSlices([], asset, cuts, idFactory);
  for (const shot of next.shots) shot.audio_policy = "passthrough";
  next.selected_shot_id = next.shots[0].id;
  next.shot_results = Object.fromEntries(Object.entries(next.shot_results || {})
    .filter(([shotId]) => !oldIds.has(shotId)));
  // Shot-only asset records cannot outlive their owner; shared/global assets
  // remain in the library, and the uploaded source file is never deleted.
  next.assets = next.assets.filter((item) =>
    item.scope !== "shot" || !oldIds.has(item.owner_shot_id));
  const errors = validate(next);
  if (errors.length) throw new Error(errors.join(" "));
  return next;
}

export function replaceTimelineWithSlices(project, asset, cuts) {
  const shots = planFullTimelineSlices(project.shots, asset, cuts);
  project.shots = shots.length ? shots : [defaultShot()];
  project.selected_shot_id = project.shots[0].id;
  return project.shots;
}

export function removeTimelineRange(project, asset, range) {
  const role = sourceRole(asset);
  project.shots = project.shots.filter((shot) => shot.bindings.some((binding) =>
    binding.asset_id === asset.id && binding.role === role && binding.range_ms &&
    !(binding.range_ms.start === range.start && binding.range_ms.end === range.end)
  ));
  if (!project.shots.length) project.shots.push(defaultShot());
  project.selected_shot_id = project.shots[0].id;
  return project.shots;
}

export function syncShotSourceRanges(shot) {
  for (const binding of shot.bindings) {
    if (["source_audio", "source_video"].includes(binding.role) && binding.range_ms) {
      binding.range_ms.end = binding.range_ms.start + shot.duration_ms;
    }
  }
}
