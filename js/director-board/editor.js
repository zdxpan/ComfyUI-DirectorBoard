import {
  ALLOWED, ASPECT_RATIOS, MEDIA_LIMITS, MEGAPIXEL_PRESETS, OPS, REQUIRED, ROLE_KIND,
  ROLE_LIMITS, ROLE_NAME, TASKS, TASK_SLOTS, bindingForSlot, blank,
  canvasSizeFor, creativeAssetTokens, danglingTags, deep, defaultShot, nearestMegapixel,
  isTaggedRole, normalizePromptMentions, officialSlots, promptTags, read, uid, validate,
  NO_TEXT_PROMPT_SUFFIX, canPassThroughAudio, effectiveAudioPolicy,
} from "./model.js";
import { button as btn, el, inputViewUrl as viewUrl, seconds as sec } from "./ui.js";
import {
  applyAudioToExistingShots, applyShotFields, audioPreparationCuts, mediaRangeErrors,
  normalizeSourceRanges, previewAudioForShots, replaceShotsFromAudio, syncShotSourceRanges,
} from "./project-operations.js";
import { renderTimelineWorkspace } from "./timeline-workspace.js?audio-shortcut=5";
import {
  mediaUploadKey, pauseResultVideos, releaseResultVideos, renderMediaWorkspace, renderResultWall,
  renderShotViewSwitch,
} from "./media-workspace.js";
import { openQuickShotAssistant } from "./quick-shot-assistant.js";
import { PROMPT_ELEMENTS, insertPromptAtSelection } from "./prompt-elements.js";
import { handoffCreativeAsset } from "./agent/director-handoff.js";
import { createTokenEditor } from "./token-editor.js?asset-mention=2";
import {
  createDispatchPanel, openShotParamsModal, renderGlobalParams, renderShotParams,
} from "./dispatch.js";
import { createAudioPreview, openTrimEditor, probeMedia } from "./video-workspace.js";
import { assistantStatus, openCreativeAssistant, readAssistant } from "./agent-index.js";
import { writeAssistant } from "./agent/storage.js";
import { removeDirectorShotDrafts } from "./agent/workspace.js";

const TEMPLATES = {
  "景别": [["全景", "全景构图，清楚交代人物与环境关系。", "Wide shot establishing the subject and environment."], ["中景", "中景构图，兼顾人物动作与表情。", "Medium shot balancing action and expression."], ["近景", "近景构图，突出人物情绪和关键动作。", "Close shot emphasizing emotion and key action."], ["特写", "特写构图，聚焦关键细节。", "Close-up focused on the key detail."]],
  "人物动作": [["行走", "人物自然向前行走。", "The subject walks forward naturally."], ["转身", "人物缓慢转身看向镜头。", "The subject slowly turns toward the camera."], ["奔跑", "人物快速向前奔跑。", "The subject runs forward quickly."]],
  "镜头运动": [["固定", "固定机位，画面稳定。", "Static camera, stable framing."], ["推进", "镜头缓慢推进主体。", "The camera slowly pushes toward the subject."], ["跟拍", "镜头横向跟随主体移动。", "The camera tracks the subject laterally."], ["环绕", "镜头平滑环绕主体。", "The camera smoothly orbits the subject."]],
  "视觉速度": [["缓慢", "动作和镜头节奏缓慢、克制。", "Slow, restrained action and camera pacing."], ["正常", "动作和镜头保持自然速度。", "Natural action and camera speed."], ["快速", "动作和镜头节奏快速、有冲击力。", "Fast, impactful action and camera pacing."]],
  "场景变化": [["渐变", "场景自然渐变为新的环境。", "The scene naturally transitions into a new environment."], ["昼夜", "场景从白昼过渡到夜晚。", "The scene transitions from day to night."], ["天气", "环境天气逐渐发生变化。", "The weather gradually changes."]],
  "商品展示": [["特写", "商品特写，突出材质与细节。", "Close-up product shot emphasizing texture and detail."], ["旋转", "商品缓慢旋转展示完整外观。", "The product slowly rotates to reveal its full appearance."], ["使用", "人物自然演示商品使用过程。", "The subject naturally demonstrates the product in use."]],
  "对白口型": [["中文", "人物自然说：<d>[Chinese] [对白]</d>。", "The subject naturally says: <d>[Chinese] [dialogue]</d>."], ["英文", "人物自然说：<d>[English] [dialogue]</d>。", "The subject naturally says: <d>[English] [dialogue]</d>."]],
  "风格转换": [["动漫", "保持构图与动作，转换为精致动漫风格。", "Preserve composition and motion, transform into polished anime style."], ["电影", "保持主体一致，增强电影级光影与质感。", "Preserve subject identity and enhance cinematic lighting and texture."], ["3D", "保持画面内容，转换为高质量 3D 渲染风格。", "Preserve scene content and transform into high-quality 3D rendering."]],
};
const AUDIO_POLICY_OPTIONS = [
  ["generated", "使用生成音频"],
  ["passthrough", "输入原声"],
  ["mute", "静音"],
];
export const PROJECT_MODES = [
  ["free", "自由分镜"],
  ["mv", "MV"],
  ["long_video_edit", "长视频编辑"],
];


export { el };
export function affectedShotTitles(shots, assetId) {
  return shots.filter((shot) =>
    shot.bindings.some((binding) => binding.asset_id === assetId)
  ).map((shot) => shot.title);
}
export function shotTimelineSegments(shots) {
  const total = Math.max(
    1,
    shots.reduce((sum, shot) => sum + shot.duration_ms, 0),
  );
  let cursor = 0;
  return shots.map((shot) => {
    const start = cursor;
    cursor += shot.duration_ms;
    return {
      shot,
      start,
      end: cursor,
      left: start / total * 100,
      width: shot.duration_ms / total * 100,
    };
  });
}
export function timelineTickStep(totalMs, widthPx) {
  const targetTicks = Math.max(2, Math.floor(widthPx / 110)),
    rawSeconds = totalMs / 1000 / targetTicks,
    magnitude = 10 ** Math.floor(Math.log10(Math.max(rawSeconds, 0.001))),
    normalized = rawSeconds / magnitude,
    nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude * 1000;
}
export function widget(node) {
  return (node.widgets || []).find((w) => w.name === "project_json");
}

export function ensureDirectorBoardStyle() {
  const id = "zdx-director-board-style";
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  // 改了样式就抬版本号：ComfyUI 的静态资源会被浏览器缓存，不抬的话用户看到的还是旧 CSS
  // （时间轴轨道那次"黑带"就有这个可能：旧版轨道底色是 #0e1520，和 seed 下拉同色）。
  link.href = new URL("./style.css?v=36", import.meta.url).href;
  document.head.append(link);
}

export class Board {
  constructor(node, root) {
    this.node = node;
    this.root = root;
    this.overlay = null;
    this.shellHost = null;
    this.modalLayer = null;
    this.modals = [];
    this.raw = widget(node)?.value || JSON.stringify(blank());
    ({ project: this.project, error: this.error } = read(this.raw));
    this.wall = false;
    // 素材区的两个视图：「输入」= 上传/绑定素材，「结果」= 生成结果（决策 12）
    this.mainView = "editor";
    this.resultFilter = "all";
    this.mediaViewByShot = new Map();
    this.resultVideoByShot = new Map();
    this.uploadingMedia = new Map();
    this.activeTemplate = null;
    this.promptTool = null;
    this.promptSelections = new Map();
    this.promptLanguage = "zh";
    this.activeShotOption = null;
    this.globalAudioOpen = false;
    this.slicer = { kind: null, assetId: null, durationMs: 0, selectedRange: null };
    this.mediaDurations = new Map();
    this.timelineFit = false;
    this.timelineScrollLeft = 0;
    this.timelineAnchor = null;
    this.timelineFocusShot = this.project?.selected_shot_id || null;
    this.deleteConfirmShot = null;
    this.overviewSelection = new Set();
    this.overviewAnchor = null;
    this.pendingFocus = null;
    this.flashMessage = "";
    this.flashTimer = null;
    this.audioReplacementUndo = null;
    this.dispatch = null;
    this.assistant = readAssistant(node);
    this.entry();
  }
  selected() {
    return this.project?.shots.find((s) =>
      s.id === this.project.selected_shot_id
    );
  }
  dispatchBusy() {
    return Boolean(this.dispatch?.isBusy?.() ?? (
      this.dispatch?.isRunning?.() || this.dispatch?.isPaused?.()
    ));
  }
  asset(id) {
    return this.project?.assets.find((a) => a.id === id);
  }
  total() {
    return this.project?.shots.reduce((n, s) => n + s.duration_ms, 0) || 0;
  }
  save() {
    if (this.error) return;
    this.writeProject();
  }
  writeProject() {
    const w = widget(this.node), value = JSON.stringify(this.project);
    w.value = value;
    w.callback?.(value);
    this.node.setDirtyCanvas?.(true, true);
  }
  update() {
    // A later edit makes the one-use replacement snapshot stale.
    this.audioReplacementUndo = null;
    this.save();
    this.overlay ? this.draw() : this.entry();
  }
  flash(message, timeoutMs = 3000) {
    clearTimeout(this.flashTimer);
    this.flashMessage = String(message || "");
    this.draw();
    const current = this.flashMessage;
    this.flashTimer = setTimeout(() => {
      if (this.flashMessage !== current) return;
      this.flashMessage = "";
      this.flashTimer = null;
      this.draw();
    }, timeoutMs);
  }
  /** Paint high-frequency ComfyUI sampling progress without rebuilding the editor. */
  renderDispatchProgress(run) {
    if (!run || !this.overlay) return;
    const percent = run.max ? Math.round(run.value / run.max * 100) : 0;
    const card = this.overlay.querySelector(`[data-shot-id="${run.shotId}"]`);
    card?.classList.add("zdb-running");
    const cardProgress = card?.querySelector?.(".zdb-time-state.is-running > i");
    if (cardProgress) cardProgress.style.width = `${percent}%`;
    const timelineLive = this.overlay.querySelector(".zdb-timeline-live");
    if (timelineLive) timelineLive.textContent = `${run.index + 1}/${run.batchTotal} · ${run.label} 生成中`;
    const selected = this.selected();
    const send = this.overlay.querySelector(".zdb-send");
    if (!send) return;
    const isCurrent = selected?.id === run.shotId;
    send.disabled = !isCurrent;
    if (!isCurrent) return;
    const batch = run.batchTotal > 1;
    send.classList.add("is-running");
    send.style.setProperty("--zdb-progress", `${percent}%`);
    send.textContent = "■";
    send.setAttribute("aria-label", batch ? "停止队列" : "停止生成");
    send.title = batch ? `停止队列（${run.index + 1}/${run.batchTotal}）` : "停止生成";
  }
  reload() {
    this.raw = widget(this.node)?.value || "";
    ({ project: this.project, error: this.error } = read(this.raw));
    this.assistant = readAssistant(this.node);
    this.timelineFocusShot = this.project?.selected_shot_id || null;
    this.overviewSelection.clear();
    this.overviewAnchor = null;
    this.mediaViewByShot.clear();
    releaseResultVideos(this);
    this.overlay ? this.draw() : this.entry();
  }
  entry() {
    const text = this.error
      ? "项目 JSON 需要修复"
      : `${this.project.project.title} · ${this.project.shots.length} 个分镜 · ${
        sec(this.total())
      }`;
    this.root.replaceChildren(
      el(
        "div",
        { class: "zdb-entry" },
        el("strong", { text: "导演台" }),
        el("small", { text }),
        btn("打开导演台", () => this.open()),
        btn("创作工作台", () => {
          this.open();
          queueMicrotask(() => openCreativeAssistant(this).catch((error) => this.notice(error.message)));
        }, "zdb-sub"),
        el("small", { class: "zdb-muted", text: assistantStatus(this.assistant) }),
      ),
    );
  }
  open() {
    if (this.overlay) return;
    this.before = document.activeElement;
    this.overlay = el("div", {
      class: "zdb-overlay",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "导演台",
      onkeydown: (e) => this.key(e),
      onclick: (e) => this.dismissPopovers(e),
    });
    this.shellHost = el("div", { class: "zdb-shell-host" });
    this.modalLayer = el("div", { class: "zdb-modal-layer" });
    this.overlay.append(this.shellHost, this.modalLayer);
    document.body.append(this.overlay);
    this.draw();
    this.focus(this.overlay);
  }
  close() {
    while (this.modals.length) {
      const top = this.modals.at(-1);
      top.close();
      if (this.modals.at(-1) === top) return false;
    }
    pauseResultVideos(this);
    this.overlay?.remove();
    this.overlay = null;
    this.shellHost = null;
    this.modalLayer = null;
    this.modals = [];
    this.entry();
    this.before?.focus?.();
    return true;
  }
  dispose() {
    clearTimeout(this.flashTimer);
    releaseResultVideos(this);
    this.mediaViewByShot.clear();
    this.overlay?.remove();
    this.overlay = null;
    this.shellHost = null;
    this.modalLayer = null;
    this.modals = [];
  }
  key(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      const top = this.modals.at(-1);
      if (top) {
        top.close();
        return;
      }
      if (this.dispatch?.isLogOpen?.()) {
        this.dispatch.closeLog();
        this.overlay?.querySelector(".zdb-dispatch-summary")?.focus?.();
        return;
      }
      if (this.deleteConfirmShot) {
        this.deleteConfirmShot = null;
        this.draw();
        return;
      }
      if (this.globalAudioOpen || this.activeShotOption || this.activeTemplate) {
        this.globalAudioOpen = false;
        this.activeShotOption = null;
        this.activeTemplate = null;
        this.draw();
        return;
      }
      this.close();
      return;
    }
    if (e.key !== "Tab") return;
    const host = this.modals.at(-1)?.element || this.overlay,
      all = [
        ...host.querySelectorAll(
          'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ),
      ].filter((x) => x.offsetParent !== null);
    if (!all.length) return;
    if (e.shiftKey && document.activeElement === all[0]) {
      e.preventDefault();
      all.at(-1).focus();
    } else if (!e.shiftKey && document.activeElement === all.at(-1)) {
      e.preventDefault();
      all[0].focus();
    }
  }
  focus(host) {
    queueMicrotask(() =>
      host.querySelector(
        'button,input,select,textarea,[tabindex]:not([tabindex="-1"])',
      )?.focus()
    );
  }
  draw() {
    const previous = this.overlay?.querySelector(".zdb-timeline-scroll");
    if (previous) this.timelineScrollLeft = previous.scrollLeft;
    this.shellHost?.replaceChildren(this.error ? this.invalid() : this.shell());
    queueMicrotask(() => {
      this.restoreTimelineView();
      if (!this.pendingFocus) return;
      const target = this.overlay?.querySelector(this.pendingFocus);
      this.pendingFocus = null;
      target?.focus?.();
    });
  }
  dismissPopovers(event) {
    const target = event.target;
    if (this.dispatch?.isLogOpen?.() && !target.closest?.(".zdb-dispatch-bar")) {
      this.dispatch.closeLog();
    }
    if (this.globalAudioOpen && !target.closest?.(".zdb-global-audio-menu")) {
      this.globalAudioOpen = false;
      this.draw();
      return;
    }
    if (this.activeShotOption && !target.closest?.(".zdb-shot-options")) {
      this.activeShotOption = null;
      this.draw();
      return;
    }
    if (this.activeTemplate && !target.closest?.(".zdb-template-anchor")) {
      this.activeTemplate = null;
      this.draw();
    }
  }
  invalid() {
    return el(
      "section",
      { class: "zdb-invalid" },
      el("h2", { text: "项目 JSON 无法打开" }),
      el("p", { class: "zdb-error", text: this.error }),
      el("p", {
        class: "zdb-muted",
        text: "无效内容保持原样；请在 project_json 修复后重新打开。",
      }),
      el("pre", { text: this.raw }),
      btn("关闭", () => this.close()),
    );
  }
  shell() {
    if (!this.dispatch) {
      this.dispatch = createDispatchPanel(this);
    }
    return el(
      "section",
      { class: "zdb-shell" },
      this.header(),
      el("main", { class: "zdb-main" },
        this.wall ? this.cards() : this.mainView === "results" ? renderResultWall(this) : this.focusPanel()),
      this.timeline(),
      this.dispatch.bar,
    );
  }
  header() {
    const shot = this.selected();
    const position = Math.max(0, this.project.shots.indexOf(shot)) + 1;
    return el(
      "header",
      { class: "zdb-header" },
      el("h2", { text: "导演台" }),
      el("span", { class: "zdb-header-project", text: this.project.project.title }),
      el("span", { class: "zdb-header-shot", text: `${position}/${this.project.shots.length} 镜` }),
      shot ? renderShotViewSwitch(this, shot) : null,
      shot ? this.audioControl(shot) : null,

      this.flashMessage ? el("span", {
        class: "zdb-flash", role: "status", "aria-live": "polite", text: this.flashMessage,
      }) : null,
      btn(`${this.project.canvas.aspect_ratio} · ${this.project.canvas.width}×${this.project.canvas.height}`, () => this.openCanvasPicker(), "zdb-canvas-summary zdb-sub"),
      el("span", { class: "zdb-grow" }),
      btn(
        this.mainView === "results"
          ? "返回编辑"
          : `结果墙${Object.keys(this.project.shot_results || {}).length ? ` · ${Object.keys(this.project.shot_results).length}` : ""}`,
        () => {
          this.wall = false;
          this.mainView = this.mainView === "results" ? "editor" : "results";
          this.draw();
        },
        this.mainView === "results" ? "zdb-active" : "zdb-sub",
      ),
      btn("创作工作台", () => openCreativeAssistant(this).catch((error) => this.notice(error.message)), "zdb-sub"),
      this.audioReplacementUndo ? btn("撤销分镜替换", () => this.undoAudioReplacement(), "zdb-sub") : null,
      btn("参数", () => this.openSettings(), "zdb-sub"),
      btn("关闭", () => this.close(), "zdb-sub"),
    );
  }
  audioControl(shot = null) {
    const allowed = canPassThroughAudio(this.project, shot);
    const select = el("select", { "aria-label": shot ? "当前镜头输出声音" : "默认声音" },
      ...AUDIO_POLICY_OPTIONS.map(([value, text]) => el("option", {
        value, text, disabled: value === "passthrough" && !allowed,
      })));
    select.value = effectiveAudioPolicy(this.project, shot);
    select.title = allowed ? "选择输出声音" : "上传并绑定原音频后可选择输入原声";
    select.addEventListener("change", () => {
      if (select.value === "passthrough" && !canPassThroughAudio(this.project, shot)) return;
      if (shot) {
        if (select.value === effectiveAudioPolicy(this.project)) delete shot.audio_policy;
        else shot.audio_policy = select.value;
      } else this.project.global.audio_policy = select.value;
      this.update();
    });
    return el("label", { class: shot ? "zdb-header-audio" : "zdb-field" },
      el("span", { text: shot ? "输出声音" : "默认声音" }), select);
  }
  openSettings() {
    const modal = this.modal("参数与批量应用");
    const render = () => {
      const shot = this.selected();
      modal.body.replaceChildren(
        this.projectStatus(),
        this.audioControl(),
        el("div", { class: "zdb-settings-panels" },
          renderGlobalParams(this, render),
          shot ? renderShotParams(this, shot, render) : null),
        btn("批量应用镜头设置", () => { modal.close(); this.global(); }, "zdb-sub"),
        el("p", { class: "zdb-muted", text: "修改即时保存。默认声音用于没有单独设置声音的分镜。" }));
    };
    render();
    modal.footer.replaceChildren(btn("完成", () => { modal.close(); this.draw(); }, "zdb-sub"));
    this.focus(modal.element);
  }
  openAudioPreparation() {
    const starter = this.project.shots.length === 1 && (() => {
      const shot = this.project.shots[0];
      return shot.title === "分镜 1" && shot.task_type === "text_to_video" &&
        shot.duration_ms === 5000 && !shot.prompt && !shot.bindings.length;
    })();
    const state = {
      assetId: this.globalAudioAsset()?.id || this.project.assets.find((asset) =>
        asset.kind === "audio" && asset.scope === "global")?.id || "",
      mode: starter ? "new" : "existing",
      strategy: "approx", seconds: 15, count: 2,
    }, modal = this.modal("音频准备"), probed = new Set();
    modal.element.classList.add("zdb-audio-preparation");
    const selectedAsset = () => this.asset(state.assetId);
    const render = () => {
      const asset = selectedAsset(), duration = this.audioDuration(asset?.id),
        available = this.project.assets.filter((item) => item.kind === "audio" && item.scope === "global"),
        preview = state.mode === "existing" && asset
          ? previewAudioForShots(this.project, asset, duration) : null,
        cuts = state.mode === "new" && asset
          ? audioPreparationCuts(duration, state) : [],
        oldLocalCount = this.project.assets.filter((item) => item.scope === "shot").length;
      const choose = el("select", {
        "aria-label": "选择已有音频",
        onchange: (event) => { state.assetId = event.target.value; render(); },
      }, el("option", { value: "", text: "选择已有全局音频" }),
      ...available.map((item) => el("option", { value: item.id, text: item.name || item.input_path })));
      choose.value = state.assetId;
      const source = el("div", { class: "zdb-audio-prep-source" },
        choose,
        btn("上传音频", () => this.upload(null, null, "audio", null, (uploaded) => {
          if (modal.closed) return;
          state.assetId = uploaded.id;
          render();
        }), "zdb-sub"),
      );
      const contents = [source];
      if (asset) {
        contents.push(el("div", { class: "zdb-audio-prep-player" },
          el("span", { text: `${asset.input_path.split("/").at(-1)} · ${duration ? sec(duration) : "读取时长中"}` }),
          createAudioPreview(this, asset)));
        if (!duration) {
          const metadataAudio = el("audio", {
            preload: "metadata", src: viewUrl(asset.input_path), "aria-hidden": "true",
            onloadedmetadata: (event) => {
              const measured = Math.round(Number(event.target.duration || 0) * 1000);
              if (modal.closed || measured <= 0 || state.assetId !== asset.id || asset.duration_ms === measured) return;
              asset.duration_ms = measured;
              this.writeProject();
              render();
            },
          });
          contents.push(metadataAudio);
          if (!probed.has(asset.id)) {
            probed.add(asset.id);
            probeMedia(asset).then((info) => {
              if (modal.closed || !info?.duration_ms || state.assetId !== asset.id) return;
              asset.duration_ms = Math.round(info.duration_ms);
              this.writeProject();
              render();
            });
          }
        }
      }
      contents.push(el("div", { class: "zdb-audio-prep-modes" },
        btn("按已有分镜切分", () => { state.mode = "existing"; render(); }, state.mode === "existing" ? "zdb-active" : "zdb-sub"),
        btn("按音频新建分镜", () => { state.mode = "new"; render(); }, state.mode === "new" ? "zdb-active" : "zdb-sub"),
      ));
      if (state.mode === "new") {
        const value = state.strategy === "approx" ? state.seconds : state.count;
        contents.push(el("div", { class: "zdb-audio-prep-controls" },
          btn("每段约", () => { state.strategy = "approx"; render(); }, state.strategy === "approx" ? "zdb-active" : "zdb-sub"),
          btn("均分", () => { state.strategy = "equal"; render(); }, state.strategy === "equal" ? "zdb-active" : "zdb-sub"),
          el("label", {}, el("span", { text: state.strategy === "approx" ? "秒" : "段" }),
            el("input", {
              class: "zdb-small", type: "number", min: 1, step: 1, value,
              "aria-label": state.strategy === "approx" ? "每段秒数" : "均分段数",
              onchange: (event) => {
                if (state.strategy === "approx") state.seconds = Number(event.target.value);
                else state.count = Number(event.target.value);
                render();
              },
            })),
        ));
      }
      if (!asset) contents.push(el("p", { class: "zdb-muted", text: "先上传或选择一条全局音频。" }));
      else if (!duration) contents.push(el("p", { class: "zdb-error", text: "尚未读到音频时长；请等待加载或更换音频。" }));
      else if (state.mode === "existing") {
        contents.push(el("div", { class: "zdb-audio-prep-rows" },
          ...preview.rows.map((row) => el("div", {
            class: `zdb-audio-prep-row ${row.reason ? "zdb-audio-prep-blocked" : ""}`,
          },
          el("b", { text: row.shot.title }),
          el("span", { text: `${sec(row.start)}–${sec(row.end)}` }),
          el("span", { text: row.reason || (row.current ? "覆盖原有驱动音频关联" : "完整覆盖") }),
          )),
        ));
        if (preview.unusedMs) contents.push(el("p", { class: "zdb-muted", text: `未使用尾段：${sec(preview.unusedMs)}` }));
      } else {
        contents.push(el("p", { class: "zdb-muted", text: `用 ${Math.max(0, cuts.length - 1)} 段替换当前 ${this.project.shots.length} 镜；新镜头不会继承旧镜头的提示词或绑定。` }));
        if (oldLocalCount) contents.push(el("p", { class: "zdb-muted", text: `旧镜头专属素材记录 ${oldLocalCount} 项将随旧镜头移出当前素材库；全局素材保留。` }));
        contents.push(el("div", { class: "zdb-audio-prep-rows" },
          ...cuts.slice(1).map((end, index) => el("div", { class: "zdb-audio-prep-row" },
            el("b", { text: `新镜 ${index + 1}` }),
            el("span", { text: `${sec(cuts[index])}–${sec(end)}` }),
            el("span", { text: end - cuts[index] < 2000 ? "短尾段保留；生成沿用现有帧对齐，实际时长可能偏离" : "保留该段" }),
          )),
        ));
      }
      modal.body.replaceChildren(...contents);
      const canApply = Boolean(asset && duration && (state.mode === "existing" ? preview.canApply : cuts.length > 1));
      const apply = btn(state.mode === "existing" ? `应用到 ${this.project.shots.length} 镜` : `替换为 ${Math.max(0, cuts.length - 1)} 镜`, () => {
        if (this.dispatchBusy()) return this.notice("生成队列运行中，暂不能修改分镜。");
        try {
          if (state.mode === "existing") {
            this.project = applyAudioToExistingShots(this.project, asset, this.audioDuration(asset.id));
            modal.close();
            this.update();
            this.flash("音频已应用；添加配图后，可为当前分镜写提示词。", 5000);
          } else {
            const candidate = replaceShotsFromAudio(this.project, asset, cuts);
            this.confirm("替换当前分镜", `确定用 ${candidate.shots.length} 段替换当前 ${this.project.shots.length} 镜吗？旧镜头及其结果将从当前项目移除。`, () => {
              const previous = deep(this.project);
              this.project = candidate;
              this.mediaViewByShot.clear();
              releaseResultVideos(this);
              modal.close();
              this.update();
              this.audioReplacementUndo = previous;
              this.draw();
              this.flash("分镜已按音频创建；添加配图后，可为当前分镜写提示词。", 5000);
            });
          }
        } catch (error) { this.notice(`音频准备未应用：${error.message}`); }
      });
      if (!canApply || this.dispatchBusy()) apply.setAttribute("disabled", "");
      modal.footer.replaceChildren(btn("取消", modal.close, "zdb-sub"), apply);
    };
    render();
    this.focus(modal.element);
  }
  undoAudioReplacement() {
    if (!this.audioReplacementUndo || this.dispatchBusy()) return;
    const previous = this.audioReplacementUndo;
    this.audioReplacementUndo = null;
    this.project = previous;
    this.mediaViewByShot.clear();
    releaseResultVideos(this);
    this.update();
  }
  openCanvasPicker() {
    const c = this.project.canvas,
      m = this.modal("画幅与分辨率");
    let ratio = c.aspect_ratio,
      megapixels = nearestMegapixel(c.width, c.height);
    const render = () => {
      const [width, height] = canvasSizeFor(ratio, megapixels);
      m.body.replaceChildren(
        el("section", { class: "zdb-canvas-picker" },
          el("span", { class: "zdb-muted", text: "选择比例" }),
          el("div", { class: "zdb-ratio-options" }, ...ASPECT_RATIOS.map((value) => {
            const [wide, high] = value.split(":").map(Number);
            return el("button", {
              type: "button",
              class: `zdb-ratio-option ${value === ratio ? "zdb-active" : ""}`,
              onclick: () => {
                ratio = value;
                render();
              },
            },
            el("i", { style: `aspect-ratio:${wide}/${high}` }),
            el("span", { text: value }));
          })),
          el("span", { class: "zdb-muted", text: "选择分辨率" }),
          el("div", { class: "zdb-megapixel-options" }, ...MEGAPIXEL_PRESETS.map(([value]) => {
            const [w, h] = canvasSizeFor(ratio, value);
            return btn(`${value}MP\n${w}×${h}`, () => {
              megapixels = value;
              render();
            }, value === megapixels ? "zdb-active" : "zdb-sub");
          })),
          el("div", { class: "zdb-canvas-result", text: `当前：${ratio} · ${width}×${height}` }),
        ),
      );
    };
    render();
    m.footer.append(btn("应用", () => {
      c.aspect_ratio = ratio;
      [c.width, c.height] = canvasSizeFor(ratio, megapixels);
      m.close();
      this.update();
    }));
    this.focus(m.element);
  }
  projectStatus() {
    const errors = [...validate(this.project), ...this.mediaRangeErrors()];
    return el("span", {
      class: errors.length ? "zdb-project-status zdb-status-error" : "zdb-project-status zdb-status-good",
      text: errors.length ? `需修复 ${errors.length} 项` : "配置有效",
      title: errors.length
        ? errors.join(" ")
        : "项目 JSON、素材绑定和任务必填项均有效，可由下游节点读取。",
    });
  }
  focusPanel() {
    const s = this.selected(), hasResult = Boolean(
      this.project.shot_results?.[s.id] || this.dispatch?.getFailures?.().has(s.id)
    ), mediaView = this.mediaViewByShot.get(s.id) || (hasResult ? "result" : "input");
    const showResult = hasResult && mediaView === "result";
    return el("section", { class: `zdb-focus${showResult ? " zdb-focus-split" : ""}` },
      el("section", { class: `zdb-workspace zdb-composer ${TASK_SLOTS[s.task_type].length ? "" : "zdb-no-media"}` },
        this.library({ view: "input" }), this.editor(s, this.shotControls(s))),
      showResult ? el("aside", { class: "zdb-result-side", "aria-label": "当前镜头结果" },
        renderMediaWorkspace(this, s, { view: "result" })) : null);
  }
  shotControls(s) {
    const title = el("input", { value: s.title, "aria-label": "分镜名称" });
    title.addEventListener("change", () => { s.title = title.value; this.update(); });
    const titleField = el("details", { class: "zdb-compact-control zdb-shot-title" },
      el("summary", { text: s.title || "未命名分镜" }),
      el("div", { class: "zdb-compact-popover" }, title));
    const taskField = this.select("任务", s.task_type, TASKS, (v) => this.task(s, v));
    taskField.classList.add("zdb-shot-task");
    return [titleField, taskField, this.duration(s)];
  }
  task(s, v) {
    const requiredImages = v === "first_last_frame" ? 2 : v === "image_to_video" ? 1 : 0;
    if (s.task_type === "reference_video" && requiredImages && s.bindings.length === requiredImages
      && s.bindings.every((binding) => binding.role === "reference_image"
        && this.asset(binding.asset_id)?.kind === "image")) {
      const images = [...s.bindings].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      s.task_type = v;
      s.bindings = images.map((binding, index) => ({ ...binding,
        role: index === 0 ? "first_frame" : "last_frame", order: 0 }));
      if (/<(?:Picture|Subject)\s+\d+>/i.test(s.prompt)) {
        this.flash?.("图片已保留；原多参考标签在新模式不适用，请检查提示词。", 5000);
      }
      return;
    }
    s.task_type = v;
    if (v === "video_to_video") s.operation = s.operation || "edit";
    else {
      delete s.operation;
      s.unselected_policy = "skip";
    }
    s.bindings = s.bindings.filter((b) => ALLOWED[v].includes(b.role));
  }
  duration(s) {
    const input = el("input", {
      type: "number", min: "0.001", step: "0.1", value: String(s.duration_ms / 1000),
      class: "zdb-duration-input", "aria-label": "精确时长（秒）",
    });
    const slider = el("input", { type: "range", min: "2", max: "15", step: "0.5",
      value: String(Math.max(2, Math.min(15, s.duration_ms / 1000))), "aria-label": "调整时长" });
    const apply = (value) => {
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds <= 0) return;
      s.duration_ms = Math.max(1, Math.round(seconds * 1000));
      this.syncRange(s);
      this.update();
    };
    input.addEventListener("change", () => { slider.value = String(Math.max(2, Math.min(15, Number(input.value)))); });
    slider.addEventListener("input", () => { input.value = slider.value; });

    return el("details", { class: "zdb-compact-control zdb-duration" },
      el("summary", { text: `时长 · ${sec(s.duration_ms)}` }),
      el("div", { class: "zdb-compact-popover" }, slider,
        el("label", { class: "zdb-field" }, el("span", { text: "精确秒数" }), input),
        btn("应用时长", () => apply(input.value), "zdb-sub")));
  }
  editor(s, shotControls = []) {
    const text = el("textarea", {
      class: "zdb-prompt-input",
      value: s.prompt,
      placeholder: "描述画面、动作、镜头……输入 @ 引用参考素材",
    });
    this.promptSelections ||= new Map();
    const savedSelection = this.promptSelections.get(s.id);
    if (savedSelection) { text.selectionStart = savedSelection.start; text.selectionEnd = savedSelection.end; }
    const rememberSelection = () => this.promptSelections.set(s.id, { start: text.selectionStart, end: text.selectionEnd });
    ["select", "keyup", "mouseup", "input", "blur"].forEach((event) => text.addEventListener(event, rememberSelection));
    const states = el("div", { class: "zdb-prompt-state" });
    // 文本即真相（§10.12）：textarea 里写的就是官方标签，引用预览单独显示在下方。
    let refreshAfterMention = false;
    const token = createTokenEditor(text, {
      slots: () =>
        officialSlots(s, this.project.assets).map((slot) => ({
          ...slot,
          ...this.promptPreview(slot.asset),
        })),
      unbound: () =>
        this.bindable(s).map((asset) => ({
          ...asset,
          ...this.promptPreview(asset),
        })),
      libraryAssets: () => this.creativeMentionAssets(s),
      bindAsset: async (asset, source) => {
        if (source === "creative") {
          try {
            const tag = s.task_type === "text_to_video"
              ? await this.confirmCreativeReferenceConversion(s, asset)
              : this.bindCreativeMention(s, asset);
            refreshAfterMention = Boolean(tag);
            return tag;
          } catch (error) { this.notice(error.message); return null; }
        }
        if (asset?._requiresTaskConversion) {
          return this.confirmReferenceConversion(s, asset).then((tag) => {
            refreshAfterMention = Boolean(tag);
            return tag;
          });
        }
        return this.promptTagFor(s, asset, { bind: true });
      },
      onMentionInserted: (asset, tag) => {
        if (!refreshAfterMention) return;
        refreshAfterMention = false;
        if (asset?.asset_id) {
          const escaped = String(asset.asset_id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          text.value = text.value.replace(new RegExp(`<asset:${escaped}>`, "gi"), tag);
          s.prompt = text.value;
        }
        this.update();
      },
      // 老写法 `@素材名` 粘进来 → 官方标签；其余原样
      normalizeText: (raw) => normalizePromptMentions({ ...s, prompt: raw }, this.project.assets),
    });
    const progress = this.dispatch?.getProgress?.();
    const runningThisShot = progress?.shotId === s.id;
    const stoppingLabel = progress?.batchTotal > 1 ? "停止队列" : "停止生成";
    // Sending belongs to the writing surface itself: the user finishes the
    // prompt where they wrote it, instead of searching the timeline for a
    // second primary action.  Bulk execution remains in the timeline menu.
    token.element.append(el("button", {
      type: "button",
      class: `zdb-send ${runningThisShot ? "is-running" : ""}`,
      text: runningThisShot ? "■" : "↑",
      "aria-label": runningThisShot ? stoppingLabel : "生成当前镜",
      title: runningThisShot ? stoppingLabel : "生成当前镜",
      style: runningThisShot && progress?.max ? `--zdb-progress:${Math.round(progress.value / progress.max * 100)}%` : null,
      disabled: this.dispatchBusy() && !runningThisShot,
      onclick: () => runningThisShot ? this.dispatch?.cancelCurrent() : this.dispatch?.runCurrent(),
    }));
    token.element.addEventListener("input", () => {
      s.prompt = text.value;
      this.save();
      this.renderMentionState(s, states);
    });
    this.renderMentionState(s, states);
    const templateAnchor = el(
      "div",
      { class: "zdb-template-anchor" },
      this.promptHead(s),
      this.activeTemplate ? this.templateOptions(s) : null,
    );
    return el(
      "section",
      { class: "zdb-prompt-panel zdb-composer-prompt" },
      templateAnchor,
      token.element,
      states,
      this.shotOptions(s, shotControls),
    );
  }
  insertPrompt(s, text) {
    const result = insertPromptAtSelection(s.prompt, text, this.promptSelections?.get(s.id));
    s.prompt = result.value;
    this.promptSelections ||= new Map();
    this.promptSelections.set(s.id, { start: result.caret, end: result.caret });
    this.activeTemplate = null;
    this.pendingFocus = ".zdb-prompt-input";
    this.update();
  }
  promptHead(s) {
    const tool = this.promptTool;
    const names = tool === "quick" ? ["景别", "镜头运动", "视觉速度", "风格转换"]
      : tool === "words" ? ["人物", "环境", "人物动作", "场景变化", "时间"]
        : tool === "more" ? ["光线", "情绪", "收束", "商品展示", "对白口型"] : [];
    return el("div", { class: "zdb-row zdb-prompt-head" },
      ...[["quick", "快捷提示词"], ["words", "加个词"], ["more", "更多表达"]].map(([id, label]) => el("button", {
        type: "button", class: `zdb-btn ${tool === id ? "zdb-active" : "zdb-sub"}`, text: label,
        "aria-expanded": String(tool === id), onclick: () => {
          this.promptTool = tool === id ? null : id; this.activeTemplate = null; this.draw();
        },
      })),
      el("span", { class: "zdb-grow" }),
      btn(s.task_type === "audio_driven" ? "用音频和配图写提示词" : "单镜助手", () => openQuickShotAssistant(this), "zdb-sub"),
      tool ? el("div", { class: "zdb-prompt-categories" },
        ...names.map((name) => btn(name, () => {
          this.activeTemplate = this.activeTemplate === name ? null : name; this.draw();
        }, this.activeTemplate === name ? "zdb-active" : "zdb-sub")),
        tool === "quick" ? btn("无字幕", () => this.insertPrompt(s, NO_TEXT_PROMPT_SUFFIX), "zdb-sub") : null,
        btn(this.promptLanguage === "en" ? "EN" : "中", () => {
          this.promptLanguage = this.promptLanguage === "en" ? "zh" : "en"; this.draw();
        }, "zdb-sub")) : null);
  }
  templateOptions(s) {
    const entries = TEMPLATES[this.activeTemplate] || PROMPT_ELEMENTS[this.activeTemplate] || [];
    return el("div", { class: "zdb-template-options" },
      el("span", { class: "zdb-muted", text: `${this.activeTemplate} · 插入光标处` }),
      ...entries.map(([label, zh, en]) => btn(label, () => {
        this.insertPrompt(s, this.promptLanguage === "en" ? en : zh);
      }, "zdb-sub")));
  }
  shotOptions(s, shotControls = []) {
    const tempoPresets = [
      ["柔和", 15, 24],
      ["标准", 24, 24],
      ["动感", 30, 30],
      ["慢镜", 48, 24],
    ];
    const motion = Number(s.motion_fps ?? 24);
    const output = Number(s.output_fps ?? motion);
    const groups = [
      [
        "tempo",
        "帧率节奏",
        tempoPresets.map(([label, motionFps, outputFps]) => [`${motionFps}:${outputFps}`, label]),
        (value, shot) => {
          const [nextMotion, nextOutput] = value.split(":").map(Number);
          shot.motion_fps = nextMotion;
          shot.output_fps = nextOutput;
        },
      ],
    ];
    if (s.task_type === "video_to_video") {
      groups.push(["operation", "视频操作", OPS, (value, shot) => shot.operation = value]);
    }
    const valueOf = (key) => {
      if (key === "tempo") return `${motion}:${output}`;
      if (key === "operation") return s.operation;
      return "";
    };
    const labelOf = ([key, label, items]) => {
      const current = items.find(([value]) => value === valueOf(key));
      return `${label} · ${current?.[1] ?? (key === "tempo" ? "自定义" : valueOf(key))}`;
    };
    const active = groups.find(([key]) => key === this.activeShotOption),
      copyControl = btn("复制", () => this.duplicate(), "zdb-sub");
    copyControl.disabled = this.dispatchBusy();
    return el("section", { class: "zdb-shot-options" },
      el("div", { class: "zdb-row" },
        ...shotControls,
        ...groups.map((group) => {
          const [key] = group;
          return el("button", {
            type: "button",
            class: `zdb-btn ${this.activeShotOption === key ? "zdb-active" : "zdb-sub"}`,
            text: labelOf(group),
            "data-shot-option": key,
            "aria-expanded": this.activeShotOption === key ? "true" : "false",
            onclick: () => {
              const opening = this.activeShotOption !== key;
              this.activeShotOption = opening ? key : null;
              this.draw();
              queueMicrotask(() => this.overlay?.querySelector(
                opening ? ".zdb-shot-option-list button" : `[data-shot-option="${key}"]`,
              )?.focus());
            },
          });
        }),
        btn("高级", () => openShotParamsModal(this, s), "zdb-sub"),
        el("span", { class: "zdb-fps-note", text: `${motion}→${output}fps` }),
        el("span", { class: "zdb-grow" }),
        copyControl,
        this.deleteControl(s),
      ),
      active ? el("div", { class: "zdb-shot-option-list" },
        ...active[2].map(([value, label]) => {
          const choice = btn(label, () => {
          active[3](value, s);
          const key = active[0];
          this.activeShotOption = null;
          this.update();
          queueMicrotask(() => this.overlay?.querySelector(`[data-shot-option="${key}"]`)?.focus());
          }, valueOf(active[0]) === value ? "zdb-active" : "zdb-sub");
          return choice;
        })) : null);
  }
  library(options) {
    return renderMediaWorkspace(this, this.selected(), options);
  }
  /** 单镜结果留在当前镜；整片拼装结果进入全局结果墙。 */
  showResults(shotId = null) {
    this.wall = false;
    if (shotId) {
      this.mediaViewByShot.set(shotId, "result");
      this.mainView = "editor";
    } else this.mainView = "results";
    this.update();
  }
  /** 点「引用」：把该素材的官方标签追加进提示词（没有槽位就先占一个）。 */
  mentionAsset(a) {
    const s = this.selected();
    if (!s || !a) return;
    const tag = this.promptTagFor(s, a, { bind: true });
    if (!tag) {
      return this.notice(
        a.kind === "audio"
          ? "当前任务没有可用的音频参考槽位（每镜最多 3 个音频）。"
          : "当前任务没有可用的参考槽位（每镜最多 6 图、2 视频）。",
      );
    }
    s.prompt = `${s.prompt}${s.prompt && !/\s$/.test(s.prompt) ? " " : ""}${tag} `;
    this.update();
  }
  visibleAssets(s) {
    return this.project.assets.filter((a) =>
      a.scope === "global" || a.owner_shot_id === s.id
    );
  }
  /** 提示词装饰/下拉里的预览：图片 `<img>`、视频 `<video>` 首帧，音频留空走类型图标。 */
  promptPreview(asset) {
    if (asset?.kind === "image") return { thumb: viewUrl(asset.input_path) };
    if (asset?.kind === "video") return { video: viewUrl(asset.input_path) };
    return {};
  }
  /**
   * `@` 下拉里"未绑定"那一档：本镜可见、还能占一个参考槽的图片/视频。
   *
   * 已经有槽位的走 `slots()`，音频与已满的参考图不列出来——
   * 列出来也插不进标签（官方按提交顺序编号），点了没反应比不列更糟。
   */
  bindable(s) {
    const slotted = new Set(s.bindings.map((binding) => binding.asset_id));
    return this.visibleAssets(s).filter((asset) =>
      !slotted.has(asset.id) &&
      (this.taggedRoles(s, asset).length > 0 || this.canConvertToReference(s, asset))
    ).map((asset) => this.taggedRoles(s, asset).length
      ? asset
      : { ...asset, _requiresTaskConversion: true });
  }
  creativeMentionAssets(s) {
    const creative = this.node ? readAssistant(this.node) : this.assistant;
    if (!creative) return [];
    this.assistant = creative;
    const canAdd = s.task_type === "reference_video"
      ? this.canBind(s, { kind: "image" }, "reference_image")
      : s.task_type === "text_to_video" && !s.bindings.length;
    if (!canAdd) return [];
    const bound = new Set(s.bindings.map((binding) => this.asset(binding.asset_id)?.creative_asset_id).filter(Boolean));
    return creative.assets.filter((asset) => asset.image_path && !bound.has(asset.asset_id))
      .map((asset) => ({ ...asset, thumb: viewUrl(asset.image_path) }));
  }
  bindCreativeMention(s, creativeAsset) {
    const creative = this.node ? readAssistant(this.node) : this.assistant;
    if (!creative?.assets.some((asset) => asset.asset_id === creativeAsset.asset_id && asset.image_path)) {
      throw new Error("当前项目资产已变化，请重新输入 @ 搜索。");
    }
    const draft = deep(this.project), draftShot = draft.shots.find((shot) => shot.id === s.id);
    const ordered = draftShot.bindings.filter((binding) => binding.role === "reference_image")
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    ordered.forEach((binding, index) => { binding.order = index; });
    const result = handoffCreativeAsset(draft, creative, s.id, creativeAsset.asset_id, "reference_image", ordered.length);
    const updated = result.project.shots.find((shot) => shot.id === s.id);
    Object.assign(s, updated);
    result.project.shots = result.project.shots.map((shot) => shot.id === s.id ? s : shot);
    this.project = result.project;
    this.assistant = creative;
    this.save();
    return result.tag;
  }
  confirmCreativeReferenceConversion(s, asset) {
    return new Promise((resolve) => {
      const modal = this.modal("切换为多参考生成");
      let confirmed = false;
      modal.body.append(el("p", {
        text: `引用“${asset.name || asset.asset_id}”需要把当前文生视频切换为多参考生成。取消不会修改分镜。`,
      }));
      modal.setCloseHandler(() => { if (!confirmed) resolve(null); return true; });
      modal.footer.append(btn("确认切换并引用", () => {
        const previous = s.task_type;
        s.task_type = "reference_video";
        let tag = null;
        try { tag = this.bindCreativeMention(s, asset); }
        catch (error) { this.notice(error.message); }
        if (!tag) s.task_type = previous;
        confirmed = true;
        modal.close();
        resolve(tag);
      }, "zdb-danger"));
      this.focus(modal.element);
    });
  }
  canConvertToReference(s, asset) {
    return s.task_type === "text_to_video" && !s.bindings.length &&
      ["image", "video", "audio"].includes(asset.kind);
  }
  confirmReferenceConversion(s, asset) {
    return new Promise((resolve) => {
      const modal = this.modal("切换为多参考生成");
      let confirmed = false;
      modal.body.append(el("p", {
        text: `引用“${asset.name || asset.id}”需要把当前文生视频切换为多参考生成，并新增一个参考 Binding。取消不会修改分镜。`,
      }));
      modal.setCloseHandler(() => {
        if (!confirmed) resolve(null);
        return true;
      });
      modal.footer.append(btn("确认切换并引用", () => {
        const before = { taskType: s.task_type, bindings: deep(s.bindings) };
        s.task_type = "reference_video";
        const cleanAsset = { ...asset };
        delete cleanAsset._requiresTaskConversion;
        const tag = this.promptTagFor(s, cleanAsset, { bind: true });
        if (!tag) {
          s.task_type = before.taskType;
          s.bindings = before.bindings;
        }
        confirmed = true;
        modal.close();
        resolve(tag || null);
      }, "zdb-danger"));
      this.focus(modal.element);
    });
  }
  /** 这个素材在当前任务下**能拿到官方号**的候选角色（音频这类没有号的角色不在此列）。 */
  taggedRoles(s, asset) {
    return this.choices(s, asset, null).filter((role) => isTaggedRole(role));
  }
  /**
   * 素材的官方标签（`<Picture i>` / `<Video k>`）。
   *
   * `bind` 为真时先给它占一个参考槽——`@` 下拉里选未绑定素材走这条路：
   * 官方是按**提交顺序**编号的，所以"没绑定的素材"根本排不上号，必须先占位再引用。
   * 返回 null 表示这个素材当前任务形态下没有可用槽位（音频 / 参考图已满）。
   */
  promptTagFor(s, asset, { bind = false } = {}) {
    const slotTag = () =>
      officialSlots(s, this.project.assets).find((slot) => slot.asset.id === asset.id)?.tag ?? null;
    const existing = slotTag();
    if (existing) return existing;
    if (!bind) return null;
    if (s.bindings.some((binding) => binding.asset_id === asset.id)) return null;
    // 先挑一个能拿到号的角色再占位：挑不到就什么都不做，
    // 不留"引用不到、运行时才报错"的绑定（音频就是这种）。
    const role = this.taggedRoles(s, asset)[0];
    if (!role) return null;
    s.bindings.push({
      id: uid("binding"),
      asset_id: asset.id,
      role,
      order: s.bindings.filter((b) => b.role === role).length,
      origin: "manual",
      ...(["source_audio", "source_video"].includes(role)
        ? { range_ms: { start: 0, end: s.duration_ms } }
        : {}),
    });
    return slotTag();
  }
  renderMentionState(s, host) {
    // 状态条只报"异常与无号输入"：带官方号的槽位不在这里重复列——
    // 提示词里标签前的缩略图、素材框上的号牌已经把它说清楚了，同一份映射不摆第三遍。
    const slots = officialSlots(s, this.project.assets),
      tagged = new Set(slots.map((slot) => slot.asset.id)),
      untagged = s.bindings
        .filter((binding) => !tagged.has(binding.asset_id))
        .map((binding) => ({ binding, asset: this.asset(binding.asset_id) }))
        .filter((item) => item.asset),
      unresolved = creativeAssetTokens(s.prompt),
      dangling = danglingTags(s, this.project.assets),
      missing = this.missingRequirements(s),
      errors = [...validate(this.project), ...this.mediaRangeErrors()],
      others = Math.max(0, errors.length - missing.length);
    const nodes = [
      ...untagged.map(({ binding, asset }) => el("span", {
        class: "zdb-state-slot",
        title: `${ROLE_NAME[binding.role] || binding.role} · 没有官方标签，提示词里引用不到它`,
      }, this.thumb(asset), el("b", { text: asset.name || asset.id }))),
      ...(slots.length || untagged.length || unresolved.length
        ? []
        : [el("span", { class: "zdb-state-idle", text: "尚无引用" })]),
      unresolved.length
        ? el("span", {
          class: "zdb-state-missing",
          text: `待确认 ${unresolved.join(" ")}`,
          title: "请从创作资产选择对应图片，确认后会转换成正式 Picture 标签。",
        })
        : null,
      dangling.length
        ? el("span", {
          class: "zdb-state-missing",
          text: `失效 ${dangling.join(" ")}`,
          title: "提示词里的标签对不上任何参考槽：槽位被删了或还没绑定。文本不动，按需自己改。",
        })
        : null,
      missing.length
        ? el("span", {
          class: "zdb-state-missing",
          text: `缺 ${missing.join("、")}`,
          title: errors.join(" ") || `分镜 ${s.id} 需要 ${missing.join("、")}`,
        })
        : null,
      others
        ? el("span", {
          class: "zdb-state-missing",
          text: `其他 ${others} 项问题`,
          title: errors.join(" "),
        })
        : null,
      !s.selected_for_generation ? this.policySelect(s) : null,
    ].filter(Boolean);
    host.replaceChildren(...nodes);
  }
  missingRequirements(s) {
    const required = REQUIRED[s.task_type] || {}, missing = [];
    for (const [role, count] of Object.entries(required)) {
      const have = s.bindings.filter((binding) => binding.role === role).length;
      if (have >= count) continue;
      const gap = count - have;
      missing.push(gap === 1 ? ROLE_NAME[role] : `${ROLE_NAME[role]}×${gap}`);
    }
    return missing;
  }
  policySelect(s) {
    const select = el("select", {
      class: "zdb-num",
      "aria-label": "\u672a\u751f\u6210\u65f6",
    },
    el("option", { value: "skip", text: "\u672a\u751f\u6210\u65f6\u8df3\u8fc7" }),
    el("option", { value: "passthrough", text: "\u672a\u751f\u6210\u65f6\u539f\u6837\u901a\u8fc7" }));
    select.value = s.unselected_policy;
    select.addEventListener("change", () => {
      s.unselected_policy = select.value;
      this.update();
    });
    return s.task_type === "video_to_video" ? select : null;
  }
  removeSlotBinding(s, binding) {
    if (!binding) return;
    // 删除参考图：**文本不动**（§10.12）。序号是位置不是身份，改写文本反而会让
    // 剩下的标签静默指向别的素材；这里只把槽位摘掉，提示词里的标签随之变成"失效"。
    // 不额外弹提示：状态条立刻就会列出失效的标签，弹窗只会打断编辑，而且删除会让
    // 后面的槽位递补，弹窗里报"旧号失效"反而会指错号。
    s.bindings = s.bindings.filter((item) => item.id !== binding.id);
    this.update();
  }
  replaceSlotAsset(s, asset, kind, target) {
    if (asset.scope !== "global") {
      this.upload(asset, s.id, kind, target);
      return;
    }
    const affected = affectedShotTitles(this.project.shots, asset.id);
    this.confirm(
      "替换全局素材",
      affected.length
        ? `替换“${asset.name}”会同步影响 ${affected.length} 个分镜：${affected.join("、")}。`
        : `替换全局素材“${asset.name}”？`,
      () => this.upload(asset, null, kind, target),
    );
  }
  audioDuration(assetId) {
    return this.mediaDurations.get(assetId) ?? this.asset(assetId)?.duration_ms ?? 0;
  }
  rememberDuration(assetId, media, redraw = true) {
    const value = Math.round(Number(media.duration || 0) * 1000);
    if (!value || this.mediaDurations.get(assetId) === value) return;
    this.mediaDurations.set(assetId, value);
    const asset = this.asset(assetId);
    if (asset) asset.duration_ms = value;
    const shortened = normalizeSourceRanges(this.project, assetId, value);
    // Persist the probed duration even when it reveals an invalid range. The
    // Python node will then reject execution instead of seeing stale JSON.
    this.writeProject();
    if (redraw) this.draw();
    if (shortened.length && redraw) {
      this.notice(
        `${shortened.map((shot) => `“${shot.title}”`).join("、")} 已按素材实际长度调整为 ${
          sec(value)
        }。`,
      );
    }
  }
  mediaRangeErrors() {
    return mediaRangeErrors(this.project, (assetId) => this.audioDuration(assetId));
  }
  openShotAudioEditor(shot, asset, binding) {
    openTrimEditor(this, shot, asset, binding);
  }
  thumb(a) {
    if (!a) return el("span", { class: "zdb-thumb zdb-muted", text: "缺失" });
    if (a.kind === "image") {
      return el("img", {
        class: "zdb-thumb",
        src: viewUrl(a.input_path),
        alt: a.name || "图片",
      });
    }
    if (a.kind === "video") {
      return el("video", {
        class: "zdb-thumb",
        src: viewUrl(a.input_path),
        muted: true,
      });
    }
    return el("span", { class: "zdb-thumb zdb-audio-thumb", text: "音频" });
  }
  canBind(s, a, role, replacing = null) {
    const rest = s.bindings.filter((b) => b !== replacing),
      kind = { image: 0, video: 0, audio: 0 },
      roles = {};
    for (const b of rest) {
      const asset = this.asset(b.asset_id);
      if (asset) kind[asset.kind]++;
      roles[b.role] = (roles[b.role] || 0) + 1;
    }
    const maximum = MEDIA_LIMITS[a.kind] || 0;
    if (kind[a.kind] >= maximum) return false;
    if ((roles[role] || 0) >= (ROLE_LIMITS[role] || 0)) return false;
    return true;
  }
  choices(s, a, replacing) {
    return ALLOWED[s.task_type].filter((r) =>
      ROLE_KIND[r] === a.kind && this.canBind(s, a, r, replacing)
    );
  }
  async upload(existing = null, owner = null, forcedKind = null, target = null, onUploaded = null) {
    const pick = el("input", {
      type: "file",
      accept: forcedKind ? `${forcedKind}/*` : "image/*,video/*,audio/*",
      multiple: existing || onUploaded ? null : true,
    });
    pick.addEventListener("change", () =>
      this.uploadFiles(pick.files, existing, owner, forcedKind, target, onUploaded)
    );
    pick.click();
  }
  async uploadFiles(files, existing = null, owner = null, forcedKind = null, target = null, onUploaded = null) {
      for (const file of files || []) {
        const kind = file.type.startsWith("image/")
          ? "image"
          : file.type.startsWith("video/")
          ? "video"
          : file.type.startsWith("audio/")
          ? "audio"
          : null;
        if (!kind) {
          this.notice(`不支持“${file.name}”。`);
          continue;
        }
        if (forcedKind && kind !== forcedKind) {
          this.notice(`该槽位只能上传${forcedKind === "image" ? "图片" : forcedKind === "video" ? "视频" : "音频"}。`);
          continue;
        }
        if (existing && kind !== existing.kind) {
          this.notice(`“${existing.name}”只能由同类素材替换。`);
          continue;
        }
        const form = new FormData();
        form.append("image", file);
        const uploadKey = mediaUploadKey(owner, kind, target || { role: existing?.id || "asset" });
        this.uploadingMedia.set(uploadKey, { name: file.name });
        this.draw();
        try {
          const res = await fetch("/upload/image", {
              method: "POST",
              body: form,
            }),
            data = await res.json();
          if (!res.ok || !data.name) throw Error(data.error || "上传失败");
          const a = {
              id: existing?.id || uid("asset"),
              kind,
              input_path: data.subfolder
                ? `${data.subfolder}/${data.name}`
                : data.name,
              name: existing?.name || this.nextAssetName(kind, owner),
              scope: existing?.scope || (owner ? "shot" : "global"),
            },
            ownerId = existing?.owner_shot_id || owner;
          if (ownerId) a.owner_shot_id = ownerId;
        if (existing) {
            Object.assign(existing, a, { id: existing.id });
            delete existing.duration_ms;
            this.mediaDurations.delete(existing.id);
            if (kind !== "image") {
              const bound = this.project.shots.flatMap((shot) =>
                shot.bindings.filter((binding) => binding.asset_id === existing.id)
                  .map((binding) => ({ shot, binding }))
              );
              // One editor only: a global asset can back many shots and opening
              // an editor per binding would stack modals on top of each other.
              if (bound.length) this.openShotAudioEditor(bound[0].shot, existing, bound[0].binding);
            }
          }
          else {
            this.project.assets.push(a);
            let created = null;
            if (owner) {
              const s = this.project.shots.find((shot) => shot.id === owner);
              const role = target?.role || (s && this.choices(s, a, null)[0]);
              if (role) {
                const order = target?.order ?? s.bindings.filter((b) => b.role === role).length;
                s.bindings = s.bindings.filter((b) => !(b.role === role && b.order === order));
                const binding = {
                id: uid("binding"), asset_id: a.id, role,
                order,
                origin: "manual",
                ...(["source_audio", "source_video"].includes(role)
                  ? { range_ms: { start: 0, end: s.duration_ms } } : {}),
                };
                s.bindings.push(binding);
                if (["source_audio", "source_video"].includes(role)) created = { shot: s, binding };
              }
            }
            if (created) {
              // Ask for the segment right away: the shot duration follows the
              // chosen range, so there is no padding step to reconcile later.
              this.openShotAudioEditor(created.shot, a, created.binding);
            }
          }
          onUploaded?.(a);
        } catch (e) {
          this.notice(`上传“${file.name}”失败：${e.message}`);
        } finally {
          this.uploadingMedia.delete(uploadKey);
        }
      }
      this.update();
  }
  nextAssetName(kind, owner) {
    const prefix = `${owner ? "" : "全局"}${kind === "image" ? "图片" : kind === "video" ? "视频" : "音频"}`;
    const count = this.project.assets.filter((a) =>
      a.kind === kind && (owner ? a.owner_shot_id === owner : a.scope === "global")
    ).length;
    return `${prefix}${count + 1}`;
  }
  cards() {
    const selected = [...this.overviewSelection].filter((id) => this.project.shots.some((shot) => shot.id === id));
    const locked = this.dispatchBusy();
    const batch = (value) => {
      if (locked) return;
      for (const shot of this.project.shots) {
        if (this.overviewSelection.has(shot.id)) shot.selected_for_generation = value;
      }
      this.update();
    };
    return el(
      "section",
      { class: "zdb-card zdb-wall-panel" },
      el("div", { class: "zdb-overview-toolbar" },
        el("h3", { text: "分镜总览" }),
        el("span", { class: "zdb-muted", text: selected.length ? `已选 ${selected.length} 镜` : "选择镜头后批量操作" }),
        el("span", { class: "zdb-grow" }),
        btn("全选", () => { this.overviewSelection = new Set(this.project.shots.map((shot) => shot.id)); this.draw(); }, "zdb-sub"),
        btn("取消选择", () => { this.overviewSelection.clear(); this.overviewAnchor = null; this.draw(); }, "zdb-sub"),
        btn("参与生成", () => batch(true), "zdb-sub"),
        btn("设为已排除", () => batch(false), "zdb-sub"),
        btn("删除选中", () => {
          if (!selected.length || locked) return;
          this.confirm("删除分镜", `确认删除选中的 ${selected.length} 个分镜？`, () => this.deleteShots(selected), true);
        }, "zdb-danger"),
        btn("清空分镜", () => {
          if (locked) return;
          const ids = this.project.shots.map((shot) => shot.id);
          this.confirm(
            "清空分镜",
            `确认删除全部 ${ids.length} 个分镜及对应结果？剧本、全局资产和磁盘文件不会删除。`,
            () => this.deleteShots(ids),
            true,
          );
        }, "zdb-danger"),
        btn("新增镜头", () => this.add(), "zdb-sub")),
      el(
        "div",
        { class: "zdb-wall" },
        ...this.project.shots.map((s, i) => this.card(s, i, true)),
      ),
    );
  }
  globalAudioAsset() {
    const selected = this.selected(),
      selectedBinding = selected?.bindings.find((binding) =>
        binding.role === "source_audio" && this.asset(binding.asset_id)?.scope === "global"
      );
    if (selectedBinding) return this.asset(selectedBinding.asset_id);
    return this.project.assets.find((asset) =>
      asset.scope === "global" && asset.kind === "audio" &&
      this.project.shots.some((shot) => shot.bindings.some((binding) =>
        binding.asset_id === asset.id && binding.role === "source_audio"
      ))
    ) || null;
  }
  timelineTotalMs(asset = this.globalAudioAsset()) {
    const rangeEnd = asset
      ? Math.max(
        0,
        ...this.project.shots.flatMap((shot) => shot.bindings.filter((binding) =>
          binding.asset_id === asset.id && binding.role === "source_audio" && binding.range_ms
        ).map((binding) => binding.range_ms.end)),
      )
      : 0;
    return Math.max(this.total(), this.audioDuration(asset?.id), rangeEnd, 1);
  }
  timelineMetrics(asset = this.globalAudioAsset()) {
    const totalMs = this.timelineTotalMs(asset),
      previous = this.overlay?.querySelector(".zdb-timeline-scroll"),
      viewport = Math.max(640, previous?.clientWidth || (this.overlay?.clientWidth || 1200) - 28),
      naturalWidth = this.project.shots.length * 148,
      width = this.timelineFit ? viewport : Math.max(viewport, naturalWidth);
    return { asset, totalMs, width };
  }
  toggleTimelineFit() {
    this.timelineFit = !this.timelineFit;
    this.timelineScrollLeft = 0;
    this.timelineAnchor = null;
    this.draw();
  }
  restoreTimelineView() {
    const scroll = this.overlay?.querySelector(".zdb-timeline-scroll");
    if (!scroll) return;
    if (this.timelineFocusShot) {
      const card = scroll.querySelector(`[data-shot-id="${this.timelineFocusShot}"]`);
      if (card) {
        scroll.scrollLeft = Math.max(
          0,
          card.offsetLeft + card.offsetWidth / 2 - scroll.clientWidth / 2,
        );
      }
    } else if (this.timelineAnchor !== null) {
      scroll.scrollLeft = Math.max(
        0,
        this.timelineAnchor * scroll.scrollWidth - scroll.clientWidth / 2,
      );
    } else {
      scroll.scrollLeft = Math.min(
        this.timelineScrollLeft,
        Math.max(0, scroll.scrollWidth - scroll.clientWidth),
      );
    }
    this.timelineScrollLeft = scroll.scrollLeft;
    this.timelineFocusShot = null;
    this.timelineAnchor = null;
  }
  timelineShotTrack(metrics) {
    const segments = this.project.shots.map((shot, index, shots) => ({
      shot, start: index, end: index + 1, left: index / shots.length * 100, width: 100 / shots.length,
    }));
    const track = el("div", { class: "zdb-shot-track" });
    segments.forEach((segment, index) => {
      const pixelWidth = metrics.width * segment.width / 100;
      track.append(this.card(segment.shot, index, false, {
        ...segment, detail: pixelWidth < 78 ? "compact" : pixelWidth < 150 ? "standard" : "detailed",
      }));
      const selected = segment.shot.id === this.project.selected_shot_id;
      if (index < segments.length - 1 || selected) {
        const nextShot = segments[index + 1]?.shot,
          locked = this.dispatchBusy();
        track.append(el("div", {
          class: `zdb-timeline-divider ${nextShot?.continuity_from_prev ? "is-continuous" : ""} ${nextShot ? "" : "is-tail"}`,
          style: `left:${segment.left + segment.width}%`,
        },
        nextShot ? el("button", {
          type: "button", class: "zdb-timeline-continuity", text: "↔",
          title: nextShot.continuity_from_prev
            ? `已承接“${segment.shot.title}”的末尾；点击关闭`
            : `让“${nextShot.title}”承接“${segment.shot.title}”的末尾`,
          "aria-label": `帧间连续性：${nextShot.continuity_from_prev ? "已开启" : "已关闭"}`,
          "aria-pressed": nextShot.continuity_from_prev ? "true" : "false",
          disabled: locked,
          onclick: (event) => {
            event.stopPropagation();
            if (this.dispatchBusy()) return;
            nextShot.continuity_from_prev = !nextShot.continuity_from_prev;
            this.update();
          },
        }) : null,
        selected ? el("button", {
          type: "button", class: "zdb-timeline-insert", text: "+",
          title: `在“${segment.shot.title}”后插入分镜`,
          "aria-label": `在${segment.shot.title}后插入分镜`,
          disabled: locked,
          onclick: (event) => {
            event.stopPropagation();
            if (!this.dispatchBusy()) this.insertAfter(index);
          },
        }) : null));
      }
    });
    return track;
  }
  timelineRuler(metrics) {
    const step = timelineTickStep(metrics.totalMs, metrics.width), ticks = [];
    for (let at = 0; at <= metrics.totalMs; at += step) {
      ticks.push(el("span", {
        class: "zdb-time-tick",
        style: `left:${at / metrics.totalMs * 100}%`,
        text: sec(at),
      }));
    }
    if (!ticks.length || ticks.at(-1).textContent !== sec(metrics.totalMs)) {
      ticks.push(el("span", {
        class: "zdb-time-tick zdb-time-tick-end",
        style: "left:100%",
        text: sec(metrics.totalMs),
      }));
    }
    return el("div", { class: "zdb-time-ruler", "aria-hidden": "true" }, ...ticks);
  }
  projectModeControl() {
    const select = el("select", {
      class: "zdb-project-mode-select",
      "aria-label": "项目模式",
    }, ...PROJECT_MODES.map(([value, label]) =>
      el("option", { value, text: label })
    ));
    select.value = PROJECT_MODES.some(([value]) => value === this.project.project.template_id)
      ? this.project.project.template_id : "free";
    select.disabled = this.dispatchBusy();
    select.addEventListener("change", () => {
      if (this.dispatchBusy()) return;
      this.project.project.template_id = select.value;
      this.slicer = { kind: null, assetId: null, durationMs: 0, selectedRange: null };
      this.update();
    });
    return select;
  }
  timeline() {
    return renderTimelineWorkspace(this, () => this.projectModeControl());
  }
  selectShot(id) {
    pauseResultVideos(this);
    this.project.selected_shot_id = id;
    this.activeTemplate = null;
    this.activeShotOption = null;
    this.timelineFocusShot = id;
    // 选中镜头是导航，不应让刚完成的音频替换失去一次撤销机会。
    this.save();
    this.draw();
  }
  toggleOverviewSelection(id, range = false) {
    const index = this.project.shots.findIndex((shot) => shot.id === id);
    if (index < 0) return;
    if (range && Number.isInteger(this.overviewAnchor)) {
      const start = Math.min(this.overviewAnchor, index), end = Math.max(this.overviewAnchor, index);
      for (let cursor = start; cursor <= end; cursor++) this.overviewSelection.add(this.project.shots[cursor].id);
    } else if (this.overviewSelection.has(id)) this.overviewSelection.delete(id);
    else this.overviewSelection.add(id);
    this.overviewAnchor = index;
    this.draw();
  }
  card(s, i, wall = false, segment = null) {
    const shotState = this.dispatch?.getShotState?.(s.id) || { status: "idle", message: "" },
      runningThisShot = segment && shotState.status === "running",
      poster = this.shotPoster(s),
      media = poster?.kind === "image"
        ? el("img", { class: "zdb-card-media", src: viewUrl(poster.input_path), alt: `${s.title} 代表画面` })
        : poster?.kind === "video"
        ? el("video", { class: "zdb-card-media", src: viewUrl(poster.input_path), muted: true, preload: "metadata" })
        : el("span", { class: "zdb-card-empty", text: "尚无画面" }),
      assetCount = new Set([
        ...s.bindings.map((b) => b.asset_id),
        ...this.project.assets.filter((a) => a.owner_shot_id === s.id).map((a) => a.id),
      ]).size;
    const selected = s.id === this.project.selected_shot_id,
      running = shotState.status === "running",
      runDisabled = this.dispatchBusy() && !running;
    return el(
      segment || wall ? "div" : "button",
      {
        ...(segment || wall ? { role: "button", tabindex: "0" } : { type: "button" }),
        class: `zdb-cardshot ${
          selected ? "zdb-active" : ""
        } ${wall ? "zdb-wall-card" : ""} ${segment ? "zdb-time-card" : ""} ${
          wall && this.overviewSelection.has(s.id) ? "zdb-overview-selected" : ""
        } ${segment?.detail ? `is-${segment.detail}` : ""} ${
          s.selected_for_generation ? "" : "zdb-skipped"
        } ${
          shotState.status !== "idle" ? `zdb-shot-${shotState.status}` : ""
        } ${runningThisShot ? "zdb-running" : ""
        }`,
        style: segment
          ? `left:${segment.left}%;width:${segment.width}%`
          : null,
        draggable: wall && !this.dispatchBusy() ? "true" : undefined,
        "data-shot-id": s.id,
        "data-shot-index": i,
        onclick: (event) => {
          if (wall && (event.shiftKey || event.metaKey || event.ctrlKey)) {
            this.toggleOverviewSelection(s.id, event.shiftKey); return;
          }
          this.selectShot(s.id);
        },
        ondragstart: (e) => {
          if (!wall || segment || this.dispatchBusy()) return;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", s.id);
          e.currentTarget.classList.add("zdb-dragging");
        },
        ondragend: (e) => {
          e.currentTarget.classList.remove("zdb-dragging");
          this.overlay?.querySelectorAll(".zdb-dragover").forEach((el) => el.classList.remove("zdb-dragover"));
        },
        ondragover: (e) => {
          if (!wall || segment || this.dispatchBusy()) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          e.currentTarget.classList.add("zdb-dragover");
        },
        ondragleave: (e) => {
          e.currentTarget.classList.remove("zdb-dragover");
        },
        ondrop: (e) => {
          if (!wall || segment || this.dispatchBusy()) return;
          e.preventDefault();
          e.currentTarget.classList.remove("zdb-dragover");
          const fromId = e.dataTransfer.getData("text/plain");
          if (!fromId || fromId === s.id) return;
          const shots = this.project.shots;
          const fromIdx = shots.findIndex((x) => x.id === fromId);
          const toIdx = shots.findIndex((x) => x.id === s.id);
          if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
          const [moved] = shots.splice(fromIdx, 1);
          shots.splice(toIdx, 0, moved);
          shots.forEach((shot) => { shot.continuity_from_prev = false; });
          this.update();
        },
        onkeydown: (e) => {
          if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
          e.preventDefault();
          const nextId = this.project
            .shots[
              (i + (e.key === "ArrowRight" ? 1 : -1) +
                this.project.shots.length) % this.project.shots.length
            ].id;
          this.selectShot(nextId);
        },
      },
      wall ? el("input", {
        type: "checkbox", class: "zdb-overview-check", checked: this.overviewSelection.has(s.id),
        "aria-label": `选择${s.title}`,
        onclick: (event) => { event.stopPropagation(); this.toggleOverviewSelection(s.id, event.shiftKey); },
      }) : null,
      segment ? null : media,
      segment
        ? el("span", { class: "zdb-time-compact", text: String(i + 1) })
        : null,
      segment ? el("span", {
        class: `zdb-time-generation ${s.selected_for_generation ? "is-included" : "is-excluded"}`,
        text: s.selected_for_generation ? "参与" : "已排除",
      }) : null,
      segment && (selected || running) ? el("button", {
        type: "button", class: `zdb-time-run ${running ? "is-running" : ""}`,
        text: running ? "■" : "▶", title: running ? "停止全部" : "运行当前",
        disabled: runDisabled || shotState.status === "blocked",
        onclick: (event) => {
          event.stopPropagation();
          if (runDisabled || shotState.status === "blocked") return;
          running ? this.dispatch?.stopAll() : this.dispatch?.runShot(s.id);
        },
      }) : null,
      segment && shotState.status !== "idle" && shotState.status !== "waiting"
        ? el("span", {
          class: `zdb-time-state is-${shotState.status}`,
          title: shotState.message,
          text: shotState.status === "warning" ? "可降级"
            : shotState.status === "blocked" ? "需处理"
            : shotState.status === "running" ? "生成中"
            : shotState.status === "failed" ? "失败"
            : shotState.status === "completed" ? "已生成"
            : "已停止",
        }, shotState.status === "running" && shotState.max
          ? el("i", { style: `width:${Math.round(shotState.value / shotState.max * 100)}%` }) : null)
        : null,
      wall ? el("span", { class: "zdb-card-index", text: String(i + 1) }) : null,
      !segment || segment.detail !== "compact"
        ? el("b", { class: "zdb-card-title", text: wall ? s.title : `${i + 1}. ${s.title}` }) : null,
      !segment || segment.detail === "detailed" ? el("small", {
        text: `${sec(s.duration_ms)} · ${
          TASKS.find(([id]) => id === s.task_type)?.[1] || s.task_type
        } · ${assetCount} 素材${s.selected_for_generation ? "" : " · 跳过"}`,
      }) : segment?.detail === "standard" ? el("small", { text: sec(s.duration_ms) }) : null,
      wall
        ? el("span", {
          class: "zdb-card-prompt",
          text: s.prompt.trim() || "尚未填写提示词",
        })
        : null,
    );
  }
  shotPoster(s) {
    const preferred = ["first_frame", "reference_image", "source_video", "reference_video", "last_frame"];
    for (const role of preferred) {
      const binding = s.bindings.find((b) => b.role === role), asset = binding && this.asset(binding.asset_id);
      if (asset && ["image", "video"].includes(asset.kind)) return { ...asset, source: "binding" };
    }
    const local = this.project.assets.find((a) =>
      a.owner_shot_id === s.id && ["image", "video"].includes(a.kind)
    );
    return local ? { ...local, source: "shot" } : null;
  }
  add() {
    if (this.dispatchBusy()) return;
    const s = defaultShot(uid("shot"), `分镜 ${this.project.shots.length + 1}`);
    this.project.shots.push(s);
    this.project.selected_shot_id = s.id;
    this.timelineFocusShot = s.id;
    this.update();
  }
  insertAfter(index) {
    if (this.dispatchBusy()) return;
    const formerNext = this.project.shots[index + 1];
    if (formerNext) formerNext.continuity_from_prev = false;
    const s = defaultShot(uid("shot"), `分镜 ${this.project.shots.length + 1}`);
    this.project.shots.splice(Math.max(0, index + 1), 0, s);
    this.project.selected_shot_id = s.id;
    this.timelineFocusShot = s.id;
    this.update();
  }
  duplicate() {
    if (this.dispatchBusy()) return;
    const source = this.selected(), s = deep(source);
    s.id = uid("shot");
    s.title += " 副本";
    const boundAssetIds = new Set(s.bindings.map((binding) => binding.asset_id)), copiedAssetIds = new Map();
    for (const asset of this.project.assets.filter((item) =>
      boundAssetIds.has(item.id) && item.scope === "shot" && item.owner_shot_id === source.id)) {
      const copied = { ...deep(asset), id: uid("asset"), owner_shot_id: s.id };
      this.project.assets.push(copied);
      copiedAssetIds.set(asset.id, copied.id);
    }
    s.bindings = s.bindings.map((b) => ({
      ...b, id: uid("binding"), asset_id: copiedAssetIds.get(b.asset_id) || b.asset_id,
    }));
    s.continuity_from_prev = false;
    this.project.shots.push(s);
    this.project.selected_shot_id = s.id;
    this.timelineFocusShot = s.id;
    this.update();
  }
  deleteControl(s) {
    if (this.dispatchBusy()) {
      return el("span", { class: "zdb-delete-control" },
        el("button", { type: "button", class: "zdb-btn zdb-danger", text: "删除", disabled: true }));
    }
    if (this.deleteConfirmShot !== s.id) {
      return el("span", { class: "zdb-delete-control" },
        btn("删除", () => {
          this.deleteConfirmShot = s.id;
          this.draw();
          this.overlay?.querySelector(".zdb-delete-inline .zdb-btn:last-child")?.focus();
        }, "zdb-danger"));
    }
    return el("span", { class: "zdb-delete-control" },
      el("span", {
        class: "zdb-delete-inline",
        role: "group",
        "aria-label": `确认删除${s.title}`,
      },
      btn("是", () => this.commitDelete(s), "zdb-danger"),
      btn("否", () => {
        this.deleteConfirmShot = null;
        this.draw();
      }, "zdb-sub")),
    );
  }
  commitDelete(s) {
    this.deleteShots([s.id]);
  }
  deleteShots(shotIds) {
    if (this.dispatchBusy()) return;
    const removed = new Set(shotIds || []), firstIndex = this.project.shots.findIndex((shot) => removed.has(shot.id));
    if (firstIndex < 0) return;
    const assistant = readAssistant(this.node);
    if ([...removed].some((id) => Object.hasOwn(assistant.shot_drafts || {}, id))) {
      this.assistant = removeDirectorShotDrafts(assistant, removed);
      writeAssistant(this.node, this.assistant);
    }
    const removedAssetIds = new Set(this.project.assets
      .filter((asset) => asset.scope === "shot" && removed.has(asset.owner_shot_id))
      .map((asset) => asset.id));
    if (removedAssetIds.size) {
      this.project.assets = this.project.assets.filter((asset) => !removedAssetIds.has(asset.id));
      for (const shot of this.project.shots) {
        if (!removed.has(shot.id)) shot.bindings = shot.bindings.filter((binding) => !removedAssetIds.has(binding.asset_id));
      }
    }
    this.project.shots = this.project.shots.filter((shot) => !removed.has(shot.id));
    for (const shot of this.project.shots) shot.continuity_from_prev = false;
    if (this.project.shot_results) {
      for (const id of removed) delete this.project.shot_results[id];
    }
    for (const id of removed) this.mediaViewByShot.delete(id);
    releaseResultVideos(this, removed);
    if (!this.project.shots.length) this.project.shots.push(defaultShot());
    if (removed.has(this.project.selected_shot_id)) {
      this.project.selected_shot_id = this.project.shots[Math.max(0, Math.min(firstIndex, this.project.shots.length - 1))].id;
    }
    this.timelineFocusShot = this.project.selected_shot_id;
    this.deleteConfirmShot = null;
    this.overviewSelection.clear();
    this.overviewAnchor = null;
    this.update();
  }
  syncRange(s) {
    syncShotSourceRanges(s);
  }
  field(label, value, set, type = "text") {
    const input = el("input", { type, value: String(value ?? "") });
    input.addEventListener("change", () => {
      set(input.value);
      this.update();
    });
    return this.wrap(label, input);
  }
  select(label, value, items, set) {
    const control = el(
      "select",
      {},
      ...items.map(([id, name]) => el("option", { value: id, text: name })),
    );
    control.value = value;
    control.addEventListener("change", () => {
      set(control.value);
      this.update();
    });
    return this.wrap(label, control);
  }
  wrap(label, control) {
    return el(
      "label",
      { class: "zdb-field" },
      el("span", { text: label }),
      control,
    );
  }
  global() {
    const m = this.modal("批量应用"),
      source = el(
        "select",
        {},
        ...this.project.shots.map((s) =>
          el("option", { value: s.id, text: s.title })
        ),
      ),
      fields = [
        ["task", "任务、素材与时长"],
        ["prompt", "提示词"],
        ["fps", "帧率节奏"],
      ].map(([name, label]) => ({
        name, label, input: el("input", { type: "checkbox", checked: name === "prompt" }),
      })),
      targets = el("div", { class: "zdb-targets" });
    source.value = this.project.selected_shot_id;
    const drawTargets = () => targets.replaceChildren(...this.project.shots
      .filter((shot) => shot.id !== source.value)
      .map((shot) => el("label", { class: "zdb-check" },
        el("input", { type: "checkbox", value: shot.id, checked: true }),
        el("span", { text: shot.title || shot.id }))));
    source.addEventListener("change", drawTargets);
    drawTargets();
    m.body.append(
      el(
        "section",
        { class: "zdb-card zdb-apply" },
        el("p", { class: "zdb-muted", text: "确认后直接写入目标分镜，不保存隐藏继承规则。" }),
        this.wrap("来源分镜", source),
        el(
          "div",
          { class: "zdb-row" },
          ...fields.map((x) =>
            el("label", { class: "zdb-check" }, x.input, el("span", { text: x.label }))
          ),
        ),
        el("b", { text: "目标分镜" }),
        targets,
      ),
    );
    m.footer.append(btn("应用到分镜", () => {
      const selectedFields = fields.filter((item) => item.input.checked).map((item) => item.name),
        selectedTargets = [...targets.querySelectorAll("input:checked")].map((input) => input.value);
      if (!selectedFields.length) return this.notice("至少选择一项要复制的内容。");
      if (!selectedTargets.length) return this.notice("至少选择一个目标分镜。");
      const candidate = applyShotFields(this.project, source.value, selectedTargets, selectedFields);
      const errors = validate(candidate);
      if (errors.length) {
        return this.notice(`批量应用失败，未修改任何分镜：${errors.join(" ")}`);
      }
      this.project = candidate;
      this.mediaViewByShot.clear();
      releaseResultVideos(this);
      m.close();
      this.update();
    }));
    this.focus(m.element);
  }
  modal(title) {
    const element = el("section", {
        class: "zdb-modal",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": title,
      }),
      header = el("header", { class: "zdb-row zdb-spread" }),
      body = el("div", { class: "zdb-modalbody" }),
      footer = el("footer", { class: "zdb-row" }),
      item = {
        element, header, body, footer, beforeClose: null, closing: false, closed: false,
        close: () => {
          if (item.closing || item.closed) return;
          item.closing = true;
          let thrown = null, allowClose = true;
          try { allowClose = item.beforeClose?.() !== false; }
          catch (error) { thrown = error; }
          if (!allowClose && !thrown) { item.closing = false; return; }
          item.closing = false; item.closed = true; element.remove();
          this.modals = this.modals.filter((x) => x !== item);
          this.focus(this.modals.at(-1)?.element || this.overlay);
          if (thrown) throw thrown;
        },
        setHeader: (...children) => {
          header.replaceChildren(...children, btn("关闭", item.close, "zdb-sub"));
        },
        setCloseHandler: (handler) => { item.beforeClose = typeof handler === "function" ? handler : null; },
      };
    item.setHeader(el("h2", { text: title }));
    element.append(header, body, footer);
    footer.append(btn("取消", item.close, "zdb-sub"));
    this.modals.push(item);
    (this.modalLayer || this.overlay).append(element);
    return item;
  }
  confirm(title, text, action, compact = false) {
    const m = this.modal(title);
    if (compact) m.element.classList.add("zdb-modal-compact");
    m.body.append(el("p", { text }));
    m.footer.append(btn("确认", () => {
      m.close();
      action();
    }, "zdb-danger"));
    this.focus(m.element);
  }
  notice(text) {
    const m = this.modal("提示");
    m.body.append(el("p", { class: "zdb-error", text }));
    this.focus(m.element);
  }
}
