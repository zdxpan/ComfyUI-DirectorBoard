import { buildCompositionPrompt } from "./generation-graph.js";

let comfyRuntime = null;
async function runtime() {
  if (!comfyRuntime) {
    const [appModule, apiModule] = await Promise.all([
      import("../../../../scripts/app.js"), import("../../../../scripts/api.js"),
    ]);
    comfyRuntime = { app: appModule.app, api: apiModule.api };
  }
  return comfyRuntime;
}

export async function waitForAssetPrompt(api, promptId, { pollIntervalMs = 1000, missingLimit = 3, onStatus = () => {} } = {}) {
  const deadline = Date.now() + 60 * 60 * 1000;
  let missing = 0, lastStatus = "";
  for (;;) {
    const response = await api.fetchApi(`/history/${encodeURIComponent(promptId)}`);
    const record = response.ok ? (await response.json())?.[promptId] : null;
    if (record?.status?.status_str === "error") {
      const message = record.status?.messages?.find?.(([kind]) => kind === "execution_error")?.[1]?.exception_message;
      throw new Error(message || "资产生成失败");
    }
    if (record?.status?.completed) return record;
    const queueResponse = await api.fetchApi("/queue");
    if (queueResponse?.ok) {
      const queue = await queueResponse.json();
      const running = (queue?.queue_running ?? []).some((item) => item?.[1] === promptId);
      const pending = (queue?.queue_pending ?? []).some((item) => item?.[1] === promptId);
      const present = running || pending;
      const status = running ? "正在生成候选图…" : pending ? "任务已排队…" : "正在确认任务状态…";
      if (status !== lastStatus) { onStatus(status); lastStatus = status; }
      missing = present ? 0 : missing + 1;
      if (missing >= missingLimit) throw new Error("资产生成已取消");
    }
    if (Date.now() > deadline) throw new Error("资产生成超时");
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

export async function generateAssetCandidate(values, onStatus = () => {}) {
  const { app, api } = await runtime();
  if (values.app_type === "draft_render") {
    const { output, workflow, previewId } = buildCompositionPrompt(values);
    const queued = await app.api.queuePrompt(0, { output, workflow });
    if (!queued?.prompt_id) throw new Error("资产生成任务入队失败");
    onStatus("任务已提交，等待执行…");
    const record = await waitForAssetPrompt(api, queued.prompt_id, { onStatus });
    const images = record?.outputs?.[previewId]?.images || [];
    if (!images.length) throw new Error("生成完成，但没有图片输出");
    return images[0];
  }
  const inputs = {
      app_type: values.app_type, text_prompt: values.prompt,
      output_size: values.output_size, aspect_ratio: values.aspect_ratio,
      steps: Number(values.steps || 10),
      enhance: Boolean(values.enhance), denoise: Number(values.denoise ?? 0.5),
      lora: values.lora || "", strength: Number(values.strength ?? 0.8),
      release_after_run: true,
  };
  const output = { "1": { class_type: "ZDXAssetGenerator", inputs }, "2": { class_type: "PreviewImage", inputs: { images: ["1", 0] } } };
  let nextId = 3;
  const attachImage = (path, inputName, outputIndex = 0) => {
    if (!path) return;
    const id = String(nextId++);
    output[id] = { class_type: "LoadImage", inputs: { image: path, upload: "image" } };
    inputs[inputName] = [id, outputIndex];
  };
  if (!["qwen21_t2i", "q21_t2i"].includes(values.app_type)) {
    attachImage(values.init_image, "init_image");
    attachImage(values.reference_image, "reference_image");
    attachImage(values.mask, "mask", 1);
  }
  const workflow = { last_node_id: nextId - 1, last_link_id: 1, nodes: [], links: [], groups: [], config: {}, extra: {}, version: 0.4 };
  const queued = await app.api.queuePrompt(0, { output, workflow });
  if (!queued?.prompt_id) throw new Error("资产生成任务入队失败");
  onStatus("任务已提交，等待执行…");
  const record = await waitForAssetPrompt(api, queued.prompt_id, { onStatus });
  const images = record?.outputs?.["2"]?.images || [];
  if (!images.length) throw new Error("生成完成，但没有图片输出");
  return images[0];
}
