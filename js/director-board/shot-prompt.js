/**
 * 单镜 prompt 构造：纯函数，不碰 DOM / app / 网络，便于用 node 直接测。
 *
 * 当前单发架构（见 docs/director-board-design.md）下，前端为每一镜构造
 * `ZDXDirectorBoard → ZDXH3ShotSelect(shot_index) → MiniMaxH3VideoShotSample → VHS_VideoCombine`
 * 子图：以 `app.graphToPrompt()` 的结果为基底，只替换/注入这几个节点，
 * 再裁掉无关节点后提交，做到"只跑导演台这条链路"。
 */

export const SHOT_SELECT_ID = "zdx_shot_select";
export const SHOT_SAMPLE_ID = "zdx_shot_sample";
export const SHOT_SAVE_ID = "zdx_shot_save";

/** 拼装（最后合成整片）用的注入节点 id 与上限。 */
export const FILM_SOURCE_PREFIX = "zdx_film_src_";
export const FILM_AUDIO_PREFIX = "zdx_film_audio_";
export const FILM_SILENCE_PREFIX = "zdx_film_silence_";
export const FILM_BATCH_ID = "zdx_film_batch";
export const FILM_SAVE_ID = "zdx_film_save";
/** `BatchImagesNode` 的 Autogrow 输入上限（min=1, max=50）。 */
export const FILM_MAX_SOURCES = 50;

/** `VHS_LoadVideoPath` 的必填 widget（缺一个 ComfyUI 就报 required_input_missing）。 */
const LOAD_VIDEO_PATH_DEFAULTS = {
  force_rate: 0,
  custom_width: 0,
  custom_height: 0,
  frame_load_cap: 0,
  skip_first_frames: 0,
  select_every_nth: 1,
};

/** DirectorBoard 上的锚点输入名：只用来读模型来源，不参与执行（§10.2）。 */
export const ANCHOR_NAMES = ["model", "vae", "clip"];
export const OPTIONAL_ANCHOR_NAMES = ["audio_vae"];

/**
 * 直通节点判定：Reroute / 前端虚拟节点只存在于画布，**不会进 `graphToPrompt()` 的结果**。
 *
 * 官方 reroute 点通常只是连线上的折点（`origin_id` 直接指向真正的来源），但
 * rgthree 的 `Reroute (rgthree)` 会把自己作为真实节点插进链路 —— 如果锚点直接连在它后面，
 * 拿到的 id 就是个永远不在 prompt 里的节点，服务端只会回 `KeyError: '20'`。
 * 这里的判定与 ComfyUI_MiniMaxH3_Director 里 `isExternalGroupPassthroughNode()` 的做法一致。
 */
function isPassthroughNode(node) {
  if (!node) return false;
  if (/reroute/i.test(String(node.comfyClass ?? node.type ?? ""))) return true;
  if (node.isVirtualNode) {
    const linked = (node.inputs ?? []).filter((item) => item?.link != null);
    if (linked.length <= 1) return true;
  }
  return false;
}

/** 沿直通节点一路往上，返回真正会被序列化的来源 `[节点 id, 输出槽号]`。 */
function resolveLink(graph, linkId) {
  let current = linkId;
  for (let depth = 0; current != null && depth < 16; depth++) {
    const link = graph?.links?.[current] ?? graph?.getLink?.(current);
    if (!link) return null;
    const originId = link.origin_id ?? link.originId;
    if (originId == null) return null;
    const originSlot = link.origin_slot ?? link.originSlot ?? 0;
    // 取不到节点对象时保持原样（例如测试里的极简 graph）
    const origin = graph?.getNodeById?.(originId) ?? graph?._nodes_by_id?.[originId];
    if (!origin || !isPassthroughNode(origin)) return [String(originId), Number(originSlot)];
    const upstream = (origin.inputs ?? []).find((item) => item?.link != null);
    if (!upstream) return null; // 直通节点没有上游：这条线没有真正来源
    current = upstream.link;
  }
  return null; // 链路异常（成环 / 过深）
}

/**
 * 从节点输入读连线来源，返回 `[来源节点 id, 输出槽号]`；未连线返回 null。
 *
 * 槽号必须从连线读：`CheckpointLoaderSimple` 是 MODEL/CLIP/VAE = 0/1/2，
 * 写死 0 会让 clip/vae 接到 MODEL。
 */
export function linkRef(node, name, graph) {
  const input = (node?.inputs ?? []).find((item) => item?.name === name);
  if (!input || input.link == null) return null;
  return resolveLink(graph, input.link);
}

/** 一次读出所有锚点；任一缺失返回 null（调用方据此禁用运行按钮）。 */
export function linkRefs(node, graph, names = ANCHOR_NAMES) {
  const refs = {};
  for (const name of names) {
    const ref = linkRef(node, name, graph);
    if (!ref) return null;
    refs[name] = ref;
  }
  return refs;
}

/** 从序列化结果里读某个锚点（这里的值已经过 graphToPrompt 的重写）。 */
function promptRef(prompt, nodeId, name) {
  const value = prompt?.[String(nodeId)]?.inputs?.[name];
  if (!Array.isArray(value) || typeof value[0] !== "string") return null;
  return [String(value[0]), Number(value[1] ?? 0)];
}

/**
 * 解析 Board 的三个必需锚点，并在已连接时附带 audio_vae 可选锚点。
 *
 * **以 `graphToPrompt()` 的结果为准**，画布连线只作兜底 —— 因为结果里的值才是引擎真正会执行的那个：
 * - `runtime-vars`（脚本变量）patch 了 `graphToPrompt`，会把输入重写成变量**真实来源节点**
 *   （画布上看到的却是 getNode/变量节点，它并不在结果里）；
 * - 旁通 / Reroute 的重写也发生在这一步。
 *
 * 返回 `{model, vae, clip}`；某个锚点压根没接返回 null；
 * 两端都指向不存在于结果里的节点时抛错（并指名是哪个锚点指向哪个节点）。
 */
export function resolveAnchorRefs(prompt, graph, node, names = ANCHOR_NAMES) {
  const canvasRefs = linkRefs(node, graph, names);
  const refs = {};
  const dangling = [];
  for (const name of names) {
    const candidates = [promptRef(prompt, node?.id, name), canvasRefs?.[name]].filter(Boolean);
    if (!candidates.length) return null; // 这个锚点没接
    const usable = candidates.find((ref) => prompt?.[ref[0]]);
    if (!usable) {
      dangling.push(`${name} → 节点 ${candidates[0][0]}`);
      continue;
    }
    refs[name] = usable;
  }
  if (dangling.length) {
    throw new Error(
      `锚点引用的节点不在工作流序列化结果里（${dangling.join("；")}）。` +
        "该节点可能被「旁通 / 静音」或已删除——取消旁通或重新连线后再运行。",
    );
  }
  for (const name of OPTIONAL_ANCHOR_NAMES) {
    const candidates = [promptRef(prompt, node?.id, name), linkRef(node, name, graph)].filter(Boolean);
    if (!candidates.length) continue;
    const usable = candidates.find((ref) => prompt?.[ref[0]]);
    if (!usable) {
      throw new Error(
        `锚点引用的节点不在工作流序列化结果里（${name} → 节点 ${candidates[0][0]}）。` +
          "该节点可能被「旁通 / 静音」或已删除——取消旁通或重新连线后再运行。",
      );
    }
    refs[name] = usable;
  }
  return refs;
}

/**
 * 沿 inputs 里的 `[id, slot]` 从 rootId 递归收敛，同时记录**被引用但基底里不存在**的节点。
 *
 * `missing` 是关键：被引用的节点如果不在 `graphToPrompt()` 的结果里（节点被旁通/静音、
 * 连线是悬空的），裁剪后就会留下一条"引用了不存在节点"的 prompt，服务端只会回一句
 * `KeyError: '22'`，非常难查。所以调用方必须拿 missing 直接报错。
 */
function closure(output, rootId) {
  const keep = new Set();
  const missing = new Set();
  const stack = [String(rootId)];
  while (stack.length) {
    const id = stack.pop();
    if (keep.has(id)) continue;
    const node = output?.[id];
    if (!node) {
      missing.add(id);
      continue;
    }
    keep.add(id);
    for (const value of Object.values(node.inputs ?? {})) {
      if (Array.isArray(value) && typeof value[0] === "string") stack.push(value[0]);
    }
  }
  return { keep, missing };
}

/** 只保留 rootId 的依赖闭包（静默丢弃无关节点；悬空引用请用 `finalizePrompt()`）。 */
export function pruneToClosure(output, rootId) {
  const { keep } = closure(output, rootId);
  return Object.fromEntries(Object.entries(output ?? {}).filter(([id]) => keep.has(id)));
}

/** 裁剪并校验：悬空引用一律抛错，不允许发出自相矛盾的 prompt。 */
function finalizePrompt(output, rootId) {
  const { keep, missing } = closure(output, rootId);
  if (missing.size) {
    throw new Error(
      `这些节点被引用、但不在工作流序列化结果里：${[...missing].join("、")}。` +
        "通常是该节点被「旁通 / 静音」或连线已失效——取消旁通或重新连线后再运行。",
    );
  }
  return Object.fromEntries(Object.entries(output).filter(([id]) => keep.has(id)));
}

/**
 * 构造一条"单镜"提交体。
 *
 * @param {object} args
 * @param {object} args.prompt      `app.graphToPrompt().output`（执行对象）
 * @param {object} args.workflow    `app.graphToPrompt().workflow`（UI 格式，原样带回）
 * @param {string|number} args.boardId  画布上 DirectorBoard 的节点 id
 * @param {string} args.projectJson 提交时要写进 Board 的项目 JSON 字符串
 * @param {number} args.shotIndex   本镜在 `shots_json` 里的下标
 * @param {object} args.params      已解析好的采样参数（seed/seed_mode 已落地成具体 seed）
 * @param {object} args.refs        model/vae/clip 及可选 audio_vae 的 `[id, slot]`
 * @param {number} args.frameRate   本镜输出帧率（output_fps）
 * @param {string} args.filenamePrefix 本镜的输出文件名前缀
 * @returns {{output: object, workflow: object}}
 */
export function buildShotPrompt({
  prompt,
  workflow,
  boardId,
  projectJson,
  shotIndex,
  params,
  refs,
  frameRate,
  filenamePrefix,
}) {
  if (!prompt || typeof prompt !== "object") {
    throw new Error("buildShotPrompt 需要 app.graphToPrompt() 的 output 作为基底");
  }
  if (!refs?.model || !refs?.vae || !refs?.clip) {
    throw new Error("导演台未接完整：请把 MODEL / VAE / CLIP 连到导演台节点的锚点输入");
  }
  // 锚点指向的节点必须真的在序列化结果里：旁通/静音的节点不会出现在
  // graphToPrompt() 的输出里，照发就会得到服务端一句 KeyError: '22'。
  const dangling = Object.entries(refs)
    .filter(([, ref]) => !prompt[String(ref?.[0])])
    .map(([name, ref]) => `${name} → 节点 ${ref?.[0]}`);
  if (dangling.length) {
    throw new Error(
      `锚点引用的节点不在工作流序列化结果里（${dangling.join("；")}）。` +
        "该节点可能被「旁通 / 静音」或已删除——取消旁通或重新连线后再运行。",
    );
  }
  const board = String(boardId);
  // 浅拷贝即可：下面只整体替换 / 新增条目，不改动既有条目的内部结构。
  const output = { ...prompt };

  output[board] = {
    class_type: "ZDXDirectorBoard",
    inputs: { project_json: projectJson },
  };
  output[SHOT_SELECT_ID] = {
    class_type: "ZDXH3ShotSelect",
    // Board 的 RETURN_NAMES = (project_json, shots_json, selected_shot_json)
    // → shots_json 是第 1 个输出槽
    inputs: { shots_json: [board, 1], shot_index: shotIndex },
  };
  output[SHOT_SAMPLE_ID] = {
    class_type: "MiniMaxH3VideoShotSample",
    inputs: {
      model: refs.model,
      vae: refs.vae,
      clip: refs.clip,
      ...(refs.audio_vae ? { audio_vae: refs.audio_vae } : {}),
      shot: [SHOT_SELECT_ID, 0],
      seed: params.seed,
      steps: params.steps,
      denoise: params.denoise,
      sampling_profile: params.sampling_profile ?? "fast",
      sampler_name: params.sampler_name,
      scheduler: params.scheduler,
      ref_image_size: params.ref_image_size ?? "match",
      output_generated_audio: Boolean(params.output_generated_audio),
      latent_upscale: Boolean(params.latent_upscale),
      latent_upscale_scale: Number(params.latent_upscale_scale) || 1.5,
    },
  };
  output[SHOT_SAVE_ID] = {
    class_type: "VHS_VideoCombine",
    inputs: {
      images: [SHOT_SAMPLE_ID, 0],
      audio: [SHOT_SAMPLE_ID, 2],
      // 播放帧率用 output_fps，不是 motion_fps（§10.7）
      frame_rate: Number(frameRate) || 24,
      loop_count: 0,
      filename_prefix: filenamePrefix,
      format: "video/h264-mp4",
      pingpong: false,
      save_output: true,
    },
  };

  return { output: finalizePrompt(output, SHOT_SAVE_ID), workflow };
}

/**
 * 构造"最后拼装一次"的提交体（§10.7）：N 个已落盘的分镜视频 → 合流 → 一个整片。
 *
 * 这条 prompt 不含采样节点，只是把磁盘上的产物读回来按顺序拼成一条：
 * `VHS_LoadVideoPath`（按绝对路径读回，IMAGE 在 0 号槽）
 *   → `BatchImagesNode`（Autogrow，`images.imageN`）
 *   → 有音轨时连接原声，无音轨时按需接 `EmptyAudio`
 *   → `VHS_VideoCombine`（整片导出）。
 *
 * @param {object} args
 * @param {object} args.prompt   `app.graphToPrompt().output`
 * @param {object} args.workflow `app.graphToPrompt().workflow`
 * @param {object[]} args.sources 按时间轴顺序排列的结果路径、音轨事实和时长
 * @param {number} args.frameRate 整片帧率（用 output_fps，不是 motion_fps）
 * @param {string} args.filenamePrefix 整片输出前缀
 */
export function buildFilmPrompt({ prompt, workflow, sources, frameRate, filenamePrefix }) {
  if (!prompt || typeof prompt !== "object") {
    throw new Error("buildFilmPrompt 需要 app.graphToPrompt() 的 output 作为基底");
  }
  const list = (sources ?? []).filter((item) => item && typeof item.path === "string" && item.path.trim());
  if (!list.length) throw new Error("没有可拼装的分镜结果");
  if (list.length > FILM_MAX_SOURCES) {
    throw new Error(
      `一次最多拼装 ${FILM_MAX_SOURCES} 个分镜（BatchImagesNode 的 Autogrow 上限），请分段拼装`,
    );
  }

  const output = { ...prompt };
  const imageLinks = [];
  const audioLinks = [];
  const hasAnyAudio = list.some((item) => item.hasAudio === true);
  list.forEach((item, index) => {
    const id = `${FILM_SOURCE_PREFIX}${index}`;
    // 用 Path 版加载器：产物在 output/ 下，Upload 版只能读 input/。
    output[id] = {
      class_type: "VHS_LoadVideoPath",
      inputs: { video: item.path, ...LOAD_VIDEO_PATH_DEFAULTS },
    };
    imageLinks.push([id, 0]);
    if (hasAnyAudio) {
      if (item.hasAudio === true) audioLinks.push([id, 2]);
      else {
        const silenceId = `${FILM_SILENCE_PREFIX}${index}`;
        const duration = Number(item.durationMs) / 1000;
        if (!Number.isFinite(duration) || duration <= 0) {
          throw new Error(`第 ${index + 1} 镜缺少有效时长，无法补静音轨`);
        }
        output[silenceId] = {
          class_type: "EmptyAudio",
          inputs: { duration, sample_rate: 44100, channels: 2 },
        };
        audioLinks.push([silenceId, 0]);
      }
    }
  });
  output[FILM_BATCH_ID] = {
    class_type: "BatchImagesNode",
    inputs: Object.fromEntries(imageLinks.map((link, index) => [`images.image${index}`, link])),
  };
  let filmAudio = null;
  if (audioLinks.length) {
    filmAudio = audioLinks[0];
    for (let index = 1; index < audioLinks.length; index++) {
      const id = `${FILM_AUDIO_PREFIX}${index}`;
      output[id] = {
        class_type: "AudioConcat",
        inputs: { audio1: filmAudio, audio2: audioLinks[index], direction: "after" },
      };
      filmAudio = [id, 0];
    }
  }
  output[FILM_SAVE_ID] = {
    class_type: "VHS_VideoCombine",
    inputs: {
      images: [FILM_BATCH_ID, 0],
      ...(filmAudio ? { audio: filmAudio } : {}),
      frame_rate: Number(frameRate) || 24,
      loop_count: 0,
      filename_prefix: filenamePrefix,
      format: "video/h264-mp4",
      pingpong: false,
      save_output: true,
    },
  };

  return { output: finalizePrompt(output, FILM_SAVE_ID), workflow };
}
