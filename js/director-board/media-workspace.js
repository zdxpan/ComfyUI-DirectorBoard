import {
  REQUIRED, ROLE_NAME, TASK_SLOTS, bindingForSlot, officialSlots, uid,
} from "./model.js";
import { openAssetGenerator } from "./asset-index.js";
import { addCreativeAsset } from "./agent/workspace.js";
import { readAssistant, writeAssistant } from "./agent/storage.js";
import { handoffCreativeAsset } from "./agent/director-handoff.js";
import { button, el, inputViewUrl, outputViewUrl } from "./ui.js";
import {
  createAudioPreview, createVideoPreview, openTrimEditor,
} from "./video-workspace.js";

const KIND_LABEL = { image: "图片", video: "视频", audio: "音频" };
const FILM_PLAYER_KEY = "__film__";
export function mediaUploadKey(owner, kind, target = {}) {
  return `${owner || "global"}:${kind}:${target.role || "asset"}:${target.order ?? 0}`;
}

function resultIdentity(result) {
  return [result?.promptId || "", result?.type || "output", result?.subfolder || "", result?.filename || ""].join(":");
}

function disposeResultVideo(entry) {
  entry?.video?.pause?.();
  entry?.video?.removeAttribute?.("src");
  entry?.video?.load?.();
}

export function pauseResultVideos(board, exceptKey = null) {
  for (const [key, entry] of board.resultVideoByShot || []) {
    if (key !== exceptKey) entry.video?.pause?.();
  }
}

export function releaseResultVideos(board, keys = null) {
  const cache = board.resultVideoByShot;
  if (!cache) return;
  const targets = keys == null ? [...cache.keys()] : [...keys];
  for (const key of targets) {
    disposeResultVideo(cache.get(key));
    cache.delete(key);
  }
}

function resultVideo(board, key, result, preload) {
  board.resultVideoByShot ||= new Map();
  const identity = resultIdentity(result), previous = board.resultVideoByShot.get(key);
  if (previous?.identity === identity) {
    previous.video.setAttribute("preload", preload);
    return previous.video;
  }
  if (previous) disposeResultVideo(previous);
  const video = el("video", {
    class: "zdb-result-video", src: outputViewUrl(result), controls: true, preload,
  });
  video.addEventListener("play", () => pauseResultVideos(board, key));
  board.resultVideoByShot.set(key, { identity, video });
  return video;
}

function assetLabel(asset, fallback = "素材") {
  if (!asset) return fallback;
  return asset.name || asset.id;
}

function assetDescription(asset) {
  if (!asset?.description) return null;
  return el("span", { class: "zdb-muted", text: asset.description, title: asset.description });
}

export function renderMediaWorkspace(board, shot, { view } = {}) {
  const hasResult = Boolean(board.project.shot_results?.[shot.id] || board.dispatch?.getFailures?.().has(shot.id));
  const selectedView = view || board.mediaViewByShot?.get(shot.id) || (hasResult ? "result" : "input");
  const result = board.project.shot_results?.[shot.id], failure = board.dispatch?.getFailures?.().get(shot.id);
  const resultSummary = selectedView === "result" && result
    ? el("div", { class: "zdb-current-result-summary" }, resultMeta(shot, result, board)) : null;
  let content;
  if (selectedView === "result" && hasResult) content = renderCurrentShotResult(board, shot);
  else if (!(TASK_SLOTS[shot.task_type] || []).length) content = el("p", {
    class: "zdb-muted zdb-library-help", text: "文生视频：不需要上传素材，直接用提示词生成。",
  });
  else content = el("div", { class: "zdb-media-input" },
    el("p", { class: "zdb-muted zdb-library-help", text: "从创作资产选择，或上传只供本镜使用的素材。" }),
    renderPictureInvitations(board, shot),
    renderShotSlots(board, shot));
  return el("section", { class: "zdb-library" }, resultSummary, content);
}

export function renderShotViewSwitch(board, shot) {
  const result = board.project.shot_results?.[shot.id], failure = board.dispatch?.getFailures?.().get(shot.id);
  if (!result && !failure) return null;
  const selectedView = board.mediaViewByShot?.get(shot.id) || "result";
  return button(
    selectedView === "result" ? "返回输入" : (result ? "查看结果" : "查看失败"),
    () => {
      board.mediaViewByShot ||= new Map();
      const next = selectedView === "result" ? "input" : "result";
      board.mediaViewByShot.set(shot.id, next);
      if (next === "input") pauseResultVideos(board);
      board.draw();
    },
    "zdb-header-view-switch zdb-sub",
  );
}

export function renderCurrentShotResult(board, shot) {
  const result = board.project.shot_results?.[shot.id], failure = board.dispatch?.getFailures?.().get(shot.id);
  if (!result && !failure) return null;
  return el("section", { class: "zdb-current-result" },
    result ? resultVideo(board, shot.id, result, "metadata") : el("p", { class: "zdb-error", text: failure }),
    !result ? el("div", { class: "zdb-result-actions" }, rerunButton(board, shot)) : null);
}

/** 结果清单：按时间轴顺序列出每镜文件，失败镜标红并给"重跑这一镜"。 */
export function renderResultWall(board) {
  const results = new Map(Object.entries(board.project.shot_results || {}));
  const failures = board.dispatch?.getFailures?.() ?? new Map();
  const film = board.dispatch?.getFilm?.() ?? null;
  const items = [];
  for (const shot of board.project.shots) {
    const result = results.get(shot.id);
    if (result) items.push({ kind: "completed", node: renderResultItem(board, shot, result) });
    const message = failures.get(shot.id);
    if (message) items.push({ kind: "failed", node: renderFailedItem(board, shot, message) });
  }
  if (!items.length) {
    return el("section", { class: "zdb-result-wall" },
      el("div", { class: "zdb-row zdb-spread" }, el("h3", { text: "结果墙" }),
        button("返回编辑", () => { board.mainView = "editor"; board.draw(); }, "zdb-sub")),
      el("div", { class: "zdb-result-empty" },
      el("p", { class: "zdb-muted", text: "还没有生成结果。" }),
      el("p", {
        class: "zdb-muted",
        text: "点提示词内发送按钮生成当前镜，或在时间轴使用「批量生成」按顺序产出全部已选分镜。",
      })));
  }
  const filter = ["all", "completed", "failed"].includes(board.resultFilter) ? board.resultFilter : "all";
  const visible = items.filter((item) => filter === "all" || item.kind === filter).map((item) => item.node);
  const filterButton = (value, label) => button(label, () => {
    board.resultFilter = value; board.draw();
  }, filter === value ? "zdb-active" : "zdb-sub");
  return el("section", { class: "zdb-result-wall" },
    el("div", { class: "zdb-result-toolbar" },
      el("h3", { text: `结果墙 · ${results.size} 镜${failures.size ? ` · ${failures.size} 失败` : ""}` }),
      board.dispatch?.isRunning?.() ? el("span", { class: "zdb-muted", text: "队列运行中…" }) : null,
      el("span", { class: "zdb-grow" }),
      filterButton("all", "全部"), filterButton("completed", "已生成"), filterButton("failed", "失败"),
      results.size ? button(
        film ? "重新拼装整片" : `拼装成片（${results.size} 镜）`,
        () => board.dispatch?.assembleFilm?.(), "zdb-sub",
      ) : null,
      button("返回编辑", () => { board.mainView = "editor"; board.draw(); }, "zdb-sub")),
    el("div", { class: "zdb-results" }, filter !== "failed" && film ? renderFilmCard(board, film) : null, ...visible));
}

function renderFilmCard(board, film) {
  return el("article", { class: "zdb-result zdb-result-film" },
    resultVideo(board, FILM_PLAYER_KEY, film, "none"),
    el("div", { class: "zdb-result-meta" },
      el("b", { text: "整片" }),
      el("span", {
        class: "zdb-muted",
        text: `${film.filename} · ${film.shots?.length ?? 0} 镜 · ${film.frameRate ?? 24}fps · ${film.hasAudio ? "有音轨" : "无音轨"}`,
      })));
}

function rerunButton(board, shot) {
  return button("重跑", () => board.dispatch?.runShot?.(shot.id), "zdb-sub");
}

function resultMeta(shot, result, board) {
  return el("div", { class: "zdb-result-meta-line", title: result.fullpath || result.filename },
    el("b", { text: shot.title || shot.id }),
    el("span", { class: "zdb-result-file", text: result.filename }),
    el("span", { text: `seed ${result.seed}` }),
    el("span", { text: `${result.frameRate ?? 24}fps` }),
    el("span", { text: result.hasAudio === true ? "有音轨" : result.hasAudio === false ? "无音轨" : "音轨未知" }),
    rerunButton(board, shot));
}

function renderResultItem(board, shot, result) {
  return el("article", { class: "zdb-result", "data-shot-id": shot.id },
    resultVideo(board, shot.id, result, "none"),
    resultMeta(shot, result, board));
}

function renderFailedItem(board, shot, message) {
  return el("article", { class: "zdb-result zdb-result-failed", "data-shot-id": shot.id },
    el("div", { class: "zdb-result-meta" },
      el("b", { text: shot.title || shot.id }),
      el("span", { class: "zdb-error", text: message })),
    el("div", { class: "zdb-result-actions" }, rerunButton(board, shot)));
}

function renderShotSlots(board, shot) {
  const seen = {},
    // 图片来源 → 官方标签，和提示词装饰层、状态条共用同一份序号算法。
    tags = new Map(officialSlots(shot, board.project.assets).map((slot) => [slot.asset.id, slot.tag])),
    descriptors = TASK_SLOTS[shot.task_type].map(([kind, role, label]) => {
      const order = seen[role] || 0;
      seen[role] = order + 1;
      const binding = bindingForSlot(shot.bindings, role, order);
      const asset = binding && board.asset(binding.asset_id);
      return { kind, role, label, order, binding, asset, tag: tags.get(asset?.id) || "", required: order < (REQUIRED[shot.task_type]?.[role] || 0) };
    });
  const shown = descriptors.filter((slot) => slot.asset || slot.required), optional = descriptors.filter((slot) => !slot.asset && !slot.required),
    visuals = shown.filter((slot) => slot.kind !== "audio"), audios = shown.filter((slot) => slot.kind === "audio"),
    visualOptional = optional.filter((slot) => slot.kind !== "audio"), audioOptional = optional.filter((slot) => slot.kind === "audio"),
    addInVisuals = visualOptional.length > 0, addInAudio = !addInVisuals && audioOptional.length > 0,
    children = [
      el("div", { class: "zdb-media-visuals" },
        ...visuals.map((slot) => renderShotSlot(board, shot, slot)),
        addInVisuals ? renderAddReference(board, shot, optional, "tile") : null),
      audios.length || addInAudio
        ? el("div", { class: "zdb-media-audio" },
          ...audios.map((slot) => renderAudioStrip(board, shot, slot)),
          addInAudio ? renderAddReference(board, shot, audioOptional, "strip") : null)
        : null,
    ];
  return el("div", { class: `zdb-media-slots zdb-slot-count-${shown.length + (optional.length ? 1 : 0)}` }, ...children);
}

function renderAddReference(board, shot, choices, variant = "tile") {
  const compact = compactReferenceChoices(choices), typeButtons = compact.map((slot) => {
    const label = KIND_LABEL[slot.kind] || slot.kind,
      uploading = board.uploadingMedia?.get(mediaUploadKey(shot.id, slot.kind, slot));
    return el("button", {
      type: "button", class: `zdb-media-kind-launcher zdb-kind-${slot.kind} ${uploading ? "is-uploading" : ""}`,
      "aria-label": uploading ? `正在上传${label}` : `添加${label}`,
      title: uploading ? `正在上传“${uploading.name}”` : `添加${label}`,
      disabled: Boolean(uploading),
      onclick: () => addReferenceByKind(board, shot, slot),
    }, uploading
      ? el("b", { text: `正在上传${label}…` })
      : [el("span", { text: "+" }), el("b", { text: label })]);
  });
  return el("article", { class: variant === "strip" ? "zdb-media-strip zdb-media-strip-add zdb-media-add" : "zdb-media-slot zdb-media-add" },
    el("div", { class: "zdb-reference-add" }, el("div", { class: "zdb-reference-type-buttons" }, ...typeButtons)));
}

export function compactReferenceChoices(choices) {
  const unique = new Map();
  for (const slot of choices || []) {
    const key = `${slot.kind}:${slot.role}`;
    if (!unique.has(key)) unique.set(key, slot);
  }
  return [...unique.values()];
}

export function selectableCreativeAssets(board, shot) {
  const bound = new Set(shot.bindings.map((binding) =>
    board.project.assets.find((asset) => asset.id === binding.asset_id)?.creative_asset_id
  ).filter(Boolean));
  return (board.assistant?.assets || []).filter((asset) =>
    asset.image_path && !bound.has(asset.asset_id));
}

function addReferenceByKind(board, shot, slot) {
  if (slot.kind !== "image") return board.upload(null, shot.id, slot.kind, { role: slot.role, order: slot.order });
  const modal = board.modal("添加图片");
  modal.body.append(el("section", { class: "zdb-image-source-choice" },
    button("从创作资产选择", () => { modal.close(); chooseCreativeAsset(board, shot, slot.role, slot.order); }, "zdb-sub"),
    button("上传图片", () => { modal.close(); board.upload(null, shot.id, "image", { role: slot.role, order: slot.order }); }, "zdb-sub")));
  board.focus(modal.element);
}

function dropHandlers(board, asset, owner, kind, target) {
  const readFiles = (list) => [...(list || [])];
  return {
    onpaste: (event) => {
      const pasted = readFiles(event.clipboardData?.files);
      if (!pasted.length) return;
      event.preventDefault();
      board.uploadFiles(pasted, asset, owner, kind, target);
    },
    ondragover: (event) => {
      event.preventDefault();
      event.currentTarget.classList.add("zdb-dragover");
    },
    ondragleave: (event) => event.currentTarget.classList.remove("zdb-dragover"),
    ondrop: (event) => {
      event.preventDefault();
      event.currentTarget.classList.remove("zdb-dragover");
      const dropped = readFiles(event.dataTransfer?.files);
      if (dropped.length) board.uploadFiles(dropped, asset, owner, kind, target);
    },
  };
}

function renderShotSlot(board, shot, { asset, kind, role, order, label, binding, tag }) {
  const replace = () => board.replaceSlotAsset(shot, asset, kind, { role, order });
  const trimmable = ["source_audio", "source_video"].includes(role),
    trim = () => openTrimEditor(board, shot, asset, binding),
    primary = trimmable
      ? button("裁剪", trim, "zdb-sub")
      : button("替换", replace, "zdb-sub");
  const preview = asset
    ? kind === "video"
      ? createVideoPreview(board, asset, { shot, binding })
      : board.thumb(asset)
    : el("span", { class: "zdb-media-empty", text: kind === "image" ? "图片" : kind === "video" ? "视频" : "音频" });
  return el("article", {
    class: `zdb-media-slot zdb-kind-${kind} ${asset ? "zdb-filled" : ""}`,
    ...dropHandlers(board, asset, shot.id, kind, { role, order }),
  },
    preview,
    asset ? el("div", { class: "zdb-slot-remove" },
      button("×", () => board.removeSlotBinding(shot, binding), "zdb-danger"),
    ) : null,
    el("div", { class: "zdb-slot-copy" },
      el("b", { text: label }),
      // 号牌就是提示词里要写的官方标签（§10.12）：序号是位置，由已绑定的槽位顺序决定。
      tag ? el("span", { class: "zdb-slot-tag", text: tag, title: "提示词里用这个标签引用它" }) : null,
      asset ? el("span", { class: "zdb-muted", text: asset.creative_asset_id ? `来自创作资产 · ${assetLabel(asset)}` : assetLabel(asset, "本镜上传") }) : null,
      assetDescription(asset)),
    asset ? el("div", { class: "zdb-row zdb-slot-actions" },
      primary,
      kind === "image" ? button("选图", () => chooseCreativeAsset(board, shot, role, order), "zdb-sub") : null,
      button("引用", () => board.mentionAsset(asset), "zdb-sub"),
    ) : el("div", { class: "zdb-row" },
      button("上传", () => board.upload(null, shot.id, kind, { role, order }), "zdb-sub"),
      kind === "image"
        ? button("从资产中选择", () => chooseCreativeAsset(board, shot, role, order), "zdb-sub")
        : null,
      null));
}

function renderAudioStrip(board, shot, { asset, kind, role, order, label, binding, tag }) {
  const actions = asset
    ? el("span", { class: "zdb-strip-actions" },
      role === "source_audio"
        ? button("裁切", () => board.openShotAudioEditor(shot, asset, binding), "zdb-sub")
        : null,
      button("替换", () => board.replaceSlotAsset(shot, asset, kind, { role, order }), "zdb-sub"),
      button("引用", () => board.mentionAsset(asset), "zdb-sub"),
      button("×", () => board.removeSlotBinding(shot, binding), "zdb-danger"))
    : el("span", { class: "zdb-strip-actions" },
      button("上传", () => board.upload(null, shot.id, kind, { role, order }), "zdb-sub"));
  return el("article", {
    class: `zdb-media-strip zdb-kind-${kind} ${asset ? "zdb-filled" : ""}`,
    title: asset ? `${label} · ${assetLabel(asset)}` : label,
    ...dropHandlers(board, asset, shot.id, kind, { role, order }),
  },
    el("div", { class: "zdb-strip-identity" },
      el("span", { class: "zdb-strip-copy" },
        el("b", { text: tag || label, title: asset ? `${label} · ${assetLabel(asset)}` : label })),
      actions),
    el("div", { class: "zdb-strip-controls" },
      asset ? createAudioPreview(board, asset, { binding }) : el("span", { class: "zdb-muted", text: "未选择音频" })));
}

function chooseCreativeAsset(board, shot, role, order, type = "") {
  const assets = selectableCreativeAssets(board, shot).filter((asset) => !type || asset.type === type);
  const modal = board.modal("选择创作资产");
  const includeDescription = el("input", { type: "checkbox", checked: false }),
    choices = assets.map((creativeAsset) => el("button", {
      type: "button",
      class: "zdb-btn zdb-sub zdb-creative-asset-option",
      onclick: () => {
        try {
          const result = handoffCreativeAsset(
            board.project, board.assistant, shot.id, creativeAsset.asset_id,
            role, order, includeDescription.checked,
          );
          board.project = result.project;
          modal.close();
          board.update();
        } catch (error) {
          board.notice(error.message);
        }
      },
    },
    el("img", {
      src: inputViewUrl(creativeAsset.image_path),
      alt: creativeAsset.name || creativeAsset.asset_id,
    }),
    el("span", { text: creativeAsset.name || creativeAsset.asset_id })));
  modal.body.append(...[
    el("label", { class: "zdb-check" }, includeDescription, el("span", { text: "在提示词开头补充所选资产描述" })),
    el("section", { class: "zdb-creative-asset-grid" }, ...choices),
    !assets.length ? el("p", { class: "zdb-muted", text: "还没有可用图片，可以上传或立即生成。" }) : null,
    button("生成新图片", () => { modal.close(); generateShotImage(board, shot, { role, order }, type || "other"); }, "zdb-sub"),
    button("上传图片", () => { modal.close(); board.upload(null, shot.id, "image", { role, order }); }, "zdb-sub"),
  ].filter(Boolean));
  board.focus(modal.element);
}

/** Invitations fill a real image slot; mandatory frame slots keep their official labels. */
export function nextImageSlot(shot) {
  const seen = {};
  for (const [kind, role, label] of TASK_SLOTS[shot.task_type] || []) {
    const order = seen[role] || 0; seen[role] = order + 1;
    if (kind === "image" && !bindingForSlot(shot.bindings, role, order)) return { kind, role, label, order };
  }
  return null;
}

function renderPictureInvitations(board, shot) {
  const slot = nextImageSlot(shot);
  if (!slot) return null;
  return el("div", { class: "zdb-picture-invitations", "aria-label": "选择画面对象" },
    ...[["character", "角色", "人物外观与动作"], ["scene", "场景", "画面环境与氛围"]].map(([type, title, help]) =>
      el("article", { class: "zdb-picture-invitation" },
        el("b", { text: title }), el("span", { class: "zdb-muted", text: help }),
        el("small", { text: `用于${slot.label}` }),
        el("div", { class: "zdb-row" },
          button(`选择${title}`, () => chooseCreativeAsset(board, shot, slot.role, slot.order, type), "zdb-sub"),
          button("做一个", () => generateShotImage(board, shot, slot, type), "zdb-sub")))));
}

/** The generator's explicit adoption commits a new shot-local snapshot, never edits shared images. */
export function adoptShotImage(board, shotId, slot, image, asset = {}) {
  if (!image?.image_path) throw new Error("生成图片缺少输入路径。");
  const shot = board.project.shots.find((item) => item.id === shotId);
  if (!shot || !(TASK_SLOTS[shot.task_type] || []).some(([kind, role]) => kind === "image" && role === slot.role)) {
    throw new Error("目标分镜或素材模式已变化，请重新打开生成窗口。");
  }
  const creative = { asset_id: uid("image"), name: asset.name || "生成图片", description: asset.description || "", image_path: image.image_path };
  const result = handoffCreativeAsset(board.project, { assets: [creative] }, shotId, creative.asset_id, slot.role, slot.order);
  const snapshot = result.project.assets.find((item) => item.id === result.binding.asset_id);
  delete snapshot.creative_asset_id;
  snapshot.scope = "shot"; snapshot.owner_shot_id = shotId;
  board.project = result.project;
  board.update();
  return true;
}

export function generateShotImage(board, shot, slot, type = "other", source = null) {
  const asset = { type, name: source?.name || ({ character: "角色", scene: "场景" }[type] || slot.label || "镜头图片"), description: source?.description || "" };
  const options = {
    project: board.assistant?.project || {}, asset, initialImage: source?.input_path || "",
    onComplete: (image) => adoptShotImage(board, shot.id, slot, image, asset),
    onSaveAsAsset: (image) => {
      const added = addCreativeAsset(readAssistant(board.node), {
        name: image.name, type: ({ 人物: "character", 场景: "scene", 道具: "prop" }[image.type] || "other"),
        image_path: image.image_path, description: image.description,
      });
      writeAssistant(board.node, added.project); board.assistant = added.project;
      return true;
    },
  };
  return openAssetGenerator({
    ...options,
    onCompose: (draft) => launchShotComposition(board, shot, slot, options, draft),
  });
}

/** Reuse the pose/camera editor's Qwen draft render for a shot-local image. */
export async function launchShotComposition(board, shot, slot, generator, seed = {}, services = {}) {
  const [{ openCompositionEditor }, { detectPose }, { uploadAssetImage }] = await Promise.all([
    services.editor || import("./composition-editor/index.js"),
    services.pose || import("./asset-center/pose-detection.js"),
    services.assets || import("./asset-center/asset-client.js"),
  ]);
  const draftKey = `${shot.id}:${slot.role}:${slot.order ?? 0}`;
  board.shotCompositionDrafts ||= new Map();
  const target = {
    kind: "frame", title: shot.title, frameRole: slot.role,
    frameSize: [board.project.canvas.width, board.project.canvas.height],
    frameAspectRatio: board.project.canvas.aspect_ratio,
  };
  const saveDraft = (result) => {
    board.shotCompositionDrafts.set(draftKey, result.composition_draft);
    return result.composition_draft;
  };
  const withImages = (types) => (board.assistant?.assets || [])
    .filter((item) => types.includes(item.type) && item.image_path)
    .map((item) => ({ name: item.name, image_path: item.image_path,
      url: inputViewUrl(item.image_path) }));
  return openCompositionEditor({
    draft: board.shotCompositionDrafts.get(draftKey) || { extra_prompt: seed.prompt || "" },
    target,
    onDetectPose: detectPose,
    characterAssets: withImages(["character"]),
    backgroundAssets: withImages(["scene"]),
    onApply: saveDraft,
    onGenerate: async (result) => {
      saveDraft(result);
      const imagePath = await uploadAssetImage(new File(
        [result.compositionBlob], "shot-composition-guide.png", { type: "image/png" },
      ));
      (services.openGenerator || openAssetGenerator)({
        ...generator,
        onCompose: (current) => {
          const saved = board.shotCompositionDrafts.get(draftKey);
          if (current.prompt !== result.prompt) board.shotCompositionDrafts.set(draftKey, { ...saved,
            promptOverrides: { ...saved?.promptOverrides, [saved?.draft_mode || "pose"]: current.prompt } });
          return launchShotComposition(board, shot, slot, generator, { ...seed, ...current }, services);
        },
        compositionSeed: {
          app_type: "draft_render", draft_mode: result.composition_draft.draft_mode,
          target_kind: "frame", output_size: seed.output_size || "1.5k", aspect_ratio: target.frameAspectRatio,
          init_image: imagePath, composition_image: imagePath,
          reference_image: seed.reference_image ?? (seed.init_image || generator.initialImage || ""),
          reference_image_2: seed.reference_image_2 || "",
          prompt: result.prompt,
        },
      });
      return result.composition_draft;
    },
  });
}
