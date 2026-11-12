// The editor exports the finished rough composition. ComfyUI only loads it and
// the identity references, then runs one Qwen asset-generation node.
function graph() {
  const output = {};
  let next = 1;
  return {
    output,
    add(class_type, inputs) {
      const id = String(next++);
      output[id] = { class_type, inputs };
      return id;
    },
    ref(id, slot = 0) { return [id, slot]; },
    finish(image) {
      const previewId = this.add("PreviewImage", { images: image });
      return { output, previewId, workflow: { last_node_id: next - 1, last_link_id: 1,
        nodes: [], links: [], groups: [], config: {}, extra: {}, version: 0.4 } };
    },
  };
}

function image(g, path) {
  if (!path) throw new Error("缺少构图图或人物身份图");
  return g.ref(g.add("LoadImage", { image: path, upload: "image" }));
}

export function buildCompositionPrompt(values) {
  const g = graph();
  const poseMode = values.draft_mode === "pose";
  const composition = image(g, values.composition_image || values.init_image);
  const identity = values.reference_image ? image(g, values.reference_image) : null;
  if (poseMode && !identity) throw new Error("姿态生成需要人物参考图");
  if (values.reference_image_2 && !identity) throw new Error("第二张人物图需要同时提供第一张人物图");
  const identity2 = values.reference_image_2 ? image(g, values.reference_image_2) : null;
  const result = g.ref(g.add("ZDXAssetGenerator", {
    app_type: poseMode ? "qwen_pose" : "draft_render",
    text_prompt: values.prompt || "",
    output_size: values.output_size || "1k",
    aspect_ratio: values.aspect_ratio || "1:1",
    steps: Number(values.steps || 25),
    enhance: poseMode,
    denoise: 1,
    lora: "",
    strength: 1,
    release_after_run: true,
    init_image: composition,
    ...(identity ? { reference_image: identity } : {}),
    ...(identity2 ? { reference_image_2: identity2 } : {}),
  }));
  return g.finish(result);
}
