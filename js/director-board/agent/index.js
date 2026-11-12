/** Formal creative entry: one three-tab workbench backed by CreativeProject. */
export { assistantStatus } from "./workspace.js";
export { CREATIVE_TABS, openCreativeWorkbench } from "./workbench.js";
export { openCreativeWorkbench as openCreativeAssistant } from "./workbench.js";

export function createAssistantSession(existing = null) {
  return existing || {};
}
