/** CreativeProject：剧本、资产卡和正式创作分镜的唯一真相。 */
export const SCHEMA = "zdx/creative-project/v1";
// 与服务端 assist_contract.MAX_STORY_CHARS 保持一致：只提示分场，不截断。
export const STORY_MAX_CHARS = 6000;
export const MANUAL_NEW_SHOT_DURATION_MS = 3000;
export const INVALID_SHOT_DURATION_RECOVERY_MS = 500;

const text = (value) => (typeof value === "string" ? value : "");
const list = (value) => (Array.isArray(value) ? value : []);
const rows = (value) => list(value).filter((item) => item && typeof item === "object");
const record = (value) => value && typeof value === "object" && !Array.isArray(value);

export function blankAssistant() {
  return {
    schema: SCHEMA,
    project: { id: "project_01", title: "未命名短片" },
    story: { skill_id: "free", text: "", dialogue: [], notes: [], revision: 0 },
    assets: [],
    shots: [],
    handoff: { director_links: {}, legacy_dialogue_by_director: {} },
    preferences: { dialogue_lock: false, strict_preflight: false },
  };
}
export const blankCreativeProject = blankAssistant;

function normalizeDialogue(value) {
  return rows(value)
    .map((item) => ({ speaker: text(item.speaker), text: text(item.text) }));
}

const assetType = (value) => ({ 人物: "character", 场景: "scene", 道具: "prop" }[value] || value);
const validAssetType = (value) => ["character", "scene", "prop"].includes(value) ? value : "prop";
const stableId = (value, prefix, fallback) => new RegExp(`^${prefix}\\d+$`, "i").test(text(value))
  ? text(value).toUpperCase() : `${prefix}${String(fallback).padStart(2, "0")}`;

function normalizeAsset(item, index) {
  return {
    asset_id: stableId(item.asset_id, "A", index + 1),
    name: text(item.name) || `未命名资产 ${index + 1}`,
    type: validAssetType(assetType(item.type || item.asset_type)),
    description: text(item.description),
    fixed_features: list(item.fixed_features).map(text).map((value) => value.trim()).filter(Boolean),
    image_path: text(item.image_path) || null,
    ...(item.composition_draft && typeof item.composition_draft === "object" && !Array.isArray(item.composition_draft)
      ? { composition_draft: structuredClone(item.composition_draft) } : {}),
  };
}

function normalizeShot(item, index) {
  return {
    shot_id: stableId(item.shot_id, "S", index + 1),
    title: text(item.title) || `分镜 ${index + 1}`,
    prompt: text(item.prompt) || text(item.fragment),
    duration_ms: Number.isFinite(item.duration_ms) && item.duration_ms > 0
      ? Math.round(item.duration_ms)
      : Number.isFinite(item.suggested_duration_ms) && item.suggested_duration_ms > 0
        ? Math.round(item.suggested_duration_ms) : INVALID_SHOT_DURATION_RECOVERY_MS,
    asset_refs: [...new Set(list(item.asset_refs).map(text).filter(Boolean))],
    ...(item.frame_drafts && typeof item.frame_drafts === "object" && !Array.isArray(item.frame_drafts)
      ? { frame_drafts: structuredClone(item.frame_drafts) } : {}),
  };
}

export function nextStableId(items, key, prefix) {
  const used = new Set(rows(items).map((item) => text(item[key]).toUpperCase()));
  for (let index = 1; index < 10000; index++) {
    const candidate = `${prefix}${String(index).padStart(2, "0")}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`无法分配新的 ${prefix} ID`);
}

export function newCreativeAsset(project, values = {}) {
  return normalizeAsset({ ...values, asset_id: nextStableId(project.assets, "asset_id", "A") }, project.assets.length);
}

export function newCreativeShot(project, values = {}) {
  return normalizeShot({
    duration_ms: MANUAL_NEW_SHOT_DURATION_MS,
    ...values,
    shot_id: nextStableId(project.shots, "shot_id", "S"),
  }, project.shots.length);
}

export function parseAssetTokens(prompt) {
  return [...String(prompt || "").matchAll(/<asset:([A-Za-z]\d+)>/g)].map((match) => match[1].toUpperCase());
}

export function assetReferenceErrors(project, shot) {
  const known = new Set(project.assets.map((asset) => asset.asset_id)),
    tokens = [...new Set(parseAssetTokens(shot.prompt))], refs = [...new Set(shot.asset_refs || [])], errors = [];
  for (const id of new Set([...tokens, ...refs])) if (!known.has(id)) errors.push(`未知资产引用：${id}`);
  if (JSON.stringify(tokens.sort()) !== JSON.stringify(refs.sort())) errors.push("prompt token 与 asset_refs 不一致");
  return errors;
}

const dialogueShapeErrors = (value, field) => {
  if (!Array.isArray(value)) return [`${field} 必须是数组`];
  return value.flatMap((line, index) => !line || typeof line !== "object"
    || typeof line.speaker !== "string" || typeof line.text !== "string"
    ? [`${field}[${index}] 必须是 {speaker,text}`] : []);
};

export function creativeProjectStructureErrors(project) {
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    return ["CreativeProject 必须是对象"];
  }
  const errors = [];
  if (project.schema !== SCHEMA) errors.push(`schema 必须是 ${SCHEMA}`);
  if (!project.project || typeof project.project !== "object"
    || typeof project.project.id !== "string" || !project.project.id
    || typeof project.project.title !== "string") errors.push("project.id/title 无效");
  const story = project.story;
  if (!story || typeof story !== "object" || typeof story.skill_id !== "string"
    || typeof story.text !== "string" || !Number.isInteger(story.revision) || story.revision < 0
    || !Array.isArray(story.notes) || story.notes.some((item) => typeof item !== "string")) {
    errors.push("Story 字段无效");
  } else errors.push(...dialogueShapeErrors(story.dialogue, "story.dialogue"));

  const assets = Array.isArray(project.assets) ? project.assets : null,
    shots = Array.isArray(project.shots) ? project.shots : null,
    assetIds = new Set(), shotIds = new Set();
  if (!assets) errors.push("assets 必须是数组");
  else for (const [index, asset] of assets.entries()) {
    if (!asset || typeof asset !== "object" || !/^A\d+$/.test(asset.asset_id || "")) {
      errors.push(`assets[${index}].asset_id 无效`); continue;
    }
    if (assetIds.has(asset.asset_id)) errors.push(`AssetCard ID ${asset.asset_id} 重复`);
    assetIds.add(asset.asset_id);
    if (typeof asset.name !== "string" || !["character", "scene", "prop"].includes(asset.type)
      || typeof asset.description !== "string" || !Array.isArray(asset.fixed_features)
      || asset.fixed_features.some((item) => typeof item !== "string")
      || !(asset.image_path === null || typeof asset.image_path === "string")
      || (asset.composition_draft !== undefined && !record(asset.composition_draft))) {
      errors.push(`AssetCard ${asset.asset_id} 字段无效`);
    }
  }
  if (!shots) errors.push("shots 必须是数组");
  else for (const [index, shot] of shots.entries()) {
    if (!shot || typeof shot !== "object" || !/^S\d+$/.test(shot.shot_id || "")) {
      errors.push(`shots[${index}].shot_id 无效`); continue;
    }
    if (shotIds.has(shot.shot_id)) errors.push(`CreativeShot ID ${shot.shot_id} 重复`);
    shotIds.add(shot.shot_id);
    if (typeof shot.title !== "string" || typeof shot.prompt !== "string"
      || !Number.isInteger(shot.duration_ms) || shot.duration_ms <= 0
      || !Array.isArray(shot.asset_refs) || shot.asset_refs.some((id) => typeof id !== "string")
      || (shot.frame_drafts !== undefined && (!record(shot.frame_drafts)
        || Object.entries(shot.frame_drafts).some(([role, draft]) =>
          !["first_frame", "last_frame"].includes(role) || !record(draft))))) {
      errors.push(`CreativeShot ${shot.shot_id} 字段无效`);
    }
  }
  const handoff = project.handoff;
  if (!handoff || typeof handoff !== "object" || !handoff.director_links
    || typeof handoff.director_links !== "object" || Array.isArray(handoff.director_links)
    || Object.values(handoff.director_links).some((id) => typeof id !== "string")
    || !handoff.legacy_dialogue_by_director || typeof handoff.legacy_dialogue_by_director !== "object"
    || Array.isArray(handoff.legacy_dialogue_by_director)) {
    errors.push("handoff 字段无效");
  } else {
    for (const [directorId, dialogue] of Object.entries(handoff.legacy_dialogue_by_director)) {
      errors.push(...dialogueShapeErrors(dialogue, `legacy_dialogue_by_director.${directorId}`));
    }
  }
  if (project.shot_drafts !== undefined) {
    if (!record(project.shot_drafts)) errors.push("shot_drafts 必须是对象");
    else for (const [id, draft] of Object.entries(project.shot_drafts)) {
      if (!id || !record(draft) || typeof draft.original_idea !== "string"
        || typeof draft.text !== "string" || !["simple", "twist"].includes(draft.story_direction)) {
        errors.push(`shot_drafts.${id} 字段无效`);
      }
    }
  }
  if (!project.preferences || typeof project.preferences !== "object"
    || typeof project.preferences.dialogue_lock !== "boolean"
    || typeof project.preferences.strict_preflight !== "boolean") errors.push("preferences 字段无效");
  return [...new Set(errors)];
}

export function assertCreativeProjectStructure(project) {
  const errors = creativeProjectStructureErrors(project);
  if (errors.length) throw new Error(`CreativeProject 结构无效：${errors.join("；")}`);
  return project;
}

/** Adopted stories belong to a Director shot, not the project-wide script. */
export function setDirectorShotDraft(project, shotId, draft) {
  assertCreativeProjectStructure(project);
  if (!shotId) throw new Error("缺少导演分镜 ID");
  return assertCreativeProjectStructure({ ...project, shot_drafts: {
    ...project.shot_drafts,
    [shotId]: { original_idea: draft.original_idea, text: draft.text, story_direction: draft.story_direction },
  } });
}

export function removeDirectorShotDrafts(project, shotIds) {
  if (!project.shot_drafts) return project;
  const removed = new Set(shotIds);
  return assertCreativeProjectStructure({ ...project, shot_drafts: Object.fromEntries(
    Object.entries(project.shot_drafts).filter(([id]) => !removed.has(id)),
  ) });
}

export function updateCreativeStory(project, changes = {}) {
  assertCreativeProjectStructure(project);
  const text = changes.text === undefined ? project.story.text : String(changes.text),
    textChanged = text !== project.story.text,
    story = {
      ...project.story,
      ...(changes.skill_id === undefined ? {} : { skill_id: String(changes.skill_id) }),
      text,
      revision: textChanged ? project.story.revision + 1 : project.story.revision,
    },
    next = { ...project, story };
  return assertCreativeProjectStructure(next);
}

export function addCreativeAsset(project, values = {}) {
  assertCreativeProjectStructure(project);
  const next = structuredClone(project), asset = newCreativeAsset(next, values);
  next.assets.push(asset);
  return { project: assertCreativeProjectStructure(next), asset };
}

export function updateCreativeAsset(project, assetId, changes = {}) {
  assertCreativeProjectStructure(project);
  const index = project.assets.findIndex((asset) => asset.asset_id === assetId);
  if (index < 0) throw new Error(`找不到 AssetCard ${assetId}`);
  const current = project.assets[index], allowed = {};
  for (const key of ["name", "type", "description", "fixed_features", "image_path", "composition_draft"]) {
    if (changes[key] !== undefined) allowed[key] = structuredClone(changes[key]);
  }
  const assets = [...project.assets];
  assets[index] = { ...current, ...allowed, asset_id: current.asset_id };
  return assertCreativeProjectStructure({ ...project, assets });
}

export function removeCreativeAsset(project, assetId) {
  assertCreativeProjectStructure(project);
  if (!project.assets.some((asset) => asset.asset_id === assetId)) {
    throw new Error(`找不到 AssetCard ${assetId}`);
  }
  const token = new RegExp(`<asset:${assetId}>`, "gi"), affected = [];
  const shots = project.shots.map((shot) => {
    token.lastIndex = 0;
    const referenced = shot.asset_refs.includes(assetId) || token.test(shot.prompt);
    if (!referenced) return shot;
    affected.push(shot.shot_id);
    token.lastIndex = 0;
    return {
      ...shot,
      prompt: shot.prompt.replace(token, ""),
      asset_refs: shot.asset_refs.filter((id) => id !== assetId),
    };
  });
  const legacyDialogue = { ...project.handoff.legacy_dialogue_by_director };
  for (const [index, shot] of shots.entries()) {
    if (shot.prompt !== project.shots[index].prompt) {
      delete legacyDialogue[project.handoff.director_links[shot.shot_id]];
    }
  }
  const next = {
    ...project,
    assets: project.assets.filter((asset) => asset.asset_id !== assetId),
    shots,
    handoff: { ...project.handoff, legacy_dialogue_by_director: legacyDialogue },
  };
  return { project: assertCreativeProjectStructure(next), affected_shot_ids: affected };
}

export function addCreativeShot(project, values = {}) {
  assertCreativeProjectStructure(project);
  const next = structuredClone(project), shot = newCreativeShot(next, values);
  shot.asset_refs = [...new Set(parseAssetTokens(shot.prompt))];
  next.shots.push(shot);
  return { project: assertCreativeProjectStructure(next), shot };
}

export function updateCreativeShot(project, shotId, changes = {}) {
  assertCreativeProjectStructure(project);
  const index = project.shots.findIndex((shot) => shot.shot_id === shotId);
  if (index < 0) throw new Error(`找不到 CreativeShot ${shotId}`);
  const current = project.shots[index], updated = { ...current };
  if (changes.title !== undefined) updated.title = String(changes.title);
  if (changes.prompt !== undefined) {
    updated.prompt = String(changes.prompt);
    updated.asset_refs = [...new Set(parseAssetTokens(updated.prompt))];
  }
  if (changes.duration_ms !== undefined) updated.duration_ms = Number(changes.duration_ms);
  if (changes.frame_drafts !== undefined) updated.frame_drafts = structuredClone(changes.frame_drafts);
  const shots = [...project.shots];
  shots[index] = { ...updated, shot_id: current.shot_id };
  const handoff = { ...project.handoff, legacy_dialogue_by_director: { ...project.handoff.legacy_dialogue_by_director } };
  if (updated.prompt !== current.prompt) {
    delete handoff.legacy_dialogue_by_director[handoff.director_links[shotId]];
  }
  return assertCreativeProjectStructure({ ...project, shots, handoff });
}

export function moveCreativeShot(project, shotId, delta) {
  assertCreativeProjectStructure(project);
  const index = project.shots.findIndex((shot) => shot.shot_id === shotId);
  if (index < 0) throw new Error(`找不到 CreativeShot ${shotId}`);
  if (!Number.isInteger(delta)) throw new Error("CreativeShot 移动步数必须是整数");
  const target = index + delta;
  if (!delta || target < 0 || target >= project.shots.length) return project;
  const shots = [...project.shots];
  [shots[index], shots[target]] = [shots[target], shots[index]];
  return assertCreativeProjectStructure({ ...project, shots });
}

const secondsLabel = (milliseconds) => (milliseconds / 1000).toFixed(2);

export function mergeCreativeShots(project, shotIds) {
  assertCreativeProjectStructure(project);
  const wanted = new Set(shotIds || []), selected = project.shots
    .map((shot, index) => ({ shot, index }))
    .filter(({ shot }) => wanted.has(shot.shot_id));
  if (wanted.size < 2 || selected.length !== wanted.size) throw new Error("请至少选择两个有效分镜。");
  for (let index = 1; index < selected.length; index++) {
    if (selected[index].index !== selected[index - 1].index + 1) {
      throw new Error("只能合并时间轴上连续的分镜。");
    }
  }
  let elapsed = 0;
  const beats = selected.map(({ shot }) => {
    const start = elapsed;
    elapsed += shot.duration_ms;
    return `${secondsLabel(start)}–${secondsLabel(elapsed)}s：${shot.prompt.trim()}`;
  }).join("\n");
  const prompt = `[Shot 1]\n${beats}`;
  const first = selected[0].shot, merged = {
    ...first,
    prompt,
    duration_ms: elapsed,
  };
  const firstFrame = first.frame_drafts?.first_frame,
    lastFrame = selected.at(-1).shot.frame_drafts?.last_frame;
  if (firstFrame || lastFrame) merged.frame_drafts = {
    ...(firstFrame ? { first_frame: firstFrame } : {}),
    ...(lastFrame ? { last_frame: lastFrame } : {}),
  };
  else delete merged.frame_drafts;
  merged.asset_refs = [...new Set(parseAssetTokens(merged.prompt))];
  const directorLinks = { ...project.handoff.director_links },
    legacyDialogue = { ...project.handoff.legacy_dialogue_by_director };
  for (const { shot } of selected) delete directorLinks[shot.shot_id];
  for (const directorId of new Set(selected.map(({ shot }) => project.handoff.director_links[shot.shot_id]).filter(Boolean))) {
    if (!Object.values(directorLinks).includes(directorId)) delete legacyDialogue[directorId];
  }
  const shots = [...project.shots];
  shots.splice(selected[0].index, selected.length, merged);
  const next = {
    ...project,
    shots,
    handoff: {
      ...project.handoff,
      director_links: directorLinks,
      legacy_dialogue_by_director: legacyDialogue,
    },
  };
  return {
    project: assertCreativeProjectStructure(next),
    merged_shot: merged,
    removed_shot_ids: selected.slice(1).map(({ shot }) => shot.shot_id),
  };
}

export function removeCreativeShot(project, shotId) {
  assertCreativeProjectStructure(project);
  const removed = project.shots.find((shot) => shot.shot_id === shotId);
  if (!removed) throw new Error(`找不到 CreativeShot ${shotId}`);
  const directorId = project.handoff.director_links[shotId],
    directorLinks = { ...project.handoff.director_links },
    legacyDialogue = { ...project.handoff.legacy_dialogue_by_director };
  delete directorLinks[shotId];
  if (directorId && !Object.values(directorLinks).includes(directorId)) delete legacyDialogue[directorId];
  const next = {
    ...project,
    shots: project.shots.filter((shot) => shot.shot_id !== shotId),
    handoff: {
      ...project.handoff,
      director_links: directorLinks,
      legacy_dialogue_by_director: legacyDialogue,
    },
  };
  return { project: assertCreativeProjectStructure(next), removed_shot: removed };
}

export function renderAssetTokenPreview(project, prompt) {
  const names = new Map(project.assets.map((asset) => [asset.asset_id, asset.name]));
  return String(prompt || "").replace(/<asset:([A-Za-z]\d+)>/g, (_all, rawId) => {
    const id = rawId.toUpperCase(); return names.has(id) ? `<${names.get(id)}>` : `<未知资产 ${id}>`;
  });
}

export function isSourceFragmentStale(workspace, sourceFragment) {
  return Boolean(sourceFragment) && !String(workspace?.story?.text || "").includes(sourceFragment);
}

const dialogueKey = (line) => `${String(line?.speaker || "").trim()}\n${String(line?.text || "").trim()}`;

/** Exact multiset diff; repeated identical lines keep their counts. */
export function dialogueDiff(current = [], candidate = []) {
  const left = new Map(), right = new Map(), samples = new Map();
  for (const line of current) {
    const key = dialogueKey(line);
    if (!key.trim()) continue;
    left.set(key, (left.get(key) || 0) + 1);
    samples.set(key, { speaker: String(line.speaker || "").trim(), text: String(line.text || "").trim() });
  }
  for (const line of candidate) {
    const key = dialogueKey(line);
    if (!key.trim()) continue;
    right.set(key, (right.get(key) || 0) + 1);
    samples.set(key, { speaker: String(line.speaker || "").trim(), text: String(line.text || "").trim() });
  }
  const added = [], removed = [], unchanged = [];
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const oldCount = left.get(key) || 0, newCount = right.get(key) || 0,
      row = samples.get(key), same = Math.min(oldCount, newCount);
    if (same) unchanged.push({ ...row, count: same });
    if (newCount > oldCount) added.push({ ...row, count: newCount - oldCount });
    if (oldCount > newCount) removed.push({ ...row, count: oldCount - newCount });
  }
  return { added, removed, unchanged };
}

/** Formal H3 <d> carries text but no stable speaker field, so M1 compares text only. */
export function dialogueTextDiff(current = [], candidate = []) {
  const withoutSpeaker = (rows) => rows.map((line) => ({ speaker: "", text: line.text }));
  return dialogueDiff(withoutSpeaker(current), withoutSpeaker(candidate));
}

export function dialogueText(dialogue = []) {
  return dialogue.map((line) => line.speaker ? `${line.speaker}：${line.text}` : line.text).join("\n");
}

export function parseDialogueText(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = line.match(/^([^：:]{1,30})[：:]\s*(.*)$/);
    return match
      ? { speaker: match[1].trim(), text: match[2].trim() }
      : { speaker: "", text: line };
  }).filter((line) => line.text);
}

export const H3_STRUCTURE_FIELDS = [
  "integrated_multimodal_description", "detailed_description", "subject_definitions",
  "overall_soundscape", "non_diegetic_music",
];

export function isStructuredPrompt(prompt) {
  const source = String(prompt || "");
  // 阶段 B 的事实是正式 prompt 已承载 <d>，不是模型是否恰好遵守字段换行。
  // 字段标题仍可识别无台词的正式 H3 提示词；有 <d> 时优先进入 prompt 真相源。
  return /<d>\s*[\s\S]*?<\/d>/i.test(source)
    || H3_STRUCTURE_FIELDS.some((field) => new RegExp(`(^|\\n)\\s*${field}\\s*:`, "i").test(source));
}

export function assistantStatus(workspace) {
  if (!workspace) return "创作项目未初始化";
  const characters = workspace.story.text.length;
  return [
    `剧本 ${characters} 字`,
    `资产 ${workspace.assets.length} 张`,
    `分镜 ${workspace.shots.length} 条`,
  ].join(" · ");
}

// 与 shot_draft_agent.extract_story_dialogue 的逐行拆镜合同保持一致。
// 仅识别「角色：整句」，不推断叙述中的引语，也不改台词标点或去重。
const nonDialogueLabels = new Set([
  "类型", "标题", "时长", "资产", "提示词", "时间", "地点", "场景", "镜头", "画面",
  "来电显示", "屏幕显示", "手机显示", "信上写着", "信只写了一行",
]);

function dialogueFromCreativePrompt(prompt) {
  return String(prompt || "").split(/\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/).flatMap((line) => {
    const match = line.match(/^\s*([A-Za-z0-9·\u3400-\u9fff]{1,64})[：:]\s*(.+?)\s*$/);
    return match && !nonDialogueLabels.has(match[1]) && match[2].trim()
      ? [{ speaker: match[1], text: match[2].trim() }] : [];
  });
}

/** 旧清单在正文编辑前保留完整兼容；编辑使其失效后从当前创作正文派生。 */
export function dialogueForShot(workspace, projectShotId) {
  if (!workspace || !projectShotId) return [];
  const linkedId = Object.entries(workspace.handoff?.director_links || {})
    .find(([, directorId]) => directorId === projectShotId)?.[0];
  if (linkedId) {
    const shot = workspace.shots?.find((item) => item.shot_id === linkedId);
    if (!shot) return [];
    // 导入的旧镜头保留旧清单；正文编辑由 updateCreativeShot 使旧清单失效。
    const stored = workspace.handoff?.legacy_dialogue_by_director || {};
    return Object.prototype.hasOwnProperty.call(stored, projectShotId)
      ? normalizeDialogue(stored[projectShotId]) : dialogueFromCreativePrompt(shot.prompt);
  }
  const stored = workspace.handoff?.legacy_dialogue_by_director?.[projectShotId],
    legacy = workspace.shots?.find((item) => (item.project_shot_id || item.director_shot_id) === projectShotId)?.dialogue;
  return normalizeDialogue(stored || legacy || []);
}

export function dialogueSignature(workspace, projectShotId) {
  return JSON.stringify(dialogueForShot(workspace, projectShotId));
}
