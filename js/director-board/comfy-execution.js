let comfyRuntime = null;

async function runtime() {
  if (!comfyRuntime) {
    const [appModule, apiModule] = await Promise.all([
      import("../../../scripts/app.js"),
      import("../../../scripts/api.js"),
    ]);
    comfyRuntime = { app: appModule.app, api: apiModule.api };
  }
  return comfyRuntime;
}

function cancelledError() {
  const error = new Error("已取消");
  error.cancelled = true;
  return error;
}

function isTransientNetworkError(error) {
  return /failed to fetch|networkerror|network request failed/i.test(String(error?.message || error || ""));
}

function promptOutcome(record) {
  for (const [event, payload] of record?.status?.messages ?? []) {
    if (event === "execution_interrupted") return { cancelled: true };
    if (event === "execution_error") {
      return { error: payload?.exception_message || payload?.exception_type || "执行失败" };
    }
  }
  const seen = (record?.status?.messages ?? []).map(([event]) => event).filter(Boolean);
  return {
    error: seen.length
      ? `执行失败：服务端只返回了 ${seen.join("、")}（没有错误详情）`
      : "执行失败：服务端未返回错误详情",
  };
}

export function createComfyExecution({
  runtime: getRuntime = runtime,
  pollIntervalMs = 1000,
  isCancelled = () => false,
} = {}) {
  const requestedInterval = Number(pollIntervalMs),
    interval = Number.isFinite(requestedInterval) && requestedInterval >= 0
      ? requestedInterval
      : 1000;
  return {
    runtime: getRuntime,
    async queuePrompt(payload) {
      const { app } = await getRuntime(), response = await app.api.queuePrompt(0, payload),
        promptId = response?.prompt_id;
      if (!promptId) throw new Error("入队失败：服务端没有返回 prompt_id");
      return promptId;
    },
    async cancelPrompt(promptId) {
      if (!promptId) return;
      const { api } = await getRuntime();
      await api.fetchApi("/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delete: [promptId] }),
      });
      await api.fetchApi("/interrupt", { method: "POST" });
    },
    async waitForPrompt(promptId, { timeoutMs = 60 * 60 * 1000 } = {}) {
      const { api } = await getRuntime(), deadline = Date.now() + timeoutMs;
      let missing = 0;
      for (;;) {
        if (isCancelled()) throw cancelledError();
        try {
          const response = await api.fetchApi(`/history/${encodeURIComponent(promptId)}`);
          if (!response.ok) throw new Error(`读取任务状态失败：HTTP ${response.status}`);
          const record = (await response.json())?.[promptId];
          if (record) {
            if (record.status?.status_str === "error") {
              const outcome = promptOutcome(record);
              if (outcome.cancelled) throw cancelledError();
              throw new Error(outcome.error);
            }
            if (record.status?.completed) return record;
          }
          const queueResponse = await api.fetchApi("/queue");
          if (queueResponse?.ok) {
            const queue = await queueResponse.json(),
              present = [...(queue?.queue_running ?? []), ...(queue?.queue_pending ?? [])]
                .some((item) => item?.[1] === promptId);
            missing = present ? 0 : missing + 1;
            if (missing >= 3) throw cancelledError();
          }
        } catch (error) {
          if (!isTransientNetworkError(error)) throw error;
        }
        if (Date.now() > deadline) throw new Error("等待执行超时");
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
    },
    extractVideo(record, nodeId) {
      const file = record?.outputs?.[nodeId]?.gifs?.[0];
      if (!file?.filename) throw new Error("执行完成但没有找到输出文件");
      return file;
    },
  };
}
