import { ASSET_CAPABILITIES, ASSET_GENERATION_DEFAULTS } from "./capabilities.js";
import { captionAsset, deleteAsset, importGeneratedImage, listAssets, saveAsset, uploadAssetImage } from "./asset-client.js";
import { generateAssetCandidate } from "./generation-client.js";
import { referencePromptLine } from "../composition-editor/prompt.js";

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "value") node.value = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children.flat().filter(Boolean));
  return node;
}
const button = (text, onclick, style = "") => el("button", { type: "button", class: `zac-btn ${style}`, text, onclick });
const field = (label, control) => el("label", { class: "zac-field" }, el("span", { text: label }), control);
export const ASSET_STYLE_PRESETS = [
  ["", "不指定风格"],
  ["超级写实，真实材质，细腻皮肤与物理光影，电影级细节", "超级写实"],
  ["黑白电影，高反差黑白影调，经典银盐质感，戏剧性布光", "黑白电影"],
  ["复古胶片，柔和颗粒，轻微褪色，暖色偏移，胶片高光", "复古胶片"],
  ["纪录片写实，自然光，现场感构图，克制调色，真实环境细节", "纪录片写实"],
  ["90年代电影，年代感布景与服饰，胶片颗粒，低饱和电影色彩", "90年代电影"],
  ["古风，传统服饰与器物，东方构图，古典色彩与氛围", "古风"],
  ["武侠，江湖气质，凌厉动作姿态，东方电影光影与风沙烟尘", "武侠"],
  ["水墨，水墨晕染，留白构图，墨色层次，东方绘画意境", "水墨"],
];
export function normalizeAssetSuggestion(seed = {}) {
  return {
    name: String(seed.name || ""), type: ["人物", "场景", "道具", "其他"].includes(seed.type) ? seed.type : "其他",
    description: String(seed.description || ""), prompt: String(seed.prompt || ""), usage: String(seed.usage || ""),
  };
}
const inputUrl = (path) => {
  const parts = String(path).split("/"), filename = parts.pop(), query = new URLSearchParams({ filename, type: "input" });
  if (parts.length) query.set("subfolder", parts.join("/"));
  return `/view?${query}`;
};
const outputUrl = (file) => `/view?${new URLSearchParams({ filename: file?.filename || "", subfolder: file?.subfolder || "", type: file?.type || "output" })}`;

class AssetCenter {
  constructor({ project = {}, onUseAsset = null, onReturn = null, onSuggestionsApplied = null, onGenerated = null, onSaveAsAsset = null, generatorSeed = null, initialImage = "", compositionSeed = null, selectionMode = false, generatorTool = false, onCompose = null } = {}) {
    this.project = { id: project.id || "", title: project.title || "" };
    this.onUseAsset = typeof onUseAsset === "function" ? onUseAsset : null;
    this.onReturn = typeof onReturn === "function" ? onReturn : null;
    this.onSuggestionsApplied = typeof onSuggestionsApplied === "function" ? onSuggestionsApplied : null;
    this.onGenerated = typeof onGenerated === "function" ? onGenerated : null;
    this.initialImage = typeof initialImage === "string" ? initialImage : "";
    this.onSaveAsAsset = typeof onSaveAsAsset === "function" ? onSaveAsAsset : null;
    this.compositionSeed = compositionSeed && typeof compositionSeed === "object" ? compositionSeed : null;
    this.generatorSeeds = Array.isArray(generatorSeed)
      ? generatorSeed.filter((item) => item && typeof item === "object").map(normalizeAssetSuggestion)
      : generatorSeed && typeof generatorSeed === "object" ? [normalizeAssetSuggestion(generatorSeed)] : [];
    this.appliedSuggestions = [];
    this.selectionMode = Boolean(selectionMode);
    this.generatorTool = Boolean(generatorTool);
    this.onCompose = typeof onCompose === "function" ? onCompose : null;
    this.assets = [];
    this.scope = "project";
    this.query = "";
  }

  open() {
    this.closed = false;
    this.overlay = el("div", { class: "zac-overlay", role: "dialog", "aria-modal": "true" });
    this.panel = el("section", { class: "zac-panel" });
    this.content = el("main", { class: "zac-content" });
    this.noticeHost = el("div", { class: "zac-notice" });
    const exit = () => { this.close(); this.onReturn?.(); };
    this.panel.append(
      el("header", { class: "zac-header" }, el("h2", { text: this.generatorTool ? this.compositionSeed ? "画面候选生成" : "资产生成工具" : this.selectionMode ? "选择图片资产" : "ZDX 资产中心" }), el("span", { class: "zac-grow" }),
        this.onReturn ? button("返回剧本草稿", exit, "sub") : null,
        button("关闭", exit, "sub")),
      this.noticeHost, this.content,
    );
    this.overlay.append(this.panel);
    document.body.append(this.overlay);
    if (this.generatorTool) {
      this.content.replaceChildren(el("p", { class: "zac-muted", text: "生成工具只返回最终图片，不创建第二份资产记录。" }));
      this.openGenerator(this.generatorSeeds[0] || {});
    } else {
      this.reload();
      if (this.generatorSeeds.length) this.openSeedChooser(this.generatorSeeds);
    }
    return this;
  }

  close() { this.closed = true; this.overlay?.remove(); }

  openSeedChooser(seeds) {
    const dialog = this.dialog("资产建议");
    const drafts = seeds.map((seed) => ({ ...normalizeAssetSuggestion(seed) }));
    dialog.body.append(
      el("p", { class: "zac-muted", text: "先应用为资产中心草稿；应用不会保存资产，也不会生成图片。" }),
      ...drafts.map((draft) => {
        const name = el("input", { value: draft.name, placeholder: "名称" }),
          type = el("select", {}, ...["人物", "场景", "道具", "其他"].map((value) => el("option", { value, text: value }))),
          description = el("textarea", { value: draft.description, placeholder: "稳定描述" }),
          prompt = el("textarea", { value: draft.prompt, placeholder: "图片生成提示词，可稍后继续修改" });
        type.value = draft.type;
        for (const [control, key] of [[name, "name"], [type, "type"], [description, "description"], [prompt, "prompt"]]) {
          control.addEventListener("input", () => { draft[key] = control.value; });
          control.addEventListener("change", () => { draft[key] = control.value; });
        }
        return el("article", { class: "zac-suggestion-edit" },
          el("div", { class: "zac-form-row zac-name-type-row" }, field("名称", name), field("类型", type)),
          field("描述", description), field("提示词", prompt));
      }),
    );
    dialog.footer.append(button("取消", dialog.close, "sub"), button("应用到资产中心", () => {
      this.appliedSuggestions = drafts;
      this.onSuggestionsApplied?.(drafts.map((draft) => ({ ...draft })));
      dialog.close(); this.render(); this.notice(`已应用 ${drafts.length} 条资产建议；请逐项编辑并生成。`);
    }));
  }
  notice(message, error = false) {
    (this.dialogNotice || this.noticeHost).replaceChildren(el("p", { class: error ? "zac-error" : "", text: message }));
  }

  async reload() {
    this.content.replaceChildren(el("p", { text: "正在读取资产库…" }));
    try { this.assets = await listAssets(); this.render(); }
    catch (error) { this.content.replaceChildren(el("p", { class: "zac-error", text: error.message })); }
  }

  visibleAssets() {
    const query = this.query.trim().toLowerCase();
    return this.assets.filter((asset) => {
      const inScope = this.scope === "all" || asset.project_id === this.project.id;
      const matches = !query || `${asset.name} ${asset.description} ${asset.project_title}`.toLowerCase().includes(query);
      return inScope && matches;
    });
  }

  render() {
    const search = el("input", { type: "search", value: this.query, placeholder: "搜索名称、描述或项目" });
    search.addEventListener("input", () => { this.query = search.value; this.renderGrid(); });
    this.grid = el("div", { class: "zac-grid" });
    const scoped = this.assets.filter((asset) => this.scope === "all" || asset.project_id === this.project.id);
    const count = (type) => scoped.filter((asset) => asset.asset_type === type).length;
    this.content.replaceChildren(
      el("div", { class: "zac-toolbar" },
        button(`当前项目 · ${this.project.title || "未分类"}`, () => { this.scope = "project"; this.render(); }, this.scope === "project" ? "active" : "sub"),
        button("全部资产", () => { this.scope = "all"; this.render(); }, this.scope === "all" ? "active" : "sub"),
        search,
        this.selectionMode ? null : button("上传资产", () => this.openEditor()),
      ),
      el("div", { class: "zac-summary" },
        el("span", { text: `人物 ${count("人物")}` }),
        el("span", { text: `场景 ${count("场景")}` }),
        el("span", { text: `道具 ${count("道具")}` }),
        el("span", { text: `其他 ${count("其他")}` })),
      this.renderAppliedSuggestions(),
      this.grid,
    );
    this.renderGrid();
  }

  renderAppliedSuggestions() {
    if (!this.appliedSuggestions.length) return null;
    const count = (type) => this.appliedSuggestions.filter((item) => item.type === type).length;
    return el("section", { class: "zac-suggestion-drafts" },
      el("div", { class: "zac-preview-head" }, el("b", { text: "待生成资产建议" }),
        el("span", { class: "zac-muted", text: `人物 ${count("人物")} · 场景 ${count("场景")} · 道具 ${count("道具")} · 其他 ${count("其他")}` })),
      ...this.appliedSuggestions.map((draft) => {
        const name = el("input", { value: draft.name, placeholder: "名称" }),
          type = el("select", {}, ...["人物", "场景", "道具", "其他"].map((value) => el("option", { value, text: value }))),
          description = el("textarea", { value: draft.description, placeholder: "稳定描述" }),
          prompt = el("textarea", { value: draft.prompt, placeholder: "图片生成提示词" });
        type.value = draft.type;
        for (const [control, key] of [[name, "name"], [type, "type"], [description, "description"], [prompt, "prompt"]]) {
          control.addEventListener("input", () => { draft[key] = control.value; });
          control.addEventListener("change", () => { draft[key] = control.value; });
        }
        return el("article", { class: "zac-suggestion-draft" },
          el("div", { class: "zac-form-row zac-name-type-row" }, field("名称", name), field("类型", type)),
          field("描述", description), field("提示词", prompt));
      }));
  }

  renderGrid() {
    const assets = this.visibleAssets();
    this.grid.replaceChildren(...assets.map((asset) => el("article", { class: "zac-card" },
      el("img", { src: inputUrl(asset.image_path), alt: asset.name }), el("b", { text: asset.name }),
      el("span", { class: "zac-muted", text: `${asset.asset_type}${asset.project_title ? ` · ${asset.project_title}` : ""}` }),
      el("p", { text: asset.description || "暂无描述" }),
      el("div", { class: "zac-actions" },
        this.onUseAsset ? button("用于当前项目", () => this.useAsset(asset), "sub") : null,
        this.selectionMode ? null : button("编辑", () => this.openEditor(asset), "sub"),
        this.selectionMode ? null : button("删除", () => this.confirmDelete(asset), "danger"),
      ),
    )));
    if (!assets.length) this.grid.append(el("p", { class: "zac-muted", text: "没有匹配的资产。" }));
  }

  async useAsset(asset) {
    if (!this.onUseAsset) return null;
    try {
      const result = await this.onUseAsset(asset);
      this.notice(
        result?.status === "already-present"
          ? "该资产已在当前项目中，现有快照保持不变。"
          : "已加入当前项目。",
      );
      return result;
    } catch (error) {
      this.notice(error?.message || "加入项目失败", true);
      return { status: "error", error };
    }
  }

  dialog(title, onClose = null) {
    const overlay = el("div", { class: "zac-suboverlay" }), panel = el("section", { class: "zac-dialog" }), body = el("main"), footer = el("footer"),
      notice = el("div", { class: "zac-dialog-notice", role: "status", "aria-live": "polite" }), previousNotice = this.dialogNotice;
    this.dialogNotice = notice;
    let closed = false;
    const ownerOverlay = this.overlay;
    const close = () => { closed = true; overlay.remove(); if (this.dialogNotice === notice) this.dialogNotice = previousNotice; onClose?.(); };
    body.append(notice);
    panel.append(el("header", {}, el("h3", { text: title }), el("span", { class: "zac-grow" }), button("×", close, "sub")), body, footer);
    overlay.append(panel); this.overlay.append(overlay);
    return { body, footer, close, isClosed: () => closed || this.closed || this.overlay !== ownerOverlay };
  }

  openEditor(asset = null) {
    const dialog = this.dialog(asset ? "编辑资产" : "上传资产"), item = asset || {};
    const name = el("input", { value: item.name || "", placeholder: "资产名称" });
    const type = el("select", {}, ...["人物", "场景", "道具", "其他"].map((value) => el("option", { value, text: value })));
    type.value = item.asset_type || "其他";
    const path = el("input", { value: item.image_path || "", readonly: true, placeholder: "先选择图片" });
    const picker = el("input", { type: "file", accept: "image/*" });
    const description = el("textarea", { value: item.description || "", placeholder: "资产描述" });
    picker.addEventListener("change", async () => {
      try { path.value = await uploadAssetImage(picker.files?.[0]); if (!name.value) name.value = picker.files?.[0]?.name.replace(/\.[^.]+$/, "") || ""; }
      catch (error) { this.notice(error.message, true); }
    });
    const caption = async (provider) => {
      if (!path.value) return this.notice("请先选择图片", true);
      try { description.value = await captionAsset(path.value, provider); }
      catch (error) { this.notice(error.message, true); }
    };
    dialog.body.append(field("名称", name), field("类型", type), field("图片", path), picker,
      el("div", { class: "zac-actions" }, button("Qwen Caption", () => caption("qwen"), "sub"), button("豆包 Caption", () => caption("doubao"), "sub")),
      field("描述", description));
    dialog.footer.append(button("保存", async () => {
      try {
        await saveAsset({ ...item, name: name.value, asset_type: type.value, image_path: path.value, description: description.value, project_id: item.project_id || this.project.id, project_title: item.project_title || this.project.title });
        dialog.close(); await this.reload();
      } catch (error) { this.notice(error.message, true); }
    }));
  }

  openGenerator(seed = {}) {
    const dialog = this.dialog(this.generatorTool ? `生成「${seed.name || "资产"}」候选图` : "生成资产", this.generatorTool ? () => this.close() : null), values = { ...ASSET_GENERATION_DEFAULTS, ...(this.compositionSeed ? { steps: 25, output_size: this.compositionSeed.output_size || "1.5k", aspect_ratio: this.compositionSeed.aspect_ratio || "1:1" } : {}), app_type: this.compositionSeed ? "draft_render" : this.initialImage ? "img2img" : "zimage" };
    const name = el("input", { placeholder: "资产名称", value: seed.name || "" }),
      type = el("select", {}, ...["人物", "场景", "道具", "其他"].map((value) => el("option", {
        value, text: value, selected: value === seed.type,
      })));
    const capabilitySelect = el("select", {}, ...Object.entries(ASSET_CAPABILITIES)
      .filter(([value]) => this.compositionSeed ? value === "draft_render" : value !== "draft_render")
      .map(([value, item]) => el("option", { value, text: item.label })));
    const description = el("textarea", { placeholder: "资产稳定描述，用于检索和复用", value: seed.description || "" });
    const prompt = el("textarea", { placeholder: "描述希望生成的画面", value: this.compositionSeed?.prompt || seed.prompt || "" }),
      inputHost = el("div", { class: "zac-source-grid", "aria-label": "输入图片" }),
      advancedHost = el("div", { class: "zac-advanced-grid" }), preview = el("div", { class: "zac-candidate" });
    const compositionSizeNote = el("p", { class: "zac-muted" });
    const stylePreset = el("select", {}, ...ASSET_STYLE_PRESETS.map(([value, label]) => el("option", { value, text: label })));
    let insertedStyle = "";
    stylePreset.addEventListener("change", () => {
      const lines = prompt.value.split("\n");
      const previous = insertedStyle ? lines.lastIndexOf(insertedStyle) : -1;
      if (previous >= 0) lines.splice(previous, 1);
      insertedStyle = stylePreset.value ? `视觉风格：${stylePreset.value}` : "";
      prompt.value = [lines.join("\n").trim(), insertedStyle].filter(Boolean).join("\n");
    });
    const outputSizeSelect = el("select", { "aria-label": "生成分辨率" },
      ...["1k", "1.5k", "2k"].map((value) => el("option", { value, text: value })));
    outputSizeSelect.value = values.output_size;
    outputSizeSelect.addEventListener("change", () => {
      values.output_size = outputSizeSelect.value;
      compositionSizeNote.textContent = `Qwen ${values.output_size} · 画幅 ${values.aspect_ratio}`;
    });
    const imagePaths = { image: this.compositionSeed?.composition_image || this.initialImage || "", reference_image: this.compositionSeed?.reference_image || "", reference_image_2: this.compositionSeed?.reference_image_2 || "", mask: "" };
    const syncReferencePrompt = () => {
      if (!this.compositionSeed || this.compositionSeed.draft_mode === "sticker") return;
      const peopleCount = this.compositionSeed.people_count === 2 ? 2 : 1;
      const count = !imagePaths.reference_image ? 0 : imagePaths.reference_image_2 ? 2 : 1;
      const instruction = referencePromptLine(count, peopleCount);
      const known = new Set([...([0, 1, 2].map((value) => referencePromptLine(value, peopleCount))),
        "Image2 contains both people: match its left person to the screen-left pose and its right person to the screen-right pose."]);
      const lines = prompt.value.split("\n"), index = lines.findIndex((line) => known.has(line));
      if (index >= 0) lines[index] = instruction;
      else {
        const renderIndex = lines.findIndex((line) => line.startsWith("Render a realistic final image."));
        lines.splice(renderIndex < 0 ? lines.length : renderIndex, 0, instruction);
      }
      prompt.value = lines.join("\n");
    };
    const inputPanel = el("section", { class: "zac-generator-input-panel", "aria-label": "生成输入区" }),
      resultPanel = el("section", { class: "zac-generator-result-panel", "aria-label": "候选结果区" }),
      workspace = el("div", { class: "zac-generator-workspace", "data-view": "input", "data-has-results": "false" }),
      viewTabs = el("div", { class: "zac-generator-view-tabs", role: "tablist", "aria-label": "生成工作区" });
    const inputActions = el("div", { class: "zac-generator-actions" }),
      resultActions = el("div", { class: "zac-generator-actions" });
    const setView = (view) => {
      if (view === "result" && !candidate) return;
      inputPanel.hidden = view !== "input";
      resultPanel.hidden = view !== "result";
      inputActions.hidden = view !== "input";
      resultActions.hidden = view !== "result";
      workspace.setAttribute("data-view", view);
      viewTabs.children[0].setAttribute("aria-selected", view === "input" ? "true" : "false");
      viewTabs.children[1].setAttribute("aria-selected", view === "result" ? "true" : "false");
    };
    viewTabs.append(
      el("button", { type: "button", role: "tab", "data-view": "input", "aria-selected": "true", text: "输入", onclick: () => setView("input") }),
      el("button", { type: "button", role: "tab", "data-view": "result", "aria-selected": "false", text: "结果", onclick: () => setView("result") }),
    );
    const candidates = [];
    let candidate = null;
    const renderCandidates = () => {
      workspace.setAttribute("data-has-results", candidates.length ? "true" : "false");
      viewTabs.hidden = !candidates.length;
      const older = candidates.filter((item) => item !== candidate).reverse();
      const candidateCard = (item, featured = false) => el("button", {
        type: "button", class: `zac-candidate-card ${featured ? "is-featured" : "is-thumbnail"}`,
        onclick: () => { candidate = item; renderCandidates(); },
      }, el("img", { src: outputUrl(item), alt: `候选 ${candidates.indexOf(item) + 1}` }),
      el("span", { text: `候选 ${candidates.indexOf(item) + 1}` }));
      preview.replaceChildren(
        el("div", { class: "zac-preview-head" }, el("b", { text: "候选结果" }), el("span", { class: "zac-muted", text: candidates.length ? `${candidates.length} 张 · 可继续生成` : "生成后可反复追加候选" })),
        candidates.length
          ? el("div", { class: "zac-candidate-list" }, candidateCard(candidate, true),
            older.length ? el("div", { class: "zac-candidate-grid" }, ...older.map((item) => candidateCard(item))) : null)
          : el("div", { class: "zac-empty-preview", text: "暂无候选图" }),
      );
    };
    const imageInput = (key, label) => {
      const image = el("img", { class: "zac-source-image", alt: label }), empty = el("span", { class: "zac-source-empty", text: `上传${label}` });
      const filename = el("span", { class: "zac-source-name", text: imagePaths[key] || "未选择" });
      const picker = el("input", { class: "zac-file-input", type: "file", accept: "image/*" });
      const pickButton = button(imagePaths[key] ? "更换图片" : "选择图片", () => picker.click(), "sub");
      picker.addEventListener("change", async () => {
        try {
          imagePaths[key] = await uploadAssetImage(picker.files?.[0]);
          image.src = inputUrl(imagePaths[key]); image.hidden = false; empty.hidden = true;
          filename.textContent = imagePaths[key].split("/").pop();
          pickButton.textContent = "更换图片";
          if (key.startsWith("reference_image")) syncReferencePrompt();
        }
        catch (error) { this.notice(error.message, true); }
      });
      if (imagePaths[key]) { image.src = inputUrl(imagePaths[key]); empty.hidden = true; }
      else image.hidden = true;
      return el("article", { class: "zac-source-card" },
        el("b", { text: label }), el("div", { class: "zac-source-preview" }, image, empty),
        filename, pickButton, picker,
      );
    };
    const renderCapability = () => {
      values.app_type = capabilitySelect.value;
      compositionSizeNote.hidden = values.app_type !== "draft_render";
      const capability = ASSET_CAPABILITIES[values.app_type];
      const inputs = this.compositionSeed?.draft_mode === "sticker" ? ["image", "prompt"] : capability.inputs;
      const inputSlots = [
        inputs.includes("image") ? ["image", values.app_type === "draft_render" ? "画面草稿" : "原图"] : null,
        inputs.includes("reference_image") ? ["reference_image", values.app_type === "draft_render" ? "人物参考（左/单人）" : "参考图"] : null,
        inputs.includes("reference_image_2") ? ["reference_image_2", values.app_type === "draft_render" ? "人物参考（右）" : "人物 2"] : null,
        inputs.includes("mask") ? ["mask", "蒙版"] : null,
      ].filter(Boolean);
      inputHost.replaceChildren(...inputSlots.map(([key, label]) => imageInput(key, label)));
      renderCandidates();
      setView("input");
      const advanced = capability.advanced;
      const controls = [];
      const add = (key, label, control) => {
        if (control.type === "checkbox") control.checked = Boolean(values[key]);
        else if (values[key] !== undefined) control.value = String(values[key]);
        control.addEventListener("change", () => values[key] = control.type === "checkbox" ? control.checked : control.value);
        controls.push(field(label, control));
      };
      if (advanced.includes("output_size")) add("output_size", "分辨率", el("select", {}, ...["1k", "1.5k", "2k"].map((value) => el("option", { value, text: value }))));
      if (advanced.includes("aspect_ratio")) {
        add("aspect_ratio", "画幅", el("select", {}, ...["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"].map((value) => el("option", { value, text: value }))));
      }
      if (advanced.includes("lora")) add("lora", "LoRA", el("input", { value: values.lora }));
      if (advanced.includes("strength")) add("strength", "Strength", el("input", { type: "number", min: "0", max: "2", step: "0.05", value: String(values.strength) }));
      if (advanced.includes("enhance")) add("enhance", "增强", el("input", { type: "checkbox", checked: values.enhance }));
      if (advanced.includes("denoise")) add("denoise", "Denoise", el("input", { type: "number", min: "0", max: "1", step: "0.01", value: String(values.denoise) }));
      if (advanced.includes("steps")) add("steps", "Steps", el("input", { type: "number", min: "1", max: "50", value: String(values.steps) }));
      advancedHost.replaceChildren(...controls);
    };
    capabilitySelect.addEventListener("change", renderCapability);
    const editComposition = async () => {
      try {
        const reopened = await this.onCompose({
          prompt: prompt.value, init_image: imagePaths.image || "",
          reference_image: imagePaths.reference_image, reference_image_2: imagePaths.reference_image_2,
          output_size: values.output_size,
        });
        if (reopened === false) return;
        dialog.close();
        this.close();
      } catch (error) { this.notice(error.message, true); }
    };
    const topControls = el("div", { class: "zac-generator-topline" },
      this.compositionSeed ? null : field("能力", capabilitySelect),
      this.onCompose ? button(this.compositionSeed ? "返回修改草稿" : "姿态／角度搭建", editComposition, "sub") : null,
      this.compositionSeed?.target_kind === "frame" ? el("span", { class: "zac-muted",
        text: `跟随视频画幅 ${values.aspect_ratio}` }) : null,
      this.compositionSeed ? field("生成分辨率", outputSizeSelect) : null);
    const shortcuts = this.compositionSeed ? null : el("div", {
      class: "zac-generator-shortcuts", "aria-label": "常用图片能力",
    }, ...[
      ["img2img", "图生图"], ["qwen21_edit", "Qwen 2.1 改图"],
      ["qwen_edit", "Qwen Edit 改图"], ["klein_edit", "Klein 改图"],
    ].map(([mode, label]) => button(label, () => {
      capabilitySelect.value = mode;
      renderCapability();
    }, "sub")));
    inputPanel.append(...[topControls, shortcuts,
      this.generatorTool ? el("details", { class: "zac-generator-identity" },
        el("summary", { text: `${seed.name || "未命名资产"} · ${seed.type || "其他"} · 资产信息` }),
        el("p", { text: seed.description || "暂无描述" }))
        : el("div", { class: "zac-form-row zac-name-type-row" }, field("名称", name), field("类型", type)),
      this.generatorTool ? null : field("描述", description),
      inputHost,
      field("画面描述", prompt),
      el("details", { class: "zac-generator-advanced" }, el("summary", { text: "高级参数" }), field("视觉风格", stylePreset), compositionSizeNote, advancedHost)].filter(Boolean));
    resultPanel.append(preview);
    workspace.append(inputPanel, resultPanel);
    dialog.body.append(viewTabs, workspace);
    capabilitySelect.value = values.app_type;
    renderCapability();
    compositionSizeNote.textContent = `Qwen ${values.output_size} · 画幅 ${values.aspect_ratio}`;
    syncReferencePrompt();
    const generate = button("生成候选图", async () => {
      generate.disabled = true; generate.textContent = "生成中…";
      try {
        this.notice("正在提交生成任务…");
        candidate = await generateAssetCandidate({ ...this.compositionSeed, ...values, prompt: prompt.value, init_image: imagePaths.image, composition_image: imagePaths.image, reference_image: imagePaths.reference_image, reference_image_2: imagePaths.reference_image_2, mask: imagePaths.mask }, (message) => this.notice(message));
        candidates.push(candidate); renderCandidates(); setView("result"); this.notice("候选图已生成，请选择并使用。");
      }
      catch (error) { this.notice(error.message, true); }
      finally { generate.disabled = false; }
      generate.textContent = candidates.length ? "继续生成" : "生成候选图";
    });
    const save = async (useAfterSave) => {
      if (!candidate) return this.notice("请先生成候选图", true);
      try {
        const image_path = await importGeneratedImage(candidate);
        if (dialog.isClosed()) return;
        if (this.generatorTool) {
          const accepted = await this.onGenerated?.({ image_path });
          if (accepted === false) throw new Error("目标资产或分镜已变化，请重新打开构图编辑器");
          dialog.close(); this.close();
          return;
        }
        const asset = await saveAsset({ name: name.value, asset_type: type.value, image_path, description: description.value, project_id: this.project.id, project_title: this.project.title });
        if (useAfterSave && this.onUseAsset) {
          const result = await this.useAsset(asset);
          if (result?.status === "error") return;
        }
        dialog.close(); await this.reload();
      } catch (error) { this.notice(error.message, true); }
    };
    const saveAsForm = el("section", { class: "zac-save-as-form", "aria-label": "另存为素材" });
    saveAsForm.hidden = true;
    const saveName = el("input", { value: seed.name || "", placeholder: "素材名称" }),
      saveType = el("select", {}, ...["人物", "场景", "道具"].map((value) => el("option", { value, text: value })));
    saveType.value = ["人物", "场景", "道具"].includes(seed.type) ? seed.type : "道具";
    const saveDescription = el("textarea", { value: seed.description || "", placeholder: "素材描述" });
    const confirmSaveAs = button("确认另存", async () => {
      if (!saveName.value.trim()) return this.notice("请填写素材名称", true);
      confirmSaveAs.disabled = true;
      try {
        const image_path = await importGeneratedImage(candidate);
        if (dialog.isClosed()) return;
        const accepted = await this.onSaveAsAsset({ image_path, name: saveName.value.trim(), type: saveType.value, description: saveDescription.value });
        if (accepted === false) throw new Error("目标项目已变化，请重新打开生成工具");
        saveAsForm.hidden = true;
        this.notice("已另存为素材，仍可采用当前结果。");
      } catch (error) { this.notice(error.message, true); }
      finally { confirmSaveAs.disabled = false; }
    });
    saveAsForm.append(field("素材名称", saveName), field("素材类型", saveType), field("素材描述", saveDescription),
      el("div", { class: "zac-generator-actions" }, button("返回结果", () => { saveAsForm.hidden = true; }, "sub"), confirmSaveAs));
    resultPanel.append(saveAsForm);
    inputActions.append(generate);
    resultActions.append(...[
      this.generatorTool ? button("使用这张图", () => save(false)) : button("保存为资产", () => save(false), "sub"),
      !this.generatorTool && this.onUseAsset ? button("保存并用于当前项目", () => save(true)) : null,
      this.generatorTool && this.onSaveAsAsset ? button("另存为素材", () => { saveAsForm.hidden = false; saveName.focus(); }, "sub") : null,
      button("继续修改", () => { saveAsForm.hidden = true; setView("input"); prompt.focus(); }, "sub"),
      this.compositionSeed && this.onCompose ? button("返回修改草稿", editComposition, "sub") : null,
    ].filter(Boolean));
    dialog.footer.append(...[inputActions, resultActions]);
    setView("input");
  }

  confirmDelete(asset) {
    const dialog = this.dialog("删除资产");
    dialog.body.append(el("p", { text: `只删除资产库记录，不删除图片文件。确认删除“${asset.name}”？` }));
    dialog.footer.append(button("取消", dialog.close, "sub"), button("删除", async () => { try { await deleteAsset(asset.id); dialog.close(); await this.reload(); } catch (error) { this.notice(error.message, true); } }, "danger"));
  }
}

export function openAssetCenter(options) { return new AssetCenter(options).open(); }
export function openAssetGenerator(options = {}) {
  const asset = options.asset || {}, type = ({ character: "人物", scene: "场景", prop: "道具" }[asset.type] || "其他");
  return new AssetCenter({
    project: options.project, generatorTool: true, onGenerated: options.onComplete, onSaveAsAsset: options.onSaveAsAsset, initialImage: options.initialImage, compositionSeed: options.compositionSeed, onCompose: options.onCompose,
    generatorSeed: { name: asset.name, type, description: asset.description, prompt: [asset.description, ...(asset.fixed_features || [])].filter(Boolean).join("，") },
  }).open();
}
