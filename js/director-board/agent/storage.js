/**
 * CreativeProject 的唯一存储：`node.properties.creative_project`（JSON 字符串）。
 *
 * 选它的两条证据：
 * - `js/runtime-vars.js` 已经用 `node.properties` 保存每节点绑定并读回，说明它随 workflow 持久化；
 * - `comfyui_save_script/js/save-as-script.js` 在 `app.graphToPrompt()` 之后手动把
 *   `node.properties` 抄进结果，说明 prompt payload 里不带 properties。
 *
 * 因此这里**不**加 widget、不写 Python INPUT_TYPES，也不做双写或回退。
 */
import { assertCreativeProjectStructure, blankAssistant } from "./workspace.js";

export const CREATIVE_PROJECT_PROPERTY = "creative_project";
export const ASSISTANT_PROPERTY = CREATIVE_PROJECT_PROPERTY;

export function ensureAssistantStorage(node) {
  node.properties = node.properties || {};
  return node;
}

export function readAssistant(node) {
  const properties = node?.properties || {};
  if (!Object.prototype.hasOwnProperty.call(properties, CREATIVE_PROJECT_PROPERTY)) return blankAssistant();
  const raw = properties[CREATIVE_PROJECT_PROPERTY];
  try {
    if (typeof raw !== "string") throw new Error("creative_project 必须是 JSON 字符串");
    const project = JSON.parse(raw);
    return structuredClone(assertCreativeProjectStructure(project));
  } catch (error) {
    throw new Error(`CreativeProject 存储无效：${error.message}`);
  }
}

export function writeAssistant(node, workspace, { notify = true } = {}) {
  ensureAssistantStorage(node);
  const raw = JSON.stringify(assertCreativeProjectStructure(workspace));
  node.properties[CREATIVE_PROJECT_PROPERTY] = raw;
  if (notify) {
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
    node.graph?.change?.();
  }
  return raw;
}
