import {
  addCreativeAsset, addCreativeShot, updateCreativeAsset, updateCreativeShot, updateCreativeStory,
} from "./workspace.js";

export const CANDIDATE_KINDS = Object.freeze([
  "story", "asset_suggestions", "asset_update",
  "shot_breakdown", "shot_update", "director_prompt",
]);

const clone = (value) => structuredClone(value);
const assetFingerprint = (asset) => JSON.stringify({
  name: asset?.name || "",
  type: asset?.type || "prop",
  description: asset?.description || "",
  fixed_features: asset?.fixed_features || [],
});
const shotFingerprint = (shot) => JSON.stringify(shot || null);
const assetsFingerprint = (project) => JSON.stringify(project.assets || []);

function pending(candidate) {
  if (!candidate || candidate.status !== "pending") throw new Error("Candidate 已处理，不能重复操作。");
}

export function createCandidate(kind, { creativeProject }, payload = {}) {
  if (!CANDIDATE_KINDS.includes(kind)) throw new Error(`未知 Candidate kind: ${kind}`);
  if (!creativeProject) throw new Error("创建 Candidate 需要 CreativeProject。");
  const story = creativeProject.story || {}, targetId = payload.targetId || null;
  let slot, scope, before, basedOnStoryRevision = null;
  if (kind === "story") {
    slot = "story";
    scope = { type: payload.selection ? "selection" : "story", ids: [] };
    before = {
      story_revision: story.revision,
      story_text: story.text,
      draft_snapshot: payload.draftSnapshot ?? story.text,
      selection: payload.selection ? clone(payload.selection) : null,
    };
    basedOnStoryRevision = story.revision;
  } else if (kind === "asset_suggestions" || kind === "shot_breakdown") {
    slot = kind === "asset_suggestions" ? "asset_batch" : "shot_batch";
    scope = { type: "story", ids: [] };
    before = {
      story_revision: story.revision,
      story_text: story.text,
      ...(kind === "shot_breakdown" ? { assets_fingerprint: assetsFingerprint(creativeProject) } : {}),
    };
    basedOnStoryRevision = story.revision;
  } else if (kind === "asset_update") {
    const asset = creativeProject.assets.find((item) => item.asset_id === targetId);
    if (!asset) throw new Error(`找不到资产卡 ${targetId}`);
    slot = `asset:${targetId}`;
    scope = { type: "asset", ids: [targetId] };
    before = { fingerprint: assetFingerprint(asset) };
  } else if (kind === "shot_update") {
    const shot = creativeProject.shots.find((item) => item.shot_id === targetId);
    if (!shot) throw new Error(`找不到创作分镜 ${targetId}`);
    slot = `shot:${targetId}`;
    scope = { type: "shot", ids: [targetId] };
    before = {
      fingerprint: shotFingerprint(shot),
      assets_fingerprint: assetsFingerprint(creativeProject),
    };
  } else {
    slot = `shot:${targetId}`;
    scope = { type: "director_shot", ids: [payload.directorShotId] };
    before = {
      fingerprint: String(payload.fingerprint || ""),
      director_shot_id: String(payload.directorShotId || ""),
      expected_dialogue: clone(payload.expectedDialogue || []),
    };
  }
  return {
    slot,
    kind,
    scope,
    before,
    after: clone(payload.after),
    warnings: clone(payload.warnings || []),
    based_on_story_revision: basedOnStoryRevision,
    status: "pending",
  };
}

export function updateCandidate(candidate, after) {
  pending(candidate);
  candidate.after = clone(after);
  return candidate;
}

export function discardCandidate(candidate) {
  pending(candidate);
  candidate.status = "discarded";
  return candidate;
}

export function candidateStaleReason(candidate, context = {}) {
  pending(candidate);
  const project = context.creativeProject;
  if (!project) return "CreativeProject 不存在。";
  if (["story", "asset_suggestions", "shot_breakdown"].includes(candidate.kind)) {
    if (project.story.revision !== candidate.before.story_revision
      || project.story.text !== candidate.before.story_text) return "剧本已变化，不能采纳旧 Candidate。";
  }
  if (candidate.kind === "story") {
    if (context.draft !== undefined && context.draft !== candidate.before.draft_snapshot) {
      return "剧本已手工修改，请重新生成 Candidate。";
    }
    const selection = candidate.before.selection;
    if (selection && project.story.text.slice(selection.start, selection.end) !== selection.text) {
      return "选中的剧本段落已变化。";
    }
  }
  if (candidate.kind === "asset_update") {
    const id = candidate.scope.ids[0], asset = project.assets.find((item) => item.asset_id === id);
    if (!asset || assetFingerprint(asset) !== candidate.before.fingerprint) return "资产卡已变化，请重新生成 Candidate。";
  }
  if (candidate.kind === "shot_update") {
    const id = candidate.scope.ids[0], shot = project.shots.find((item) => item.shot_id === id);
    if (!shot || shotFingerprint(shot) !== candidate.before.fingerprint) return "分镜已变化，请重新生成 Candidate。";
  }
  if (["shot_breakdown", "shot_update"].includes(candidate.kind)
    && assetsFingerprint(project) !== candidate.before.assets_fingerprint) {
    return "创作资产已变化，请重新生成 Candidate。";
  }
  if (candidate.kind === "director_prompt"
    && context.directorFingerprint !== candidate.before.fingerprint) {
    return "导演台分镜已变化，请重新生成 Candidate。";
  }
  return "";
}

function applyStory(candidate, project) {
  let text = project.story.text;
  const selection = candidate.before.selection;
  if (selection) text = text.slice(0, selection.start) + String(candidate.after.text || "") + text.slice(selection.end);
  else text = String(candidate.after.text || "");
  return updateCreativeStory(project, { text });
}

function applyAssetSuggestions(candidate, project) {
  let next = project;
  const added = [];
  for (const suggestion of candidate.after.filter((row) => row.selected !== false)) {
    const result = addCreativeAsset(next, {
      name: suggestion.name,
      type: ({ 人物: "character", 场景: "scene", 道具: "prop" }[suggestion.type] || suggestion.type),
      description: suggestion.description,
      fixed_features: suggestion.fixed_features || [],
    });
    next = result.project; added.push(result.asset);
  }
  if (!added.length) throw new Error("请至少选择一个资产 Candidate。");
  return { project: next, added };
}

function applyAssetUpdate(candidate, project) {
  const id = candidate.scope.ids[0], after = candidate.after || {};
  const asset = project.assets.find((item) => item.asset_id === id);
  return updateCreativeAsset(project, id, {
    name: String(after.name || asset.name),
    type: String(after.type || asset.type),
    description: String(after.description ?? asset.description),
    fixed_features: clone(after.fixed_features || []),
  });
}

function applyShotBreakdown(candidate, project) {
  let next = project;
  const added = [];
  for (const row of candidate.after.filter((item) => item.selected !== false)) {
    const durationMs = Number(row.duration_ms ?? row.suggested_duration_ms);
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("分镜 Candidate 时长必须是正数。");
    const result = addCreativeShot(next, {
      title: row.title,
      prompt: row.prompt || row.fragment,
      duration_ms: Math.round(durationMs),
    });
    next = result.project; added.push(result.shot);
  }
  if (!added.length) throw new Error("请至少选择一个分镜 Candidate。");
  return { project: next, added };
}

function applyShotUpdate(candidate, project) {
  const id = candidate.scope.ids[0], after = candidate.after || {};
  const shot = project.shots.find((item) => item.shot_id === id);
  return updateCreativeShot(project, id, {
    title: String(after.title || shot.title),
    prompt: String(after.prompt ?? shot.prompt),
    duration_ms: Number(after.duration_ms || after.suggested_duration_ms || shot.duration_ms),
  });
}

export function acceptCandidate(candidate, context = {}) {
  const stale = candidateStaleReason(candidate, context);
  if (stale) throw new Error(stale);
  let creativeProject = context.creativeProject, directorProject = context.directorProject, added = [];
  if (candidate.kind === "story") creativeProject = applyStory(candidate, creativeProject);
  else if (candidate.kind === "asset_suggestions") {
    ({ project: creativeProject, added } = applyAssetSuggestions(candidate, creativeProject));
  } else if (candidate.kind === "asset_update") creativeProject = applyAssetUpdate(candidate, creativeProject);
  else if (candidate.kind === "shot_breakdown") {
    ({ project: creativeProject, added } = applyShotBreakdown(candidate, creativeProject));
  } else if (candidate.kind === "shot_update") creativeProject = applyShotUpdate(candidate, creativeProject);
  else {
    const errors = context.validateDirectorPrompt?.(
      candidate.after.prompt, candidate.before.expected_dialogue,
    ) || [];
    if (errors.length) throw new Error(`正式提示词不能写入：${errors.join("；")}`);
    if (!context.applyDirectorPrompt) throw new Error("缺少 DirectorHandoff 写入 Adapter。");
    directorProject = context.applyDirectorPrompt(
      directorProject, candidate.before.director_shot_id, candidate.after.prompt,
    );
  }
  if (context.commitCreativeProject && creativeProject !== context.creativeProject) {
    creativeProject = context.commitCreativeProject(creativeProject);
  }
  if (context.commitDirectorProject && directorProject !== context.directorProject) {
    directorProject = context.commitDirectorProject(directorProject);
  }
  candidate.status = "accepted";
  return {
    candidate,
    creativeProject,
    directorProject,
    added,
  };
}

export function putCandidate(store, candidate) {
  pending(candidate);
  const existing = store.get(candidate.slot);
  if (existing && existing !== candidate && existing.status === "pending") {
    throw new Error("已有未处理 Candidate，请先采纳或放弃。");
  }
  store.set(candidate.slot, candidate);
  return candidate;
}

export function consumeCandidate(store, candidate) {
  if (store.get(candidate.slot) === candidate) store.delete(candidate.slot);
}

export function discardStoredCandidate(store, candidate) {
  const discarded = discardCandidate(candidate);
  consumeCandidate(store, candidate);
  return discarded;
}

export function candidateCount(store, page = null) {
  const pageFor = (kind) => kind === "story" ? "story"
    : kind.startsWith("asset") ? "assets" : "shots";
  return [...store.values()].filter((candidate) => candidate.status === "pending"
    && (!page || pageFor(candidate.kind) === page)).length;
}

export function hasPendingCandidates(store) {
  return candidateCount(store) > 0;
}

export function pruneCandidateStore(store, project) {
  const assetIds = new Set(project.assets.map((asset) => asset.asset_id)),
    shotIds = new Set(project.shots.map((shot) => shot.shot_id));
  for (const candidate of store.values()) {
    const id = candidate.scope.ids[0];
    if ((candidate.kind === "asset_update" && !assetIds.has(id))
      || (["shot_update", "director_prompt"].includes(candidate.kind) && !shotIds.has(candidate.slot.slice(5)))) {
      store.delete(candidate.slot);
    }
  }
  return store;
}
