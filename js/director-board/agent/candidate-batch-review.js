import { button, el } from "../ui.js";
import { warningDetails } from "./assist-panel.js";

export function candidateBatchReview({
  title, subtitle, rows = [], rowClass = "", unit = "项", warnings = [], error = "",
  renderFields, onDeleteRow, onDiscardAll, onAdoptSelected,
} = {}) {
  let adoptSelected;
  const refreshSelectedLabel = () => {
      if (adoptSelected) adoptSelected.textContent = `采纳选中 ${rows.filter((row) => row.selected).length} ${unit}`;
    },
    articles = rows.map((row, index) => {
      const selected = el("input", { type: "checkbox", checked: row.selected });
      selected.addEventListener("change", () => { row.selected = selected.checked; refreshSelectedLabel(); });
      return el("article", { class: `zcw-candidate-row ${rowClass}` }, selected,
        renderFields?.(row, index) || [],
        button("删除", () => onDeleteRow?.(index), "zdb-danger"));
    });
  adoptSelected = button("", () => onAdoptSelected?.(), "zda-primary");
  refreshSelectedLabel();
  return el("section", { class: "zcw-candidate-panel" },
    el("div", { class: "zda-section-head" }, el("b", { text: title }), el("span", { class: "zda-muted", text: subtitle })),
    warningDetails(warnings),
    error ? el("p", { class: "zda-error", text: error }) : null,
    ...articles,
    el("div", { class: "zdb-row zcw-candidate-actions" },
      button("放弃全部", () => onDiscardAll?.(), "zdb-sub"),
      el("span", { class: "zda-grow" }),
      button("全部采纳", () => {
        for (const row of rows) row.selected = true;
        onAdoptSelected?.();
      }, "zdb-sub"),
      adoptSelected));
}
