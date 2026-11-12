import { button, el } from "../ui.js";
import { createAssistantComposer } from "./assistant-composer.js";
import { candidateActions } from "./candidate-actions.js";
import {
  acceptCandidate, candidateStaleReason, consumeCandidate, createCandidate, discardStoredCandidate, updateCandidate,
} from "./candidate.js";
import { updateCreativeStory } from "./workspace.js";

export const STORY_SKILLS = [
  ["free", "自由剧本"],
  ["emotional-drama", "情感文戏"],
  ["action", "动作戏"],
  ["commerce-host", "口播带货"],
];

export function renderStoryPage(host, project, commit, options = {}) {
  let draft = project.story.text, skillId = project.story.skill_id || "free", candidate = options.candidate || null,
    refining = false, requestInFlight = false, instructionDraft = "",
    requestControls = { setRequestStatus() {} };
  const candidateStore = options.candidateStore || new Map();
  const setCandidate = (next) => { candidate = next; options.onCandidateChange?.(candidate); };
  const setRequestStatus = (active) => requestControls.setRequestStatus(
    active || (requestInFlight ? { label: "正在生成剧本候选…" } : null),
  );
  const editor = el("textarea", { class: "zcw-story-editor", value: draft, placeholder: "在这里写剧本…" }),
    assistant = el("aside", { class: "zcw-assistant" }), saveState = el("span", { class: "zda-muted", text: "已保存" });
  const save = () => {
    if (draft === project.story.text) return project;
    project = commit(updateCreativeStory(project, { text: draft }));
    saveState.textContent = "已保存"; return project;
  };
  editor.addEventListener("input", () => { draft = editor.value; saveState.textContent = "有未保存修改"; });
  editor.addEventListener("select", () => drawAssistant());

  function drawAssistant() {
    instructionDraft = requestControls.instruction?.value ?? instructionDraft;
    const composer = createAssistantComposer({
      placeholder: refining ? "输入对当前候选的修改意见…" : "输入剧本修改要求…",
      statusText: refining ? "基于候选修改" : "等待输入", skills: STORY_SKILLS, skillValue: skillId, skillLabel: "剧本 Skill",
      onSkillChange: (value) => {
      skillId = value;
      project = commit(updateCreativeStory(project, { skill_id: skillId }));
      },
      onSend: async ({ instruction, status, send }) => {
      if (!instruction.value.trim() || send.disabled || requestInFlight) return;
      if (candidate && !refining) { status.textContent = "请先点击继续修改，或采纳、放弃当前 Candidate。"; return; }
      let requestCandidate, source;
      try {
        if (candidate) {
          const stale = candidateStaleReason(candidate, { creativeProject: project, draft });
          if (stale) throw new Error(stale);
          requestCandidate = candidate; source = candidate.after.text;
        } else {
          save();
          const start = editor.selectionStart, end = editor.selectionEnd,
            selection = end > start ? { start, end, text: project.story.text.slice(start, end) } : null;
          source = selection?.text || project.story.text;
          requestCandidate = createCandidate("story", { creativeProject: project }, {
            after: { text: source }, selection, draftSnapshot: draft,
          });
        }
        requestInFlight = true; send.disabled = true; status.textContent = "正在生成剧本候选…";
        const requestText = instruction.value.trim(), result = await options.requestFn?.({
          target: "story", skill_id: skillId, current: { text: source },
          instruction: source || refining ? requestText : "",
          context: { inspiration: source || refining ? "" : requestText },
        }, { page: "story", label: "正在生成剧本候选" });
        const stale = candidateStaleReason(requestCandidate, { creativeProject: project, draft });
        if (stale) throw new Error(stale);
        requestCandidate.warnings = structuredClone(result?.warnings || []);
        setCandidate(updateCandidate(requestCandidate, { text: result?.story?.text || source }));
        refining = false; requestInFlight = false; requestControls.instruction.value = "";
        drawAssistant();
      } catch (error) { requestControls.status.textContent = error.message; }
      finally { requestInFlight = false; requestControls.send.disabled = Boolean(options.requestStatus?.()); }
      },
    }), { instruction, status, send, skillField } = composer;
    instruction.value = instructionDraft;
    assistant.replaceChildren(el("div", { class: "zda-section-head" },
      el("b", { text: (candidate ? candidate.before.selection : editor.selectionEnd > editor.selectionStart) ? "当前范围：选中的剧本段落" : "当前范围：整个剧本" }),
      skillField),
      ...(candidate ? [el("section", { class: "zda-preview-host" }, el("pre", { class: "zda-preview", text: candidate.after.text }), ...candidateActions({
        warnings: candidate.warnings,
        onPrimary: () => {
          if (requestInFlight) { status.textContent = "候选正在修改，请等待完成。"; return; }
          const accepted = acceptCandidate(candidate, {
            creativeProject: project, draft, commitCreativeProject: commit,
          });
          project = accepted.creativeProject; consumeCandidate(candidateStore, candidate);
          draft = project.story.text; editor.value = draft; setCandidate(null); refining = false; saveState.textContent = "已保存"; drawAssistant();
        },
        onContinue: () => {
          if (requestInFlight) { status.textContent = "候选正在修改，请等待完成。"; return; }
          const stale = candidateStaleReason(candidate, { creativeProject: project, draft });
          if (stale) throw new Error(stale);
          refining = true; drawAssistant(); requestControls.instruction.focus();
        },
        onDiscard: () => {
          if (requestInFlight) { status.textContent = "候选正在修改，请等待完成。"; return; }
          discardStoredCandidate(candidateStore, candidate); setCandidate(null); refining = false; drawAssistant();
        },
        onError: (error) => { status.textContent = error.message; },
      }))] : []),
      instruction, send, status);
    requestControls = composer; setRequestStatus(options.requestStatus?.());
  }
  const saveButton = button("保存", save, "zda-primary");
  // 段数：决定「拆分分镜」是让模型自由决定切几刀（自动），还是"恰好切成 N 个"。
  const segments = el("select", { class: "zda-input zcw-segment-picker", "aria-label": "分镜段数" },
    ...[["auto", "段数：自动"], ...Array.from({ length: 12 }, (_, index) => {
      const value = String(index + 1);
      return [value, `段数：${index + 1}`];
    })].map(([value, text]) => el("option", { value, text })));
  segments.value = options.breakdownSegments || "auto";
  segments.addEventListener("change", () => options.onBreakdownSegmentsChange?.(segments.value));
  host.replaceChildren(el("section", { class: "zcw-page" }, el("header", { class: "zcw-page-head" }, el("h2", { text: "剧本" }), saveState, el("span", { class: "zda-grow" }),
    segments, button("提取资产", () => { save(); options.extractAssets?.(project); }, "zdb-sub"), button("拆分分镜", () => { save(); options.breakdown?.(project); }, "zdb-sub"), saveButton),
    el("div", { class: "zcw-story-layout" }, editor, assistant)));
  drawAssistant(); editor.focus(); return { save, setRequestStatus };
}
