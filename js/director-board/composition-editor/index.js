import { PoseViewerCore } from "./vendor/vnccs/vnccs_pose_studio_core.mjs";
import { loadMorphPack, solveMorph, buildStaticModelData } from "./vendor/vnccs/vnccs_pose_morph_runtime.mjs";
import { readPoseKeypoints, largestBody, applicableBody, poseOverlay } from "./vendor/fisher-editor/pose-keypoints.mjs";
import { POSE_CATEGORIES, findPosePresets, poseSpec } from "./pose-catalog.js";
import { applyCommonPose, applyDetectedPose } from "./pose-actions.js";
import { draftPrompt } from "./prompt.js";
import { ASPECT_RATIOS, canvasSizeFor } from "../model.js";

const PACK_URL = new URL("./vendor/vnccs/assets/pose_studio_makehuman.v2.bin.gz", import.meta.url);
const CSS_URL = new URL("./style.css?v=9", import.meta.url);
const DEFAULT_MESH = { age: 25, gender: 0.5, weight: 0.5, muscle: 0.5, height: 0.5, breast_size: 0, firmness: 0.5, show_genitals: false };
const WHITE = [255, 255, 255];
const GREEN = [0, 255, 0];
let packPromise;

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
const node = (tag, className, textContent) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (textContent != null) element.textContent = textContent;
  return element;
};
const dataUrlBlob = async (url) => (await fetch(url)).blob();
const loadImage = (src) => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error("背景图片无法读取"));
  image.src = src;
});

function modelData(morph, staticData) {
  const bones = staticData.bones.map((bone, index) => {
    const headPos = Array.from(morph.bonePositions.subarray(index * 6, index * 6 + 3));
    const tailPos = Array.from(morph.bonePositions.subarray(index * 6 + 3, index * 6 + 6));
    return { name: bone.name, parent: bone.parent || null, headPos, tailPos,
      length: Math.hypot(...tailPos.map((value, axis) => value - headPos[axis])) };
  });
  return { vertices: morph.vertices, uvs: staticData.uvs, indices: staticData.indices, bones,
    skinIndices: staticData.skinIndices, skinWeights: staticData.skinWeights,
    landmarks: morph.landmarks || {}, landmark_indices: morph.landmarkIndices || {} };
}

function drawBackground(ctx, image, width, height) {
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  if (!image) return;
  const fit = Math.max(width / image.width, height / image.height);
  ctx.drawImage(image, (width - image.width * fit) / 2, (height - image.height * fit) / 2,
    image.width * fit, image.height * fit);
}

function stickerRect(sticker, image, width, height) {
  const ratio = image.width / image.height;
  const w = Math.min(width * .36, height * .65 * ratio) * sticker.scale;
  return { x: width * (.5 + sticker.x), y: height * (.5 + sticker.y), w, h: w / ratio };
}

function drawSticker(ctx, sticker, image, width, height, selected) {
  const { x, y, w, h } = stickerRect(sticker, image, width, height);
  ctx.save(); ctx.translate(x, y); ctx.rotate(sticker.rotation * Math.PI / 180);
  ctx.drawImage(image, -w / 2, -h / 2, w, h);
  if (selected) {
    ctx.strokeStyle = "#ffbc42"; ctx.lineWidth = Math.max(2, width / 500);
    ctx.strokeRect(-w / 2, -h / 2, w, h);
  }
  ctx.restore();
}

function drawPoseGuide(ctx, viewer, width, height) {
  const links = [["head", "neck", "#9c58d0"], ["neck", "pelvis", "#22b788"],
    ["neck", "upperarm_l", "#e4ad29"], ["upperarm_l", "lowerarm_l", "#e4ad29"], ["lowerarm_l", "hand_l", "#e4ad29"],
    ["neck", "upperarm_r", "#e05065"], ["upperarm_r", "lowerarm_r", "#e05065"], ["lowerarm_r", "hand_r", "#e05065"],
    ["pelvis", "thigh_l", "#29a8c6"], ["thigh_l", "calf_l", "#29a8c6"], ["calf_l", "foot_l", "#29a8c6"],
    ["pelvis", "thigh_r", "#64c154"], ["thigh_r", "calf_r", "#64c154"], ["calf_r", "foot_r", "#64c154"]];
  const rigs = [viewer.bones, ...[...viewer.passiveCharacters.values()].map((entry) =>
    Object.fromEntries((entry.mesh.skeleton?.bones || []).map((bone) => [bone.name, bone])))];
  for (const bones of rigs) {
    const points = Object.fromEntries([...new Set(links.flatMap(([a, b]) => [a, b]))].flatMap((name) => {
      const bone = bones?.[name];
      if (!bone) return [];
      const projected = bone.getWorldPosition(new viewer.THREE.Vector3()).project(viewer.captureCamera);
      return [[name, { x: (projected.x + 1) * width / 2, y: (1 - projected.y) * height / 2 }]];
    }));
    ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (const [a, b, color] of links) {
      if (!points[a] || !points[b]) continue;
      ctx.beginPath(); ctx.moveTo(points[a].x, points[a].y); ctx.lineTo(points[b].x, points[b].y);
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = Math.max(6, width / 140); ctx.stroke();
      ctx.strokeStyle = color; ctx.lineWidth = Math.max(3, width / 300); ctx.stroke();
    }
    for (const point of Object.values(points)) {
      ctx.beginPath(); ctx.arc(point.x, point.y, Math.max(4, width / 210), 0, Math.PI * 2);
      ctx.fillStyle = "#f5c84c"; ctx.fill();
    }
    ctx.restore();
  }
}

/** Opens one self-contained editor. onApply/onGenerate receive editable state and PNG Blobs. */
export function openCompositionEditor({ draft = null, characterAssets = [], backgroundAssets = [], target = null, onDetectPose, onApply, onGenerate } = {}) {
  if (!document.body) throw new Error("构图编辑器需要浏览器页面");
  const previous = document.querySelector(".zce-overlay");
  previous?.__close?.();
  if (!document.querySelector("link[data-zce-style]")) {
    const style = node("link");
    style.rel = "stylesheet";
    style.href = CSS_URL.href;
    style.dataset.zceStyle = "";
    document.head.append(style);
  }
  const saved = typeof draft === "string" ? JSON.parse(draft || "{}") : (draft || {});
  const poseSaved = (() => { try { return JSON.parse(saved.pose_json || "{}"); } catch { return {}; } })();
  const restoredPeople = (saved.people?.length > 1 ? saved.people : poseSaved.people)?.slice(0, 2);
  const firstPerson = restoredPeople?.[0] || {};
  const state = {
    ...saved,
    version: 1,
    width: clamp(target?.kind === "frame" && target.frameSize ? target.frameSize[0] : saved.width || 1024, 256, 2048),
    height: clamp(target?.kind === "frame" && target.frameSize ? target.frameSize[1] : saved.height || 1024, 256, 2048),
    mesh: { ...DEFAULT_MESH, ...poseSaved.mesh, ...firstPerson.mesh, ...saved.mesh },
    person: { x: 0, y: 0, z: 0, zoom: 1, ...poseSaved.transform, ...saved.person, ...firstPerson.transform },
    camera: { yaw: 0, pitch: 0, zoom: 1, offsetX: 0, offsetY: 0, ...poseSaved.anyAngle, ...poseSaved.shotCamera, ...saved.camera },
    background: { src: saved.background?.src || "", image_path: saved.background?.image_path || "" },
    draft_mode: ["pose", "angle", "sticker"].includes(saved.draft_mode) ? saved.draft_mode : "pose",
    guide_style: saved.guide_style === "mannequin" ? "mannequin" :
      saved.guide_style === "skeleton" ? "skeleton" : "mannequin_skeleton",
    export_style: ["mannequin", "skeleton", "mannequin_skeleton"].includes(saved.export_style)
      ? saved.export_style : "mannequin",
    stickers: Array.isArray(saved.stickers) ? saved.stickers.map((item) => ({ ...item })) : [],
    promptOverrides: { ...saved.promptOverrides },
    extra_prompt: saved.extra_prompt || "",
    pose: firstPerson.pose || saved.pose || poseSaved.pose || null,
    people: restoredPeople?.map((person) => ({ mesh: { ...DEFAULT_MESH, ...person.mesh }, pose: person.pose || null,
      transform: { x: 0, y: 0, z: 0, zoom: 1, ...person.transform } })) || null,
  };
  const stickerOnly = target?.kind === "asset" && target.assetType !== "character";
  if (stickerOnly) state.draft_mode = "sticker";
  delete state.camera.roll;
  delete state.identity_image_path;
  delete state.peopleReferences;
  delete state.generation_references;
  delete state.referenceMode;
  let activePerson = 0;
  let pairUndo = null, pairRedo = null, applyingPair = false;
  const clearPairUndo = () => { if (!applyingPair) pairUndo = pairRedo = null; };
  let updateDetectTarget = () => {};
  const overlay = node("div", "zce-overlay");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "草稿编辑器");
  const panel = node("section", "zce-panel");
  const header = node("header", "zce-header");
  const heading = node("div", "zce-heading");
  const isFrame = target?.kind === "frame";
  const frameLabel = target?.frameRole === "last_frame" ? "尾帧" : "首帧";
  const modeRow = node("div", "zce-mode-row");
  modeRow.append(node("span", "zce-eyebrow", isFrame ? "生成 / 分镜关键帧" :
    target?.kind === "asset" ? "生成 / 资产打磨" : "生成 / 画面草稿"));
  const headingTitle = node("h2", "", isFrame ? `${target.title || "未命名分镜"} · ${frameLabel}` :
    target?.kind === "asset" ? target.title || "未命名资产" : "姿态与构图");
  heading.append(modeRow, headingTitle);
  header.append(heading);
  const closeButton = node("button", "zce-close", "×");
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "关闭构图编辑器");
  header.append(closeButton);
  const body = node("div", "zce-body");
  const stage = node("div", "zce-stage");
  const canvas = node("canvas", "zce-viewport");
  canvas.width = 900; canvas.height = 700;
  stage.append(canvas);
  const previewWrap = node("div", "zce-preview-wrap");
  const preview = node("canvas", "zce-preview");
  preview.width = state.width; preview.height = state.height;
  previewWrap.append(preview);
  const visual = node("div", "zce-visual");
  const visualToolbar = node("div", "zce-visual-toolbar");
  visual.append(visualToolbar, stage, previewWrap);
  const controls = node("div", "zce-controls");
  const sceneBar = node("div", "zce-scene-bar"); controls.append(sceneBar);
  const guideControls = node("div", "zce-guide-style");
  const guideSelect = node("select");
  guideSelect.setAttribute("aria-label", "预览辅助样式");
  guideSelect.title = "只改变编辑预览，不影响生成用草稿";
  for (const [value, label] of [["mannequin_skeleton", "人偶＋彩色骨架（默认）"],
    ["skeleton", "背景/照片＋彩色骨架"], ["mannequin", "纯白膜"]]) {
    const option = node("option", "", label); option.value = value; guideSelect.append(option);
  }
  guideSelect.value = state.guide_style;
  guideSelect.onchange = () => { state.guide_style = guideSelect.value; schedulePreview(); };
  const exportSelect = node("select");
  exportSelect.setAttribute("aria-label", "生成用草稿样式");
  exportSelect.title = "默认输出干净白膜；也可按所用模型要求手动指定骨骼样式";
  for (const [value, label] of [["mannequin", "白膜（默认）"], ["skeleton", "纯骨骼"],
    ["mannequin_skeleton", "白膜＋骨骼"]]) {
    const option = node("option", "", label); option.value = value; exportSelect.append(option);
  }
  exportSelect.value = state.export_style;
  exportSelect.onchange = () => { state.export_style = exportSelect.value; refreshPrompt(); };
  const previewLabel = node("label", "", "预览："); previewLabel.append(guideSelect);
  const exportLabel = node("label", "", "生成草稿："); exportLabel.append(exportSelect);
  guideControls.append(previewLabel, exportLabel); sceneBar.append(guideControls);
  const tabs = node("div", "zce-tabs"); tabs.setAttribute("role", "tablist");
  const poseTab = node("button", "zce-tab", "摆姿态");
  const cameraTab = node("button", "zce-tab", "调角度");
  const stickerTab = node("button", "zce-tab", "贴图融合");
  if (stickerOnly) tabs.hidden = true;
  const posePane = node("div", "zce-pane"), cameraPane = node("div", "zce-pane"), stickerPane = node("div", "zce-pane");
  let activeTab = state.draft_mode;
  let manualEdit = false;
  let promptInput;
  const switchTab = (tab) => {
    if (tab !== activeTab) clearPairUndo();
    activeTab = tab;
    state.draft_mode = tab;
    const poseActive = tab === "pose";
    const cameraActive = tab === "angle";
    headingTitle.hidden = poseActive && target?.kind === "asset";
    poseTab.setAttribute("aria-selected", String(poseActive));
    cameraTab.setAttribute("aria-selected", String(cameraActive));
    stickerTab.setAttribute("aria-selected", String(tab === "sticker"));
    posePane.hidden = !poseActive; cameraPane.hidden = !cameraActive; stickerPane.hidden = tab !== "sticker";
    manualEdit = false;
    visual.classList.toggle("zce-manual", manualEdit);
    manualButton.textContent = "手动调关节";
    visualToolbar.hidden = tab === "sticker";
    manualButton.hidden = !poseActive;
    poseButtons.hidden = !poseActive;
    canvas.style.cursor = "";
    preview.style.cursor = cameraActive ? "grab" : "move";
    guideControls.hidden = tab === "sticker";
    if (viewer?.isCaptureReady()) setStatus(tab === "sticker" ?
      state.stickers.length ? "拖动贴图摆放画面" : "可添加透明素材，也可直接打磨当前场景" :
      cameraActive ? "拖动画布调整选中人物角度；切到整体机位可调整镜头" : "选择姿态卡片或从照片提取动作，画布上可继续调整站位和远近");
    refreshPrompt(); schedulePreview();
  };
  poseTab.onclick = () => switchTab("pose"); cameraTab.onclick = () => switchTab("angle");
  stickerTab.onclick = () => switchTab("sticker");
  tabs.append(poseTab, cameraTab, stickerTab); modeRow.append(tabs);
  controls.append(posePane, cameraPane, stickerPane);
  body.append(visual, controls);
  const footer = node("footer", "zce-footer");
  const status = node("span", "zce-status", "加载人体模型中…");
  const saveButton = node("button", "zce-secondary", "保存草稿");
  const generateButton = node("button", "zce-primary", isFrame ? `生成${frameLabel}候选` :
    target?.kind === "asset" ? "生成资产候选" : "生成画面候选");
  saveButton.disabled = generateButton.disabled = true;
  footer.append(status, saveButton, generateButton);
  panel.append(header, body, footer); overlay.append(panel); document.body.append(overlay);

  let disposed = false, busy = false, viewer, image = null, backgroundBlob = null;
  let refreshTimer = 0, renderingPreview = false, previewRevision = 0, backgroundRevision = 0;
  let hitMask = null, hitMaskWidth = state.width, hitMaskHeight = state.height;
  const stickerImages = new Map(), stickerBlobs = new Map();
  const poseMaterials = new Map(), guideMaterials = new Set();
  let selectedSticker = state.stickers.length ? 0 : -1;
  let previewContext = preview.getContext("2d");
  const setStatus = (message) => {
    status.textContent = message;
    status.dataset.tone = /失败|错误|无法/.test(message) ? "error" : "normal";
  };
  const close = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(refreshTimer);
    window.removeEventListener("keydown", onKeyDown);
    resizeObserver?.disconnect();
    viewer?.renderer?.forceContextLoss();
    viewer?.dispose();
    guideMaterials.forEach((material) => material.dispose());
    overlay.remove();
  };
  overlay.__close = close;
  closeButton.onclick = close;
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  const onKeyDown = (event) => { if (event.key === "Escape") close(); };
  window.addEventListener("keydown", onKeyDown);

  function addPreviewColors() {
    const geometry = viewer.skinnedMesh.geometry;
    if (geometry.getAttribute("color")) return;
    const indices = geometry.getAttribute("skinIndex"), weights = geometry.getAttribute("skinWeight");
    const names = viewer.skeleton.bones.map((bone) => bone.name);
    const palette = {
      skin: new viewer.THREE.Color("#dfb99c"), jacket: new viewer.THREE.Color("#9caec0"),
      trousers: new viewer.THREE.Color("#7f8997"), shoes: new viewer.THREE.Color("#555b66"),
    };
    const colorFor = (name) => /^(head|neck_|hand_|index_|middle_|pinky_|ring_|thumb_)/.test(name) ? palette.skin :
      /^(foot_|ball_)/.test(name) ? palette.shoes :
      /^(thigh_|calf_)/.test(name) ? palette.trousers : palette.jacket;
    const values = new Float32Array(geometry.attributes.position.count * 3);
    for (let vertex = 0; vertex < geometry.attributes.position.count; vertex++) {
      let r = 0, g = 0, b = 0, total = 0;
      for (let slot = 0; slot < 4; slot++) {
        const weight = weights.getComponent(vertex, slot);
        if (!weight) continue;
        const color = colorFor(names[indices.getComponent(vertex, slot)] || "");
        r += color.r * weight; g += color.g * weight; b += color.b * weight; total += weight;
      }
      values.set([r / (total || 1), g / (total || 1), b / (total || 1)], vertex * 3);
    }
    geometry.setAttribute("color", new viewer.THREE.BufferAttribute(values, 3));
  }

  function ensurePreviewMaterial(mesh) {
    if (poseMaterials.has(mesh)) return;
    const original = mesh.material;
    const previewMaterial = original.vertexColors ? original : original.clone();
    const guideMaterial = original.vertexColors ? original.clone() : original;
    previewMaterial.vertexColors = true;
    previewMaterial.color.set("#ffffff");
    previewMaterial.needsUpdate = true;
    guideMaterial.vertexColors = false;
    guideMaterial.color.set("#ffffff");
    guideMaterial.needsUpdate = true;
    mesh.material = previewMaterial;
    poseMaterials.set(mesh, { previewMaterial, guideMaterial });
    guideMaterials.add(guideMaterial);
  }

  function captureGuide(args, skeletonOnly = false) {
    const meshes = [viewer.skinnedMesh, ...[...viewer.passiveCharacters.values()].map((entry) => entry.mesh)];
    const current = new Set(meshes);
    for (const [mesh, pair] of poseMaterials) {
      if (current.has(mesh)) continue;
      pair.guideMaterial.dispose(); guideMaterials.delete(pair.guideMaterial); poseMaterials.delete(mesh);
    }
    const previous = meshes.map((mesh) => {
      ensurePreviewMaterial(mesh);
      const pair = poseMaterials.get(mesh);
      const material = mesh.material;
      mesh.material = pair.guideMaterial;
      const visible = pair.guideMaterial.visible;
      if (skeletonOnly) pair.guideMaterial.visible = false;
      return { mesh, material, visible };
    });
    try { return viewer.capture(...args); }
    finally {
      for (const { mesh, material, visible } of previous) {
        poseMaterials.get(mesh).guideMaterial.visible = visible;
        mesh.material = material;
      }
    }
  }

  function group(title, parent = posePane) {
    const wrapper = node("fieldset", "zce-group");
    wrapper.append(node("legend", "", title));
    parent.append(wrapper);
    return wrapper;
  }
  function slider(parent, label, key, object, min, max, step, unit = "") {
    const row = node("label", "zce-slider");
    const name = node("span", "", label);
    const output = node("output", "", `${Number(object[key]).toFixed(step < 1 ? 2 : 0)}${unit}`);
    const input = node("input");
    input.type = "range"; input.min = min; input.max = max; input.step = step; input.value = object[key];
    input.addEventListener("input", () => {
      clearPairUndo();
      object[key] = Number(input.value);
      output.textContent = `${object[key].toFixed(step < 1 ? 2 : 0)}${unit}`;
      if (object === state.person) viewer?.setActiveCharacterAppearance({ transform: state.person });
      else if (object === state.camera) { updateCamera(); syncObservationToShot(); }
      schedulePreview();
    });
    row.append(name, output, input); parent.append(row);
    return input;
  }
  posePane.prepend(node("p", "zce-tab-help", "选一个接近的动作一键应用；画布上继续调站位和角度。"));
  cameraPane.prepend(node("p", "zce-tab-help", "拖动选中人物调朝向；切换到整体机位后拖动画布调镜头。"));
  const manualButton = node("button", "zce-manual-button", "手动调关节");
  manualButton.type = "button";
  manualButton.onclick = () => {
    manualEdit = !manualEdit;
    visual.classList.toggle("zce-manual", manualEdit);
    manualButton.textContent = manualEdit ? "查看草稿画面" : "手动调关节";
    if (manualEdit) {
      viewer?.resize(stage.clientWidth, stage.clientHeight);
      syncObservationToShot();
    } else schedulePreview();
  };
  const poseControls = node("div", "zce-pose-tools");
  posePane.append(poseControls);
  const peopleRow = node("div", "zce-button-row zce-people");
  const personButtons = [node("button", "", "人物 1"), node("button", "", "人物 2")];
  const addPersonButton = node("button", "", "＋ 添加第二人");
  const removePersonButton = node("button", "", "移除第二人");
  personButtons.forEach((button, index) => { button.type = "button"; button.onclick = () => switchPerson(index); peopleRow.append(button); });
  addPersonButton.type = removePersonButton.type = "button";
  peopleRow.append(addPersonButton, removePersonButton);
  visualToolbar.append(peopleRow, manualButton);
  const poseButtons = node("div", "zce-button-row");
  for (const [label, action] of [["撤销", () => pairUndo ? undoPairPose() : viewer?.undo()],
    ["重做", () => pairRedo ? redoPairPose() : viewer?.redo()],
    ["重置姿态", () => { clearPairUndo(); viewer?.resetPose(); }]]) {
    const button = node("button", "", label); button.type = "button"; button.onclick = () => { action(); schedulePreview(); }; poseButtons.append(button);
  }
  visualToolbar.append(poseButtons);
  const poseLibrary = node("section", "zce-pose-library");
  const librarySearch = node("input", "zce-pose-search");
  librarySearch.type = "search"; librarySearch.placeholder = "搜姿态：拥抱、挥手、出拳…";
  librarySearch.setAttribute("aria-label", "搜索姿态");
  const libraryCategories = node("div", "zce-pose-categories");
  const libraryScope = node("select", "zce-pose-scope");
  libraryScope.setAttribute("aria-label", "应用范围");
  for (const [value, label] of [["all", "全部范围"], ["full", "全身"], ["upper", "上半身"],
    ["lower", "下半身"], ["pair", "双人"]]) {
    const option = node("option", "", label); option.value = value; libraryScope.append(option);
  }
  libraryScope.value = "all";
  const libraryCards = node("div", "zce-pose-cards");
  let selectedCategory = "basic";
  const scopeLabels = { full: "全身", upper: "上身", lower: "下身", pair: "双人" };
  function renderPoseLibrary() {
    const query = librarySearch.value.trim();
    libraryCategories.replaceChildren(...POSE_CATEGORIES.map((category) => {
      const button = node("button", "", category.name); button.type = "button";
      button.setAttribute("aria-pressed", String(!query && selectedCategory === category.id));
      button.onclick = () => { selectedCategory = category.id; librarySearch.value = ""; renderPoseLibrary(); };
      return button;
    }));
    const entries = findPosePresets(selectedCategory, query)
      .filter((entry) => libraryScope.value === "all" || entry.scope === libraryScope.value);
    libraryCards.replaceChildren(...(entries.length ? entries.map((entry) => {
      const button = node("button", "zce-pose-card"); button.type = "button";
      const image = node("img"); image.src = entry.thumbnail; image.alt = ""; image.loading = "lazy";
      button.append(image, node("span", "zce-pose-name", entry.name));
      button.onclick = () => entry.scope === "pair" ? applyPairPose(entry) : applyQuickPose(entry);
      return button;
    }) : [node("p", "zce-help", "没有匹配的动作，试试其他分类或关键词。")]));
  }
  librarySearch.oninput = renderPoseLibrary;
  libraryScope.onchange = renderPoseLibrary;
  const libraryToolbar = node("div", "zce-pose-toolbar");
  const searchRow = node("div", "zce-pose-search-row");
  searchRow.append(librarySearch, libraryScope);
  libraryToolbar.append(searchRow, libraryCategories);
  poseLibrary.append(libraryToolbar, libraryCards);
  posePane.insertBefore(poseLibrary, poseControls);
  renderPoseLibrary();
  if (onDetectPose) {
    const detect = node("details", "zce-detect zce-advanced");
    detect.append(node("summary", "", "从参考照片提取姿态"));
    const detectFile = node("input"); detectFile.type = "file"; detectFile.accept = "image/png,image/jpeg,image/webp";
    const method = node("select"); method.setAttribute("aria-label", "姿态识别模型");
    for (const [value, label] of [["dwpose", "DWPose 多人"], ["sdpose", "SDPose 单人"]]) {
      const option = node("option", "", label); option.value = value; method.append(option);
    }
    const detectButton = node("button", "", "识别参考照片"); detectButton.type = "button";
    const applyDetectedButton = node("button", "", "应用到人物 1"); applyDetectedButton.type = "button"; applyDetectedButton.disabled = true;
    updateDetectTarget = () => { applyDetectedButton.textContent = `应用到人物 ${activePerson + 1}`; };
    const detectedPreview = node("img"); detectedPreview.alt = "识别出的骨架预览"; detectedPreview.hidden = true;
    const bodySelect = node("select"); bodySelect.setAttribute("aria-label", "照片中识别的人物"); bodySelect.hidden = true;
    const detectNotice = node("p", "zce-help", "上传照片识别姿态，选择照片中的人，再应用到当前选中的人物；其他人物保持原样。");
    let detected = null;
    detectButton.onclick = async () => {
      if (detectButton.disabled) return;
      const file = detectFile.files?.[0];
      if (!file) { detectNotice.textContent = "请先选择参考照片。"; return; }
      detectButton.disabled = detectFile.disabled = true; applyDetectedButton.disabled = true;
      detectNotice.textContent = "正在 ComfyUI 中识别姿态…";
      try {
        const result = await onDetectPose(file, method.value);
        if (disposed) return;
        const parsed = readPoseKeypoints(result?.raw ?? result);
        const points = largestBody(parsed.people);
        const body = applicableBody(points);
        const sourceUrl = URL.createObjectURL(file);
        let source;
        try { source = await loadImage(sourceUrl); }
        finally { URL.revokeObjectURL(sourceUrl); }
        detectedPreview.src = poseOverlay(source, parsed);
        detectedPreview.hidden = false;
        const bodies = parsed.people.map((person) => ({ points: person, body: applicableBody(person) }));
        bodySelect.replaceChildren();
        bodies.forEach((_, index) => { const option = node("option", "", `照片中的人物 ${index + 1}`);
          option.value = String(index); bodySelect.append(option); });
        bodySelect.value = String(Math.max(0, parsed.people.indexOf(points)));
        bodySelect.hidden = bodies.length < 2;
        detected = { points, body, bodies };
        applyDetectedButton.disabled = false;
        if (bodies.length === 1) {
          applyDetectedPose(viewer, state.person, points, body);
          schedulePreview();
          detectNotice.textContent = `已自动应用到人物 ${activePerson + 1}；如需修改，可撤销或手动微调。`;
        } else detectNotice.textContent = "识别到多人，请选择照片中的人物，再应用到当前人物。";
      } catch (error) { detectNotice.textContent = `识别失败：${error.message}`; }
      finally { detectButton.disabled = detectFile.disabled = false; }
    };
    detectFile.onchange = () => { if (detectFile.files?.[0]) void detectButton.onclick(); };
    applyDetectedButton.onclick = () => {
      if (!detected || !viewer?.isCaptureReady()) return;
      try {
        const selected = detected.bodies?.[Number(bodySelect.value)] || detected;
        applyDetectedPose(viewer, state.person, selected.points, selected.body);
        detectNotice.textContent = `已应用到人物 ${activePerson + 1}，其他人物保持原样；可继续拖动关节修正。`;
        schedulePreview();
      } catch (error) { detectNotice.textContent = `应用失败：${error.message}`; }
    };
    detect.append(detectFile, method, detectButton, detectedPreview, bodySelect, applyDetectedButton, detectNotice);
    posePane.insertBefore(detect, poseLibrary);
  }
  const positionControls = node("details", "zce-advanced");
  positionControls.append(node("summary", "", "人物站位与大小"));
  poseControls.append(positionControls);
  slider(positionControls, "左右站位", "x", state.person, -20, 20, 0.1);
  slider(positionControls, "上下站位", "y", state.person, -20, 20, 0.1);
  slider(positionControls, "人物大小", "zoom", state.person, 0.3, 2.5, 0.01, "×");
  const groundButton = node("button", "", "脚底落地");
  groundButton.type = "button";
  groundButton.onclick = () => {
    if (!viewer?.isCaptureReady()) return;
    const mesh = viewer.skinnedMesh, vertex = new viewer.THREE.Vector3();
    mesh.updateMatrixWorld(true); mesh.skeleton?.update();
    let minY = Infinity;
    for (let index = 0; index < mesh.geometry.attributes.position.count; index += 23) {
      mesh.getVertexPosition(index, vertex).applyMatrix4(mesh.matrixWorld);
      minY = Math.min(minY, vertex.y);
    }
    if (Number.isFinite(minY)) {
      state.person.y = clamp(state.person.y - minY, -20, 20);
      viewer.setActiveCharacterAppearance({ transform: state.person });
      const positionInput = poseControls.querySelectorAll(".zce-slider")[1]?.querySelector("input");
      if (positionInput) { positionInput.value = state.person.y; positionInput.dispatchEvent(new Event("input")); }
      schedulePreview();
    }
  };
  positionControls.append(groundButton);
  const angleScope = node("div", "zce-button-row zce-angle-scope");
  const personScope = node("button", "zce-selected", "当前人物");
  const cameraScope = node("button", "", "整体机位");
  personScope.type = cameraScope.type = "button";
  angleScope.append(personScope, cameraScope); cameraPane.append(angleScope);
  const anglePersonControls = group("人物朝向", cameraPane);
  const rotationControls = new Map();
  for (const [axis, label, min, max] of [
    ["y", "水平转身", -180, 180], ["x", "前后倾斜", -60, 60], ["z", "左右侧倾", -60, 60],
  ]) {
    const row = node("label", "zce-slider");
    const output = node("output", "", "0°");
    const input = node("input");
    input.type = "range"; input.min = min; input.max = max; input.step = 1;
    input.onpointerdown = () => viewer?.recordState();
    input.oninput = () => {
      if (!viewer?.isCaptureReady()) return;
      clearPairUndo();
      const rotation = { ...viewer.modelRotation, [axis]: Number(input.value) };
      viewer.setModelRotation(rotation.x, rotation.y, rotation.z);
      output.textContent = `${input.value}°`;
      schedulePreview();
    };
    row.append(node("span", "", label), output, input);
    anglePersonControls.append(row);
    rotationControls.set(axis, { input, output });
  }
  const turnPresets = node("div", "zce-button-row zce-turn-presets");
  for (const [label, angle] of [["正面", 0], ["左 45°", -45], ["右 45°", 45], ["侧面", 90], ["背面", 180]]) {
    const button = node("button", "", label); button.type = "button";
    button.onclick = () => {
      if (!viewer?.isCaptureReady()) return;
      viewer.recordState();
      viewer.setModelRotation(viewer.modelRotation.x, angle, viewer.modelRotation.z);
      syncAnglePersonControls(); schedulePreview();
    };
    turnPresets.append(button);
  }
  anglePersonControls.append(turnPresets);
  const resetRotation = node("button", "", "恢复人物正向与直立");
  resetRotation.type = "button";
  resetRotation.onclick = () => {
    if (!viewer?.isCaptureReady()) return;
    viewer.recordState(); viewer.setModelRotation(0, 0, 0);
    syncAnglePersonControls(); schedulePreview();
  };
  anglePersonControls.append(resetRotation);
  function syncAnglePersonControls() {
    for (const [axis, { input, output }] of rotationControls) {
      const angle = Math.round(viewer?.modelRotation?.[axis] || 0);
      input.value = String(angle); output.textContent = `${angle}°`;
    }
  }
  const cameraControls = group("整体拍摄机位", cameraPane);
  function showAngleScope(scope) {
    anglePersonControls.hidden = scope !== "person";
    cameraControls.hidden = scope !== "camera";
    personScope.classList.toggle("zce-selected", scope === "person");
    cameraScope.classList.toggle("zce-selected", scope === "camera");
    if (activeTab === "angle") preview.style.cursor = "grab";
    if (activeTab === "angle" && viewer?.isCaptureReady()) setStatus(scope === "camera" ?
      "拖动画面调机位，Shift 拖动平移，滚轮调整远近" : "拖动画布让选中人物转身，Shift 拖动人物，滚轮缩放人物");
  }
  personScope.onclick = () => showAngleScope("person");
  cameraScope.onclick = () => showAngleScope("camera");
  showAngleScope("person");
  const applyCanvasSize = (width, height) => {
    state.width = Math.round(clamp(width, 256, 2048) / 32) * 32;
    state.height = Math.round(clamp(height, 256, 2048) / 32) * 32;
    preview.width = state.width; preview.height = state.height;
    previewContext = preview.getContext("2d");
    updateCamera(); schedulePreview();
  };
  if (isFrame) {
    cameraControls.append(node("div", "zce-frame-size",
      `跟随视频画幅 ${target.frameAspectRatio || `${state.width}:${state.height}`} · 高清草稿 ${state.width}×${state.height}`));
  } else {
    const ratioSelect = node("select"); ratioSelect.setAttribute("aria-label", "画面比例");
    for (const ratio of ASPECT_RATIOS) {
      const option = node("option", "", ratio); option.value = ratio; ratioSelect.append(option);
    }
    const custom = node("option", "", "自定义尺寸"); custom.value = "custom"; ratioSelect.append(custom);
    const [wide, high] = [state.width, state.height];
    ratioSelect.value = ASPECT_RATIOS.find((ratio) => {
      const [a, b] = ratio.split(":").map(Number);
      return Math.abs((wide / high) / (a / b) - 1) < .03;
    }) || "custom";
    const customSize = node("div", "zce-custom-size");
    const widthInput = node("input"), heightInput = node("input");
    for (const [input, value, label] of [[widthInput, wide, "宽度"], [heightInput, high, "高度"]]) {
      input.type = "number"; input.min = 256; input.max = 2048; input.step = 32;
      input.value = value; input.setAttribute("aria-label", label);
    }
    const applySize = node("button", "", "应用尺寸"); applySize.type = "button";
    applySize.onclick = () => { applyCanvasSize(widthInput.value, heightInput.value); widthInput.value = state.width; heightInput.value = state.height; };
    customSize.append(widthInput, node("span", "", "×"), heightInput, applySize);
    customSize.hidden = ratioSelect.value !== "custom";
    ratioSelect.onchange = () => {
      customSize.hidden = ratioSelect.value !== "custom";
      if (ratioSelect.value === "custom") return;
      applyCanvasSize(...canvasSizeFor(ratioSelect.value, 1.5));
      widthInput.value = state.width; heightInput.value = state.height;
    };
    const ratioRow = node("div", "zce-ratio-row");
    ratioRow.append(node("span", "", "画幅"), ratioSelect, customSize);
    cameraControls.append(ratioRow);
  }
  const cameraSliders = new Map();
  const framingAdvanced = node("details", "zce-advanced");
  framingAdvanced.append(node("summary", "", "画面平移（高级）"));
  for (const [label, key, min, max, step, unit] of [
    ["左右角度", "yaw", -180, 180, 1, "°"], ["俯仰角度", "pitch", -60, 60, 1, "°"],
    ["画面远近", "zoom", 0.2, 4, 0.01, "×"], ["画面左右", "offsetX", -20, 20, 0.1, ""],
    ["画面上下", "offsetY", -20, 20, 0.1, ""],
  ]) cameraSliders.set(key, slider(["offsetX", "offsetY"].includes(key) ? framingAdvanced : cameraControls,
    label, key, state.camera, min, max, step, unit));
  cameraControls.append(framingAdvanced);
  function syncCameraControls() {
    cameraSliders.forEach((input, key) => {
      input.value = state.camera[key];
      const digits = Number(input.step) < 1 ? 2 : 0;
      input.parentElement.querySelector("output").textContent =
        `${Number(input.value).toFixed(digits)}${key === "yaw" || key === "pitch" ? "°" : key === "zoom" ? "×" : ""}`;
    });
    updateCamera(); schedulePreview();
  }
  function syncObservationToShot() {
    if (!viewer?.isCaptureReady()) return;
    viewer.snapToCaptureCamera(stage.clientWidth || canvas.width, stage.clientHeight || canvas.height,
      state.camera.zoom, state.camera.offsetX, state.camera.offsetY, state.camera.yaw, -state.camera.pitch);
  }
  const backgroundControls = node("div", "zce-background");
  sceneBar.append(backgroundControls);
  const bgSelect = node("select");
  bgSelect.setAttribute("aria-label", "选择场景背景");
  const empty = node("option", "", "白色背景"); empty.value = ""; bgSelect.append(empty);
  for (const asset of backgroundAssets) {
    const option = node("option", "", asset.name || asset.label || "场景图片");
    option.value = asset.url || asset.src || asset.image_path || "";
    bgSelect.append(option);
  }
  if (state.background.src && ![...bgSelect.options].some((option) => option.value === state.background.src)) {
    const restored = node("option", "", "已保存的背景图"); restored.value = state.background.src; bgSelect.append(restored);
  }
  bgSelect.value = state.background.src || "";
  const upload = node("input");
  upload.type = "file"; upload.accept = "image/png,image/jpeg,image/webp";
  upload.hidden = true;
  const uploadButton = node("button", "", "上传背景");
  uploadButton.type = "button"; uploadButton.onclick = () => upload.click();
  backgroundControls.append(bgSelect, uploadButton, upload);
  stickerPane.append(node("p", "zce-tab-help", stickerOnly && target.assetType === "scene" ?
    "场景底图已放好；可直接打磨，或添加透明人物、道具再调整位置。" :
    "把透明底人物或道具放到画面中，拖动、缩放或旋转整张贴图。"));
  const stickerControls = group("透明贴图", stickerPane);
  const stickerSource = node("select"); stickerSource.setAttribute("aria-label", "选择已有贴图");
  const stickerPlaceholder = node("option", "", "选择已有透明素材"); stickerPlaceholder.value = "";
  stickerSource.append(stickerPlaceholder);
  for (const asset of characterAssets) {
    const option = node("option", "", asset.name || "人物素材"); option.value = asset.url || asset.src || "";
    option.dataset.path = asset.image_path || ""; stickerSource.append(option);
  }
  const addStickerButton = node("button", "", "添加素材"); addStickerButton.type = "button";
  const stickerUpload = node("input"); stickerUpload.type = "file"; stickerUpload.accept = "image/png,image/webp";
  const stickerList = node("select"); stickerList.setAttribute("aria-label", "贴图图层");
  const removeStickerButton = node("button", "", "删除选中贴图"); removeStickerButton.type = "button";
  const stickerEditControls = node("div", "zce-sticker-edit");
  const stickerSliders = new Map();
  for (const [key, label, min, max, step, unit] of [["scale", "大小", .1, 4, .01, "×"], ["rotation", "旋转", -180, 180, 1, "°"]]) {
    const row = node("label", "zce-slider");
    const output = node("output", "", "");
    const input = node("input"); input.type = "range"; input.min = min; input.max = max; input.step = step;
    input.oninput = () => {
      const sticker = state.stickers[selectedSticker];
      if (!sticker) return;
      sticker[key] = Number(input.value); output.textContent = `${sticker[key]}${unit}`; schedulePreview();
    };
    row.append(node("span", "", label), output, input); stickerEditControls.append(row);
    stickerSliders.set(key, { input, output, unit });
  }
  function refreshStickerControls() {
    stickerList.replaceChildren();
    state.stickers.forEach((item, index) => {
      const option = node("option", "", item.name || `贴图 ${index + 1}`); option.value = String(index); stickerList.append(option);
    });
    stickerList.value = selectedSticker >= 0 ? String(selectedSticker) : "";
    stickerEditControls.hidden = selectedSticker < 0;
    removeStickerButton.disabled = selectedSticker < 0;
    for (const [key, { input, output, unit }] of stickerSliders) {
      input.disabled = selectedSticker < 0;
      input.value = state.stickers[selectedSticker]?.[key] ?? (key === "scale" ? 1 : 0);
      output.textContent = `${input.value}${unit}`;
    }
  }
  async function addSticker(src, name, imagePath = "", file = null) {
    const loaded = await loadImage(src);
    const check = document.createElement("canvas"); check.width = check.height = 64;
    const context = check.getContext("2d", { willReadFrequently: true });
    context.drawImage(loaded, 0, 0, 64, 64);
    if (![...context.getImageData(0, 0, 64, 64).data].some((value, index) => index % 4 === 3 && value < 250)) {
      throw new Error("请选择已抠图的透明 PNG/WebP；普通照片请作为背景使用");
    }
    const sticker = { id: `${Date.now()}-${Math.random()}`, name, src, image_path: imagePath,
      x: 0, y: 0, scale: 1, rotation: 0 };
    state.stickers.push(sticker); stickerImages.set(src, loaded);
    if (file) stickerBlobs.set(sticker.id, file);
    selectedSticker = state.stickers.length - 1;
    refreshStickerControls(); refreshPrompt(); schedulePreview();
  }
  addStickerButton.onclick = async () => {
    const option = stickerSource.selectedOptions[0];
    if (!option?.value) { setStatus("先选择一个已有透明素材，或上传 PNG/WebP"); return; }
    try { await addSticker(option.value, option.textContent, option.dataset.path || ""); }
    catch (error) { setStatus(error.message); }
  };
  stickerUpload.onchange = async () => {
    const file = stickerUpload.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try { await addSticker(String(reader.result), file.name, "", file); }
      catch (error) { setStatus(error.message); }
    };
    reader.readAsDataURL(file);
  };
  stickerList.onchange = () => { selectedSticker = Number(stickerList.value); refreshStickerControls(); schedulePreview(); };
  removeStickerButton.onclick = () => {
    if (selectedSticker < 0) return;
    stickerBlobs.delete(state.stickers[selectedSticker].id);
    state.stickers.splice(selectedSticker, 1);
    selectedSticker = state.stickers.length ? Math.min(selectedSticker, state.stickers.length - 1) : -1;
    refreshStickerControls(); refreshPrompt(); schedulePreview();
  };
  stickerEditControls.prepend(stickerList, removeStickerButton);
  stickerControls.prepend(stickerSource, addStickerButton, stickerUpload);
  stickerControls.append(stickerEditControls);
  refreshStickerControls();

  const textControls = node("details", "zce-prompt");
  textControls.append(node("summary", "", "生成设置 · 提示词"));
  controls.append(textControls);
  promptInput = node("textarea");
  promptInput.placeholder = "生成时交给 Qwen 的完整提示词，可直接修改";
  promptInput.oninput = () => { state.promptOverrides[activeTab] = promptInput.value; };
  const resetPrompt = node("button", "", "恢复当前模式默认提示词"); resetPrompt.type = "button";
  resetPrompt.onclick = () => { delete state.promptOverrides[activeTab]; refreshPrompt(); };
  textControls.append(promptInput, resetPrompt);
  function refreshPrompt() {
    if (!promptInput) return;
    promptInput.value = state.promptOverrides[activeTab] ?? draftPrompt({
      mode: activeTab, guideStyle: state.export_style, hasBackground: !!state.background.src,
      peopleCount: state.people ? 2 : 1, referenceCount: 0, stickerCount: state.stickers.length,
      detail: state.extra_prompt || "",
    });
  }
  switchTab(state.draft_mode);

  const shotArgs = () => [state.width, state.height, state.camera.zoom, state.camera.offsetX,
    state.camera.offsetY, state.camera.yaw, -state.camera.pitch];
  const currentPose = () => {
    const { camera, cameraParams, ...pose } = viewer.getPose();
    return pose;
  };
  function snapshotPerson() {
    return { mesh: { ...state.mesh }, pose: currentPose(), transform: { ...state.person } };
  }
  function snapshotScene() {
    return { activePerson, people: state.people?.map((person, index) =>
      index === activePerson ? snapshotPerson() : structuredClone(person)) || null,
    single: state.people ? null : snapshotPerson() };
  }
  function restoreScene(snapshot) {
    applyingPair = true;
    try {
      viewer.clearPassiveCharacters();
      activePerson = snapshot.activePerson;
      state.people = snapshot.people?.map((person) => structuredClone(person)) || null;
      const current = state.people?.[activePerson] || snapshot.single;
      Object.assign(state.person, current.transform);
      state.mesh = { ...current.mesh };
      viewer.setPose(current.pose, true);
      viewer.setActiveCharacterAppearance({ color: "#ffffff", transform: state.person });
      if (state.people) {
        const other = 1 - activePerson;
        viewer.upsertPassiveCharacterFromActive(`person-${other}`, {
          pose: state.people[other].pose, transform: state.people[other].transform, color: "#ffffff",
        });
      }
      syncPersonControls(); refreshPrompt(); schedulePreview();
    } finally { applyingPair = false; }
  }
  function undoPairPose() {
    if (!pairUndo) return;
    const snapshot = pairUndo;
    pairRedo = snapshotScene(); pairUndo = null;
    restoreScene(snapshot);
    setStatus("已撤销双人姿态");
  }
  function redoPairPose() {
    if (!pairRedo) return;
    const snapshot = pairRedo;
    pairUndo = snapshotScene(); pairRedo = null;
    restoreScene(snapshot);
    setStatus("已重做双人姿态");
  }
  function syncPersonControls() {
    const rows = [...poseControls.querySelectorAll(".zce-slider")];
    for (const [index, key] of ["x", "y", "zoom"].entries()) {
      const input = rows[index]?.querySelector("input"), output = rows[index]?.querySelector("output");
      if (input) input.value = state.person[key];
      if (output) output.textContent = `${Number(state.person[key]).toFixed(2)}${key === "zoom" ? "×" : ""}`;
    }
    personButtons[0].classList.toggle("zce-selected", activePerson === 0);
    personButtons[1].classList.toggle("zce-selected", activePerson === 1);
    personButtons[1].hidden = !state.people;
    addPersonButton.hidden = !!state.people;
    removePersonButton.hidden = !state.people;
    syncAnglePersonControls(); updateDetectTarget();
  }
  function leftToRightPeople(people) {
    updateCamera();
    const THREE = viewer.THREE;
    return people.map((person, index) => ({ index, x: new THREE.Vector3(person.transform.x,
      person.transform.y, person.transform.z).project(viewer.captureCamera).x }))
      .sort((a, b) => a.x - b.x);
  }
  function switchPerson(index) {
    if (!viewer?.isCaptureReady() || !state.people || index === activePerson || !state.people[index]) return;
    state.people[activePerson] = snapshotPerson();
    viewer.upsertPassiveCharacterFromActive(`person-${activePerson}`, { pose: state.people[activePerson].pose,
      transform: state.people[activePerson].transform, color: "#ffffff" });
    viewer.removePassiveCharacter(`person-${index}`);
    activePerson = index;
    const next = state.people[index];
    Object.assign(state.person, next.transform);
    state.mesh = { ...next.mesh };
    viewer.setPose(next.pose || { bones: {} }, true);
    viewer.setActiveCharacterAppearance({ color: "#ffffff", transform: state.person });
    viewer.history = []; viewer.future = [];
    syncPersonControls(); refreshPrompt(); schedulePreview();
  }
  addPersonButton.onclick = () => {
    if (!viewer?.isCaptureReady() || state.people) return;
    clearPairUndo();
    const first = snapshotPerson();
    first.transform.x -= 4.4 * first.transform.zoom;
    state.people = [first, { mesh: { ...DEFAULT_MESH }, pose: { bones: {} },
      transform: { ...first.transform, x: first.transform.x + 8.8 * first.transform.zoom } }];
    Object.assign(state.person, first.transform);
    viewer.setActiveCharacterAppearance({ transform: state.person });
    viewer.upsertPassiveCharacterFromActive("person-1", { pose: state.people[1].pose,
      transform: state.people[1].transform, color: "#ffffff" });
    syncPersonControls(); refreshPrompt(); schedulePreview();
  };
  removePersonButton.onclick = () => {
    if (!viewer?.isCaptureReady() || !state.people) return;
    clearPairUndo();
    if (activePerson !== 0) switchPerson(0);
    state.people = null;
    viewer.clearPassiveCharacters(); syncPersonControls(); schedulePreview();
  };
  function applyQuickPose(entry) {
    if (!viewer?.isCaptureReady()) return;
    try {
      clearPairUndo();
      const preset = poseSpec(entry.poseId);
      if (!preset) throw new Error("姿态数据不存在");
      applyCommonPose(viewer, state.person, preset, entry.scope, entry.rotation || null);
      if (entry.id === "lie") {
        updateCamera();
        viewer.skinnedMesh.updateMatrixWorld(true);
        const center = viewer.meshCenter.clone().applyMatrix4(viewer.skinnedMesh.matrixWorld)
          .project(viewer.captureCamera);
        const visibleHeight = 2 * 45 * Math.tan(Math.PI / 12) / state.camera.zoom;
        state.person.y = clamp(state.person.y + (-0.4 - center.y) * visibleHeight / 2, -20, 20);
        viewer.setActiveCharacterAppearance({ transform: state.person });
        syncPersonControls();
      }
      syncAnglePersonControls();
      setStatus(`人物 ${activePerson + 1} 已应用「${entry.name}」· ${scopeLabels[entry.scope]}`);
      schedulePreview();
    } catch (error) { setStatus(`快捷姿态失败：${error.message}`); }
  }
  function applyPairPose(entry) {
    if (!viewer?.isCaptureReady()) return;
    const previous = snapshotScene();
    applyingPair = true;
    try {
      const selected = activePerson;
      const centerX = state.people ? (state.people[0].transform.x + state.people[1].transform.x) / 2 : state.person.x;
      const centerZ = state.people ? (state.people[0].transform.z + state.people[1].transform.z) / 2 : state.person.z;
      const zoom = state.person.zoom;
      if (!state.people) addPersonButton.onclick();
      for (const [index, person] of entry.people.entries()) {
        if (activePerson !== index) switchPerson(index);
        const preset = poseSpec(person.poseId);
        if (!preset) throw new Error(`双人姿态数据不存在：${person.poseId}`);
        applyCommonPose(viewer, state.person, preset, "full", [0, person.turn || 0, 0]);
        state.person.x = clamp(centerX + person.x * zoom, -20, 20);
        state.person.z = clamp(centerZ + (person.z || 0) * zoom, -20, 20);
        viewer.setActiveCharacterAppearance({ transform: state.person });
        state.people[index] = snapshotPerson();
      }
      if (activePerson !== selected) switchPerson(selected);
      syncPersonControls(); refreshPrompt(); schedulePreview();
      pairUndo = previous; pairRedo = null;
      setStatus(`已应用双人「${entry.name}」；可继续分别调整两人站位与朝向`);
    } catch (error) {
      restoreScene(previous);
      setStatus(`双人姿态失败：${error.message}`);
    } finally { applyingPair = false; }
  }
  function updateCamera() { viewer?.updateCaptureCamera(...shotArgs()); }
  function schedulePreview() {
    if (!viewer?.isCaptureReady() || disposed) return;
    ++previewRevision;
    // Coalesce pointer moves without postponing every frame until the drag stops.
    if (refreshTimer || renderingPreview) return;
    refreshTimer = setTimeout(async () => {
      refreshTimer = 0; renderingPreview = true;
      const revision = previewRevision;
      try { await renderPreview(true, revision, !!dragging); }
      finally {
        renderingPreview = false;
        if (!disposed && previewRevision !== revision) schedulePreview();
      }
    }, dragging ? 32 : 0);
  }
  async function renderPreview(includeSelection = true, revision = ++previewRevision, fast = false, forExport = false) {
    if (disposed || !viewer?.isCaptureReady()) return false;
    try {
      if (activeTab === "sticker") {
        hitMask = null;
        const layers = [];
        for (const sticker of state.stickers) {
          const loaded = stickerImages.get(sticker.src) || await loadImage(sticker.src);
          stickerImages.set(sticker.src, loaded);
          if (disposed || revision !== previewRevision) return false;
          layers.push(loaded);
        }
        drawBackground(previewContext, image, state.width, state.height);
        for (const [index, sticker] of state.stickers.entries()) {
          const loaded = layers[index];
          drawSticker(previewContext, sticker, loaded, state.width, state.height,
            includeSelection && index === selectedSticker);
        }
        return true;
      }
      const scale = fast ? Math.min(1, 512 / Math.max(state.width, state.height)) : 1;
      const captureWidth = Math.round(state.width * scale), captureHeight = Math.round(state.height * scale);
      // Preview style and model input style are independent.
      const guideStyle = forExport ? state.export_style : state.guide_style;
      const coloredPreview = !forExport && guideStyle === "mannequin_skeleton";
      const captureArgs = [captureWidth, captureHeight, state.camera.zoom, GREEN,
        state.camera.offsetX, state.camera.offsetY, state.camera.yaw, -state.camera.pitch,
        !coloredPreview && !fast && guideStyle !== "mannequin"];
      const shot = coloredPreview
        ? viewer.capture(...captureArgs)
        : captureGuide(captureArgs, guideStyle === "skeleton");
      if (!shot) return false;
      const person = await loadImage(shot);
      if (disposed || revision !== previewRevision) return false;
      drawBackground(previewContext, image, state.width, state.height);
      // The green capture backdrop turns either skeleton lines or white surfaces into an overlay.
      const layer = document.createElement("canvas");
      layer.width = captureWidth; layer.height = captureHeight;
      const layerCtx = layer.getContext("2d", { willReadFrequently: true });
      layerCtx.drawImage(person, 0, 0);
      const pixels = layerCtx.getImageData(0, 0, layer.width, layer.height);
      const mask = new Uint8Array(captureWidth * captureHeight);
      for (let index = 0; index < pixels.data.length; index += 4) {
        const greenExcess = pixels.data[index + 1] - Math.max(pixels.data[index], pixels.data[index + 2]);
        const alpha = 255 - clamp((greenExcess - 35) * 255 / 140, 0, 255);
        pixels.data[index + 3] = alpha;
        mask[index / 4] = alpha;
      }
      hitMask = mask; hitMaskWidth = captureWidth; hitMaskHeight = captureHeight;
      layerCtx.putImageData(pixels, 0, 0);
      previewContext.drawImage(layer, 0, 0, state.width, state.height);
      if ((forExport || guideStyle === "skeleton") && guideStyle !== "mannequin") {
        drawPoseGuide(previewContext, viewer, state.width, state.height);
      }
      updateCamera();
      return true;
    } catch (error) { if (revision === previewRevision) setStatus(error.message); return false; }
  }
  async function setBackground(src, blob = null, imagePath = "") {
    const revision = ++backgroundRevision;
    try {
      const loaded = src ? await loadImage(src) : null;
      if (disposed || revision !== backgroundRevision) return;
      if (loaded && stickerOnly && target.assetType === "scene" && !saved.width && !saved.height) {
        const ratio = loaded.width / loaded.height;
        state.width = ratio >= 1 ? 1024 : Math.max(256, Math.round(1024 * ratio / 32) * 32);
        state.height = ratio >= 1 ? Math.max(256, Math.round(1024 / ratio / 32) * 32) : 1024;
        preview.width = state.width; preview.height = state.height;
        previewContext = preview.getContext("2d");
      }
      image = loaded;
      state.background.src = src;
      state.background.image_path = src ? imagePath : "";
      backgroundBlob = blob;
      if (src && ![...bgSelect.options].some((option) => option.value === src)) {
        const custom = node("option", "", blob ? "上传的背景图" : "已保存的背景图");
        custom.value = src; bgSelect.append(custom);
      }
      bgSelect.value = src;
      refreshPrompt(); schedulePreview();
    } catch (error) { if (revision === backgroundRevision) setStatus(error.message); }
  }
  bgSelect.onchange = () => {
    const selected = backgroundAssets.find((asset) => (asset.url || asset.src || asset.image_path) === bgSelect.value);
    void setBackground(bgSelect.value, null, selected?.image_path || "");
  };
  upload.onchange = async () => {
    const file = upload.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setBackground(String(reader.result), file);
    reader.readAsDataURL(file);
  };
  let dragging = null;
  canvas.addEventListener("pointerdown", clearPairUndo, { capture: true });
  canvas.addEventListener("pointerdown", (event) => {
    if (!manualEdit || activeTab !== "pose" || !event.shiftKey || event.button !== 0 || !viewer?.isCaptureReady()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    viewer.recordState();
    const camera = viewer.camera;
    const distance = camera.position.distanceTo(viewer.orbit.target);
    const perPixel = 2 * distance * Math.tan(viewer.THREE.MathUtils.degToRad(camera.fov) / 2) /
      (canvas.clientHeight * camera.zoom);
    const right = new viewer.THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new viewer.THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const start = { x: event.clientX, y: event.clientY, person: { ...state.person } };
    const move = (next) => {
      const delta = right.clone().multiplyScalar((next.clientX - start.x) * perPixel)
        .add(up.clone().multiplyScalar(-(next.clientY - start.y) * perPixel));
      state.person.x = clamp(start.person.x + delta.x, -20, 20);
      state.person.y = clamp(start.person.y + delta.y, -20, 20);
      viewer.setActiveCharacterAppearance({ transform: state.person });
      syncPersonControls(); schedulePreview();
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      schedulePreview();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }, { capture: true });
  preview.addEventListener("pointerdown", (event) => {
    clearPairUndo();
    if (activeTab === "angle") {
      if (!viewer?.isCaptureReady()) return;
      if (cameraControls.hidden) {
        viewer?.recordState();
        dragging = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
          originX: state.person.x, originY: state.person.y,
          rotationX: viewer?.modelRotation.x || 0, rotationY: viewer?.modelRotation.y || 0,
          target: event.shiftKey ? state.person : "person-rotation" };
      } else dragging = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
        originX: state.camera.offsetX, originY: state.camera.offsetY,
        yaw: state.camera.yaw, pitch: state.camera.pitch,
        pan: event.shiftKey || event.button === 2, target: state.camera };
      preview.setPointerCapture(event.pointerId);
      preview.style.cursor = "grabbing";
      return;
    }
    const rect = preview.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - .5;
    const y = (event.clientY - rect.top) / rect.height - .5;
    if (activeTab === "sticker") {
      const px = (x + .5) * state.width, py = (y + .5) * state.height;
      const hit = state.stickers.findLastIndex((sticker) => {
        const loaded = stickerImages.get(sticker.src);
        if (!loaded) return false;
        const { x: sx, y: sy, w, h } = stickerRect(sticker, loaded, state.width, state.height);
        const angle = -sticker.rotation * Math.PI / 180;
        const dx = px - sx, dy = py - sy;
        return Math.abs(dx * Math.cos(angle) - dy * Math.sin(angle)) <= w / 2 &&
          Math.abs(dx * Math.sin(angle) + dy * Math.cos(angle)) <= h / 2;
      });
      selectedSticker = hit;
      refreshStickerControls();
      if (hit < 0) { schedulePreview(); return; }
      const target = state.stickers[hit];
      dragging = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
        originX: target.x, originY: target.y, target };
      preview.setPointerCapture(event.pointerId);
      schedulePreview();
      return;
    }
    const pixelX = clamp(Math.floor((x + .5) * hitMaskWidth), 0, hitMaskWidth - 1);
    const pixelY = clamp(Math.floor((y + .5) * hitMaskHeight), 0, hitMaskHeight - 1);
    const personHit = (hitMask?.[pixelY * hitMaskWidth + pixelX] || 0) > 100;
    if (personHit && state.people) {
      const ordered = leftToRightPeople(state.people.map((person, index) => index === activePerson ?
        { ...person, transform: state.person } : person));
      const nearest = ordered.reduce((best, item) => Math.abs(item.x - x * 2) < Math.abs(best.x - x * 2) ? item : best);
      if (nearest.index !== activePerson) switchPerson(nearest.index);
    }
    if (!personHit) return;
    const target = state.person;
    dragging = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: target.x, originY: target.y, target };
    preview.setPointerCapture(event.pointerId);
    schedulePreview();
  });
  preview.addEventListener("pointermove", (event) => {
    if (activeTab === "angle" && !dragging) return;
    if (dragging && event.pointerId !== dragging.pointerId) return;
    if (dragging?.target === state.camera) {
      const dx = event.clientX - dragging.x, dy = event.clientY - dragging.y;
      if (dragging.pan) {
        const rect = preview.getBoundingClientRect();
        const visibleHeight = 2 * 45 * Math.tan(Math.PI / 12) / state.camera.zoom;
        const visibleWidth = visibleHeight * state.width / state.height;
        state.camera.offsetX = clamp(dragging.originX - dx * visibleWidth / rect.width, -20, 20);
        state.camera.offsetY = clamp(dragging.originY + dy * visibleHeight / rect.height, -20, 20);
      } else {
        state.camera.yaw = clamp(dragging.yaw + dx * .45, -180, 180);
        state.camera.pitch = clamp(dragging.pitch + dy * .35, -60, 60);
      }
      syncCameraControls();
      return;
    }
    if (dragging?.target === "person-rotation") {
      const dx = event.clientX - dragging.x, dy = event.clientY - dragging.y;
      viewer.setModelRotation(clamp(dragging.rotationX + dy * .35, -60, 60),
        clamp(dragging.rotationY + dx * .45, -180, 180), viewer.modelRotation.z);
      syncAnglePersonControls(); schedulePreview();
      return;
    }
    if (!dragging) return;
    const rect = preview.getBoundingClientRect();
    const localX = event.clientX - dragging.x, localY = event.clientY - dragging.y;
    if (dragging.target === state.person) {
      const visibleHeight = 2 * 45 * Math.tan(Math.PI / 12) / state.camera.zoom;
      const visibleWidth = visibleHeight * state.width / state.height;
      state.person.x = clamp(dragging.originX + localX * visibleWidth / rect.width, -20, 20);
      state.person.y = clamp(dragging.originY - localY * visibleHeight / rect.height, -20, 20);
      viewer.setActiveCharacterAppearance({ transform: state.person });
      poseControls.querySelectorAll(".zce-slider").forEach((row, index) => {
        if (index > 1) return;
        const input = row.querySelector("input"); input.value = index ? state.person.y : state.person.x;
        row.querySelector("output").textContent = Number(input.value).toFixed(2);
      });
    } else if (activeTab === "sticker") {
      dragging.target.x = clamp(dragging.originX + localX / rect.width, -1, 1);
      dragging.target.y = clamp(dragging.originY + localY / rect.height, -1, 1);
    }
    schedulePreview();
  });
  const endPreviewDrag = (event) => {
    if (event.pointerId !== dragging?.pointerId) return;
    dragging = null; preview.style.cursor = activeTab === "angle" ? "grab" : "move";
    schedulePreview();
  };
  preview.addEventListener("pointerup", endPreviewDrag);
  preview.addEventListener("pointercancel", endPreviewDrag);
  preview.addEventListener("contextmenu", (event) => { if (activeTab === "angle") event.preventDefault(); });
  preview.addEventListener("wheel", (event) => {
    event.preventDefault();
    if (!viewer?.isCaptureReady()) return;
    clearPairUndo();
    const factor = Math.exp(-event.deltaY * .001);
    if (activeTab === "sticker") {
      const sticker = state.stickers[selectedSticker];
      if (sticker) { sticker.scale = clamp(sticker.scale * factor, .1, 4); refreshStickerControls(); }
      schedulePreview();
    } else if ((activeTab === "angle" && !cameraControls.hidden) || activeTab === "pose") {
      state.camera.zoom = clamp(state.camera.zoom * factor, .2, 4);
      syncCameraControls();
    } else {
      state.person.zoom = clamp(state.person.zoom * factor, .3, 2.5);
      viewer.setActiveCharacterAppearance({ transform: state.person });
      syncPersonControls(); schedulePreview();
    }
  }, { passive: false });
  const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
    if (!disposed && viewer) viewer.resize(stage.clientWidth, stage.clientHeight);
  });
  resizeObserver?.observe(stage);

  async function collect() {
    if (!viewer?.isCaptureReady()) throw new Error("人体模型尚未就绪");
    await viewer.waitForCaptureReady();
    const pose = viewer.getPose();
    const { camera, cameraParams, ...bones } = pose;
    state.pose = bones;
    if (state.people) state.people[activePerson] = snapshotPerson();
    const poseReference = captureGuide([state.width, state.height, 1, WHITE, 0, 0, 0, 0, true]);
    const people = state.people?.map((person) => ({ mesh: person.mesh, pose: person.pose,
      transform: person.transform, proportions: {}, grips: { l: 0, r: 0 } }));
    const poseDocument = { version: 2, kind: "vnccs-free-pose", mesh: people?.[0]?.mesh || state.mesh,
      pose: people?.[0]?.pose || bones, transform: people?.[0]?.transform || state.person,
      people, width: state.width, height: state.height,
      framing: { zoom: state.camera.zoom, offsetX: state.camera.offsetX, offsetY: state.camera.offsetY },
      shotCamera: { ...state.camera }, camera: { yaw: 0, pitch: 0 }, outputSkeleton: true };
    const poseJson = JSON.stringify(poseDocument);
    clearTimeout(refreshTimer);
    if (!await renderPreview(false, ++previewRevision, false, true)) throw new Error("构图在变化，请停止拖动后再应用");
    if (activeTab === "sticker" && !state.stickers.length && !state.background.src) {
      throw new Error("请先添加人物、道具贴图或选择底图");
    }
    const prompt = promptInput.value.trim();
    if (!prompt) throw new Error("请填写生成提示词");
    const composition_draft = { ...state, pose_json: poseJson, prompt,
      background: { ...state.background } };
    const compositionBlob = await new Promise((resolve) => preview.toBlob(resolve, "image/png"));
    if (!compositionBlob) throw new Error("构图图导出失败");
    schedulePreview();
    return { composition_draft, poseJson, prompt, poseBlob: await dataUrlBlob(poseReference),
      compositionBlob, backgroundBlob,
      stickerFiles: state.stickers.map((sticker) => stickerBlobs.get(sticker.id) || null) };
  }
  async function apply(callback, closeAfterSuccess = false) {
    if (busy) return;
    busy = true; saveButton.disabled = generateButton.disabled = true;
    try { setStatus("保存构图中…"); await callback?.(await collect()); setStatus("构图已应用"); if (closeAfterSuccess) close(); }
    catch (error) { setStatus(`构图失败：${error.message}`); }
    finally { busy = false; saveButton.disabled = generateButton.disabled = false; }
  }
  saveButton.onclick = () => apply(onApply);
  generateButton.onclick = () => apply(onGenerate || onApply, true);

  (async () => {
    viewer = new PoseViewerCore(canvas, { skinMode: "flat_color", enableTextureSkinning: false,
      showSkeletonHelper: true, showCaptureFrame: true, syncMode: "end",
      onPoseChange: () => { clearPairUndo(); schedulePreview(); } });
    await viewer.init();
    if (disposed) return;
    if (!viewer.initialized) throw new Error("WebGL 初始化失败");
    viewer.setDirectionalSkydomeVisible(false);
    packPromise ||= loadMorphPack(PACK_URL);
    const pack = await packPromise;
    if (disposed) return;
    const morph = solveMorph(pack, state.mesh);
    viewer.loadData(modelData(morph, buildStaticModelData(pack, morph.includeGenitals)), true);
    addPreviewColors();
    ensurePreviewMaterial(viewer.skinnedMesh);
    viewer.updateLights([{ type: "ambient", color: "#ffffff", intensity: 1 }]);
    if (state.pose) viewer.setPose(state.pose, true);
    viewer.setActiveCharacterAppearance({ color: "#ffffff", transform: state.person });
    if (state.people?.[1]) viewer.upsertPassiveCharacterFromActive("person-1", {
      pose: state.people[1].pose || { bones: {} }, transform: state.people[1].transform, color: "#ffffff" });
    syncPersonControls();
    viewer.resize(stage.clientWidth, stage.clientHeight);
    // Give the observation view its own full-body framing. Capture framing stays in state.camera.
    const viewWidth = stage.clientWidth || canvas.width, viewHeight = stage.clientHeight || canvas.height;
    const fitZoom = viewer.computeModelFitZoom(viewWidth, viewHeight, 0, 0, state.camera.yaw, -state.camera.pitch, 0.14);
    viewer.snapToCaptureCamera(viewWidth, viewHeight, Math.min(2, fitZoom || 1.5),
      0, 0, state.camera.yaw, -state.camera.pitch);
    updateCamera();
    if (state.background.src) await setBackground(state.background.src, null, state.background.image_path || "");
    await viewer.waitForCaptureReady();
    saveButton.disabled = generateButton.disabled = false;
    setStatus(activeTab === "sticker" ?
      state.stickers.length ? "拖动贴图摆放画面" : "可添加透明素材，也可直接打磨当前场景" :
      activeTab === "angle" ? "拖动画布调整机位" : "选择姿态卡片或从照片提取动作，一键套用后可继续调站位");
    schedulePreview();
  })().catch((error) => { if (!disposed) setStatus(`加载失败：${error.message}`); });
  return { close, getState: () => state };
}
