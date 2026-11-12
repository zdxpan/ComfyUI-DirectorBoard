import { el, button as btn } from "./ui.js";
import {
  DEFAULT_DISPATCH_PARAMS,
  REF_IMAGE_SIZES,
  SEED_MODE_LABELS,
  SEED_MODES,
  deep,
  isSafeResultFile,
  resolveActualSeed,
} from "./model.js";
import {
  FILM_MAX_SOURCES,
  FILM_SAVE_ID,
  SHOT_SAMPLE_ID,
  SHOT_SAVE_ID,
  buildFilmPrompt,
  buildShotPrompt,
  resolveAnchorRefs,
} from "./shot-prompt.js";
import { executionPromptErrors } from "./shot-assist.js";
import { buildPreflightPlan, materializeExecutionProject, preflightFingerprint } from "./preflight.js";
import { createComfyExecution } from "./comfy-execution.js";
import { probeOutputMedia } from "./video-workspace.js";

const DEFAULT_PARAMS = { ...DEFAULT_DISPATCH_PARAMS };

const SAMPLERS = ["euler", "euler_ancestral", "heun", "dpm_2", "dpm_2_ancestral", "lms", "dpm_fast", "dpm_adaptive", "dpmpp_2s_ancestral", "dpmpp_sde", "dpmpp_sde_gpu", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_2m_sde_gpu", "dpmpp_3m_sde", "dpmpp_3m_sde_gpu", "ddim", "uni_pc", "uni_pc_bh2"];
const SCHEDULERS = ["beta", "normal", "sgm_uniform", "simple", "ddim_uniform", "karras", "exponential", "sgm_beta"];

export function safeOutputName(value, fallback = "project") {
  const normalized = String(value || "").trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+|\.+$/g, "")
    .replace(/^_|_$/g, "");
  return (normalized || fallback).slice(0, 80);
}

export function projectOutputDirectory(project) {
  const title = safeOutputName(project?.project?.title, "project"),
    id = safeOutputName(project?.project?.id, "project");
  return `${title}__${id}`;
}

export function friendlyExecutionError(error, label = "当前任务") {
  const detail = String(error?.message || error || "未知错误");
  if (/VHS failed to extract audio|audio stream|音轨/i.test(detail)) {
    return `${label}没有音轨，无法按当前方式处理`;
  }
  if (/CUDA out of memory|out of memory/i.test(detail)) {
    return `${label}生成失败：显存不足，请降低分辨率或关闭其它占用后重试`;
  }
  if (/required_input_missing/i.test(detail)) {
    return `${label}缺少工作流必填输入，请检查导演台锚点和拼装节点`;
  }
  return `${label}失败：${detail.split("\n")[0]}`;
}

export function shotExecutionFingerprint(project, shot) {
  const assetIds = new Set((shot?.bindings || []).map((binding) => binding.asset_id));
  const source = JSON.stringify({
    shot,
    assets: (project?.assets || [])
      .filter((asset) => assetIds.has(asset.id))
      .map((asset) => ({
        id: asset.id,
        kind: asset.kind,
        input_path: asset.input_path,
        duration_ms: asset.duration_ms ?? null,
      }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id))),
    canvas: project?.canvas,
    project_template_id: project?.project?.template_id,
    audio_policy: project?.global?.audio_policy,
    ref_image_size: project?.global?.ref_image_size,
    global_dispatch_params: project?.global?.dispatch_params || {},
  });
  let hash = 2166136261;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `v1:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function globalParams(board, project = board.project) {
  return { ...DEFAULT_PARAMS, ...(project.global.dispatch_params || {}) };
}

function shotParams(board, shot, project = board.project) {
  return { ...globalParams(board, project), ...(shot.dispatch_params || {}) };
}

/** Drop keys equal to the baseline so the JSON only stores real overrides. */
function overridesOnly(params, baseline) {
  const diff = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== baseline[key]) diff[key] = value;
  }
  return diff;
}

/**
 * Shared sampler-parameter controls.
 *
 * `baseline` is what the edited scope inherits (global defaults for a shot,
 * hardcoded defaults for the project), so unchanged fields are not written
 * into JSON and inheritance keeps working after an edit.
 */
function renderParamControls(host, params, baseline, onSave) {
  const seedInput = el("input", {
    type: "number",
    value: String(params.seed || 0),
    min: "0",
    style: "width:100%",
  });
  seedInput.addEventListener("change", save);
  const seedField = wrap("Seed", seedInput);

  const stepsInput = el("input", { type: "number", value: String(params.steps), min: "1", max: "100", style: "width:100%" });
  stepsInput.addEventListener("change", save);

  // Denoise 是**预留的扩展位**：当前采样路径从空 AV latent 生成，没有注入原视频 latent，
  // 所以只有 1.0 有意义（<1 等于从被噪声化的空 latent 起步，画面会退化）。
  // 保留这一项是为了以后接"重绘/精修"分支时不用改 UI；届时 <1 才真正生效。
  const denoiseInput = el("input", { type: "number", value: String(params.denoise), min: "0", max: "2", step: "0.05", style: "width:100%" });
  denoiseInput.addEventListener("change", save);

  const samplerSelect = el("select", { style: "width:100%" },
    ...SAMPLERS.map((s) => el("option", { value: s, text: s })),
  );
  samplerSelect.value = params.sampler_name;
  samplerSelect.addEventListener("change", save);

  const schedulerSelect = el("select", { style: "width:100%" },
    ...SCHEDULERS.map((s) => el("option", { value: s, text: s })),
  );
  schedulerSelect.value = params.scheduler;
  schedulerSelect.addEventListener("change", save);

  const latentUpscaleInput = el("input", {
    type: "checkbox", checked: Boolean(params.latent_upscale),
  });
  latentUpscaleInput.addEventListener("change", save);
  const latentUpscaleScaleInput = el("input", {
    type: "number", value: String(params.latent_upscale_scale ?? 1.5),
    min: "1.05", max: "2", step: "0.05", style: "width:100%",
  });
  latentUpscaleScaleInput.addEventListener("change", save);

  const seedModeSelect = el("select", { style: "width:100%" },
    ...SEED_MODES.map((mode) => el("option", { value: mode, text: SEED_MODE_LABELS[mode] })),
  );
  seedModeSelect.value = params.seed_mode;
  seedModeSelect.addEventListener("change", () => {
    syncSeedEnabled();
    save();
  });

  // seed 策略决定这个数值怎么用：random 下它被忽略（§10.4），所以直接禁用输入，
  // 不再保留"固定"复选框——两个控件表达同一件事只会互相打架。
  function syncSeedEnabled() {
    const random = seedModeSelect.value === "random";
    seedInput.disabled = random;
    seedField.hidden = random;
  }

  const profileSelect = el("select", { style: "width:100%" },
    el("option", { value: "fast", text: "快速" }),
    el("option", { value: "quality", text: "质量优先" }),
  );
  profileSelect.value = params.sampling_profile ?? "fast";
  function syncProfileControls() {
    const quality = profileSelect.value === "quality";
    for (const input of [stepsInput, denoiseInput, samplerSelect, schedulerSelect]) {
      input.disabled = quality;
    }
  }
  profileSelect.addEventListener("change", () => {
    syncProfileControls();
    save();
  });

  function save() {
    const p = {
      sampling_profile: profileSelect.value,
      seed: Number(seedInput.value) || 0,
      seed_mode: seedModeSelect.value,
      steps: Number(stepsInput.value) || DEFAULT_PARAMS.steps,
      denoise: Number(denoiseInput.value) || 1.0,
      sampler_name: samplerSelect.value,
      scheduler: schedulerSelect.value,
      latent_upscale: latentUpscaleInput.checked,
      latent_upscale_scale: Number(latentUpscaleScaleInput.value) || 1.5,
    };
    onSave(overridesOnly(p, baseline), p);
  }

  syncProfileControls();
  host.replaceChildren(
    el("p", { class: "zdb-muted", text: "质量优先使用预设步数和调度；二采由开关决定。请连接未加载 Turbo 加速 LoRA 的模型，导演台不会移除已加载的 LoRA。" }),
    el("div", { class: "zdb-dispatch-grid" },
      wrap("采样质量", profileSelect),
      seedField,
      wrap("Seed 策略", seedModeSelect),
      wrap("一采步数", stepsInput),
      wrap("Denoise", denoiseInput),
      wrap("Sampler", samplerSelect),
      wrap("Scheduler", schedulerSelect),
      wrap("开启双采（质量模式仅显式开启）", latentUpscaleInput),
      wrap("放大倍数", latentUpscaleScaleInput),
    ),
  );
  syncSeedEnabled();
}

function wrap(label, control) {
  return el("label", { class: "zdb-field" }, el("span", { text: label }), control);
}

/**
 * @param {object} board   导演台 Board 实例
 * @param {object} [options]
 * @param {Function} [options.runtime] 取 `{app, api}` 的函数；测试可注入假运行时
 */
export function createDispatchPanel(board, options = {}) {
  const statusEl = el("span", { class: "zdb-dispatch-status", text: "就绪", role: "status", "aria-live": "polite" });
  const progressFill = el("span", { class: "zdb-dispatch-progress-fill" });
  const progressText = el("span", { class: "zdb-dispatch-progress-text", text: "" });
  const progressTrack = el("span", { class: "zdb-dispatch-progress-bar" }, progressFill);
  const progressView = el("span", { class: "zdb-dispatch-progress" }, progressTrack, progressText);
  const latestLogEl = el("span", { class: "zdb-dispatch-latest", text: "" });
  const logBody = el("div", { class: "zdb-dispatch-log-body" });
  const logPanelId = `zdb-dispatch-log-${board.node?.id ?? "board"}`;
  const logPanel = el("div", { class: "zdb-dispatch-log", id: logPanelId, role: "region", "aria-label": "运行详情" },
    el("div", { class: "zdb-dispatch-log-head" },
      el("b", { text: "技术日志" }), el("span", { text: "点击底部状态收起" })),
    logBody);

  // shot_id → 错误文本（失败的分镜在 UI 上标红，见 §10.3.1）
  const failures = new Map();
  // prompt_id → shot_id：原生事件按 prompt_id 反查是哪一镜（§10.3.3）
  const promptToShot = new Map();
  // 整片拼装结果（§10.7）：只在内存里，重拼一次即可覆盖。
  let film = null;
  let running = false;
  let cancelled = false;
  let currentPromptId = null;
  let currentRun = null;
  let progress = { value: 0, max: 0 };
  let paused = null; // { queue, startIndex, batchTotal, project, assistant, owner }
  let listenersInstalled = false;
  let logsOpen = false;
  let progressLogIndex = -1;
  const logEntries = [];
  const tasks = new Map();
  let lastPreflight = new Map();
  let lastPreflightFingerprint = null;
  const execution = createComfyExecution({
    runtime: options.runtime,
    pollIntervalMs: options.pollIntervalMs,
    isCancelled: () => cancelled,
  });
  const getRuntime = execution.runtime;
  const inspectOutput = options.probeOutput || probeOutputMedia;
  logPanel.hidden = true;

  const resultMap = () => new Map(Object.entries(board.project.shot_results || {}));
  const resultCount = () => Object.keys(board.project.shot_results || {}).length;

  function persistPendingRun(run) {
    board.project.pending_run = run;
    board.save?.();
  }
  function clearPendingRun(promptId) {
    if (board.project.pending_run?.prompt_id !== promptId) return;
    delete board.project.pending_run;
    board.save?.();
  }

  function setLogsOpen(value) {
    logsOpen = Boolean(value);
    logPanel.hidden = !logsOpen;
    summary?.setAttribute("aria-expanded", logsOpen ? "true" : "false");
  }

  const timestamp = () => new Date().toLocaleTimeString("zh-CN", {
    hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  function paintLogs() {
    const visible = logEntries.length ? logEntries : [{ time: "", message: "暂无运行日志" }];
    const latest = logEntries.at(-1);
    latestLogEl.textContent = latest ? `${latest.time} ${latest.message}` : "暂无运行日志";
    logBody.replaceChildren(...visible.map((entry) =>
      el("div", { class: "zdb-dispatch-log-row" },
        el("time", { text: entry.time }), el("span", { text: entry.message }))));
  }

  const taskStatusText = {
    waiting: "等待中", running: "生成中", completed: "已完成", failed: "失败", stopped: "已停止",
  };

  function prepareTasks(queue, startIndex, batchTotal, preserve = false) {
    if (!preserve) tasks.clear();
    queue.forEach((shot, index) => {
      const previous = tasks.get(shot.id);
      tasks.set(shot.id, {
        shotId: shot.id,
        label: shot.title || shot.id,
        index: startIndex + index,
        batchTotal,
        status: previous?.status === "completed" ? "completed" : "waiting",
        error: "",
        progressValue: 0,
        progressMax: 0,
      });
    });
  }

  function patchTask(shotId, patch) {
    const task = tasks.get(shotId);
    if (!task) return;
    Object.assign(task, patch);
  }

  function getShotState(shotId) {
    const task = tasks.get(shotId);
    if (task && ["running", "failed", "stopped", "waiting"].includes(task.status)) {
      return {
        status: task.status,
        message: task.error || taskStatusText[task.status],
        value: task.progressValue,
        max: task.progressMax,
      };
    }
    if (board.project.shot_results?.[shotId]) return { status: "completed", message: "已生成" };
    const planIsCurrent = lastPreflightFingerprint
      && preflightFingerprint(board.project, board.assistant) === lastPreflightFingerprint;
    const preflight = planIsCurrent ? lastPreflight.get(shotId) : null;
    if (preflight?.level === "blocked") {
      return { status: "blocked", message: preflight.blocked[0] || "需处理" };
    }
    if (preflight?.level === "warning") {
      return { status: "warning", message: preflight.warnings[0] || "可降级" };
    }
    return { status: "idle", message: "" };
  }

  function clearLogs() {
    logEntries.length = 0;
    progressLogIndex = -1;
    paintLogs();
  }

  function addLog(message) {
    logEntries.push({ time: timestamp(), message });
    if (logEntries.length > 10) logEntries.shift();
    progressLogIndex = -1;
    paintLogs();
  }

  function updateProgressLog(message) {
    const entry = { time: timestamp(), message };
    if (progressLogIndex >= 0 && logEntries[progressLogIndex]) logEntries[progressLogIndex] = entry;
    else {
      logEntries.push(entry);
      progressLogIndex = logEntries.length - 1;
    }
    paintLogs();
  }

  function cancelledError() {
    const error = new Error("已取消");
    error.cancelled = true;
    return error;
  }

  function assertNotCancelled() {
    if (cancelled) throw cancelledError();
  }

  /** 运行状态翻转时通知 Board：运行中把运行按钮置灰（§10.6）。 */
  function setRunning(value) {
    if (running === value) return;
    running = value;
    board.update?.();
  }

  function setStatus(text, kind = "") {
    statusEl.textContent = text;
    statusEl.className = `zdb-dispatch-status${kind ? ` ${kind}` : ""}`;
  }

  function paintProgress() {
    const percent = progress.max ? Math.max(0, Math.min(100, progress.value / progress.max * 100)) : 0;
    progressView.hidden = !currentRun;
    progressTrack.classList.toggle("is-indeterminate", Boolean(currentRun && !progress.max));
    progressFill.style.width = progress.max ? `${percent}%` : "34%";
    progressText.textContent = currentRun
      ? progress.max ? `当前步骤 ${progress.value}/${progress.max} · ${Math.round(percent)}%` : "ComfyUI 正在执行"
      : "";
  }

  function updateStatus() {
    // 运行中的文案由 runQueue() 逐镜更新，这里只在空闲态反映已有结果。
    if (running) return;
    if (failures.size) {
      setStatus(`${resultCount()} 镜已生成，${failures.size} 镜失败`, "zdb-status-error");
    } else if (resultCount()) {
      setStatus(`${resultCount()} 镜已生成`, "zdb-status-ok");
    } else {
      setStatus("就绪");
    }
  }

  function selectedShots() {
    return board.project.shots.filter((s) => s.selected_for_generation);
  }

  /** 执行顺序 = 时间轴顺序（以 board.project.shots 为准，不跟随点击顺序）。 */
  function timelineOrder(shotIds, project = board.project) {
    const wanted = new Set(shotIds);
    return project.shots.filter((shot) => wanted.has(shot.id));
  }

  function shotOutputFps(shot) {
    return Number(shot.output_fps ?? shot.motion_fps ?? 24) || 24;
  }

  function shotFilenamePrefix(shot, project = board.project) {
    return `zdx/${projectOutputDirectory(project)}/${safeOutputName(shot.id, "shot")}`;
  }

  /** 按时间轴顺序取出已生成的分镜（拼装顺序与生成先后无关）。 */
  function filmSources() {
    const sources = [];
    for (const shot of board.project.shots) {
      const result = board.project.shot_results?.[shot.id];
      if (result) sources.push({
        shotId: shot.id, title: shot.title || shot.id,
        path: result.fullpath, frameRate: result.frameRate,
        hasAudio: result.hasAudio, durationMs: result.durationMs || shot.duration_ms,
        safe: isSafeResultFile(result),
      });
    }
    return sources;
  }

  function filmFilenamePrefix() {
    const title = safeOutputName(board.project?.project?.title, "project");
    return `zdx/${projectOutputDirectory(board.project)}/${title}_film`;
  }

  /** 原生事件：按 prompt_id 反查本镜，只关心自己提交的那一条（§10.3.3）。 */
  function installApiListeners(api) {
    if (listenersInstalled || typeof api?.addEventListener !== "function") return;
    listenersInstalled = true;
    api.addEventListener("executing", ({ detail }) => {
      if (!currentPromptId || detail?.prompt_id !== currentPromptId) return;
      const shotId = promptToShot.get(detail?.prompt_id);
      const nodeId = String(detail?.node ?? detail?.display_node ?? "");
      if (!shotId || !currentRun || currentRun.shotId !== shotId || nodeId !== SHOT_SAMPLE_ID) return;
      if (currentRun.executingNode === nodeId) return;
      currentRun.executingNode = nodeId;
      addLog("MiniMaxH3VideoShotSample 执行中");
    });
    api.addEventListener("progress", ({ detail }) => {
      if (!currentPromptId || detail?.prompt_id !== currentPromptId) return;
      const shotId = promptToShot.get(detail?.prompt_id);
      if (!shotId || !currentRun || currentRun.shotId !== shotId) return;
      const rawNodeId = detail?.node ?? detail?.display_node;
      const nodeId = rawNodeId == null ? "" : String(rawNodeId);
      if (nodeId ? nodeId !== SHOT_SAMPLE_ID : currentRun.executingNode !== SHOT_SAMPLE_ID) return;
      if (!detail?.max) return;
      if (!currentRun.progressStarted) {
        currentRun.progressStarted = true;
        if (currentRun.executingNode !== SHOT_SAMPLE_ID) {
          currentRun.executingNode = SHOT_SAMPLE_ID;
          addLog("MiniMaxH3VideoShotSample 执行中");
        }
      }
      progress = { value: Number(detail.value) || 0, max: Number(detail.max) || 0 };
      patchTask(shotId, { progressValue: progress.value, progressMax: progress.max });
      paintProgress();
      updateProgressLog(`${progress.value} / ${progress.max} 步`);
      setStatus(
        `${resultCount()} 镜完成，正在跑「${currentRun.label}」 ` +
          `${detail.value}/${detail.max} 步`,
      );
      // Sampling is high-frequency.  Paint only the live controls instead of
      // serializing and rebuilding the complete Director Board every step.
      board.renderDispatchProgress?.({ ...currentRun, ...progress });
    });
    api.addEventListener("execution_error", ({ detail }) => {
      if (!currentPromptId || detail?.prompt_id !== currentPromptId) return;
      const shotId = promptToShot.get(detail?.prompt_id);
      if (shotId) failures.set(shotId, detail?.exception_message || "执行失败");
    });
  }

  /** 提交一镜并等它跑完，把结果记进 manifest。 */
  async function submitShot(shot, runIndex, project, assistant, owner) {
    const { app } = await getRuntime();
    assertNotCancelled();
    const promptErrors = executionPromptErrors({ project, assistant }, shot);
    if (promptErrors.length) throw new Error(`提示词不能执行：${promptErrors.join("；")}`);
    // 基底必须比锚点先拿：runtime-vars 会 patch graphToPrompt 把变量重写成真实来源，
    // 画布上的连线（指向变量/getNode 节点）不是引擎真正会用的那个值。
    const { output, workflow } = await app.graphToPrompt();
    assertNotCancelled();
    const refs = resolveAnchorRefs(output, app.graph, board.node);
    if (!refs) {
      throw new Error(
        "导演台没读到模型：请把 MODEL / VAE / CLIP 接到「ZDX 导演台」左侧的三个锚点插槽" +
          "（节点上没有这三个插槽时，重启 ComfyUI 再刷新页面）",
      );
    }
    const audioRoles = new Set((shot.bindings ?? []).map((binding) => binding.role));
    const audioPolicy = shot.audio_policy ?? project.global.audio_policy ?? "generated";
    const needsAudioVae = (
      audioPolicy === "generated"
      || audioRoles.has("source_audio")
      || audioRoles.has("reference_audio")
    );
    if (needsAudioVae && !refs.audio_vae) {
      throw new Error(
        "当前分镜需要音频 VAE：请把 AUDIO_VAE 接到「ZDX 导演台」的 audio_vae 锚点输入",
      );
    }

    const params = {
      ...shotParams(board, shot, project),
      // ref_image_size 是项目级默认，不是每镜参数（§10.4）
      ref_image_size: project.global.ref_image_size ?? "match",
      output_generated_audio: (
        audioPolicy === "generated"
      ),
    };
    const seed = resolveActualSeed(params, runIndex);

    const built = buildShotPrompt({
      prompt: output,
      workflow,
      boardId: board.node.id,
      // 提示词原样透传（§10.12）：编辑器里写的就是提交内容，提交前不编译、也不额外体检——
      // 失效标签在状态条里已经即时显示，控制台再报一遍只会变成噪音。
      projectJson: JSON.stringify(project),
      shotIndex: project.shots.findIndex((item) => item.id === shot.id),
      params: { ...params, seed },
      refs,
      frameRate: shotOutputFps(shot),
      filenamePrefix: shotFilenamePrefix(shot, project),
    });

    assertNotCancelled();
    const promptId = await execution.queuePrompt(built);
    if (cancelled) {
      await execution.cancelPrompt(promptId);
      throw cancelledError();
    }
    addLog("已提交 ComfyUI 队列");
    // 入队后立刻登记映射：原生 progress / execution_error 都靠它反查分镜。
    promptToShot.set(promptId, shot.id);
    currentPromptId = promptId;
    persistPendingRun({
      prompt_id: promptId, shot_id: shot.id, seed,
      frame_rate: shotOutputFps(shot),
      execution_fingerprint: shot.execution_fingerprint || shotExecutionFingerprint(project, shot),
      continuity_from_prev: Boolean(shot.continuity_from_prev),
      continuity_previous_shot_id: shot.continuity_prev_shot_id || null,
    });

    try {
      const record = await execution.waitForPrompt(promptId);
      const file = execution.extractVideo(record, SHOT_SAVE_ID), mediaInfo = await inspectOutput(file), result = {
        promptId,
        seed,
        frameRate: shotOutputFps(shot),
        hasAudio: typeof mediaInfo?.has_audio === "boolean" ? mediaInfo.has_audio : null,
        durationMs: Number.isInteger(mediaInfo?.duration_ms) && mediaInfo.duration_ms > 0
          ? mediaInfo.duration_ms : shot.duration_ms,
        executionFingerprint: shot.execution_fingerprint || shotExecutionFingerprint(project, shot),
        continuityFromPrev: Boolean(shot.continuity_from_prev),
        continuityPreviousShotId: shot.continuity_prev_shot_id || null,
        continuityContextFrames: shot.continuity_from_prev ? 22 : 0,
        ...file,
      };
      if (!isSafeResultFile(result)) throw new Error("输出文件路径无效，未写入项目结果");
      // 实际使用的 seed 必须记下来：random 模式下这是唯一的回溯入口（§10.4）。
      const liveShot = board.project.shots.find((item) => item.id === shot.id);
      if (board.project !== owner.project || liveShot !== owner.shots.get(shot.id)) {
        board.notice(`“${shot.title || shot.id}”所属项目或分镜已变化，本次输出未写入项目结果。`);
        return file;
      }
      board.project.shot_results ||= {};
      board.project.shot_results[shot.id] = result;
      film = null;
      failures.delete(shot.id);
      addLog("输出文件已生成");
      // 结果视图在素材区（决策 12），由 Board 负责切视图与重绘。
      board.showResults?.(shot.id);
      return file;
    } finally {
      if (currentPromptId === promptId) currentPromptId = null;
      promptToShot.delete(promptId);
      clearPendingRun(promptId);
    }
  }

  function primePendingRun() {
    const saved = board.project.pending_run;
    if (!saved?.prompt_id || !saved?.shot_id) return null;
    const shot = board.project.shots.find((item) => item.id === saved.shot_id);
    if (!shot || saved.execution_fingerprint !== shotExecutionFingerprint(board.project, shot)) {
      return { saved, shot: null };
    }
    // 首屏渲染前先建立运行状态，确保新任务覆盖同镜的旧 shot_result。
    running = true;
    cancelled = false;
    currentPromptId = saved.prompt_id;
    currentRun = { shotId: shot.id, label: shot.title || shot.id, index: board.project.shots.indexOf(shot), batchTotal: 1 };
    promptToShot.set(saved.prompt_id, shot.id);
    tasks.set(shot.id, { shotId: shot.id, label: currentRun.label, index: currentRun.index, batchTotal: 1, status: "running", error: "", progressValue: 0, progressMax: 0 });
    setStatus(`正在恢复「${currentRun.label}」的任务状态…`);
    addLog(`恢复查询 ComfyUI 任务 ${saved.prompt_id}`);
    return { saved, shot };
  }

  async function recoverPendingRun(recovery) {
    if (!recovery) return;
    const { saved, shot } = recovery;
    if (!shot) {
      clearPendingRun(saved.prompt_id);
      return;
    }
    try {
      const { api } = await getRuntime();
      installApiListeners(api);
      const record = await execution.waitForPrompt(saved.prompt_id);
      const file = execution.extractVideo(record, SHOT_SAVE_ID), mediaInfo = await inspectOutput(file);
      const result = {
        promptId: saved.prompt_id, seed: saved.seed, frameRate: saved.frame_rate,
        hasAudio: typeof mediaInfo?.has_audio === "boolean" ? mediaInfo.has_audio : null,
        durationMs: Number.isInteger(mediaInfo?.duration_ms) && mediaInfo.duration_ms > 0 ? mediaInfo.duration_ms : shot.duration_ms,
        executionFingerprint: saved.execution_fingerprint,
        continuityFromPrev: Boolean(saved.continuity_from_prev),
        continuityPreviousShotId: saved.continuity_previous_shot_id || null,
        continuityContextFrames: saved.continuity_from_prev ? 22 : 0,
        ...file,
      };
      if (!isSafeResultFile(result)) throw new Error("输出文件路径无效，未写入项目结果");
      board.project.shot_results ||= {};
      board.project.shot_results[shot.id] = result;
      tasks.get(shot.id).status = "completed";
      board.showResults?.(shot.id);
      addLog("恢复任务已完成");
    } catch (error) {
      const friendly = friendlyExecutionError(error, `「${shot.title || shot.id}」`);
      failures.set(shot.id, friendly);
      tasks.get(shot.id).status = "failed";
      tasks.get(shot.id).error = friendly;
      board.notice?.(friendly);
    } finally {
      clearPendingRun(saved.prompt_id);
      promptToShot.delete(saved.prompt_id);
      currentPromptId = null;
      currentRun = null;
      progress = { value: 0, max: 0 };
      running = false;
      paintProgress();
      updateStatus();
      board.update?.();
    }
  }

  /** 失败即暂停；只能从失败镜重试，不能跳过后继续。 */
  function pauseForFailure(shot, error, queue, index, runIndex, batchTotal, project, assistant, owner) {
    paused = {
      shotId: shot.id,
      queue: queue.slice(index),
      startIndex: runIndex,
      batchTotal,
      project,
      assistant,
      owner,
    };
    setLogsOpen(true);
  }

  function retryFailed() {
    const state = paused;
    paused = null;
    if (!state) return undefined;
    return runQueue(
      state.queue, state.startIndex, state.batchTotal,
      state.project, state.assistant, state.owner, true,
    );
  }

  /** 停止当前 prompt 与整条队列；等待项不再提交。 */
  async function stopAll() {
    if (!running && !paused) {
      board.notice("当前没有正在执行的分镜");
      return;
    }
    const pausedShotId = paused?.shotId;
    paused = null;
    cancelled = true;
    for (const task of tasks.values()) {
      if (task.status === "waiting" || task.status === "running" || task.shotId === pausedShotId) {
        task.status = "stopped";
        task.error = "";
      }
    }
    setStatus(`已停止（完成 ${resultCount()} 镜）`);
    if (currentPromptId) {
      const promptId = currentPromptId;
      await execution.cancelPrompt(promptId);
    }
    board.update?.();
  }

  /**
   * 最后拼装一次（§10.7）：把已落盘的分镜按时间轴顺序合流成一条整片。
   *
   * 这条 prompt 不含采样节点，只是读回产物再导出；失败或取消都不会影响
   * 已经生成好的每镜文件，重拼一次即可。
   */
  async function assembleFilm() {
    // 与 runQueue 共用 running 互锁：单发模式下同一时刻只允许一条自己发起的任务，
    // 所以"正在跑分镜时不能拼装、正在拼装时不能跑分镜"两个方向都由这一个标记挡住。
    if (running || paused) return board.notice("当前仍有运行或暂停任务，请先处理");
    const sources = filmSources();
    if (!sources.length) return board.notice("还没有可拼装的分镜结果");
    if (sources.length > FILM_MAX_SOURCES) {
      const message = `分镜数超过 ${FILM_MAX_SOURCES}，请分段拼装（BatchImagesNode 的 Autogrow 上限）`;
      setStatus(message, "zdb-status-error");
      board.notice(message);
      return;
    }
    const unsafe = sources.filter((item) => !item.safe).map((item) => item.shotId);
    if (unsafe.length) {
      const message = `结果文件路径无效，无法拼装：${unsafe.join("、")}`;
      setStatus(message, "zdb-status-error");
      board.notice(message);
      return;
    }
    const withoutPath = sources.filter((item) => !item.path).map((item) => item.shotId);
    if (withoutPath.length) {
      const message = `缺少文件路径，无法拼装：${withoutPath.join("、")}（VHS 输出没有 fullpath）`;
      setStatus(message, "zdb-status-error");
      board.notice(message);
      return;
    }
    const unknownAudio = sources.filter((item) => typeof item.hasAudio !== "boolean");
    if (unknownAudio.length) {
      const labels = unknownAudio.map((item) => item.title).join("、");
      const message = `无法确认以下分镜的音轨状态：${labels}；请重新生成或检查 ffprobe`;
      setStatus(message, "zdb-status-error");
      board.notice(message);
      return;
    }

    const { app } = await getRuntime();
    const rates = [...new Set(sources.map((item) => item.frameRate || 24))];
    const frameRate = Math.max(...rates);
    if (rates.length > 1) {
      board.notice(`各镜帧率不一致（${rates.join(" / ")}），整片按 ${frameRate}fps 拼装`);
    }

    setRunning(true);
    cancelled = false;
    currentPromptId = null;
    setStatus(`拼装中…（${sources.length} 镜）`);
    try {
      const { output, workflow } = await app.graphToPrompt();
      const built = buildFilmPrompt({
        prompt: output,
        workflow,
        sources,
        frameRate,
        filenamePrefix: filmFilenamePrefix(),
      });
      const promptId = await execution.queuePrompt(built);
      // 拼装同样是一条可取消的 prompt（长片拼装可能要等一会儿）。
      currentPromptId = promptId;
      const record = await execution.waitForPrompt(promptId);
      const file = execution.extractVideo(record, FILM_SAVE_ID);
      film = {
        promptId, frameRate, shots: sources.map((item) => item.shotId),
        hasAudio: sources.some((item) => item.hasAudio === true),
        durationMs: sources.reduce((sum, item) => sum + Number(item.durationMs || 0), 0),
        ...file,
      };
      board.showResults?.();
      setStatus(`整片已拼装：${film.filename}`, "zdb-status-ok");
      return film;
    } catch (error) {
      if (error?.cancelled) {
        setStatus("拼装已取消");
        return undefined;
      }
      const friendly = friendlyExecutionError(error, "整片拼装");
      addLog(`拼装失败：${error.message}`);
      setStatus(friendly, "zdb-status-error");
      board.notice(friendly);
      return undefined;
    } finally {
      setRunning(false);
      currentPromptId = null;
    }
  }

  /** 顺序提交：一镜一份 prompt，等这一镜跑完再发下一镜（§10.3）。 */
  async function runQueue(queue, startIndex = 0, batchTotal = queue.length, project, assistant, owner, preserveTasks = false) {
    if (running || paused) return board.notice("当前仍有运行或暂停任务，请先处理");
    if (!queue.length) return board.notice("没有可运行的分镜");
    if (!preserveTasks) clearLogs();
    prepareTasks(queue, startIndex, batchTotal, preserveTasks);
    setRunning(true);
    cancelled = false;
    try {
      const { api } = await getRuntime();
      assertNotCancelled();
      installApiListeners(api);
      for (let index = 0; index < queue.length; index++) {
        assertNotCancelled();
        const shot = queue[index];
        const label = shot.title || shot.id;
        const runIndex = startIndex + index;
        currentRun = { shotId: shot.id, label, index: runIndex, batchTotal };
        patchTask(shot.id, { status: "running", error: "", progressValue: 0, progressMax: 0 });
        progress = { value: 0, max: 0 };
        paintProgress();
        board.update?.();
        setStatus(`${resultCount()} 镜完成，正在跑「${label}」`);
        try {
          await submitShot(shot, runIndex, project, assistant, owner);
        } catch (error) {
          if (error?.cancelled || cancelled) {
            patchTask(shot.id, { status: "stopped" });
            addLog("生成已取消");
            setStatus(`已停止（完成 ${resultCount()} 镜）`);
            return;
          }
          const friendly = friendlyExecutionError(error, `「${label}」`);
          failures.set(shot.id, friendly);
          patchTask(shot.id, { status: "failed", error: friendly });
          addLog(`生成失败：${error.message}`);
          board.showResults?.(shot.id);
          setStatus(friendly, "zdb-status-error");
          board.notice(friendly);
          pauseForFailure(shot, error, queue, index, runIndex, batchTotal, project, assistant, owner);
          return;
        }
        patchTask(shot.id, { status: "completed", error: "" });
      }
      setStatus(`${resultCount()} 镜完成`, "zdb-status-ok");
    } catch (error) {
      if (error?.cancelled || cancelled) {
        for (const task of tasks.values()) {
          if (task.status === "waiting" || task.status === "running") task.status = "stopped";
        }
        addLog("生成已停止");
        setStatus(`已停止（完成 ${resultCount()} 镜）`);
        return;
      }
      const friendly = friendlyExecutionError(error, "运行");
      addLog(`运行失败：${error.message}`);
      setStatus(friendly, "zdb-status-error");
      board.notice(friendly);
      return;
    } finally {
      setRunning(false);
      currentRun = null;
      progress = { value: 0, max: 0 };
      paintProgress();
      board.update?.();
    }
  }

  async function preflightContext(project, shotIds) {
    const { app, api } = await getRuntime(), { output } = await app.graphToPrompt();
    const anchors = {};
    for (const name of ["model", "vae", "clip"]) {
      try { anchors[name] = resolveAnchorRefs(output, app.graph, board.node, [name])?.[name] || null; }
      catch { anchors[name] = null; }
    }
    try { anchors.audio_vae = resolveAnchorRefs(output, app.graph, board.node, [])?.audio_vae || null; }
    catch { anchors.audio_vae = null; }
    const wanted = new Set(shotIds), assetIds = new Set(project.shots
      .filter((shot) => wanted.has(shot.id))
      .flatMap((shot) => shot.bindings || [])
      .map((binding) => binding.asset_id));
    const missingAssetPaths = new Set();
    const checkPath = options.pathExists || (async (asset) => {
      const response = await api.fetchApi(`/zdx/director/file-exists?input_path=${encodeURIComponent(asset.input_path)}`);
      if (!response.ok) return false;
      const payload = await response.json();
      return payload?.exists === true;
    });
    await Promise.all(project.assets.filter((asset) => assetIds.has(asset.id)).map(async (asset) => {
      try { if (!await checkPath(asset)) missingAssetPaths.add(asset.id); }
      catch { missingAssetPaths.add(asset.id); }
    }));
    return { anchors, missingAssetPaths };
  }

  function drawPreflight(modal, plan, onConfirm) {
    const runnable = plan.filter((item) => item.level !== "blocked");
    modal.body.replaceChildren(
      el("p", { class: "zdb-muted", text: `检查 ${plan.length} 镜；阻断项不会入队，黄色提醒将在确认后按显示方式执行。` }),
      el("section", { class: "zdb-preflight-list" }, ...plan.map((item) => el("article", {
        class: `zdb-preflight-item zdb-preflight-${item.level}`,
        "data-shot-id": item.shot_id,
      },
      el("div", { class: "zdb-row zdb-spread" },
        el("b", { text: item.title }),
        el("span", { text: item.level === "blocked" ? "需处理" : item.level === "warning" ? "可降级" : "可运行" })),
      item.effective_task_type !== board.project.shots.find((shot) => shot.id === item.shot_id)?.task_type
        ? el("small", { class: "zdb-muted", text: `本次执行：${item.effective_task_type}` }) : null,
      ...item.blocked.map((message) => el("small", { class: "zdb-error", text: message })),
      ...item.warnings.map((message) => el("small", { class: "zdb-warning", text: message }))))),
    );
    const confirm = btn(`确认运行 ${runnable.length} 镜`, onConfirm, "zdb-primary");
    confirm.disabled = !runnable.length;
    modal.footer.append(confirm);
  }

  function launchPreflightPlan(plan, { project, assistant, owner, fingerprint, modal = null }) {
    if (board.project !== owner.project || preflightFingerprint(board.project, board.assistant) !== fingerprint) {
      board.notice("项目已变化，请重新预检。");
      return undefined;
    }
    const runnable = plan.filter((item) => item.level !== "blocked"),
      executionProject = materializeExecutionProject(project, plan, shotExecutionFingerprint);
    modal?.close();
    const queue = timelineOrder(runnable.map((item) => item.shot_id), executionProject);
    return runQueue(queue, 0, queue.length, executionProject, assistant, owner);
  }

  async function preflightShots(shotIds, {
    alwaysConfirm = false, title = "运行预检", loadingModal = null,
  } = {}) {
    if (running || paused) return board.notice("当前仍有运行或暂停任务，请先处理");
    const owner = {
        project: board.project,
        shots: new Map(board.project.shots.map((shot) => [shot.id, shot])),
      },
      project = deep(board.project), assistant = board.assistant ? deep(board.assistant) : null,
      fingerprint = preflightFingerprint(board.project, board.assistant),
      context = await preflightContext(project, shotIds),
      continuityReadyShotIds = new Set(project.shots.filter((shot) => (
        project.shot_results?.[shot.id]?.executionFingerprint
        === shotExecutionFingerprint(project, shot)
      )).map((shot) => shot.id)),
      plan = buildPreflightPlan(project, assistant, shotIds, {
        ...context,
        requireContinuityPredecessor: alwaysConfirm || shotIds.length > 1,
        continuityReadyShotIds,
      });
    if (preflightFingerprint(board.project, board.assistant) !== fingerprint) {
      if (loadingModal) {
        loadingModal.body.replaceChildren(el("p", { class: "zdb-error", text: "项目已变化，请重新预检。" }));
      } else board.notice("项目已变化，请重新预检。");
      return [];
    }
    lastPreflight = new Map(plan.map((item) => [item.shot_id, item]));
    lastPreflightFingerprint = fingerprint;
    board.draw?.();
    const blocked = plan.filter((item) => item.level === "blocked");
    if (blocked.length && blocked.length === plan.length) {
      if (loadingModal) drawPreflight(loadingModal, plan, () => {});
      else board.notice(blocked.flatMap((item) => item.blocked.map((message) => `「${item.title}」${message}`)).join("；"));
      return plan;
    }
    if (alwaysConfirm || plan.some((item) => item.level === "warning") || blocked.length) {
      const modal = loadingModal || board.modal(title);
      drawPreflight(modal, plan, () => {
        void launchPreflightPlan(plan, { project, assistant, owner, fingerprint, modal });
      });
      board.focus?.(modal.element);
      return plan;
    }
    await launchPreflightPlan(plan, { project, assistant, owner, fingerprint });
    return plan;
  }

  async function preflightAll() {
    const shotIds = board.project.shots.filter((shot) => shot.selected_for_generation).map((shot) => shot.id),
      modal = board.modal("批量生成预检");
    modal.body.append(el("p", { class: "zdb-muted", text: "正在检查素材、任务与模型连接…" }));
    board.focus?.(modal.element);
    try {
      return await preflightShots(shotIds, {
        alwaysConfirm: true, title: "批量生成预检", loadingModal: modal,
      });
    } catch (error) {
      modal.body.replaceChildren(el("p", { class: "zdb-error", text: `预检失败：${error.message}` }));
      return [];
    }
  }

  const summary = el("button", {
    type: "button", class: "zdb-dispatch-summary", "aria-expanded": "false",
    "aria-controls": logPanelId,
    title: "查看运行日志",
    onclick: () => setLogsOpen(!logsOpen),
  }, statusEl, progressView, latestLogEl, el("span", { class: "zdb-dispatch-log-toggle", text: "详情" }));
  const bar = el("div", { class: "zdb-dispatch-bar" }, summary, logPanel);
  const pendingRecovery = primePendingRun();
  paintLogs();
  paintProgress();
  queueMicrotask(() => { void recoverPendingRun(pendingRecovery); });

  return {
    bar,
    updateStatus,
    isRunning: () => running,
    isPaused: () => paused !== null,
    isBusy: () => running || paused !== null,
    getResults: resultMap,
    getFailures: () => new Map(failures),
    getTasks: () => [...tasks.values()].map((task) => ({ ...task })),
    getShotState,
    // 时间轴卡片逐镜判断用：避免每次重绘为每个 shot 复制一份 Map。
    hasFailure: (shotId) => failures.has(shotId),
    getFilm: () => (film ? { ...film } : null),
    getProgress: () => currentRun ? { ...currentRun, ...progress } : null,
    isLogOpen: () => logsOpen,
    closeLog: () => setLogsOpen(false),
    cancelCurrent: stopAll,
    stopAll,
    retryFailed,
    assembleFilm,
    // 「重跑这一镜」：单元素队列，走同一条提交路径。
    runShot: (shotId) => preflightShots([shotId], { title: "运行当前预检" }),
    runCurrent: () => {
      const shot = board.selected();
      return shot ? preflightShots([shot.id], { title: "运行当前预检" }) : undefined;
    },
    preflightAll,
    // 非 UI 调用也必须经过同一预检；只有时间轴“批量生成”额外强制展示确认抽屉。
    runAll: () => preflightShots(selectedShots().map((item) => item.id), { title: "运行全部预检" }),
  };
}

/**
 * Per-shot sampler parameters. The shot stores only what differs from the
 * global defaults, so global edits keep propagating to untouched fields.
 */
export function renderShotParams(board, shot, onChange = () => {}) {
  const host = el("div", { class: "zdb-dispatch-params-modal" }),
    baseline = globalParams(board);
  renderParamControls(host, shotParams(board, shot), baseline, (overrides) => {
    if (Object.keys(overrides).length) shot.dispatch_params = overrides;
    else delete shot.dispatch_params;
    board.save();
    onChange();
  });
  return el("section", { class: "zdb-settings-section" },
    el("h3", { text: `当前镜头高级参数 · ${shot.title}` }),
    el("p", { class: "zdb-muted", text: "未修改的参数跟随全局默认。" }),
    host,
    btn("恢复为全局默认", () => {
      delete shot.dispatch_params;
      board.save();
      onChange();
    }, "zdb-sub"));
}

export function openShotParamsModal(board, shot) {
  const modal = board.modal(`参数设置 · ${shot.title}`);
  const render = () => modal.body.replaceChildren(renderShotParams(board, shot, render));
  render();
  board.focus(modal.element);
}

/** Project-wide sampler defaults used by every shot without an override. */
export function renderGlobalParams(board, onChange = () => {}) {
  const host = el("div", { class: "zdb-dispatch-params-modal" });
  renderParamControls(host, globalParams(board), DEFAULT_PARAMS, (overrides) => {
    if (Object.keys(overrides).length) board.project.global.dispatch_params = overrides;
    else delete board.project.global.dispatch_params;
    board.save();
    onChange();
  });
  const refSizeSelect = el("select", { style: "width:100%" },
    ...REF_IMAGE_SIZES.map((size) => el("option", { value: size, text: size })),
  );
  refSizeSelect.value = board.project.global.ref_image_size ?? "match";
  refSizeSelect.addEventListener("change", () => {
    board.project.global.ref_image_size = refSizeSelect.value;
    board.save();
  });
  return el("section", { class: "zdb-settings-section" },
    el("h3", { text: "全局采样参数" }),
    el("p", { class: "zdb-muted", text: "作为所有分镜的默认值；当前镜头可以单独覆盖。" }),
    host,
    wrap("参考图尺寸（项目级）", refSizeSelect),
    btn("恢复默认", () => {
      delete board.project.global.dispatch_params;
      board.save();
      onChange();
    }, "zdb-sub"));
}

export function openGlobalParamsModal(board) {
  const modal = board.modal("全局默认参数");
  const render = () => modal.body.replaceChildren(renderGlobalParams(board, render));
  render();
  board.focus(modal.element);
}
