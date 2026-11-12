import { button, el } from "./ui.js";
import { buildShotAssistRequest, executionPromptErrors, shotAssistFingerprint, shotDialogueState } from "./shot-assist.js";
import { requestDirectorAssist } from "./agent/assist-client.js";
import { acceptCandidate, createCandidate } from "./agent/candidate.js";
import { writePromptToDirector } from "./agent/director-handoff.js";
import { addCreativeAsset, setDirectorShotDraft } from "./agent/workspace.js";
import { readAssistant, writeAssistant } from "./agent/storage.js";

export const QUICK_SHOT_MODES = [
  ["idea", "想画什么"], ["story", "扩写剧情"],
  ["breakdown", "拆成画面"], ["prompt", "写视频提示词"],
];

const ASSET_TYPES = { 人物: "character", 场景: "scene", 道具: "prop" };

/** Picture plans stay separate from timeline shots and use text-only generation context. */
export function buildQuickShotRequest(board, shot, mode, draft, instruction, dialogueSource = "auto", options = {}) {
  const idea = draft.trim(), original = String(options.originalIdea || idea).trim();
  if (mode === "prompt") {
    return buildShotAssistRequest(board, shot,
      [idea ? `本镜创作想法：\n${idea}` : "", instruction.trim()].filter(Boolean).join("\n\n"),
      { dialogueSource });
  }
  if (mode === "idea" || mode === "breakdown") {
    const kind = mode === "breakdown" ? "sequence" : options.kind || "asset";
    return {
      target: "picture_plan", skill_id: "free", kind, count: kind === "frame" ? 2 : 3,
      instruction: [options.pictures?.length ? `待修改的画面候选（不是原始设定，请依据补充要求调整）：\n${options.pictures.map(({ name, type, prompt }) => `【${name} · ${type}】${prompt}`).join("\n\n")}` : "", instruction.trim()].filter(Boolean).join("\n\n"),
      context: { idea_text: original && original !== idea ? `原始创意与设定：${original}\n当前剧情：${idea}` : idea,
        mode: "text", assets: [] },
    };
  }
  const duration = Number(shot.duration_ms) / 1000;
  if (!Number.isFinite(duration) || duration < 1 || duration > 15) {
    throw new Error("单镜短剧情支持 1–15 秒，请先将当前镜时长调整到此范围；不会自动截短镜头。");
  }
  return {
    target: "story", skill_id: "free", current: { text: idea },
    instruction: [original ? `保留原始创意与设定：${original}` : "",
      options.storyDirection === "twist" ? "围绕原创意写一个小反转，反转由眼前的动作或声音造成，不增加身世或奖励背景。"
        : "简单扩写原创意，补齐可见动作和因果，不强加反转。", instruction.trim()].filter(Boolean).join("\n"),
    context: { inspiration: idea ? "" : instruction.trim(), duration_seconds: duration },
  };
}

export function openQuickShotAssistant(board, options = {}) {
  const shot = board.selected();
  if (!shot) return;
  if (!document.getElementById?.("zdb-quick-shot-style")) {
    const link = el("link", { id: "zdb-quick-shot-style", rel: "stylesheet", href: new URL("./quick-shot-assistant.css", import.meta.url).href });
    document.head.append(link);
  }
  const savedDraft = readAssistant(board.node).shot_drafts?.[shot.id];
  const shotId = shot.id, modal = board.modal("单镜助手"),
    context = () => ({ project: board.project, assistant: readAssistant(board.node) }),
    current = () => board.project.shots.find((item) => item.id === shotId),
    draft = el("textarea", { class: "zdb-quick-draft", rows: 3, "aria-label": "本镜创作草稿", value: savedDraft?.text ?? shot.prompt ?? "", placeholder: "描述想画的角色、场景或动作…" }),
    instruction = el("textarea", { class: "zdb-quick-instruction", rows: 2, value: "", "aria-label": "助手要求", placeholder: "补充要求，例如：强化人物反应，保持台词不变" }),
    status = el("p", { class: "zdb-muted", role: "status", "aria-live": "polite", text: "选择一个步骤，生成后再决定是否采用。" }),
    resultHost = el("section", { class: "zdb-quick-result", "aria-label": "助手候选结果" }),
    tabs = el("div", { class: "zdb-row zdb-quick-modes", "aria-label": "创作步骤" }),
    dialogue = el("select", { "aria-label": "台词来源" },
      el("option", { value: "auto", text: "沿用当前台词" }),
      el("option", { value: "formal", text: "正式提示词中的台词" }),
      el("option", { value: "seed", text: "创作原句中的台词" }));
  dialogue.value = "auto";
  const pictureKind = el("select", { "aria-label": "画面类型" },
    el("option", { value: "asset", text: "人物／场景／道具" }), el("option", { value: "frame", text: "这一张画面" })),
    storyDirection = el("select", { "aria-label": "扩写方向" },
      el("option", { value: "simple", text: "简单扩写" }), el("option", { value: "twist", text: "一个小反转" })),
    modeHelp = el("p", { class: "zdb-muted" });
  pictureKind.value = "asset"; storyDirection.value = savedDraft?.story_direction || "simple";
  let originalIdea = savedDraft?.original_idea ?? draft.value.trim();
  let mode = "prompt", active = null, result = null;
  modal.element.classList.add("zdb-quick-shot-assistant");
  const sameShot = () => Boolean(current()) && board.selected()?.id === shotId;
  const setBusy = (busy) => {
    send.disabled = busy; draft.disabled = busy; instruction.disabled = busy; dialogue.disabled = busy;
    for (const control of [...modeButtons, pictureKind, storyDirection]) control.disabled = busy;
    for (const control of resultHost.querySelectorAll?.("button, textarea") || []) control.disabled = busy;
    cancel.disabled = !busy;
  };
  const clearResult = () => { result = null; resultHost.replaceChildren(); };
  const selectMode = (value) => {
    if (active) return;
    mode = value; clearResult();
    pictureKind.hidden = mode !== "idea"; storyDirection.hidden = mode !== "story";
    modeHelp.textContent = mode === "breakdown" ? "拆成关键画面候选，不会自动新建分镜。"
      : mode === "idea" ? "设计图片候选；用于生图时仅传文字，不会自动使用本镜参考图。"
        : mode === "story" ? `按当前镜 ${Number(current()?.duration_ms) / 1000} 秒扩写，支持 1–15 秒。` : "生成适配当前镜模式的视频提示词。";
    for (let index = 0; index < modeButtons.length; index++) {
      modeButtons[index].classList.toggle("zdb-active", QUICK_SHOT_MODES[index][0] === mode);
      modeButtons[index].setAttribute("aria-pressed", String(QUICK_SHOT_MODES[index][0] === mode));
    }
    send.textContent = `生成${QUICK_SHOT_MODES.find(([id]) => id === mode)[1]}建议`;
  };
  const modeButtons = QUICK_SHOT_MODES.map(([value, label]) => button(label, () => selectMode(value), "zdb-sub"));
  tabs.append(...modeButtons);
  pictureKind.addEventListener("change", clearResult);
  storyDirection.addEventListener("change", clearResult);
  draft.addEventListener("input", () => { originalIdea = draft.value.trim(); clearResult(); });
  const validateResult = (entry) => {
    if (active || modal.closed || result !== entry) throw new Error("候选已失效，请重新生成。");
    if (!sameShot()) throw new Error("当前镜头已切换或删除，请重新打开助手。");
    if (shotAssistFingerprint(context(), current(), { dialogueSource: entry.dialogueSource }) !== entry.fingerprint) {
      throw new Error("本镜内容或素材已变化，请重新生成建议。");
    }
  };
  const adopt = () => {
    if (active || !result || modal.closed) return;
    try {
      validateResult(result);
      const ctx = context(), latest = current();
      if (result.mode === "story") {
        const next = setDirectorShotDraft(ctx.assistant, shotId, {
          original_idea: originalIdea, text: result.text, story_direction: storyDirection.value,
        });
        writeAssistant(board.node, next); board.assistant = next;
        draft.value = result.text; clearResult(); status.textContent = "已采用为本镜创作草稿，可继续扩写、拆画面或写视频提示词。"; return;
      }
      const accepted = acceptCandidate(result.candidate, {
        creativeProject: ctx.assistant, directorProject: board.project,
        directorFingerprint: result.fingerprint,
        validateDirectorPrompt: (prompt, expected) => executionPromptErrors(ctx, { ...latest, prompt }, expected),
        applyDirectorPrompt: writePromptToDirector,
      });
      board.project = accepted.directorProject; board.update(); modal.close(); board.flash?.("已采用当前镜提示词");
    } catch (error) { status.textContent = error.message; }
  };
  const renderResult = () => {
    const entry = result;
    const contents = entry.pictures ? entry.pictures.map((card) => {
      const prompt = el("textarea", { rows: 3, value: card.prompt, "aria-label": `${card.name}画面提示词`,
        oninput: (event) => { card.prompt = event.currentTarget.value; } });
      const add = ASSET_TYPES[card.type] ? button("加入资产", () => {
        try {
          validateResult(entry);
          if (!card.prompt.trim()) throw new Error("请先填写画面提示词。");
          const assistant = readAssistant(board.node), type = ASSET_TYPES[card.type];
          if (assistant.assets.some((asset) => asset.name === card.name && asset.type === type)) {
            status.textContent = "资产中已有同名条目，请在资产页编辑。"; return;
          }
          const added = addCreativeAsset(assistant, { name: card.name, type, description: card.prompt.trim() });
          writeAssistant(board.node, added.project); board.assistant = added.project;
          add.disabled = true; add.textContent = "已加入资产";
          status.textContent = "已加入创作资产，待制作配图。";
        } catch (error) { status.textContent = error.message; }
      }, "zdb-sub") : null;
      return el("article", { class: "zdb-quick-picture" },
        el("div", { class: "zdb-row" }, el("b", { text: card.name }), el("span", { text: card.type })), prompt,
        el("div", { class: "zdb-row" }, button("用于生图", async () => {
          try {
            validateResult(entry);
            if (!card.prompt.trim()) throw new Error("请先填写画面提示词。");
            const media = options.mediaActions || await import("./media-workspace.js");
            validateResult(entry);
            const slot = media.nextImageSlot(current());
            if (!slot) throw new Error("本镜没有空图片槽。请先在素材区选择支持图片的生成模式，或清空需要替换的图片。");
            await media.generateShotImage(board, current(), slot, ASSET_TYPES[card.type] || "other", { name: card.name, description: card.prompt.trim() });
          } catch (error) { status.textContent = error.message; }
        }), add));
    }) : [el("pre", { text: entry.text }), button(entry.mode === "prompt" ? "采用为当前镜提示词" : "采用为创作草稿", adopt)];
    resultHost.replaceChildren(el("h3", { text: "候选结果" }), ...contents,
      ...(entry.warnings || []).map((warning) => el("p", { class: "zdb-muted", text: String(warning) })),
      button("放弃候选", () => { if (!active) clearResult(); }, "zdb-sub"));
  };
  const run = async () => {
    if (active || modal.closed) return;
    if (!sameShot()) { status.textContent = "当前镜头已切换或删除，请重新打开助手。"; return; }
    if (mode === "breakdown" && !draft.value.trim()) { status.textContent = "请先填写或生成创作草稿，再拆成画面。"; return; }
    if (mode !== "prompt" && !draft.value.trim() && !instruction.value.trim()) { status.textContent = "请先描述你想画什么。"; return; }
    const ctx = context(), latest = current(), dialogueState = shotDialogueState(ctx, latest);
    if (mode === "prompt" && dialogue.value === "auto" && dialogueState.structured && dialogueState.seed.length
        && JSON.stringify(dialogueState.seed.map((line) => line.text)) !== JSON.stringify(dialogueState.formal.map((line) => line.text))) {
      status.textContent = "创作原句与正式提示词的台词不同，请选择台词来源再生成。"; return;
    }
    const controller = new AbortController(), requestedMode = mode, dialogueSource = dialogue.value,
      fingerprint = shotAssistFingerprint(ctx, latest, { dialogueSource });
    let payload;
    try {
      if (!originalIdea) originalIdea = draft.value.trim() || instruction.value.trim();
      payload = buildQuickShotRequest(ctx, latest, mode,
        result && mode === "story" ? result.text : draft.value, instruction.value, dialogueSource,
        { kind: pictureKind.value, storyDirection: storyDirection.value, originalIdea, pictures: result?.pictures });
    } catch (error) { status.textContent = error.message; return; }
    if (result && shotAssistFingerprint(ctx, latest, { dialogueSource: result.dialogueSource }) !== result.fingerprint) {
      status.textContent = "本镜内容或素材已变化，请放弃旧候选后重新生成。"; return;
    }
    if (result?.mode === "prompt" && mode === "prompt") payload.current.prompt = result.text;
    active = controller; setBusy(true); status.textContent = "正在生成建议…";
    try {
      const response = await (options.requestFn || requestDirectorAssist)(payload, { signal: controller.signal });
      if (controller.signal.aborted || modal.closed) return;
      if (!sameShot() || shotAssistFingerprint(context(), current(), { dialogueSource }) !== fingerprint) throw new Error("本镜内容或素材已变化，本次结果未应用，请重新生成。");
      const text = requestedMode === "prompt" ? response?.prompt : response?.story?.text;
      const pictureMode = ["idea", "breakdown"].includes(requestedMode), pictures = response?.pictures;
      if (pictureMode ? !Array.isArray(pictures) || !pictures.length || pictures.some((card) =>
        !card || typeof card.name !== "string" || !card.name.trim() || typeof card.prompt !== "string" || !card.prompt.trim()
        || !(payload.kind === "asset" ? Object.keys(ASSET_TYPES) : ["关键帧"]).includes(card.type)) : !String(text || "").trim()) {
        throw new Error("助手未返回可用建议，原内容已保留。");
      }
      const candidate = requestedMode === "prompt"
        ? createCandidate("director_prompt", { creativeProject: ctx.assistant }, {
          targetId: shotId, directorShotId: shotId, fingerprint, expectedDialogue: payload.context.dialogue,
          after: { prompt: text }, warnings: response.warnings || [],
        }) : null;
      result = { mode: requestedMode, candidate, text, pictures: pictureMode ? structuredClone(pictures) : null, fingerprint, dialogueSource, warnings: response.warnings || [] };
      renderResult(); status.textContent = "建议已生成，采用后才会写入。可补充要求再次生成。";
    } catch (error) {
      if (!modal.closed && !controller.signal.aborted) status.textContent = error.message;
    } finally { if (active === controller) { active = null; setBusy(false); } }
  };
  const send = button("生成建议", run), cancel = button("停止等待", () => {
    active?.abort(); status.textContent = "已停止等待；服务端可能仍在执行。";
  }, "zdb-sub");
  modal.setCloseHandler(() => { active?.abort(); });
  modal.body.append(el("p", { class: "zdb-muted", text: `当前镜：${shot.title || "未命名"} · ${(shot.duration_ms / 1000).toFixed(1)} 秒 · ${(shot.bindings || []).length} 项素材` }),
    tabs, pictureKind, storyDirection, modeHelp, el("label", { class: "zdb-quick-field" }, el("span", { text: "本镜创作草稿" }), draft),
    el("details", {}, el("summary", { text: "查看原提示词与台词来源" }), el("pre", { text: shot.prompt || "尚未填写提示词" }), dialogue),
    el("label", { class: "zdb-quick-field" }, el("span", { text: "补充要求" }), instruction),
    el("div", { class: "zdb-row" }, send, cancel), status, resultHost);
  modal.footer.replaceChildren(button("完整创作工作台", async () => {
    modal.close();
    const open = options.openWorkbench || (await import("./agent/workbench.js")).openCreativeWorkbench;
    await open(board, { tab: "shots", director_shot_id: shotId });
  }, "zdb-sub"), button("关闭", modal.close, "zdb-sub"));
  selectMode("prompt"); setBusy(false); board.focus?.(modal.element);
  return modal;
}
