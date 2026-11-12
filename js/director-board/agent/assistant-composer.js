import { button, el } from "../ui.js";

export function createAssistantComposer({
  placeholder = "", sendLabel = "发送", statusText = "等待输入",
  skills = [], skillValue = "", skillLabel = "Skill", onSkillChange, onSend,
} = {}) {
  const instruction = el("textarea", { class: "zda-chat-input", placeholder }),
    status = el("p", { class: "zda-muted", text: statusText });
  let controls;
  const send = button(sendLabel, () => onSend?.(controls));
  send.classList.add("zcw-assist-send");
  const skill = skills.length
    ? el("select", { class: "zda-input zcw-skill-picker" },
      ...skills.map(([value, label]) => el("option", { value, text: label })))
    : null,
    skillField = skill
      ? el("label", { class: "zda-field zcw-skill-field" }, el("span", { text: skillLabel }), skill)
      : null;
  if (skill) {
    skill.value = skillValue;
    skill.addEventListener("change", () => onSkillChange?.(skill.value));
  }
  controls = {
    instruction, status, send, skill, skillField,
    setRequestStatus(active) {
      status.textContent = active?.label || statusText;
      send.disabled = Boolean(active);
    },
  };
  return controls;
}
