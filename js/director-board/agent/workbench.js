import { el, button } from "../ui.js";
import { canvasSizeFor } from "../model.js";
import { openAssetGenerator, uploadAssetImage } from "../asset-index.js";
import { requestDirectorAssist } from "./assist-client.js";
import { requestAssetFacts } from "./assist-client.js";
import { renderAssetPage } from "./asset-page.js";
import {
  candidateCount as countCandidates,
  createCandidate,
  hasPendingCandidates,
  pruneCandidateStore,
  putCandidate,
  updateCandidate,
} from "./candidate.js";
import {
  ensureCreativeShotForDirector, handoffCreativeProject, writePromptToDirector,
} from "./director-handoff.js";
import { renderShotPage } from "./shot-page.js";
import { renderStoryPage } from "./story-page.js";
import { ensureDirectorAgentStyle } from "./assist-panel.js";
import { readAssistant, writeAssistant } from "./storage.js";
import { addCreativeAsset } from "./workspace.js";
import {
  buildShotAssistRequest, effectiveShotAssistOptions, executionPromptErrors, shotAssistFingerprint, shotDialogueState,
} from "../shot-assist.js";

export const CREATIVE_TABS = [["story", "剧本"], ["assets", "资产"], ["shots", "分镜"]];
const PAGE_LABELS = { story: "剧本", assets: "资产", shots: "分镜" };

/**
 * 拆镜请求。
 *
 * ``segments`` = ``"auto"`` 时由模型按叙事节拍决定切几刀（既有行为）；
 * 给一个 1–12 的整数就是"恰好切成 N 个" —— 即"剧本 + 资产 + 段数 → 分镜"里的段数。
 *
 * **刻意不带资产目录**：拆镜模型只负责"在哪切"。早期版本带过资产目录，
 * 实测（提交 2b8de6e）模型会优先满足 JSON 与资产 token，真实 benchmark 出现 5 个无效输出；
 * 资产匹配与正式提示词优化必须留在后续独立步骤。
 */
export function buildShotBreakdownPayload(project, segments = "auto") {
  const count = Number(segments);
  return {
    target: "shot_breakdown",
    skill_id: project.story.skill_id || "free",
    current: {},
    instruction: "标准拆分，平衡叙事与画面节奏",
    segment_count: Number.isInteger(count) && count > 0 ? count : null,
    context: { story_text: project.story.text },
  };
}

export function createRequestGate(requestFn, onChange = () => {}) {
  let activeRequest = null, closed = false;
  const notify = () => onChange(activeRequest ? { page: activeRequest.page, label: activeRequest.label } : null);
  return {
    status: () => activeRequest ? { page: activeRequest.page, label: activeRequest.label } : null,
    async run(payload, { page = "story", label = "正在生成" } = {}) {
      if (closed) throw new Error("创作工作台已关闭");
      if (activeRequest) throw new Error(`${PAGE_LABELS[activeRequest.page] || "内容"}正在生成，请等待完成或关闭工作台取消。`);
      const controller = new AbortController(), token = { controller, page, label };
      activeRequest = token; notify();
      try {
        const result = await requestFn(payload, { signal: controller.signal });
        if (closed || activeRequest !== token) {
          const error = new Error("请求已取消"); error.name = "AbortError"; throw error;
        }
        return result;
      } finally {
        if (activeRequest === token) { activeRequest = null; notify(); }
      }
    },
    close() {
      closed = true;
      const token = activeRequest;
      activeRequest = null; notify(); token?.controller.abort();
    },
  };
}

function chooseImage() {
  return new Promise((resolve) => {
    const picker = document.createElement("input"); picker.type = "file"; picker.accept = "image/*";
    picker.addEventListener("change", async () => {
      try { resolve(picker.files?.[0] ? await uploadAssetImage(picker.files[0]) : null); }
      catch { resolve(null); }
    }, { once: true });
    picker.click();
  });
}

export async function openCreativeWorkbench(board, options = {}) {
  ensureDirectorAgentStyle();
  const directorOnly = Boolean(options.directorOnly && options.director_shot_id);
  const directorShot = directorOnly && board.project.shots.find((shot) => shot.id === options.director_shot_id);
  if (directorOnly && !directorShot) throw new Error("当前导演台镜头已不存在，请重新选择。");
  const projectId = board.project?.project?.id || "",
    sameSessionProject = !options.session?.opinionProjectId || options.session.opinionProjectId === projectId,
    runtime = board.opinionRuntime?.projectId === projectId ? board.opinionRuntime : {
      projectId, drafts: new Map(), refinements: new Map(), styles: new Map(),
      guidance: sameSessionProject ? options.session?.shotGuidance || new Map() : new Map(),
    };
  board.opinionRuntime = runtime;
  const modal = board.modal(directorOnly ? "优化当前导演台镜头" : "创作工作台"),
    host = el("main", { class: "zcw-shell" }), session = options.session || {};
  if (session.opinionProjectId && session.opinionProjectId !== projectId) {
    session.candidates = new Map();
    session.identifications = new Map();
    session.identificationResults = new Map();
    session.shotGuidance = runtime.guidance;
    session.opinionDrafts = runtime.drafts;
    session.opinionRefinements = runtime.refinements;
    session.shotStyles = runtime.styles;
  }
  session.opinionProjectId = projectId;
  session.candidates ||= new Map();
  session.identifications ||= new Map();
  session.identificationResults ||= new Map();
  session.shotGuidance ||= runtime.guidance;
  session.opinionDrafts ||= runtime.drafts;
  session.opinionRefinements ||= runtime.refinements;
  session.shotStyles ||= runtime.styles;
  const guidanceFor = (directorId) => effectiveShotAssistOptions(
    { project: board.project, assistant: project },
    board.project.shots.find((shot) => shot.id === directorId),
    session.shotGuidance.get(directorId) || {},
  );
  modal.element.classList.add("zda-shell", "zcw-modal");
  if (directorOnly) modal.element.classList.add("zcw-director-only");
  modal.body.classList.add("zda-body", "zda-chat-body");
  modal.footer.replaceChildren();
  let project = readAssistant(board.node), activeTab = directorOnly ? "shots" : options.tab || "story", navigationRevision = 0, pageRevision = 0,
    pageHandle = null, closed = false, confirmClose = false;
  const gate = createRequestGate(options.requestFn || requestDirectorAssist, (status) => { drawHeader(); pageHandle?.setRequestStatus?.(status); });
  if (project.project.id === "project_01" && board.project?.project?.id) {
    project = { ...project, project: { id: board.project.project.id, title: board.project.project.title || project.project.title } };
    if (!directorOnly) { writeAssistant(board.node, project); board.assistant = project; }
  }
  if (options.director_shot_id) {
    const linked = ensureCreativeShotForDirector(project, board.project, options.director_shot_id);
    if (JSON.stringify(linked.creative) !== JSON.stringify(project)) {
      project = linked.creative;
      if (!directorOnly) { writeAssistant(board.node, project); board.assistant = project; }
    }
  }

  const commit = (next) => {
    if (directorOnly) {
      const stored = readAssistant(board.node);
      writeAssistant(board.node, { ...stored, preferences: next.preferences });
      board.assistant = readAssistant(board.node);
      project = { ...next, preferences: board.assistant.preferences };
      return project;
    }
    writeAssistant(board.node, next); project = readAssistant(board.node); board.assistant = project;
    pruneCandidateStore(session.candidates, project); board.entry(); return project;
  };
  const request = (payload, requestOptions) => gate.run(payload, requestOptions);
  modal.setCloseHandler(() => {
    if (hasPendingCandidates(session.candidates) && !confirmClose) {
      modal.footer.replaceChildren(
        el("span", { class: "zda-error zda-grow", text: "仍有未处理候选，关闭后将丢失。" }),
        button("继续编辑", () => modal.footer.replaceChildren(), "zdb-sub"),
        button("确认关闭", () => { confirmClose = true; modal.close(); }, "zdb-danger"),
      );
      return false;
    }
    closed = true; pageHandle?.save?.(); gate.close();
    if (confirmClose) {
      for (const [key, value] of session.opinionRefinements) {
        if (value.instruction?.trim()) session.opinionDrafts.set(key, value.instruction);
      }
      session.candidates.clear(); session.opinionRefinements.clear();
    }
    return true;
  });
  const runStoryDerived = async (kind, payload) => {
    const revision = project.story.revision, text = project.story.text,
      requestNavigationRevision = navigationRevision,
      requestCandidate = createCandidate(
        kind === "assets" ? "asset_suggestions" : "shot_breakdown",
        { creativeProject: project }, { after: [] },
      );
    try {
      const result = await request(payload, { page: kind, label: kind === "assets" ? "正在提取资产" : "正在拆分分镜" });
      if (activeTab === "story") project = pageHandle?.save?.() || project;
      if (revision !== project.story.revision || text !== project.story.text) return board.notice("剧本已变化，本次派生结果未应用，请重新生成。");
      if (kind === "assets") {
        const rows = (result.assets || []).map((row) => ({ ...row, selected: true }));
        if (!rows.length) return board.notice("没有生成可审阅的资产 Candidate。");
        requestCandidate.warnings = structuredClone(result.warnings || []);
        putCandidate(session.candidates, updateCandidate(requestCandidate, rows));
      } else {
        const rows = (result.shots || []).map((row) => ({ ...row, selected: true }));
        if (!rows.length) return board.notice("没有生成可审阅的分镜 Candidate。");
        requestCandidate.warnings = structuredClone(result.warnings || []);
        putCandidate(session.candidates, updateCandidate(requestCandidate, rows));
      }
      if (navigationRevision === requestNavigationRevision) activeTab = kind;
      draw();
    } catch (error) { if (!closed && error.name !== "AbortError") board.notice(error.message); }
  };
  const extractAssets = async () => {
    if (!project.story.text.trim()) return board.notice("请先保存剧本。");
    return runStoryDerived("assets", { target: "asset_suggest", skill_id: "free", current: {}, instruction: "提取角色、场景和关键道具", context: { story_text: project.story.text } });
  };
  const breakdown = async () => {
    if (!project.story.text.trim()) return board.notice("请先保存剧本。");
    return runStoryDerived("shots", buildShotBreakdownPayload(project, session.breakdownSegments || "auto"));
  };
  const handoff = async (_snapshot, selectedShotId) => {
    if (hasPendingCandidates(session.candidates)) {
      board.notice("仍有未处理 Candidate，请先采纳或放弃后再交给导演台。");
      return false;
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
    try {
      const result = handoffCreativeProject(board.project, project);
      const preferred = result.links.find((link) => link.shot_id === selectedShotId) || result.links[0];
      if (preferred) result.project.selected_shot_id = preferred.director_shot_id;
      board.project = result.project; project = commit(result.creative); board.update();
      modal.close();
      board.flash(`已交接 ${result.links.length} 个分镜，请确认素材和任务模式`);
      return true;
    } catch (error) { board.notice(error.message); return false; }
  };
  const saveGeneratedAsset = ({ image_path, name, type, description }) => {
    if (closed) return false;
    const added = addCreativeAsset(directorOnly ? readAssistant(board.node) : project, {
      image_path, name, description, type: ({ 人物: "character", 场景: "scene", 道具: "prop" }[type] || "other"),
    });
    if (directorOnly) {
      writeAssistant(board.node, added.project); board.assistant = readAssistant(board.node);
      project = { ...project, assets: board.assistant.assets };
    } else commit(added.project);
    pageHandle?.setProject?.(project);
    return true;
  };
  const openGenerator = (asset, onComplete) => openAssetGenerator({ project: project.project, asset,
    onSaveAsAsset: saveGeneratedAsset, onComplete: ({ image_path }) => onComplete(image_path) });
  const inputImageUrl = (path) => `/view?${new URLSearchParams({
    filename: String(path).split("/").pop(),
    subfolder: String(path).split("/").slice(0, -1).join("/"), type: "input",
  })}`;
  const uploadedBackgrounds = new WeakMap();
  const uploadedStickers = new WeakMap();
  const saveComposition = async (result, onSave, { exportForGeneration = false } = {}) => {
    const draft = structuredClone(result.composition_draft || {});
    const upload = (blob, name) => blob ? uploadAssetImage(new File([blob], name, {
      type: blob.type || "image/png",
    })) : Promise.resolve(null);
    const [compositionPath, backgroundPath, stickerPaths] = await Promise.all([
      exportForGeneration ? upload(result.compositionBlob, "composition-guide.png") : Promise.resolve(null),
      result.backgroundBlob
        ? uploadedBackgrounds.get(result.backgroundBlob) || upload(result.backgroundBlob, "composition-background.png")
        : Promise.resolve(null),
      Promise.all((result.stickerFiles || []).map(async (file) => {
        if (!file) return null;
        const path = uploadedStickers.get(file) || await uploadAssetImage(file);
        uploadedStickers.set(file, path);
        return path;
      })),
    ]);
    if (compositionPath) draft.composition_image_path = compositionPath;
    else delete draft.composition_image_path;
    delete draft.pose_image_path;
    if (backgroundPath) {
      if (result.backgroundBlob) uploadedBackgrounds.set(result.backgroundBlob, backgroundPath);
      draft.background = { ...draft.background, image_path: backgroundPath, src: inputImageUrl(backgroundPath) };
    }
    draft.stickers = (draft.stickers || []).map((sticker, index) => stickerPaths[index] ? {
      ...sticker, image_path: stickerPaths[index], src: inputImageUrl(stickerPaths[index]),
    } : sticker);
    if (result.poseJson) draft.pose_json = typeof result.poseJson === "string"
      ? result.poseJson : JSON.stringify(result.poseJson);
    if (result.prompt) draft.prompt = result.prompt;
    if (!onSave(draft)) throw new Error("目标内容已变化，构图未应用。请重新打开编辑器。");
    return draft;
  };
  const generatorSeed = (asset, draft, target) => ({
    app_type: "draft_render",
    draft_mode: draft.draft_mode,
    target_kind: target?.kind || "asset",
    people_count: draft.people?.length === 2 ? 2 : 1,
    output_size: "1.5k",
    aspect_ratio: target?.kind === "frame" && target.frameAspectRatio ? target.frameAspectRatio :
      `${draft.width}:${draft.height}`,
    init_image: draft.composition_image_path || "",
    reference_image: draft.draft_mode === "sticker" ? "" : asset?.image_path || "",
    reference_image_2: "",
    composition_image: draft.composition_image_path || "",
    prompt: [draft.prompt, draft.draft_mode === "sticker" || asset?.image_path ? "" :
      [asset?.description, ...(asset?.fixed_features || [])].filter(Boolean).join("，")].filter(Boolean).join("\n"),
  });
  const launchCompositionEditor = async ({ draft, identityImage, backgroundAssets, characterAssets, onSave, onGenerated, asset, target, generationSettings = {} }) => {
    try {
      const { openCompositionEditor } = await import("../composition-editor/index.js");
      const { detectPose } = await import("../asset-center/pose-detection.js");
      const sourceUrl = identityImage ? inputImageUrl(identityImage) : "";
      const editorDraft = { ...(draft || {}) };
      if (target?.kind === "asset" && target.assetType !== "character") {
        editorDraft.draft_mode = "sticker";
        if (!draft && sourceUrl && target.assetType === "scene") {
          editorDraft.background = { src: sourceUrl, image_path: identityImage };
        } else if (!draft && sourceUrl && target.assetType === "prop") {
          editorDraft.stickers = [{ id: `asset-${asset.asset_id}`, name: asset.name, src: sourceUrl,
            image_path: identityImage, x: 0, y: 0, scale: 1, rotation: 0 }];
        }
      }
      return openCompositionEditor({
        draft: editorDraft,
        target,
        onDetectPose: detectPose,
        backgroundAssets: backgroundAssets.map((item) => ({
          name: item.name, image_path: item.image_path, url: inputImageUrl(item.image_path),
        })),
        characterAssets: characterAssets.map((item) => ({
          name: item.name, image_path: item.image_path, url: inputImageUrl(item.image_path),
        })),
        onApply: (result) => saveComposition(result, onSave),
        onGenerate: async (result) => {
          const saved = await saveComposition(result, onSave, { exportForGeneration: true });
          const generationAsset = target?.kind === "frame" ? { ...asset,
            name: `${target.title} · ${target.frameRole === "last_frame" ? "尾帧" : "首帧"}` } : asset;
          openAssetGenerator({ project: project.project, asset: generationAsset,
            compositionSeed: { ...generatorSeed(asset, saved, target), ...generationSettings },
            onSaveAsAsset: saveGeneratedAsset,
            onCompose: (current) => launchCompositionEditor({
              draft: current.prompt === saved.prompt ? saved : { ...saved,
                promptOverrides: { ...saved.promptOverrides, [saved.draft_mode || "pose"]: current.prompt } },
              identityImage, backgroundAssets, characterAssets, onSave, onGenerated, asset, target,
              generationSettings: { reference_image: current.reference_image,
                reference_image_2: current.reference_image_2, output_size: current.output_size },
            }),
            onComplete: ({ image_path }) => {
              if (onGenerated?.(image_path, saved) === false) {
                throw new Error("目标构图已变化，候选图未应用。请重新生成或关闭候选窗口。");
              }
            },
          });
          return saved;
        },
      });
    } catch (error) { board.notice(error.message); return false; }
  };

  function drawTabs() {
    if (directorOnly) return null;
    return el("nav", { class: "zcw-tabs", role: "tablist" }, ...CREATIVE_TABS.map(([id, label]) => button(
      `${label}${countCandidates(session.candidates, id) ? " · 候选" : ""}`,
      () => {
        pageHandle?.save?.();
        if (activeTab !== id) navigationRevision += 1;
        activeTab = id; draw();
      }, activeTab === id ? "zdb-active" : "zdb-sub",
    )));
  }
  function drawHeader() {
    const active = gate.status();
    modal.setHeader(el("b", { class: "zcw-modal-title", text: directorOnly ? "导演台单镜提示词" : "创作工作台" }), el("b", { class: "zcw-project-title", text: directorOnly ? directorShot.title : project.project.title }),
      ...(directorOnly ? [] : [drawTabs()]), el("span", { class: "zda-grow" }),
      el("span", { class: "zda-muted zcw-header-status", text: active?.label || "" }));
  }
  function draw() {
    const page = el("section", { class: "zcw-page-host" }), renderedRevision = ++pageRevision;
    drawHeader();
    host.replaceChildren(page);
    if (activeTab === "story") pageHandle = renderStoryPage(page, project, commit, {
      requestFn: request, requestStatus: () => gate.status(), candidate: session.candidates.get("story") || null,
      candidateStore: session.candidates,
      onCandidateChange: (candidate) => {
        if (candidate) putCandidate(session.candidates, candidate); else session.candidates.delete("story");
        drawHeader();
      }, extractAssets, breakdown,
      breakdownSegments: session.breakdownSegments || "auto",
      onBreakdownSegmentsChange: (value) => { session.breakdownSegments = value; },
    });
    else if (activeTab === "assets") pageHandle = renderAssetPage(page, project, commit, {
      requestFn: request, requestStatus: () => gate.status(), candidateStore: session.candidates,
      suggestionCandidate: session.candidates.get("asset_batch") || null,
      onCandidateStateChange: drawHeader, extractAssets, uploadImage: chooseImage, openGenerator,
      openCompositionEditor: (asset, onSave, onGenerated) => {
        if (closed || renderedRevision !== pageRevision) return;
        const targetId = asset.asset_id;
        void launchCompositionEditor({
          draft: asset.composition_draft,
          identityImage: asset.image_path,
          backgroundAssets: project.assets.filter((row) => row.type === "scene" && row.image_path),
          characterAssets: project.assets.filter((row) => row.type === "character" && row.image_path),
          onSave: (draft) => !closed && renderedRevision === pageRevision
            && project.assets.some((row) => row.asset_id === targetId) && onSave(draft),
          onGenerated: (imagePath, draft) => !closed && renderedRevision === pageRevision
            && project.assets.some((row) => row.asset_id === targetId) && onGenerated(imagePath, draft), asset,
          target: { kind: "asset", title: asset.name, assetType: asset.type },
        });
      },
      identifications: session.identifications,
      identificationResults: session.identificationResults,
      identifyImage: async (imagePath) => {
        if (closed || renderedRevision !== pageRevision) return null;
        const result = await (options.identifyImage || requestAssetFacts)(imagePath);
        // A remounted page owns a newer project snapshot; the detached page cannot commit.
        return closed || renderedRevision !== pageRevision ? null : result;
      },
      imageUrl: inputImageUrl,
    });
    else pageHandle = renderShotPage(page, project, commit, {
      directorOnly,
      opinionDrafts: session.opinionDrafts,
      opinionRefinements: session.opinionRefinements,
      opinionStyles: session.shotStyles,
      directorAudioShots: board.project.shots.flatMap((shot) => {
        const source = shot.bindings.find((binding) => binding.role === "source_audio" && binding.range_ms);
        return source ? [{ id: shot.id, title: shot.title, duration_ms: shot.duration_ms,
          audioRange: source.range_ms }] : [];
      }),
      onOpenDirectorShot: (id) => {
        if (hasPendingCandidates(session.candidates)) {
          board.notice("先采纳或放弃当前候选，再切换到导演台镜头。");
          return;
        }
        modal.close();
        board.selectShot(id);
      },
      requestFn: request, requestStatus: () => gate.status(), candidateStore: session.candidates,
      breakdownCandidate: session.candidates.get("shot_batch") || null,
      onCandidateStateChange: drawHeader, breakdown,
      openFrameEditor: (shot, role, onSave, onGenerated) => {
        if (closed || renderedRevision !== pageRevision) return;
        const targetId = shot.shot_id,
          identity = project.assets.find((row) => shot.asset_refs.includes(row.asset_id)
            && row.type === "character" && row.image_path),
          existing = shot.frame_drafts?.[role] || {};
        void launchCompositionEditor({
          draft: existing.composition_draft || existing,
          identityImage: identity?.image_path,
          backgroundAssets: project.assets.filter((row) => row.type === "scene" && row.image_path),
          characterAssets: project.assets.filter((row) => row.type === "character" && row.image_path),
          onSave: (draft) => !closed && renderedRevision === pageRevision
            && project.shots.some((row) => row.shot_id === targetId)
            && onSave({ ...existing, composition_draft: draft }),
          onGenerated: (imagePath, draft) => !closed && renderedRevision === pageRevision
            && project.shots.some((row) => row.shot_id === targetId) && onGenerated(imagePath, draft),
          asset: identity || { name: `${shot.title} · ${role === "first_frame" ? "首帧" : "尾帧"}`,
            type: "character", description: shot.prompt, image_path: null },
          target: { kind: "frame", title: shot.title, frameRole: role,
            frameAspectRatio: board.project.canvas.aspect_ratio,
            frameSize: canvasSizeFor(board.project.canvas.aspect_ratio, 2.0) },
        });
      },
      skillId: "free",
      handoff,
      selectedShotId: Object.entries(project.handoff.director_links).find(([, directorId]) => directorId === options.director_shot_id)?.[0],
      formalDirectorShotId: options.director_shot_id || null,
      directorLink: (shotId) => project.handoff.director_links[shotId] || null,
      directorPrompt: (directorShotId) => board.project.shots.find((shot) => shot.id === directorShotId)?.prompt || "",
      formalDraft: (directorId) => project.shot_drafts?.[directorId] || null,
      formalGuidance: guidanceFor,
      onFormalGuidanceChange: (directorId, changes) => {
        session.shotGuidance.set(directorId, { ...(session.shotGuidance.get(directorId) || {}), ...changes });
      },
      formalContextSummary: (shotId) => {
        const directorId = project.handoff.director_links[shotId],
          index = board.project.shots.findIndex((shot) => shot.id === directorId),
          directorShot = board.project.shots[index];
        if (!directorShot) return {};
        const contextBoard = { project: board.project, assistant: project },
          values = guidanceFor(directorId), state = shotDialogueState(contextBoard, directorShot),
          payload = buildShotAssistRequest(contextBoard, directorShot, "", values),
          source = values.dialogueSource === "seed" || values.dialogueSource === "formal" ? values.dialogueSource : state.source;
        return {
          taskType: directorShot.task_type, audioPolicy: payload.context.audio_policy,
          hasPreviousShot: index > 0, previousTitle: index > 0 ? board.project.shots[index - 1].title : "",
          structured: state.structured,
          dialogueSource: source === "seed" ? "创作原句" : "正式提示词",
          formalDialogueCount: state.formal.length, seedDialogueCount: state.seed.length,
          formalDialogue: state.formal, seedDialogue: state.seed,
          dialogue: payload.context.dialogue,
          durationMs: directorShot.duration_ms,
          materialCount: payload.context.bindings.filter((binding) => binding.kind !== "audio").length,
          materialNames: payload.context.bindings.filter((binding) => binding.kind !== "audio")
            .map((binding) => binding.name),
          audio: payload.context.bindings.filter((binding) => binding.kind === "audio")
            .map((binding) => `${binding.name}${binding.range_ms ? ` · ${binding.range_ms.start / 1000}–${binding.range_ms.end / 1000}秒` : " · 完整音频"}`).join("；"),
        };
      },
      formalFingerprint: (shotId) => {
        const directorId = project.handoff.director_links[shotId], directorShot = board.project.shots.find((shot) => shot.id === directorId);
        return directorShot ? shotAssistFingerprint({ project: board.project, assistant: project }, directorShot,
          { ...guidanceFor(directorId), skillId: session.shotStyles.get(`director:${directorId}`) || "free" }) : "";
      },
      formalCandidateErrors: (shotId, prompt, expectedDialogue) => {
        const directorId = project.handoff.director_links[shotId], directorShot = board.project.shots.find((shot) => shot.id === directorId);
        return directorShot
          ? executionPromptErrors(
            { project: board.project, assistant: project }, { ...directorShot, prompt }, expectedDialogue,
          )
          : ["关联的导演台分镜不存在"];
      },
      buildFormalRequest: (shotId, instruction, skillId) => {
        const directorId = project.handoff.director_links[shotId], directorShot = board.project.shots.find((shot) => shot.id === directorId);
        if (!directorShot) throw new Error("关联的导演台分镜不存在。");
        const draft = project.shot_drafts?.[directorId];
        const draftInstruction = draft ? [
          `原始创意与设定：${draft.original_idea}`,
          `当前镜已采用剧情：${draft.text}`, instruction,
        ].filter(Boolean).join("\n\n") : instruction;
        return buildShotAssistRequest(
          { project: board.project, assistant: project }, directorShot, draftInstruction, { ...guidanceFor(directorId), skillId },
        );
      },
      directorProject: () => board.project,
      applyDirectorPrompt: writePromptToDirector,
      commitDirectorProject: (next) => {
        board.project = next;
        board.update();
        if (directorOnly && board.flash) board.flash("已采用当前镜提示词");
        else board.notice("已写入导演台当前分镜提示词。");
        return board.project;
      },
    });
  }
  modal.body.append(host);
  modal.element.addEventListener("keydown", (event) => {
    if (!directorOnly && event.altKey && ["1", "2", "3"].includes(event.key)) {
      event.preventDefault(); pageHandle?.save?.();
      const nextTab = CREATIVE_TABS[Number(event.key) - 1][0];
      if (activeTab !== nextTab) navigationRevision += 1;
      activeTab = nextTab; draw();
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      const send = modal.element.querySelector(".zcw-assist-send:not(:disabled)");
      if (send) { event.preventDefault(); send.click(); }
    }
  });
  draw(); board.focus(modal.element);
  return modal;
}
