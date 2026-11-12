import { uploadAssetImage } from "./asset-client.js";
import { waitForAssetPrompt } from "./generation-client.js";

async function runtime() {
  const [appModule, apiModule] = await Promise.all([
    import("../../../../scripts/app.js"), import("../../../../scripts/api.js"),
  ]);
  return { app: appModule.app, api: apiModule.api };
}

async function nodeInfo(api, name) {
  const response = await api.fetchApi(`/object_info/${name}`);
  return response.ok ? (await response.json())?.[name] : null;
}

function pickOption(info, key, preferred) {
  const values = info?.input?.optional?.[key]?.[0] || [];
  return values.includes(preferred) ? preferred : values.find((value) => value !== "None") || preferred;
}

export async function detectPose(file, method = "dwpose") {
  if (!file) throw new Error("请选择动作参考图片");
  const { app, api } = await runtime();
  const filename = await uploadAssetImage(file);
  const output = { "1": { class_type: "LoadImage", inputs: { image: filename, upload: "image" } } };
  if (method === "sdpose") {
    const [extractor, draw, loader] = await Promise.all([
      nodeInfo(api, "SDPoseKeypointExtractor"), nodeInfo(api, "SDPoseDrawKeypoints"), nodeInfo(api, "CheckpointLoaderSimple"),
    ]);
    const checkpoint = (loader?.input?.required?.ckpt_name?.[0] || []).find((name) => /sdpose/i.test(name));
    if (!extractor || !draw || !checkpoint) throw new Error("当前 ComfyUI 未安装 SDPose 节点或权重");
    output["6"] = { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint } };
    output["2"] = { class_type: "SDPoseKeypointExtractor", inputs: { model: ["6", 0], vae: ["6", 2], image: ["1", 0], batch_size: 1 } };
    output["5"] = { class_type: "SDPoseDrawKeypoints", inputs: { keypoints: ["2", 0], draw_body: true, draw_hands: false, draw_face: false, draw_feet: false, draw_head: true, stick_width: 4, face_point_size: 3, score_threshold: 0.3 } };
    output["3"] = { class_type: "PreviewImage", inputs: { images: ["5", 0] } };
    output["4"] = { class_type: "PreviewAny", inputs: { source: ["2", 0] } };
  } else {
    const detector = await nodeInfo(api, "DWPreprocessor");
    if (!detector) throw new Error("当前 ComfyUI 未安装 comfyui_controlnet_aux 的 DWPose 节点");
    output["2"] = { class_type: "DWPreprocessor", inputs: {
      image: ["1", 0], detect_hand: "disable", detect_body: "enable", detect_face: "disable", resolution: 1024,
      bbox_detector: pickOption(detector, "bbox_detector", "yolox_l.torchscript.pt"),
      pose_estimator: pickOption(detector, "pose_estimator", "dw-ll_ucoco_384_bs5.torchscript.pt"),
    } };
    output["3"] = { class_type: "PreviewImage", inputs: { images: ["2", 0] } };
    output["4"] = { class_type: "PreviewAny", inputs: { source: ["2", 1] } };
  }
  const workflow = { last_node_id: method === "sdpose" ? 6 : 4, last_link_id: 1, nodes: [], links: [], groups: [], config: {}, extra: {}, version: 0.4 };
  const queued = await app.api.queuePrompt(0, { output, workflow });
  if (!queued?.prompt_id) throw new Error("姿态识别任务入队失败");
  const record = await waitForAssetPrompt(api, queued.prompt_id);
  const raw = record?.outputs?.["4"]?.text?.[0];
  const preview = record?.outputs?.["3"]?.images?.[0];
  if (!raw || !preview) throw new Error("识别未返回关键点与预览图，请更新 ComfyUI 后重试");
  return { raw: typeof raw === "string" ? JSON.parse(raw) : raw,
    previewUrl: `/view?${new URLSearchParams({ filename: preview.filename, subfolder: preview.subfolder || "", type: preview.type || "temp" })}` };
}
