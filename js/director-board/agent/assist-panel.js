/** 创作工作台样式加载 seam。 */
import { el } from "../ui.js";

export function ensureDirectorAgentStyle() {
  const id = "zdx-director-agent-style";
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = new URL("./style.css?v=12", import.meta.url).href;
  document.head.append(link);
}

export function warningDetails(warnings) {
  const items = (warnings || []).filter(Boolean);
  if (!items.length) return null;
  return el("details", { class: "zcw-warnings" },
    el("summary", { text: `${items.length} 条提醒 · 可忽略` }),
    el("ul", {}, ...items.map((item) => el("li", { text: String(item) }))));
}
