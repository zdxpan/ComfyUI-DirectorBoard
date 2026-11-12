import {
  ALLOWED,
  MEDIA_LIMITS,
  ROLE_KIND,
  ROLE_LIMITS,
  creativeAssetTokens,
  deep,
  defaultShot,
  officialSlots,
  uid,
  withNoTextConstraint,
} from "../model.js";
import { assetReferenceErrors, creativeProjectStructureErrors, newCreativeShot } from "./workspace.js";

const directorId = (creativeId, used) => {
  const base = `creative_${String(creativeId).toLowerCase()}`;
  let value = base, suffix = 2;
  while (used.has(value)) value = `${base}_${suffix++}`;
  used.add(value); return value;
};

function stripRetiredDirectorFields(project) {
  if (project.global && typeof project.global === "object") {
    delete project.global.global_apply;
    delete project.global.continuity;
  }
  for (const shot of project.shots || []) delete shot.camera;
  return project;
}

function directorLinkErrors(creative) {
  const liveShotIds = new Set(creative.shots.map((shot) => shot.shot_id)),
    links = creative.handoff.director_links,
    ownerByDirector = new Map(), errors = [];
  for (const [creativeShotId, directorShotId] of Object.entries(links)) {
    if (!liveShotIds.has(creativeShotId)) {
      errors.push(`director_links 引用了不存在的 CreativeShot ${creativeShotId}`);
      continue;
    }
    const previous = ownerByDirector.get(directorShotId);
    if (previous && previous !== creativeShotId) {
      errors.push(`多个创作分镜（${previous}、${creativeShotId}）指向同一导演台分镜 ${directorShotId}`);
    }
    ownerByDirector.set(directorShotId, creativeShotId);
  }
  return errors;
}

function handoffReadinessErrors(creative) {
  const structureErrors = creativeProjectStructureErrors(creative);
  if (structureErrors.length) return structureErrors;
  const referenceErrors = creative.shots.flatMap((shot) =>
    assetReferenceErrors(creative, shot).map((error) => `${shot.shot_id}：${error}`));
  return [...referenceErrors, ...directorLinkErrors(creative)];
}

function assertCreativeLinkTopology(creative) {
  const structureErrors = creativeProjectStructureErrors(creative);
  if (structureErrors.length) throw new Error(`创作分镜建链失败：${structureErrors.join("；")}`);
  const linkErrors = directorLinkErrors(creative);
  if (linkErrors.length) throw new Error(`创作分镜建链失败：${linkErrors.join("；")}`);
  return creative.handoff.director_links;
}

function importCreativeAssetSnapshot(project, asset) {
  if (!asset?.asset_id || !asset?.image_path) throw new Error("创作资产缺少图片，不能用于导演台。");
  const existing = project.assets.find((item) => item.creative_asset_id === asset.asset_id);
  if (existing) {
    existing.input_path = asset.image_path;
    existing.name = asset.name || asset.asset_id;
    existing.description = asset.description || "";
    return existing;
  }
  const used = new Set(project.assets.map((item) => item.id)),
    base = `creative_${String(asset.asset_id).toLowerCase()}`;
  let id = base, suffix = 2;
  while (used.has(id)) id = `${base}_${suffix++}`;
  const snapshot = {
    id, creative_asset_id: asset.asset_id, kind: "image", input_path: asset.image_path,
    name: asset.name || asset.asset_id, description: asset.description || "", scope: "global",
  };
  project.assets.push(snapshot);
  return snapshot;
}

function resolveCreativeAssetPrompt(
  prompt, assetId, officialTag, description = "", includeDescription = false,
) {
  const token = `<asset:${String(assetId || "").toUpperCase()}>`,
    escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    pattern = new RegExp(escaped, "gi"),
    source = String(prompt || "");
  if (!new RegExp(escaped, "i").test(source)) return source;
  let resolved = source.replace(pattern, officialTag);
  const detail = String(description || "").trim();
  if (includeDescription && detail) resolved = `${officialTag}：${detail}\n${resolved}`;
  return resolved;
}

function validateAssetBinding(project, shot, asset, role, order, ignoredBinding = null) {
  if (!ALLOWED[shot.task_type]?.includes(role) || ROLE_KIND[role] !== asset.kind) {
    throw new Error(`当前任务不能把创作资产用于 ${role}`);
  }
  const remaining = shot.bindings.filter((binding) => binding !== ignoredBinding
      && !(binding.role === role && binding.order === order)),
    roleCount = remaining.filter((binding) => binding.role === role).length,
    kindCount = remaining.filter((binding) =>
      project.assets.find((item) => item.id === binding.asset_id)?.kind === asset.kind).length;
  if (roleCount >= ROLE_LIMITS[role] || kindCount >= MEDIA_LIMITS[asset.kind]) {
    throw new Error(`当前分镜的 ${role} 素材数量已满`);
  }
}

function importCreativeFrame(project, shot, creativeShot, role) {
  const frame = creativeShot.frame_drafts?.[role], path = frame?.image_path;
  if (!path || !ALLOWED[shot.task_type]?.includes(role)) return;
  const key = `${creativeShot.shot_id}:${role}`,
    existing = project.assets.find((asset) => asset.creative_frame_key === key),
    binding = existing && shot.bindings.find((item) => item.asset_id === existing.id),
    occupied = shot.bindings.find((item) => item.role === role && item.order === 0);
  if (occupied && occupied !== binding) return;
  const asset = existing || {
    id: `creative_frame_${creativeShot.shot_id.toLowerCase()}_${role}`,
    creative_frame_key: key, kind: "image", scope: "shot", owner_shot_id: shot.id,
    name: `${creativeShot.title} · ${role === "first_frame" ? "首帧" : "尾帧"}`,
  };
  if (!existing && project.assets.some((item) => item.id === asset.id)) return;
  validateAssetBinding(project, shot, asset, role, 0, binding || null);
  asset.input_path = path;
  if (!existing) project.assets.push(asset);
  if (!binding) shot.bindings.push({
    id: uid("binding"), asset_id: asset.id, role, order: 0, origin: "manual",
  });
}

export function handoffCreativeProject(directorProject, creativeProject) {
  const readinessErrors = handoffReadinessErrors(creativeProject);
  if (readinessErrors.length) throw new Error("交给导演台失败：" + readinessErrors.join("；"));
  const project = stripRetiredDirectorFields(deep(directorProject)), creative = structuredClone(creativeProject);
  if (creative.shots.length && project.shots.length === 1) {
    const only = project.shots[0];
    if (only.id === "shot_01" && only.task_type === defaultShot().task_type
      && !only.prompt && !(only.bindings || []).length) project.shots = [];
  }
  const
    byId = new Map(project.shots.map((shot) => [shot.id, shot])), used = new Set(byId.keys()), links = [];
  for (const creativeShot of creative.shots) {
    const linkedId = creative.handoff?.director_links?.[creativeShot.shot_id];
    let shot = linkedId ? byId.get(linkedId) : null;
    if (!shot) {
      shot = defaultShot(directorId(creativeShot.shot_id, used), creativeShot.title);
      project.shots.push(shot); byId.set(shot.id, shot);
    }
    shot.title = creativeShot.title;
    shot.prompt = withNoTextConstraint(creativeShot.prompt);
    shot.duration_ms = creativeShot.duration_ms;
    for (const role of ["first_frame", "last_frame"]) {
      try { importCreativeFrame(project, shot, creativeShot, role); }
      catch { /* Existing media limits and user bindings take priority over optional frame drafts. */ }
    }
    creative.handoff ||= { director_links: {}, legacy_dialogue_by_director: {} };
    creative.handoff.director_links[creativeShot.shot_id] = shot.id;
    links.push({ shot_id: creativeShot.shot_id, director_shot_id: shot.id, unresolved_asset_refs: [...creativeShot.asset_refs] });
  }
  if (!project.selected_shot_id || !byId.has(project.selected_shot_id)) project.selected_shot_id = links[0]?.director_shot_id || project.shots[0]?.id;
  return { project, creative, links };
}

export function handoffCreativeAsset(
  directorProject, creativeProject, directorShotId, creativeAssetId, role, order,
  includeDescription = false,
) {
  const project = deep(directorProject),
    shot = project.shots.find((item) => item.id === directorShotId),
    creativeAsset = creativeProject.assets.find((item) => item.asset_id === creativeAssetId);
  if (!shot) throw new Error(`导演台中找不到分镜 ${directorShotId}`);
  if (!creativeAsset) throw new Error(`创作项目中找不到资产 ${creativeAssetId}`);
  const snapshot = importCreativeAssetSnapshot(project, creativeAsset),
    existing = shot.bindings.find((binding) => binding.asset_id === snapshot.id);
  if (existing && (existing.role !== role || existing.order !== order)) {
    throw new Error(`“${creativeAsset.name || creativeAsset.asset_id}”已绑定在当前分镜的其它槽位。`);
  }
  validateAssetBinding(project, shot, snapshot, role, order, existing);
  const binding = existing || {
    id: uid("binding"), asset_id: snapshot.id, role, order, origin: "manual",
  };
  if (!existing) {
    shot.bindings = shot.bindings.filter((item) => !(item.role === role && item.order === order));
    shot.bindings.push(binding);
  }
  const creativeToken = `<asset:${String(creativeAsset.asset_id).toUpperCase()}>`,
    hasCreativeToken = shot.prompt.toUpperCase().includes(creativeToken.toUpperCase()),
    tag = officialSlots(shot, project.assets).find((slot) => slot.binding.id === binding.id)?.tag || null;
  if (hasCreativeToken && !tag) {
    throw new Error(`当前槽位没有可替换 ${creativeToken} 的正式 Picture 标签。`);
  }
  if (hasCreativeToken) {
    shot.prompt = resolveCreativeAssetPrompt(
      shot.prompt, creativeAsset.asset_id, tag, creativeAsset.description, includeDescription,
    );
  }
  return { project, binding, tag, replaced: hasCreativeToken };
}

export function ensureCreativeShotForDirector(creativeProject, directorProject, directorShotId) {
  const creative = structuredClone(creativeProject), links = assertCreativeLinkTopology(creative),
    existing = Object.entries(links).find(([, linkedId]) => linkedId === directorShotId);
  if (existing) return { creative, shot_id: existing[0], created: false };
  const source = directorProject.shots.find((shot) => shot.id === directorShotId);
  if (!source) throw new Error(`导演台中找不到分镜 ${directorShotId}`);
  const shot = newCreativeShot(creative, {
    title: source.title, prompt: source.prompt, duration_ms: source.duration_ms,
  });
  creative.shots.push(shot);
  creative.handoff.director_links[shot.shot_id] = source.id;
  return { creative, shot_id: shot.shot_id, created: true };
}

export function writePromptToDirector(directorProject, directorShotId, prompt) {
  const project = stripRetiredDirectorFields(deep(directorProject)),
    shot = project.shots.find((item) => item.id === directorShotId);
  if (!shot) throw new Error(`导演台中找不到分镜 ${directorShotId}`);
  const unresolved = creativeAssetTokens(prompt);
  if (unresolved.length) {
    throw new Error(`写入导演台失败：创作资产尚未确认 ${unresolved.join(" ")}`);
  }
  shot.prompt = withNoTextConstraint(prompt);
  return project;
}
