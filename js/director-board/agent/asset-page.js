import { button, el } from "../ui.js";
import { createAssistantComposer } from "./assistant-composer.js";
import { candidateActions } from "./candidate-actions.js";
import { candidateBatchReview } from "./candidate-batch-review.js";
import {
  acceptCandidate, candidateStaleReason, consumeCandidate, createCandidate, discardStoredCandidate, putCandidate, updateCandidate,
} from "./candidate.js";
import { addCreativeAsset, removeCreativeAsset, updateCreativeAsset } from "./workspace.js";

const TYPES = [["character", "角色"], ["scene", "场景"], ["prop", "道具"]];

export function renderAssetPage(host, project, commit, options = {}) {
  let selectedId = project.assets[0]?.asset_id || null, editing = false, query = "", filterType = "",
    suggestionCandidate = options.suggestionCandidate || null,
    suggestionRows = suggestionCandidate?.after || [], confirmRegenerate = false, regenerateError = "",
    requestControls = { setRequestStatus() {} };
  const candidates = options.candidateStore || new Map(), identifications = options.identifications || new Map(),
    identificationResults = options.identificationResults || new Map();
  const refinements = new Map(), pendingRequests = new Map();
  const list = el("aside", { class: "zcw-asset-list" }), detail = el("main", { class: "zcw-asset-detail" }),
    assistant = el("aside", { class: "zcw-assistant" });
  const layout = el("div", { class: "zcw-asset-layout" }),
    editor = el("div", { class: "zcw-asset-edit-layout" }, detail, assistant),
    groups = el("div", { class: "zcw-asset-groups" }),
    search = el("input", { class: "zda-input", type: "search", "aria-label": "搜索资产名称", placeholder: "搜索资产名称" }),
    typeFilter = el("select", { class: "zda-input", "aria-label": "筛选资产类型" },
      el("option", { value: "", text: "全部类型" }), ...TYPES.map(([value, label]) => el("option", { value, text: label })));
  search.addEventListener("input", () => { query = search.value.trim().toLocaleLowerCase(); drawList(); });
  typeFilter.addEventListener("change", () => { filterType = typeFilter.value; drawList(); });
  list.append(el("div", { class: "zcw-asset-filters" }, search, typeFilter), groups);
  layout.append(list, editor);
  const current = () => project.assets.find((asset) => asset.asset_id === selectedId) || null;
  const save = (next) => { project = commit(next); draw(); };
  const patch = (changes) => save(updateCreativeAsset(project, selectedId, changes));
  const patchAsset = (assetId, changes) => {
    if (!project.assets.some((item) => item.asset_id === assetId)) return false;
    project = commit(updateCreativeAsset(project, assetId, changes));
    drawList();
    if (selectedId === assetId) drawDetail();
    return true;
  };
  const setRequestStatus = (active) => requestControls.setRequestStatus(active);

  function drawList() {
    const sections = TYPES.flatMap(([type, label]) => {
      const rows = project.assets.filter((asset) => asset.type === type
        && (!filterType || asset.type === filterType)
        && (!query || asset.name.toLocaleLowerCase().includes(query)));
      if (!rows.length) return [];
      return [el("section", { class: "zcw-asset-group", "aria-label": `${label}资产` },
        el("b", { class: "zcw-group-title", text: `${label} · ${rows.length}` }),
        el("div", { class: "zcw-asset-grid" }, ...rows.map((asset) => {
          const card = button("", () => { selectedId = asset.asset_id; editing = true; draw(); }, "zcw-asset-card");
          card.setAttribute("aria-label", `编辑资产 ${asset.name}`);
          card.append(asset.image_path
            ? el("img", { src: options.imageUrl?.(asset.image_path) || asset.image_path, alt: asset.name, loading: "lazy" })
            : el("span", { class: "zcw-asset-placeholder", text: asset.composition_draft ? "已有画面草稿 · 待生成" : "待配图" }),
          el("b", { text: `${asset.name}${candidates.has(`asset:${asset.asset_id}`) ? " · 候选" : ""}` }),
          el("small", { class: "zda-muted", text: `${asset.asset_id} · ${label}` }));
          return card;
        })))];
    });
    groups.replaceChildren(...(sections.length ? sections : [el("div", { class: "zda-empty", text: query || filterType
      ? "没有符合条件的资产" : "暂无资产，可新增或从剧本提取" })]));
  }

  /**
   * 「识别图片」：用写作层同一套看图给这张图打标，结果写进**描述**。
   *
   * 描述是用户可改的 —— 写作时**有描述就直接采信、不再看图**，
   * 所以在这里改描述就等于改写作依据。
   */
  function identifyButton(asset, notice) {
    const node = button("识别图片", async () => {
      const targetId = asset.asset_id;
      if (!asset.image_path || identifications.has(targetId)) return;
      const request = { imagePath: asset.image_path, description: asset.description, edited: false, node, notice };
      identifications.set(targetId, request);
      node.disabled = true;
      node.textContent = "识别中…";
      identificationResults.set(targetId, "识别中…");
      notice.textContent = "识别中…";
      let result = "";
      try {
        const facts = await options.identifyImage?.(request.imagePath);
        const target = project.assets.find((row) => row.asset_id === targetId);
        if (facts === null) result = "未应用：页面已切换，请重新识别。";
        else if (!target) result = "未应用：资产已删除。";
        else if (target.image_path !== request.imagePath) result = "未应用：图片已变动，请重新识别。";
        else if (request.edited || target.description !== request.description) result = "未应用：描述已变动，请重新识别。";
        else if (!facts) result = "识别失败：未返回描述，可重试。";
        else {
          // A selection change must never redirect the result to another asset.
          project = commit(updateCreativeAsset(project, targetId, { description: facts }));
          result = "已写入描述。";
          if (selectedId === targetId) { drawDetail(); drawAssistant(); }
        }
      } catch (error) {
        result = `识别失败：${error.message}，可重试。`;
      } finally {
        identifications.delete(targetId);
        // Redraws replace buttons; restore the latest one without losing unsaved input.
        identificationResults.set(targetId, result);
        request.notice.textContent = result;
        request.node.textContent = "识别图片";
        request.node.disabled = !project.assets.find((row) => row.asset_id === targetId)?.image_path;
      }
    }, "zdb-sub");
    const pending = identifications.get(asset.asset_id);
    if (pending) { pending.node = node; pending.notice = notice; node.textContent = "识别中…"; }
    node.disabled = !asset.image_path || !!pending;
    node.title = asset.image_path
      ? "用写作层同一套看图给这张图打标，结果写进描述（可改）"
      : "先上传或生成一张图";
    return node;
  }

  function drawDetail() {
    const asset = current();
    if (!asset) return detail.replaceChildren(el("div", { class: "zda-empty", text: "暂无资产卡" }));
    const name = el("input", { class: "zda-input zcw-asset-name", value: asset.name, "aria-label": "资产名称", placeholder: "资产名称" }),
      type = el("select", { class: "zda-input zcw-asset-type", "aria-label": "资产类型" }, ...TYPES.map(([value, label]) => el("option", { value, text: label }))),
      description = el("textarea", { class: "zda-text zcw-asset-description", value: asset.description, placeholder: "用几句话写清外观、身份和辨识特征" }),
      features = el("textarea", { class: "zda-text zcw-asset-features-input", value: asset.fixed_features.join("\n"), placeholder: "需要跨图片严格保持的特征，每行一条" });
    type.value = asset.type;
    name.addEventListener("change", () => patch({ name: name.value.trim() || asset.name }));
    type.addEventListener("change", () => patch({ type: type.value }));
    description.addEventListener("input", () => {
      const pending = identifications.get(asset.asset_id);
      if (pending) pending.edited = true;
    });
    description.addEventListener("change", () => patch({ description: description.value }));
    features.addEventListener("change", () => patch({ fixed_features: features.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) }));
    const remove = button("删除", () => {
        const removed = removeCreativeAsset(project, asset.asset_id);
        selectedId = removed.project.assets[0]?.asset_id || null; editing = false; save(removed.project);
      }, "zdb-danger");
    const imagePreview = asset.image_path
      ? el("img", { src: options.imageUrl?.(asset.image_path) || asset.image_path, alt: asset.name })
      : el("div", { class: "zcw-image-empty" }, el("b", { text: "暂无参考图" }), el("span", { class: "zda-muted", text: "可上传现有图片，或生成一张" }));
    const identificationNotice = el("p", {
      class: "zda-muted zcw-identification-notice", role: "status", "aria-live": "polite",
      text: identificationResults.get(asset.asset_id) || "",
    });
    detail.replaceChildren(
      button("返回资产列表", () => { editing = false; draw(); }, "zdb-sub zcw-asset-back"),
      el("div", { class: "zcw-asset-topline" }, el("span", { class: "zcw-id-badge", text: asset.asset_id }), name, type, remove),
      el("div", { class: "zcw-asset-editor-grid" },
        el("section", { class: "zcw-asset-copy" },
          el("label", { class: "zda-field" }, el("span", { text: "资产描述" }), description),
          el("details", { class: "zcw-asset-features" }, el("summary", { text: `可选固定特征${asset.fixed_features.length ? ` · ${asset.fixed_features.length} 条` : ""}` }), features),
          identificationNotice),
        el("section", { class: "zcw-image" }, imagePreview,
          el("div", { class: "zdb-row" }, button(asset.image_path ? "更换图片" : "上传图片", async () => {
          const imagePath = await options.uploadImage?.(asset); if (imagePath) patchAsset(asset.asset_id, { image_path: imagePath });
        }, "zdb-sub"), button("编辑画面草稿", () => {
          const targetId = asset.asset_id;
          let initialImage = asset.image_path;
          let initialDraft = JSON.stringify(asset.composition_draft || null);
          const saveDraft = (draft) => {
            const latest = project.assets.find((item) => item.asset_id === targetId);
            if (!latest || latest.image_path !== initialImage
              || JSON.stringify(latest.composition_draft || null) !== initialDraft) return false;
            const saved = patchAsset(targetId, { composition_draft: draft });
            if (saved) initialDraft = JSON.stringify(draft);
            return saved;
          };
          options.openCompositionEditor?.(asset, saveDraft, (imagePath, generatedDraft) => {
            const latest = project.assets.find((item) => item.asset_id === targetId);
            if (!latest || latest.image_path !== initialImage
              || JSON.stringify(latest.composition_draft || null) !== JSON.stringify(generatedDraft)) return false;
            const saved = patchAsset(targetId, { image_path: imagePath });
            if (saved) initialImage = imagePath;
            return saved;
          });
        }, "zda-primary"), identifyButton(asset, identificationNotice)),
          ...(asset.type === "character" && !asset.image_path ? [el("p", {
            class: "zda-muted", text: "可直接摆姿态；没有人物参考图时，生成结果会按资产描述推断外观。",
          })] : []))),
    );
  }
  function drawAssistant() {
    const asset = current(), targetId = asset?.asset_id, slot = `asset:${targetId}`,
      entry = asset ? candidates.get(slot) : null, candidate = entry?.after,
      refining = !!entry && refinements.get(targetId)?.entry === entry,
      composer = createAssistantComposer({
        placeholder: refining ? "输入对当前候选的修改意见" : "输入修改意见；返回候选后由你确认采纳",
        statusText: refining ? "正在继续修改当前候选，请输入修改意见。" : "等待输入",
        onSend: async ({ instruction, status, send }) => {
          if (!asset || selectedId !== targetId || !instruction.value.trim() || send.disabled || pendingRequests.has(targetId)) return;
          if (entry && !refining) { status.textContent = "请点击继续修改，或先采纳、放弃当前 Candidate。"; return; }
          let requestCandidate;
          try {
            if (candidates.get(slot) !== entry && (entry || candidates.has(slot))) throw new Error("Candidate 已变化，请重新操作。");
            requestCandidate = entry || createCandidate("asset_update", { creativeProject: project }, { targetId, after: asset });
            const stale = candidateStaleReason(requestCandidate, { creativeProject: project });
            if (stale) throw new Error(stale);
          } catch (error) { status.textContent = error.message; return; }
          const currentAsset = { ...asset, ...(entry?.after || {}), asset_id: asset.asset_id, image_path: asset.image_path };
          const instructionText = instruction.value.trim();
          if (refining) refinements.set(targetId, { entry, instruction: instruction.value });
          pendingRequests.set(targetId, requestCandidate);
          drawAssistant();
          let failure = "";
          try {
            const result = await options.requestFn?.({
              target: "asset_prompt", instruction: instructionText,
              context: { asset: currentAsset },
            }, { page: "assets", label: "正在生成资产卡候选" });
            if (entry ? candidates.get(slot) !== entry : candidates.has(slot)) return;
            const stale = candidateStaleReason(requestCandidate, { creativeProject: project });
            if (stale) throw new Error(stale);
            if (!result?.asset) throw new Error("未返回资产卡候选，请重试。");
            updateCandidate(requestCandidate, { ...currentAsset, ...result.asset, asset_id: asset.asset_id, image_path: asset.image_path });
            requestCandidate.warnings = structuredClone(result.warnings || []);
            putCandidate(candidates, requestCandidate);
            refinements.delete(targetId);
            options.onCandidateStateChange?.();
          } catch (error) { failure = error.message; }
          finally {
            pendingRequests.delete(targetId);
            drawList();
            if (selectedId === targetId) {
              drawAssistant();
              if (failure) requestControls.status.textContent = failure;
            }
          }
        },
      }), { instruction, status, send } = composer;
    if (refining) instruction.value = refinements.get(targetId).instruction || "";
    instruction.addEventListener("input", () => {
      if (refining) refinements.set(targetId, { entry, instruction: instruction.value });
    });
    const assertActionable = () => {
      if (pendingRequests.has(targetId)) throw new Error("正在生成资产卡候选，请等待完成。");
      if (candidates.get(slot) !== entry) throw new Error("Candidate 已变化，请重新操作。");
    };
    const reviewActions = candidate ? candidateActions({
        warnings: entry.warnings,
        onPrimary: () => {
          assertActionable();
          const accepted = acceptCandidate(entry, {
            creativeProject: project, commitCreativeProject: commit,
          });
          project = accepted.creativeProject; consumeCandidate(candidates, entry);
          options.onCandidateStateChange?.(); draw();
        },
        onContinue: () => {
          assertActionable();
          const stale = candidateStaleReason(entry, { creativeProject: project });
          if (stale) throw new Error(stale);
          refinements.set(targetId, { entry, instruction: "" }); drawAssistant();
        },
        onDiscard: () => {
          assertActionable(); refinements.delete(targetId);
          discardStoredCandidate(candidates, entry); options.onCandidateStateChange?.(); draw();
        },
        onError: (error) => { status.textContent = error.message; },
      }) : [];
    assistant.replaceChildren(el("b", { text: asset ? `资产助手 · ${asset.name}` : "资产助手" }),
      el("p", { class: "zda-muted zcw-assist-note", text: "当前资产卡和修改意见会一起发送；结果只作为候选，不会直接覆盖。" }),
      ...(candidate ? [el("section", { class: "zda-preview-host" }, el("b", { text: `${candidate.name || asset.name} · ${TYPES.find(([value]) => value === candidate.type)?.[1] || candidate.type}` }),
        el("p", { text: candidate.description }), candidate.fixed_features?.length ? el("small", { class: "zda-muted", text: `固定特征：${candidate.fixed_features.join("；")}` }) : null, ...reviewActions)] : []),
      instruction, send, status);
    const updateRequestStatus = composer.setRequestStatus;
    composer.setRequestStatus = (active) => {
      updateRequestStatus(active);
      const pending = pendingRequests.has(targetId);
      if (pending) { send.disabled = true; status.textContent = "正在生成资产卡候选…"; }
      for (const action of (reviewActions.at(-1)?.children || [])) action.disabled = pending;
    };
    requestControls = composer; setRequestStatus(options.requestStatus?.());
  }
  function draw() {
    list.style.display = editing ? "none" : "flex";
    editor.style.display = editing ? "grid" : "none";
    drawList(); drawDetail(); drawAssistant();
  }

  function candidatePanel() {
    if (!suggestionRows.length) return null;
    return candidateBatchReview({
      title: `资产候选 · ${suggestionRows.length}`,
      subtitle: "确认后才创建正式资产卡",
      rows: suggestionRows,
      rowClass: "zcw-asset-candidate-row",
      unit: "项",
      warnings: suggestionCandidate?.warnings,
      error: regenerateError && !confirmRegenerate ? regenerateError : "",
      renderFields: (row) => {
        const name = el("input", { class: "zda-input", value: row.name || "" }),
        type = el("select", { class: "zda-input" }, ...TYPES.map(([value, label]) => el("option", { value, text: label }))),
        description = el("textarea", { class: "zda-input", value: row.description || "" });
        type.value = ({ 人物: "character", 场景: "scene", 道具: "prop" }[row.type] || row.type || "prop");
        name.addEventListener("input", () => { row.name = name.value; });
        type.addEventListener("change", () => { row.type = type.value; });
        description.addEventListener("input", () => { row.description = description.value; });
        return [name, type, description];
      },
      onDeleteRow: (index) => {
        suggestionRows.splice(index, 1);
        if (!suggestionRows.length) {
          discardStoredCandidate(candidates, suggestionCandidate); suggestionCandidate = null;
          options.onCandidateStateChange?.();
        }
        render();
      },
      onDiscardAll: () => {
        discardStoredCandidate(candidates, suggestionCandidate); suggestionCandidate = null; suggestionRows = [];
        options.onCandidateStateChange?.(); render();
      },
      onAdoptSelected: adoptSuggestions,
    });
  }
  function adoptSuggestions() {
    const chosen = suggestionRows.filter((row) => row.selected);
    if (!chosen.length) return;
    try {
      const accepted = acceptCandidate(suggestionCandidate, {
        creativeProject: project, commitCreativeProject: commit,
      });
      project = accepted.creativeProject; consumeCandidate(candidates, suggestionCandidate);
      selectedId = accepted.added[0]?.asset_id || selectedId; suggestionCandidate = null; suggestionRows = [];
      options.onCandidateStateChange?.(); render();
    } catch (error) { regenerateError = error.message; render(); }
  }

  function render() {
    const reviewing = suggestionRows.length > 0,
      content = reviewing
      ? candidatePanel()
      : layout,
      regenerate = () => {
        const active = options.requestStatus?.();
        if (active) {
          regenerateError = `${active.label || "其他请求"}尚未完成，请等待后重试。`; render(); return;
        }
        if (!project.story.text.trim()) {
          regenerateError = "请先保存剧本。"; render(); return;
        }
        discardStoredCandidate(candidates, suggestionCandidate); suggestionCandidate = null;
        suggestionRows = []; confirmRegenerate = false;
        options.onCandidateStateChange?.(); render(); void options.extractAssets?.();
      },
      headerActions = reviewing
        ? confirmRegenerate
          ? [
            el("span", { class: "zda-error", text: regenerateError || "重新提取会放弃当前候选修改。" }),
            button("取消", () => { confirmRegenerate = false; render(); }, "zdb-sub"),
            button("确认放弃并重新提取", regenerate, "zdb-danger"),
          ]
          : [button("重新提取", () => { confirmRegenerate = true; regenerateError = ""; render(); }, "zdb-sub")]
        : [
          button("从剧本提取", options.extractAssets, "zdb-sub"),
          button("新增资产", () => {
            const added = addCreativeAsset(project, { name: "新资产", type: "character" });
            selectedId = added.asset.asset_id; editing = true; save(added.project);
          }, "zda-primary"),
        ];
    host.replaceChildren(el("section", { class: "zcw-page" }, el("header", { class: "zcw-page-head" }, el("h2", { text: "资产" }), el("span", { class: "zda-grow" }),
      ...headerActions),
      el("div", { class: "zcw-page-content" }, content)));
    draw();
  }

  render(); return { setRequestStatus, setProject(next) { project = next; draw(); } };
}
