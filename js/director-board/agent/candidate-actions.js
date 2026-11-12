import { button, el } from "../ui.js";
import { warningDetails } from "./assist-panel.js";

const guarded = (action, onError) => () => {
  try { return action?.(); }
  catch (error) {
    if (onError) return onError(error);
    throw error;
  }
};

export function candidateActions({
  warnings = [], primaryLabel = "采纳", onPrimary, onContinue, onDiscard, onError,
} = {}) {
  return [
    warningDetails(warnings),
    el("div", { class: "zdb-row" },
      button(primaryLabel, guarded(onPrimary, onError), "zda-primary"),
      button("继续修改", guarded(onContinue, onError), "zdb-sub"),
      button("放弃", guarded(onDiscard, onError), "zdb-sub")),
  ].filter(Boolean);
}
