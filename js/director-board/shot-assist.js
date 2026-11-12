/** 正式单镜提示词的纯请求与执行校验；交互界面统一由创作工作台负责。 */
import {
  creativeAssetTokens, danglingTags, officialSlots, promptDialogues,
} from "./model.js";
import { dialogueForShot, isStructuredPrompt } from "./agent/workspace.js";

export function shotDialogueState(board, shot) {
  const seed = dialogueForShot(board.assistant, shot.id),
    formal = promptDialogues(shot.prompt).map((text) => ({ speaker: "", text })),
    structured = isStructuredPrompt(shot.prompt);
  return {
    seed, formal, structured,
    source: structured ? "formal" : seed.length ? "seed" : "formal",
  };
}

/**
 * 本镜素材快照：把 Binding（本镜怎么用）与 Asset（是哪份资产、去哪里读）合成一次。
 *
 * **请求构造与候选指纹共用这一份** —— 各算一遍就会各漏一遍字段
 * （之前的实际后果：请求里没有 `input_path` 导致后端看不了图，
 * 指纹里没有 `input_path` 导致换图后旧候选仍然通过检查）。
 *
 * 注意 `input_path` 只说明"去哪里读"，**不是内容版本** ——
 * 同路径文件被覆盖时，判据必须是图片内容摘要。
 */
export function expandShotMaterials(board, shot) {
  const assetsById = new Map((board.project.assets || []).map((asset) => [asset.id, asset]));
  const tagsByBinding = new Map(
    officialSlots(shot, board.project.assets).map((slot) => [slot.binding.id, slot]),
  );
  return (shot.bindings || []).map((binding) => {
    const asset = assetsById.get(binding.asset_id), slot = tagsByBinding.get(binding.id);
    return {
      asset_id: binding.asset_id,                       // 项目里是哪份资产
      name: asset?.name || binding.asset_id,            // 给人看的名字
      description: asset?.description || "",
      kind: asset?.kind || null,
      input_path: asset?.input_path || null,            // 去哪里读文件
      role: binding.role,                               // 本镜怎样使用它
      order: binding.order ?? 0,
      range_ms: binding.range_ms || null,
      tag: slot?.tag || null,                           // 本镜怎么称呼它
      subject_tag: slot?.subjectTag || null,
    };
  });
}

/** 可选写作指导快照；仅取项目顺序的上一镜，不合并其台词或素材。 */
export function shotGuidanceContext(board, shot, options = {}) {
  const shots = board.project.shots || [], index = shots.findIndex((item) => item.id === shot.id);
  const previous = options.includePreviousShot && index > 0 ? shots[index - 1] : null;
  const guidance = {
    previous_shot: previous ? {
      shot_id: previous.id, title: previous.title || "", prompt: previous.prompt || "",
    } : null,
    story_background: String(options.storyBackground || "").trim(),
    visual_direction: String(options.visualDirection || "").trim(),
    music_direction: String(options.musicDirection || "").trim(),
  };
  return options.includePreviousShot || guidance.story_background || guidance.visual_direction || guidance.music_direction
    ? guidance : null;
}

/** 在读取时推导默认写作方式，避免把自动 MV 固定为用户显式选择。 */
export function effectiveShotAssistOptions(board, shot, options = {}) {
  const explicitMode = options.writingMode === "mv" || options.writingMode === "standard";
  return {
    ...options,
    writingMode: explicitMode ? options.writingMode
      : shot.task_type === "audio_driven"
        && (shot.audio_policy || board.project.global.audio_policy) === "passthrough" ? "mv" : "standard",
  };
}

export function buildShotAssistRequest(board, shot, instruction, options = {}) {
  options = effectiveShotAssistOptions(board, shot, options);
  const bindings = expandShotMaterials(board, shot);
  const guidance = shotGuidanceContext(board, shot, options);
  const dialogueState = shotDialogueState(board, shot),
    dialogueSource = selectedDialogueSource(dialogueState, options),
    dialogue = dialogueState[dialogueSource];
  return {
    target: "shot_prompt",
    ...(options.writingMode === "mv" ? { writing_mode: "mv" } : {}),
    skill_id: options.skillId || "base-h3",
    dialogue_lock: Boolean(board.assistant?.preferences?.dialogue_lock),
    strict: false,
    current: {
      shot: {
        id: shot.id,
        title: shot.title,
        task_type: shot.task_type,
        operation: shot.operation ?? null,
        duration_ms: shot.duration_ms,
        motion_fps: shot.motion_fps ?? 24,
        output_fps: shot.output_fps ?? shot.motion_fps ?? 24,
      },
      prompt: shot.prompt || "",
    },
    instruction: String(instruction || "").trim(),
    context: {
      ...(guidance ? { guidance } : {}),
      ...(options.dialogueSource ? { dialogue_source: dialogueSource } : {}),
      bindings,
      dialogue,
      canvas: board.project.canvas,
      audio_policy: shot.audio_policy || board.project.global.audio_policy,
    },
  };
}

function selectedDialogueSource(state, options) {
  return options.dialogueSource === "seed" || options.dialogueSource === "formal"
    ? options.dialogueSource : state.source;
}

export function shotAssistFingerprint(board, shot, options = {}) {
  options = effectiveShotAssistOptions(board, shot, options);
  const dialogueState = shotDialogueState(board, shot);
  const guidance = shotGuidanceContext(board, shot, options);
  return JSON.stringify({
    ...(options.skillId ? { skill_id: options.skillId } : {}),
    ...(options.writingMode === "mv" ? { writing_mode: "mv" } : {}),
    ...(guidance ? { guidance } : {}),
    prompt: shot.prompt || "",
    shot_draft: board.assistant?.shot_drafts?.[shot.id] || null,
    task_type: shot.task_type,
    operation: shot.operation ?? null,
    duration_ms: shot.duration_ms,
    motion_fps: shot.motion_fps ?? 24,
    output_fps: shot.output_fps ?? shot.motion_fps ?? 24,
    dialogue_lock: Boolean(board.assistant?.preferences?.dialogue_lock),
    audio_policy: shot.audio_policy || board.project.global.audio_policy,
    canvas: board.project.canvas,
    dialogue: {
      source: selectedDialogueSource(dialogueState, options),
      structured: dialogueState.structured,
      seed: dialogueState.seed,
      formal: dialogueState.formal,
    },
    // 与请求同源：任一影响"本镜输入是什么"的字段变了，指纹就要变。
    // 仍然只覆盖到"路径"这一层；同路径换内容要靠内容摘要复核（见 expandShotMaterials 注释）。
    bindings: expandShotMaterials(board, shot),
  });
}

export function executionPromptErrors(board, shot, expectedDialogue = null) {
  const errors = [];
  const unresolved = creativeAssetTokens(shot.prompt);
  if (unresolved.length) errors.push(`创作资产尚未确认：${unresolved.join(" ")}`);
  const dangling = danglingTags(shot, board.project.assets);
  if (dangling.length) errors.push(`失效素材标签：${dangling.join(" ")}`);
  const state = shotDialogueState(board, shot);
  const expected = expectedDialogue
    ? expectedDialogue.map((item) => String(item?.text || item).trim()).filter(Boolean)
    : (!state.structured ? state.seed.map((item) => item.text.trim()) : []);
  if (board.assistant?.preferences?.dialogue_lock && expected.length) {
    const formal = promptDialogues(shot.prompt);
    if (JSON.stringify(formal) !== JSON.stringify(expected)) {
      errors.push("锁定台词与正式提示词的 <d> 不一致");
    }
  }
  return errors;
}
