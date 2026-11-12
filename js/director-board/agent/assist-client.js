/** 创作助手的 HTTP 客户端：一个入口，五个 target。 */
let comfyApi = null;
export const ASSIST_TIMEOUT_MS = 90000;
/** 异步任务的总预算。**刻意远大于同步超时** —— 走异步就是为了不被 90 秒砍掉。 */
export const JOB_TIMEOUT_MS = 15 * 60 * 1000;
export const JOB_POLL_INTERVAL_MS = 1500;
/** 会走异步入口的 target。**门槛由服务端定**（段数大的拆镜），客户端只管问。 */
const JOB_TARGETS = new Set(["shot_breakdown"]);
const TERMINAL = new Set(["completed", "failed", "cancelled", "blocked_restart", "blocked_ambiguous"]);
export function assistFailure(result, responseOk = true, status = 200) {
  const failure = result?.hard_error || result?.error;
  if (failure) return failure;
  if (result?.valid === false) return "模型返回结果未通过结构校验。";
  return responseOk ? "" : `HTTP ${status}`;
}
async function api() {
  if (!comfyApi) comfyApi = (await import("../../../../scripts/api.js")).api;
  return comfyApi;
}

const abortError = () => Object.assign(new Error("assist cancelled"), { name: "AbortError" });
const checkAborted = (signal) => { if (signal.aborted) throw abortError(); };
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    checkAborted(signal);
    const cancel = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

/** 服务端决定是否创建 job；提交迟到时仍记录 job_id，尽力取消一次。 */
async function requestWithJob(payload, { stage, transport, signal, pollIntervalMs, setJobId }) {
  stage("job-submitting", `target=${payload.target}`);
  const created = await transport("/zdx/director/assist/jobs", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(payload), signal,
  });
  const first = await created.json().catch(() => ({}));
  if (first.job_id) setJobId(first.job_id);
  checkAborted(signal);
  const failure = assistFailure(first, created.ok, created.status);
  if (failure) { stage("response-failed", failure); throw new Error(failure); }
  if (!first.job_id) {
    const failure = assistFailure(first.result);
    if (failure) { stage("response-failed", failure); throw new Error(failure); }
    stage("response-valid", first.result?.model ? `model=${first.result.model}` : "同步完成");
    return first.result || {};
  }

  const jobId = first.job_id;
  stage("job-queued", `job=${jobId}`);
  for (;;) {
    await sleep(pollIntervalMs, signal);
    checkAborted(signal);
    const polled = await transport(`/zdx/director/assist/jobs/${jobId}`, { signal });
    checkAborted(signal);
    const job = await polled.json().catch(() => ({}));
    checkAborted(signal);
    if (!polled.ok) {
      stage("job-poll-failed", `HTTP ${polled.status}`);
      throw new Error(job.error || `任务查询失败（HTTP ${polled.status}）`);
    }
    stage("job-running", job.stage || job.status);
    if (!TERMINAL.has(job.status)) continue;
    if (job.status === "completed") {
      const failure = assistFailure(job.result);
      if (failure) { stage("response-failed", failure); throw new Error(failure); }
      stage("job-completed", job.result?.model ? `model=${job.result.model}` : "");
      return job.result || {};
    }
    const detail = job.message || job.error || job.status;
    stage("job-failed", detail);
    throw new Error(job.message ? `${job.message}${job.error ? `（${job.error}）` : ""}` : detail);
  }
}

/** 一次请求共用一个预算，包括提交、读取响应与轮询。取消不承诺停止上游计费。 */
export async function requestDirectorAssist(payload, options = {}) {
  const {
    onStage = null, signal = null, fetchApi = null,
    jobPollIntervalMs = JOB_POLL_INTERVAL_MS,
  } = options;
  const usesJob = JOB_TARGETS.has(payload?.target);
  const budget = options.timeoutMs ?? (usesJob ? JOB_TIMEOUT_MS : ASSIST_TIMEOUT_MS);
  const startedAt = Date.now();
  const stage = (name, detail = "") => onStage?.({ name, detail, at: Date.now(), elapsedMs: Date.now() - startedAt });
  const controller = new AbortController();
  let timedOut = false, transport, jobId = null, cancelSent = false;
  const cancelJob = () => {
    if (!jobId || cancelSent) return;
    cancelSent = true;
    // 不等待取消端点：它也可能卡住，且确认收到也不代表上游停止计费。
    Promise.resolve().then(() => transport(`/zdx/director/assist/jobs/${jobId}/cancel`, {
      method: "POST",
    })).catch(() => {});
  };
  let rejectStopped;
  const stopped = new Promise((_, reject) => { rejectStopped = reject; });
  const stop = () => { cancelJob(); rejectStopped(abortError()); };
  controller.signal.addEventListener("abort", stop, { once: true });
  const cancel = () => controller.abort();
  const timer = setTimeout(() => { timedOut = true; cancel(); }, budget);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();

  const run = async () => {
    checkAborted(controller.signal);
    stage("request-created", `target=${payload?.target || "?"}`);
    const client = fetchApi ? null : await api();
    transport = fetchApi || client.fetchApi.bind(client);
    checkAborted(controller.signal);
    if (usesJob) {
      return requestWithJob(payload, {
        stage, transport, signal: controller.signal, pollIntervalMs: jobPollIntervalMs,
        setJobId: (id) => { jobId = id; if (controller.signal.aborted) cancelJob(); },
      });
    }
    const response = await transport("/zdx/director/assist", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(payload), signal: controller.signal,
    });
    checkAborted(controller.signal);
    stage("response-received", `HTTP ${response.status}`);
    let result = {};
    try { result = await response.json(); } catch { stage("response-unparsable", "响应不是合法 JSON"); }
    checkAborted(controller.signal);
    const failure = assistFailure(result, response.ok, response.status);
    if (failure) { stage("response-failed", failure); throw new Error(failure); }
    stage("response-valid", result.model ? `model=${result.model}` : "");
    return result;
  };
  try {
    // race 同时保护忽略 AbortSignal 的传输；迟到结果由 run 内的检查拒绝。
    return await Promise.race([stopped, Promise.resolve().then(run)]);
  } catch (error) {
    if (error?.name === "AbortError") {
      const reason = timedOut ? `请求超过 ${Math.round(budget / 1000)} 秒未返回，已停止等待。` : "请求已取消。";
      const detail = usesJob && !jobId
        ? "提交结果未确认，服务端可能仍在执行；不会自动重试。"
        : "服务端或上游可能仍在执行，不能保证停止计费。";
      const message = reason + detail;
      stage(timedOut ? "timeout" : "cancelled", message);
      throw new Error(message);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", stop);
  }
}

/**
 * 资产图打标：用**写作层同一套**看图给一张图生成描述。
 *
 * 为什么必须同一套：结果会存成资产描述，而写作时**有描述就直接采信、不再看图**。
 * 两套看图 = 同一张图两个结论，"打完标后续就顺了"就不成立。
 */
export async function requestAssetFacts(imagePath) {
  const response = await (await api()).fetchApi("/zdx/director/asset-facts", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ image_path: imagePath }),
  });
  const result = await response.json().catch(() => ({}));
  const failure = assistFailure(result, response.ok, response.status);
  if (failure) throw new Error(failure);
  return result.facts || "";
}

export async function loadShotCapabilities() {
  const response = await (await api()).fetchApi("/zdx/director/capabilities");
  const result = await response.json();
  if (!response.ok || result?.error) throw new Error(result?.error || `HTTP ${response.status}`);
  return result;
}
