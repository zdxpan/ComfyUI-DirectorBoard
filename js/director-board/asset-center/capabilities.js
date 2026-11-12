export const ASSET_CAPABILITIES = {
  draft_render: { label: "Qwen 草稿生成", inputs: ["image", "reference_image", "reference_image_2", "prompt"], advanced: ["steps"] },
  zimage: {
    label: "ZImage 文生图",
    inputs: ["prompt"],
    advanced: ["output_size", "aspect_ratio", "lora", "strength", "enhance", "steps"],
  },
  qwen21_t2i: {
    label: "Qwen 2.1 文生图",
    inputs: ["prompt"],
    advanced: ["output_size", "aspect_ratio", "enhance"],
  },
  zimage_reverse: { label: "ZImage 反推再生成", inputs: ["image", "prompt"], advanced: ["output_size", "strength", "enhance", "steps"] },
  zimage_caption2img: { label: "ZImage Caption 生图", inputs: ["image", "prompt"], advanced: ["output_size", "strength", "enhance", "steps"] },
  zimage_refine: { label: "ZImage 精修", inputs: ["image", "prompt"], advanced: ["output_size", "strength", "enhance", "steps"] },
  // zimage_inpaint: { label: "ZImage 局部修改", inputs: ["image", "mask", "prompt"], advanced: ["output_size", "strength", "steps"] },
  upscale: { label: "ZImage 放大", inputs: ["image", "prompt"], advanced: ["output_size", "denoise"] },
  caption2img: { label: "ZImage TTP Caption 生图", inputs: ["image", "prompt"], advanced: ["output_size", "enhance", "denoise"] },
  img2img: { label: "ZImage 图生图", inputs: ["image", "prompt"], advanced: ["output_size", "enhance", "denoise"] },
  qwen_edit: { label: "Qwen Edit 万能改图", inputs: ["image", "reference_image", "prompt"], advanced: [] },
  qwen21_edit: { label: "Qwen 2.1 万能改图", inputs: ["image", "reference_image", "prompt"], advanced: ["enhance"] },
  klein_edit: { label: "Klein 万能改图", inputs: ["image", "reference_image", "prompt"], advanced: ["output_size"] },
  pose: { label: "ZImage 姿态控制", inputs: ["image", "prompt"], advanced: ["output_size", "enhance"] },
};

export const ASSET_GENERATION_DEFAULTS = {
  output_size: "1.5k", aspect_ratio: "1:1", lora: "", strength: 0.8,
  enhance: false, denoise: 0.5, steps: 10,
};
