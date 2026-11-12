import { button, el } from "../ui.js";
import { TASKS } from "../model.js";
import {
  addCreativeShot, assetReferenceErrors, mergeCreativeShots, moveCreativeShot, removeCreativeShot,
  parseAssetTokens, renderAssetTokenPreview, updateCreativeShot,
} from "./workspace.js";
import { createAssistantComposer } from "./assistant-composer.js";
import { candidateActions } from "./candidate-actions.js";
import { candidateBatchReview } from "./candidate-batch-review.js";
import {
  acceptCandidate, candidateStaleReason, consumeCandidate, createCandidate, discardStoredCandidate, putCandidate, updateCandidate,
} from "./candidate.js";

export const SHOT_DRAFT_SKILLS = [
  ["free", "自由优化"],
  ["emotional-drama", "情绪文戏"],
  ["martial-arts", "武打动作"],
  ["time-lapse", "时间流逝"],
  ["transformation-transition", "视觉转场"],
  ["ink-xianxia", "水墨剑仙"],
  ["dialogue-performance", "对白表演"],
];

const QUICK_SNIPPETS = [
  ["动作", ["只补动作细节，不改剧情", "放慢动作并写清起止", "增加人物的可见反应"]],
  ["镜头", ["使用固定镜头", "镜头缓慢推进", "改为人物特写"]],
  ["风格", ["由水墨逐渐转为写实", "保持当前画风", "改用冷色光线"]],
  ["承接", []],
  ["台词", ["保留本镜原句，只增加停顿", "放慢说话节奏，不改台词"]],
  ["音乐", ["前半段舒缓，后半段加快", "画面动作在段尾停住"]],
];

function dialogueNeedsChoice(context) {
  if (!context?.structured) return false;
  if (Array.isArray(context.formalDialogue) && Array.isArray(context.seedDialogue)) {
    const lines = (items) => items.map((item) => String(item?.text || "").trim()).filter(Boolean);
    const seed = lines(context.seedDialogue);
    return seed.length > 0 && JSON.stringify(lines(context.formalDialogue)) !== JSON.stringify(seed);
  }
  return context.formalDialogueCount === 0 && context.seedDialogueCount > 0;
}

export function renderShotPage(host, project, commit, options = {}) {
  let selectedId = options.selectedShotId || project.shots[0]?.shot_id || null,
    skillId = options.skillId || "free",
    breakdownCandidate = options.breakdownCandidate || null,
    breakdownRows = breakdownCandidate?.after || [], confirmRegenerate = false, confirmMerge = false,
    regenerateError = "", mergeError = "", handoffActive = false,
    requestControls = { setRequestStatus() {} };
  const candidates = options.candidateStore || new Map(), inFlight = new Set(),
    refinements = options.opinionRefinements || new Map(),
    instructionDrafts = options.opinionDrafts || new Map(), styles = options.opinionStyles || new Map();
  const selected = new Set(), list = el("aside", { class: "zcw-shot-list" }), detail = el("main", { class: "zcw-shot-detail" }),
    assistant = el("aside", { class: "zcw-assistant" }), heading = el("h2");
  const current = () => project.shots.find((shot) => shot.shot_id === selectedId) || null;
  const save = (next) => { project = commit(next); draw(); return project; };
  const patch = (changes) => save(updateCreativeShot(project, selectedId, changes));
  const patchFrame = (shotId, role, baseline, frame) => {
    const latest = project.shots.find((item) => item.shot_id === shotId);
    if (!latest || JSON.stringify(latest.frame_drafts?.[role] || null) !== baseline) return false;
    const frame_drafts = { ...latest.frame_drafts, [role]: frame };
    project = commit(updateCreativeShot(project, shotId, { frame_drafts }));
    if (selectedId === shotId) drawDetail();
    return true;
  };
  const setRequestStatus = (active) => requestControls.setRequestStatus(active);
  const move = (delta) => {
    const next = moveCreativeShot(project, selectedId, delta);
    if (next !== project) save(next);
  };
  const selectedShotIds = () => project.shots
    .filter((shot) => selected.has(shot.shot_id)).map((shot) => shot.shot_id);
  const checkMerge = (ids) => {
    const pending = [...candidates.values()].find((candidate) => candidate.status === "pending"
      && (candidate.scope?.ids?.some((id) => ids.includes(id))
        || ids.includes(String(candidate.slot || "").replace(/^shot:/, ""))));
    if (pending) throw new Error("选中分镜存在未处理 Candidate，请先采纳或放弃。");
    return mergeCreativeShots(project, ids);
  };
  const beginMerge = () => {
    try {
      checkMerge(selectedShotIds()); confirmMerge = true; mergeError = ""; render();
    } catch (error) { confirmMerge = false; mergeError = error.message; render(); }
  };
  const mergeSelected = () => {
    try {
      const ids = selectedShotIds(), merged = checkMerge(ids);
      project = commit(merged.project); selectedId = merged.merged_shot.shot_id;
      selected.clear(); confirmMerge = false; mergeError = ""; render();
    } catch (error) { confirmMerge = false; mergeError = error.message; render(); }
  };
  const beginHandoff = async () => {
    if (handoffActive) return;
    handoffActive = true; render();
    let completed = false;
    try { completed = await options.handoff?.(project, selectedId) === true; }
    finally {
      handoffActive = false;
      if (!completed) render();
    }
  };

  function drawList() {
    const linkedIds = new Set(Object.values(project.handoff?.director_links || {})),
      directorAudioShots = (options.directorAudioShots || []).filter((shot) => !linkedIds.has(shot.id)),
      audioGroup = directorAudioShots.length ? el("section", { class: "zcw-director-audio-list" },
        el("b", { text: `导演台音频分镜 · ${directorAudioShots.length} 镜` }),
        ...directorAudioShots.map((shot) => button(
          `转到导演台 · ${shot.title} · ${(shot.audioRange.start / 1000).toFixed(1)}–${(shot.audioRange.end / 1000).toFixed(1)}秒`,
          () => options.onOpenDirectorShot?.(shot.id), "zdb-sub"))) : null;
    list.replaceChildren(...(audioGroup ? [audioGroup] : []), ...project.shots.map((shot, index) => el("div", { class: `zcw-shot-row ${shot.shot_id === selectedId ? "is-active" : ""}` },
      el("input", { type: "checkbox", checked: selected.has(shot.shot_id), onchange: (event) => {
        if (event.currentTarget.checked) selected.add(shot.shot_id); else selected.delete(shot.shot_id);
        confirmMerge = false; mergeError = ""; render();
      } }),
      button(`${index + 1}. ${shot.title} · ${(shot.duration_ms / 1000).toFixed(1)}秒${candidates.has(`shot:${shot.shot_id}`) ? " · 候选" : ""}`, () => { selectedId = shot.shot_id; draw(); }, shot.shot_id === selectedId ? "zdb-active" : "zdb-sub"))));
  }
  function drawDetail() {
    const shot = current();
    if (!shot) return detail.replaceChildren(el("div", { class: "zda-empty",
      text: options.directorAudioShots?.length
        ? "左侧是已在导演台的音频镜头。选一镜去配图，再用该镜的助手写提示词；这里保留剧本创作草稿。"
        : "暂无创作分镜" }));
    const title = el("input", { class: "zda-input zcw-shot-title", value: shot.title, "aria-label": "分镜标题", placeholder: "分镜标题" }), prompt = el("textarea", { class: "zda-text zcw-shot-prompt", value: shot.prompt }),
      duration = el("input", { class: "zda-input zcw-shot-duration", type: "number", min: 500, step: 500, value: shot.duration_ms, "aria-label": "时长毫秒" });
    title.addEventListener("change", () => patch({ title: title.value.trim() || shot.title }));
    prompt.addEventListener("change", () => patch({ prompt: prompt.value }));
    duration.addEventListener("change", () => patch({ duration_ms: Math.max(500, Number(duration.value) || shot.duration_ms) }));
    const refs = shot.asset_refs.map((id) => project.assets.find((asset) => asset.asset_id === id)).filter(Boolean), errors = assetReferenceErrors(project, shot);
    detail.replaceChildren(el("div", { class: "zcw-shot-topline" }, el("span", { class: "zcw-id-badge", text: shot.shot_id }), title,
      el("label", { class: "zcw-duration-inline" }, duration, el("span", { text: "ms" })), el("div", { class: "zdb-row zcw-shot-actions" },
      button("上移", () => move(-1), "zdb-sub"), button("下移", () => move(1), "zdb-sub"), button("删除", () => {
        const removed = removeCreativeShot(project, shot.shot_id);
        selectedId = removed.project.shots[0]?.shot_id || null; save(removed.project);
      }, "zdb-danger"))),
    el("label", { class: "zda-field" }, el("span", { text: "分镜提示词" }), prompt),
    el("p", { class: "zcw-token-preview", text: `引用预览：${renderAssetTokenPreview(project, shot.prompt) || "（无）"}` }),
    ...(options.openFrameEditor ? [el("section", { class: "zcw-shot-assets" }, el("b", { text: "画面构图" }),
      el("div", { class: "zdb-row" }, ...[["first_frame", "首帧"], ["last_frame", "尾帧"]].map(([role, label]) =>
        button(`${shot.frame_drafts?.[role] ? "编辑" : "创建"}${label}构图`, () => {
          const shotId = shot.shot_id;
          let baseline = JSON.stringify(shot.frame_drafts?.[role] || null);
          options.openFrameEditor(shot, role, (frame) => {
            const saved = patchFrame(shotId, role, baseline, frame);
            if (saved) baseline = JSON.stringify(frame);
            return saved;
          }, (imagePath, draft) => {
            const latest = project.shots.find((item) => item.shot_id === shotId),
              previous = latest?.frame_drafts?.[role];
            if (!previous || JSON.stringify(previous) !== baseline
              || JSON.stringify(previous.composition_draft) !== JSON.stringify(draft)) return false;
            const frame = { ...previous, composition_draft: draft, image_path: imagePath };
            const saved = patchFrame(shotId, role, baseline, frame);
            if (saved) baseline = JSON.stringify(frame);
            return saved;
          });
        }, "zdb-sub"))))] : []),
    el("section", { class: "zcw-shot-assets" }, el("b", { text: "引用资产" }), el("div", { class: "zdb-row" }, ...refs.map((asset) => button(`<${asset.name}>`, () => {
      const token = new RegExp(`<asset:${asset.asset_id}>`, "gi");
      patch({ prompt: shot.prompt.replace(token, "") });
    }, "zdb-sub")), ...project.assets.filter((asset) => !shot.asset_refs.includes(asset.asset_id)).map((asset) => button(`+ ${asset.name}`, () => {
      const token = `<asset:${asset.asset_id}>`; patch({ prompt: `${shot.prompt}${shot.prompt ? " " : ""}${token}` });
    }, "zdb-sub"))), ...errors.map((error) => el("p", { class: "zda-error", text: error }))));
  }
  function drawAssistant() {
    const shot = current(), directorId = shot ? options.directorLink?.(shot.shot_id) : null,
      formal = Boolean(directorId && directorId === options.formalDirectorShotId && options.buildFormalRequest),
      candidateSlot = shot ? `shot:${shot.shot_id}` : null,
      opinionKey = shot ? formal ? `director:${directorId}` : `creative:${shot.shot_id}` : null;
    if (!shot && options.directorAudioShots?.length) {
      assistant.replaceChildren(el("p", { class: "zda-muted",
        text: "音频镜头已经在导演台。选左侧片段去配图，然后在该镜点击“用音频和配图写提示词”。" }));
      return;
    }
    let entry = candidateSlot ? candidates.get(candidateSlot) : null;
    const refining = !!entry && refinements.get(opinionKey)?.entry === entry;
    skillId = styles.get(opinionKey) || options.skillId || "free";
    let refreshGuidance = () => {}, refreshSelectedChips = () => {};
    const candidate = entry?.after;
    const existingPrompt = formal ? options.directorPrompt?.(directorId) : shot?.prompt,
      opinionLabel = refining ? "调整这版建议" : existingPrompt?.trim() ? "想怎么改" : "想生成什么画面";
    const sendLabel = refining ? "修改候选" : formal
      ? (options.directorPrompt?.(directorId)?.trim() ? "重新优化提示词" : "生成正式提示词")
      : "发送";
    const composer = createAssistantComposer({
      placeholder: refining ? "继续说明这版建议需要调整的地方" : existingPrompt?.trim()
        ? "例如：只补动作细节，镜头缓慢推进" : "例如：人物从水墨场景走向写实舞台", sendLabel,
      statusText: refining ? "基于当前候选修改；成功前保留上一版。" : "等待输入",
      skills: SHOT_DRAFT_SKILLS, skillValue: skillId, skillLabel: "写作风格",
      onSkillChange: (value) => {
        skillId = value; styles.set(opinionKey, value); options.onSkillChange?.(skillId);
        refreshSelectedChips(); refreshGuidance();
      },
      onSend: async ({ instruction, status, send }) => {
      if (!shot || inFlight.has(shot.shot_id) || (!formal && !instruction.value.trim()) || send.disabled) return;
      if (formal) {
        const source = options.formalGuidance?.(directorId)?.dialogueSource,
          context = options.formalContextSummary?.(shot.shot_id);
        if ((!source || source === "auto") && dialogueNeedsChoice(context)) {
          status.textContent = "两份台词不同，请在下方核对并选择台词来源；本次未提交。";
          return;
        }
      }
      if (entry && !refining) { status.textContent = "请采纳、继续修改或放弃当前候选。"; return; }
      if (entry) {
        const stale = candidateStaleReason(entry, { creativeProject: project,
          directorFingerprint: options.formalFingerprint?.(shot.shot_id) });
        if (stale) { status.textContent = stale; return; }
      }
      const previous = entry, previousText = JSON.stringify(entry?.after), submittedInstruction = instruction.value;
      if (previous) refinements.set(opinionKey, { entry, instruction: submittedInstruction });
      inFlight.add(shot.shot_id);
      send.disabled = true; status.textContent = formal ? "正在生成正式提示词候选…" : "正在生成单镜候选…";
      try {
        const targetId = shot.shot_id,
          baseline = formal ? options.formalFingerprint?.(targetId) : JSON.stringify(shot),
          requestCandidate = previous || (formal ? null : createCandidate("shot_update", { creativeProject: project }, {
            targetId, after: shot,
          })),
          formalSkill = skillId === "free" ? "base-h3" : skillId,
          sourceShot = previous ? { ...shot, ...previous.after } : shot,
          refs = parseAssetTokens(sourceShot.prompt),
          duration = previous?.after.duration_ms ?? previous?.after.suggested_duration_ms ?? shot.duration_ms,
          referencedAssets = project.assets.filter((asset) => refs.includes(asset.asset_id)),
          availableAssets = project.assets.filter((asset) => !refs.includes(asset.asset_id))
            .map((asset) => ({ asset_id: asset.asset_id, name: asset.name })),
          payload = formal
            ? options.buildFormalRequest(targetId, instruction.value.trim(), formalSkill)
            : {
              target: "shot_draft", skill_id: skillId,
              current: { title: sourceShot.title, prompt: sourceShot.prompt, suggested_duration_ms: duration },
              instruction: instruction.value.trim(), context: {
                dialogue: [], referenced_assets: referencedAssets, available_assets: availableAssets,
              },
            };
        if (formal && previous) payload.current = { ...payload.current, prompt: previous.after.prompt };
        const result = await options.requestFn?.(payload, { page: "shots", label: formal ? "正在生成正式提示词候选" : "正在生成分镜候选" });
        if (previous && (previous.status !== "pending" || candidates.get(candidateSlot) !== previous)) return;
        if (previous && (JSON.stringify(previous.after) !== previousText
            || candidateStaleReason(previous, { creativeProject: project,
              directorFingerprint: options.formalFingerprint?.(targetId) }))) {
          status.textContent = "内容已修改，本次生成结果未应用；已保留当前候选。";
          return;
        }
        if (formal && result?.prompt) {
          const next = requestCandidate || createCandidate("director_prompt", { creativeProject: project }, {
            targetId, directorShotId: directorId, fingerprint: baseline,
            after: { prompt: result.prompt }, expectedDialogue: payload.context?.dialogue || [],
            warnings: result.warnings || [],
          });
          next.warnings = structuredClone(result.warnings || []);
          putCandidate(candidates, updateCandidate(next, { prompt: result.prompt }));
          options.onCandidateStateChange?.();
        } else if (!formal && result?.shot) {
          requestCandidate.warnings = structuredClone(result.warnings || []);
          putCandidate(candidates, updateCandidate(requestCandidate, result.shot));
          options.onCandidateStateChange?.();
        } else {
          throw new Error("助手未返回可用的分镜建议，原候选和意见已保留。");
        }
        const laterRefinement = refinements.get(opinionKey);
        if (laterRefinement && laterRefinement.instruction !== submittedInstruction) {
          instructionDrafts.set(opinionKey, laterRefinement.instruction);
        }
        refinements.delete(opinionKey);
        if (instructionDrafts.get(opinionKey) === submittedInstruction) instructionDrafts.delete(opinionKey);
        if (selectedId === targetId) drawAssistant(); else drawList();
      } catch (error) { status.textContent = error.message; }
      finally { inFlight.delete(shot.shot_id); send.disabled = false; }
      },
    }), { instruction, status, send, skillField } = composer;
    if (refining) instruction.value = refinements.get(opinionKey).instruction;
    else if (shot) instruction.value = instructionDrafts.get(opinionKey) || "";
    instruction.addEventListener("input", () => {
      if (refining) refinements.set(opinionKey, { entry, instruction: instruction.value });
      else if (shot) instructionDrafts.set(opinionKey, instruction.value);
    });
    const shotContext = formal ? options.formalContextSummary?.(shot.shot_id) || {} : {},
      hasAudio = formal && (shotContext.taskType === "audio_driven" || Boolean(shotContext.audio)
        || Boolean(options.formalGuidance?.(directorId)?.musicDirection)),
      hasDialogue = formal && Boolean(shotContext.dialogue?.length);
    const categories = QUICK_SNIPPETS.filter(([name]) =>
      (name !== "音乐" || hasAudio) && (name !== "承接" || formal)
      && (name !== "台词" || hasDialogue)),
      quickBar = el("div", { class: "zdb-row zcw-quick-categories" }),
      quickOptions = el("div", { class: "zcw-quick-options" }),
      selectedChips = el("div", { class: "zcw-opinion-chips", "aria-label": "已选择的参考和风格" });
    let openCategory = null, savedSelection = null;
    let renderCategoryExtras = () => [];
    const rememberSelection = () => {
      const length = String(instruction.value || "").length,
        start = Number.isInteger(instruction.selectionStart) ? instruction.selectionStart : length,
        end = Number.isInteger(instruction.selectionEnd) ? instruction.selectionEnd : start;
      savedSelection = { start: Math.min(length, Math.max(0, start)), end: Math.min(length, Math.max(start, end)) };
    };
    const insertSnippet = (phrase) => {
      const value = String(instruction.value || "");
      if (!savedSelection) rememberSelection();
      const start = Math.min(savedSelection.start, value.length), end = Math.min(savedSelection.end, value.length),
        before = value.slice(0, start), after = value.slice(end),
        prefix = before && !/\s$/.test(before) ? " " : "",
        suffix = after && !/^\s/.test(after) ? " " : "",
        text = `${prefix}${phrase}${suffix}`, caret = start + text.length;
      instruction.focus();
      if (typeof instruction.setSelectionRange === "function") instruction.setSelectionRange(start, end);
      const nativeUndo = document.execCommand?.("insertText", false, text);
      if (!nativeUndo) {
        if (typeof instruction.setRangeText === "function") instruction.setRangeText(text, start, end, "end");
        else instruction.value = `${before}${text}${after}`;
      }
      instruction.selectionStart = instruction.selectionEnd = caret;
      savedSelection = { start: caret, end: caret };
      instruction.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const categoryButtons = categories.map(([name]) => {
      const control = button(name, () => {
        rememberSelection(); openCategory = openCategory === name ? null : name; renderQuickOptions();
      }, "zdb-sub");
      control.addEventListener("mousedown", (event) => event.preventDefault());
      control.setAttribute("aria-expanded", "false");
      quickBar.append(control);
      return [name, control];
    });
    const renderQuickOptions = () => {
      for (const [name, control] of categoryButtons) control.setAttribute("aria-expanded", String(name === openCategory));
      const phrases = categories.find(([name]) => name === openCategory)?.[1] || [];
      quickOptions.replaceChildren(...renderCategoryExtras(openCategory), ...phrases.map((phrase) => {
        const control = button(phrase, () => {
          insertSnippet(phrase); openCategory = null; renderQuickOptions();
        }, "zdb-sub");
        control.addEventListener("mousedown", (event) => event.preventDefault());
        return control;
      }));
    };
    for (const event of ["select", "click", "keyup", "input"]) instruction.addEventListener(event, rememberSelection);
    instruction.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && openCategory) { openCategory = null; renderQuickOptions(); }
    });
    const candidateText = candidate?.prompt;
    let candidatePanel = null;
    if (candidateText !== undefined) {
      const editor = el("textarea", { class: "zda-preview zcw-candidate-editor", value: candidateText || "" });
      editor.addEventListener("input", () => {
        entry = updateCandidate(entry, { ...entry.after, prompt: editor.value });
        putCandidate(candidates, entry);
      });
      const formalCandidate = entry.kind === "director_prompt";
      candidatePanel = el("section", { class: "zda-preview-host" },
        el("b", { text: formalCandidate ? "导演台提示词建议 · 尚未替换当前提示词" : "分镜内容建议 · 尚未替换当前分镜" }),
        editor, ...candidateActions({
          warnings: entry.warnings,
          primaryLabel: formalCandidate ? "采用为当前提示词" : "采用到分镜",
          onPrimary: () => {
            if (inFlight.has(shot.shot_id)) { status.textContent = "正在修改候选，请等待完成。"; return; }
            if (formalCandidate) {
            acceptCandidate(entry, {
              creativeProject: project,
              directorProject: options.directorProject?.(),
              directorFingerprint: options.formalFingerprint?.(shot.shot_id),
              validateDirectorPrompt: (prompt, expectedDialogue) =>
                options.formalCandidateErrors?.(shot.shot_id, prompt, expectedDialogue) || [],
              applyDirectorPrompt: options.applyDirectorPrompt,
              commitDirectorProject: options.commitDirectorProject,
            });
            consumeCandidate(candidates, entry); options.onCandidateStateChange?.(); draw();
            } else {
            const accepted = acceptCandidate(entry, {
              creativeProject: project, commitCreativeProject: commit,
            });
            project = accepted.creativeProject; consumeCandidate(candidates, entry);
            options.onCandidateStateChange?.(); draw();
            }
          },
          onContinue: () => {
            if (inFlight.has(shot.shot_id)) return;
            refinements.set(opinionKey, { entry, instruction: instructionDrafts.get(opinionKey) || "" });
            instructionDrafts.delete(opinionKey);
            drawAssistant(); requestControls.instruction.focus();
          },
          onDiscard: () => {
          if (inFlight.has(shot.shot_id)) { status.textContent = "正在修改候选，请等待完成。"; return; }
          refinements.delete(opinionKey);
          discardStoredCandidate(candidates, entry); options.onCandidateStateChange?.(); draw();
          },
          onError: (error) => { status.textContent = error.message; },
        }));
    }
    const inputSummary = el("p", { class: "zda-muted zcw-shot-input-summary",
      text: shot ? `输入摘要：${(shot.duration_ms / 1000).toFixed(1)}秒 · 引用资产 ${shot.asset_refs.length} 项` : "选择一镜后查看输入摘要" });
    let inputDetails = null, conflictPanel = null, updateGuidance = () => {};
    const setSkill = (value) => {
      composer.skill.value = value; skillId = value; styles.set(opinionKey, value);
      options.onSkillChange?.(value); refreshSelectedChips(); refreshGuidance();
    };
    refreshSelectedChips = () => {
      const values = formal ? options.formalGuidance?.(directorId) || {} : {}, chips = [],
        chip = (text, onRemove) => button(`${text} ×`, () => {
          onRemove(); renderQuickOptions();
        }, "zdb-sub");
      if (values.includePreviousShot && shotContext.hasPreviousShot) {
        chips.push(chip(`参考上一镜${shotContext.previousTitle ? `：${shotContext.previousTitle}` : ""}`,
          () => updateGuidance({ includePreviousShot: false })));
      }
      if (skillId !== "free") chips.push(chip(`风格：${SHOT_DRAFT_SKILLS.find(([id]) => id === skillId)?.[1] || skillId}`,
        () => setSkill("free")));
      for (const [key, label] of [["storyBackground", "背景"], ["visualDirection", "画面指导"], ["musicDirection", "节奏指导"]]) {
        if (values[key]) chips.push(chip(`${label}：${values[key]}`, () => updateGuidance({ [key]: "" })));
      }
      selectedChips.replaceChildren(...chips);
    };
    renderCategoryExtras = (name) => name === "风格" ? [skillField] : [];
    if (formal) {
      const guidance = options.formalGuidance?.(directorId) || {},
        context = options.formalContextSummary?.(shot.shot_id) || {},
        summary = el("p", { class: "zda-muted" }),
        dialoguePreview = el("details"), warning = el("p", { class: "zda-muted" });
      const refreshSummary = () => {
        const latest = options.formalContextSummary?.(shot.shot_id) || context,
          values = options.formalGuidance?.(directorId) || guidance,
          dialogue = entry?.before?.expected_dialogue || latest.dialogue || [];
        const taskLabel = TASKS.find(([id]) => id === latest.taskType)?.[1] || "当前任务";
        const dialogueBrief = dialogue.slice(0, 2).map((line) => line.text).join(" / ");
        inputSummary.textContent = `输入摘要：${values.writingMode === "mv" ? "MV写作 · " : ""}${((latest.durationMs ?? shot.duration_ms) / 1000).toFixed(1)}秒 · 素材 ${latest.materialCount ?? shot.asset_refs.length} 项 · ${dialogue.length ? `台词 ${dialogue.length} 句：${dialogueBrief}${dialogue.length > 2 ? " …" : ""}` : latest.audio ? "未提供已确认文字台词" : "无台词"}${latest.audio ? ` · 音频：${latest.audio}` : ""}`;
        summary.textContent = `本次依据：${taskLabel} · ${values.writingMode === "mv" ? "MV" : "标准"}写作 · ${SHOT_DRAFT_SKILLS.find(([id]) => id === skillId)?.[1] || "基础风格"} · 台词${entry ? "候选冻结" : latest.dialogueSource || "当前来源"} ${dialogue.length} 句${latest.audio ? ` · 音频：${latest.audio}` : ""}`;
        dialoguePreview.replaceChildren(el("summary", { text: `台词清单 · ${dialogue.length} 句` }),
          ...dialogue.map((line) => el("p", { text: `${line.speaker ? `${line.speaker}：` : ""}${line.text}` })),
          ...(!dialogue.length ? [el("p", { class: "zda-muted", text: latest.audio ? "未提供已确认文字台词；音频内容未转写。" : "当前来源无台词。" })] : []));
        warning.textContent = [
          values.writingMode === "mv" && latest.audioPolicy !== "passthrough" ? "MV需在导演台音轨策略选择保留原音频。" : "",
          (!values.dialogueSource || values.dialogueSource === "auto") && dialogueNeedsChoice(latest)
            ? "两份台词不同，请核对并选择台词来源后再生成。" : "",
        ].filter(Boolean).join(" ");
      };
      refreshGuidance = refreshSummary;
      updateGuidance = (patch) => {
        options.onFormalGuidanceChange?.(directorId, patch);
        refreshSummary(); refreshSelectedChips();
      };
      const textField = (label, key, placeholder) => el("label", { class: "zda-field" },
        el("span", { text: label }), el("textarea", { class: "zda-input", rows: 2,
          maxlength: key === "storyBackground" ? 2000 : 1000,
          "aria-label": label, value: options.formalGuidance?.(directorId)?.[key] || "", placeholder,
          oninput: (event) => updateGuidance({ [key]: event.currentTarget.value }) }));
      const writingMode = el("select", { class: "zda-input", "aria-label": "写作方式",
        onchange: (event) => updateGuidance({ writingMode: event.currentTarget.value }) },
        el("option", { value: "standard", text: "标准写作" }),
        context.taskType === "audio_driven" ? el("option", { value: "mv", text: "MV 写作" }) : null);
      writingMode.value = context.taskType === "audio_driven" && guidance.writingMode === "mv" ? "mv" : "standard";
      const dialogueSource = el("select", { class: "zda-input", "aria-label": "台词来源",
        onchange: (event) => updateGuidance({ dialogueSource: event.currentTarget.value }) },
        el("option", { value: "auto", text: "沿用当前台词来源" }),
        el("option", { value: "formal", text: `正式提示词 · ${context.formalDialogueCount ?? 0} 句` }),
        el("option", { value: "seed", text: `创作原句 · ${context.seedDialogueCount ?? 0} 句` }));
      dialogueSource.value = guidance.dialogueSource || "auto";
      renderCategoryExtras = (name) => {
        const values = options.formalGuidance?.(directorId) || {};
        if (name === "风格") return [skillField,
          textField("画面风格 / 氛围", "visualDirection", "例如：水墨逐渐转为写实")];
        if (name === "承接") return [
          context.hasPreviousShot ? button(values.includePreviousShot ? "取消参考上一镜" : "参考上一镜", () => {
            updateGuidance({ includePreviousShot: !values.includePreviousShot }); renderQuickOptions();
          }, "zdb-sub") : null,
          textField("简要背景", "storyBackground", "只补充本镜需要的背景")].filter(Boolean);
        if (name === "音乐") return [
          context.taskType === "audio_driven"
            ? el("label", { class: "zda-field" }, el("span", { text: "写作方式" }), writingMode) : null,
          textField("节奏要求", "musicDirection", "例如：前半段舒缓、后半段加快；不自动分析音频")].filter(Boolean);
        return [];
      };
      if (dialogueNeedsChoice(context) || (guidance.dialogueSource && guidance.dialogueSource !== "auto")) {
        const lines = (items) => items?.map((line) => line.text).join(" / ") || "（无）";
        conflictPanel = el("div", { class: "zcw-shot-dialogue-choice" }, warning,
          el("p", { text: `正式提示词：${lines(context.formalDialogue)}` }),
          el("p", { text: `创作原句：${lines(context.seedDialogue)}` }),
          el("label", { class: "zda-field" }, el("span", { text: "台词来源" }), dialogueSource));
      } else if (context.taskType === "audio_driven") {
        conflictPanel = warning;
      }
      inputDetails = el("details", { class: "zcw-shot-input-details" },
        el("summary", { text: "查看输入详情" }), summary,
        el("p", { text: `素材：${context.materialNames?.join("、") || "无"}` }),
        options.directorPrompt?.(directorId)
          ? el("pre", { text: `当前导演台提示词：\n${options.directorPrompt(directorId)}` }) : null,
        dialoguePreview);
      refreshSummary();
    }
    refreshSelectedChips();
    const dialogueLock = formal ? el("input", {
      type: "checkbox", checked: Boolean(project.preferences?.dialogue_lock),
      onchange: (event) => save({
        ...project,
        preferences: { ...project.preferences, dialogue_lock: event.currentTarget.checked },
      }),
    }) : null;
    assistant.replaceChildren(el("div", { class: "zda-section-head" },
      el("b", { text: shot ? `当前镜：${shot.title}` : `当前范围：${selected.size ? `${selected.size} 镜` : "全部分镜"}` }),
      formal ? el("label", { class: "zdb-check" }, dialogueLock, el("span", { text: "锁定台词" })) : null),
      inputSummary,
      ...(options.formalDraft?.(directorId) ? [el("details", { class: "zcw-shot-input-details" },
        el("summary", { text: "当前镜已采用剧情" }),
        el("p", { class: "zcw-token-preview", text: options.formalDraft(directorId).text }))] : []),
      ...(inputDetails ? [inputDetails] : []),
      el("label", { class: "zda-field zcw-shot-instruction" }, el("span", { text: opinionLabel }), instruction),
      quickBar, quickOptions, selectedChips,
      ...(conflictPanel ? [conflictPanel] : []),
      send, status,
      ...(candidatePanel ? [candidatePanel] : []));
    requestControls = composer; setRequestStatus(options.requestStatus?.());
  }
  function draw() {
    heading.textContent = !project.shots.length && options.directorAudioShots?.length
      ? `分镜 · 导演台 ${options.directorAudioShots.length} 镜`
      : `分镜 · ${project.shots.length} 镜`;
    drawList(); drawDetail(); drawAssistant();
  }

  function candidatePanel() {
    if (!breakdownRows.length) return null;
    return candidateBatchReview({
      title: `分镜候选 · ${breakdownRows.length}`,
      subtitle: "确认后进入正式分镜列表",
      rows: breakdownRows,
      rowClass: "zcw-shot-candidate-row",
      unit: "镜",
      warnings: breakdownCandidate?.warnings,
      error: regenerateError && !confirmRegenerate ? regenerateError : "",
      renderFields: (row) => {
        const title = el("input", { class: "zda-input", value: row.title || "" }),
        duration = el("input", { class: "zda-input", type: "number", min: 500, step: 100, value: row.suggested_duration_ms, "aria-label": "建议时长毫秒", title: "建议时长（毫秒）" }),
        prompt = el("textarea", { class: "zda-input", value: row.prompt || row.fragment || "" });
        title.addEventListener("input", () => { row.title = title.value; });
        duration.addEventListener("change", () => {
          const value = Number(duration.value);
          row.suggested_duration_ms = Number.isFinite(value) && value > 0 ? Math.round(value) : row.suggested_duration_ms;
          duration.value = row.suggested_duration_ms;
        });
        prompt.addEventListener("input", () => { row.prompt = prompt.value; });
        return [title, duration, prompt];
      },
      onDeleteRow: (index) => {
        breakdownRows.splice(index, 1);
        if (!breakdownRows.length) {
          discardStoredCandidate(candidates, breakdownCandidate); breakdownCandidate = null;
          options.onCandidateStateChange?.();
        }
        render();
      },
      onDiscardAll: () => {
        discardStoredCandidate(candidates, breakdownCandidate); breakdownCandidate = null; breakdownRows = [];
        options.onCandidateStateChange?.(); render();
      },
      onAdoptSelected: adoptBreakdown,
    });
  }
  function adoptBreakdown() {
    const chosen = breakdownRows.filter((row) => row.selected); if (!chosen.length) return;
    try {
      const accepted = acceptCandidate(breakdownCandidate, {
        creativeProject: project, commitCreativeProject: commit,
      });
      project = accepted.creativeProject; consumeCandidate(candidates, breakdownCandidate);
      selectedId = accepted.added[0]?.shot_id || selectedId; breakdownCandidate = null; breakdownRows = [];
      options.onCandidateStateChange?.(); render();
    } catch (error) { regenerateError = error.message; render(); }
  }
  function render() {
    const directorContext = options.directorOnly ? options.formalContextSummary?.(selectedId) : null,
      reviewing = breakdownRows.length > 0,
      content = reviewing
      ? candidatePanel()
      : options.directorOnly
      ? el("div", { class: "zcw-director-assist-layout" }, assistant)
      : el("div", { class: "zcw-shot-layout" }, list, detail, assistant),
      regenerate = () => {
        const active = options.requestStatus?.();
        if (active) {
          regenerateError = `${active.label || "其他请求"}尚未完成，请等待后重试。`; render(); return;
        }
        if (!project.story.text.trim()) {
          regenerateError = "请先保存剧本。"; render(); return;
        }
        discardStoredCandidate(candidates, breakdownCandidate); breakdownCandidate = null;
        breakdownRows = []; confirmRegenerate = false;
        options.onCandidateStateChange?.(); render(); void options.breakdown?.();
      },
      headerActions = options.directorOnly ? [] : reviewing
        ? confirmRegenerate
          ? [
            el("span", { class: "zda-error", text: regenerateError || "重新拆分会放弃当前候选修改。" }),
            button("取消", () => { confirmRegenerate = false; render(); }, "zdb-sub"),
            button("确认放弃并重新拆分", regenerate, "zdb-danger"),
          ]
          : [button("重新拆分", () => { confirmRegenerate = true; regenerateError = ""; render(); }, "zdb-sub")]
        : [
          button("重新拆分", options.breakdown, "zdb-sub"),
          selected.size >= 2 && !confirmMerge
            ? button(`合并选中 ${selected.size} 镜`, beginMerge, "zdb-sub") : null,
          confirmMerge ? el("span", { class: "zda-muted", text: "合并后保留第一镜，时长求和；素材和 Binding 请重新确认。" }) : null,
          confirmMerge ? button("取消", () => { confirmMerge = false; render(); }, "zdb-sub") : null,
          confirmMerge ? button(`确认合并 ${selected.size} 镜`, mergeSelected, "zdb-danger") : null,
          mergeError ? el("span", { class: "zda-error", text: mergeError }) : null,
          button("新增镜头", () => {
            const added = addCreativeShot(project); selectedId = added.shot.shot_id; save(added.project);
          }, "zdb-sub"),
          project.shots.length ? el("button", {
            type: "button", class: "zdb-btn zda-primary",
            text: handoffActive ? "正在交接…" : `交接全部 ${project.shots.length} 镜`,
            disabled: handoffActive || !project.shots.length,
            onclick: beginHandoff,
          }) : null,
        ];
    host.replaceChildren(el("section", { class: "zcw-page" }, el("header", { class: "zcw-page-head" }, heading, el("span", { class: "zda-grow" }),
      ...headerActions),
      el("div", { class: "zcw-page-content" },
        ...(options.directorOnly ? [el("p", { class: "zda-muted zcw-handoff-note",
          text: "当前镜已在导演台。先给本镜添加图片，再根据音频与配图生成提示词建议；采用后只更新本镜提示词。" }),
          ...(directorContext?.taskType === "audio_driven" && directorContext.audioPolicy !== "passthrough"
            ? [el("p", { class: "zda-muted zcw-handoff-note",
              text: "当前使用生成音频；若要 MV 写作，请先在导演台把“输出声音”设为保留原音。" })]
            : [])]
          : !reviewing && project.shots.length ? [el("p", { class: "zda-muted zcw-handoff-note",
            text: "交接全部镜头，更新标题、正文和时长；素材与任务模式仍需确认。" })] : []),
        content))); draw();
  }

  render(); return { setRequestStatus, setProject(next) { project = next; draw(); } };
}
