/**
 * Media preview and range trimming for the Director Board.
 *
 * Kept in its own module on purpose: video probing, proxy playback and the
 * in/out trimming editor are a self-contained stack, and mixing them into
 * editor.js made that file hard to work with.
 *
 * Two backends cooperate with this module (see director_board/media_server.py):
 *   /zdx/director/media-info      ffprobe metadata, used for frame-accurate UI
 *   /zdx/director/preview-video   ffmpeg proxy clip for cheap playback
 * Both degrade gracefully: without the routes the board falls back to direct
 * `/view` playback and browser-reported durations.
 */
import { button, el, inputViewUrl, seconds } from "./ui.js";
import { normalizeMediaRange } from "./project-operations.js";

const MEDIA_INFO_ROUTE = "/zdx/director/media-info";
const PREVIEW_ROUTE = "/zdx/director/preview-video";
const PROBE_CACHE = new Map();
const OUTPUT_PROBE_CACHE = new Map();
const DIRECT_IF_SHORTER_MS = 30_000;
const PREVIEW_WIDTH = 480;
const PREVIEW_FPS = 12;

export const mediaBackend = { probe: true, preview: true };
export const mediaInfoCache = new Map();

let styleInjected = false;
export function ensureVideoWorkspaceStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const link = document.createElement("link");
  link.id = "zdx-director-video-style";
  link.rel = "stylesheet";
  link.href = new URL("./video-workspace.css?v=1", import.meta.url).href;
  document.head.append(link);
}

/** Only one preview plays at a time, otherwise the board turns into a chorus. */
let playing = null;
function playExclusive(element) {
  if (playing && playing !== element) playing.pause();
  playing = element;
  const result = element.play?.();
  result?.catch?.(() => {});
}

export function formatClock(milliseconds) {
  const total = Math.max(0, Math.round(Number(milliseconds || 0) / 100) / 10),
    minutes = Math.floor(total / 60),
    rest = total - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

/**
 * ffprobe-backed metadata. Returns {} when the route is unavailable so callers
 * can keep working with browser-reported durations.
 */
export async function probeMedia(asset) {
  if (!asset?.input_path) return {};
  const cached = PROBE_CACHE.get(asset.input_path);
  if (cached) return cached;
  if (!mediaBackend.probe) return {};
  try {
    const response = await fetch(
      `${MEDIA_INFO_ROUTE}?input_path=${encodeURIComponent(asset.input_path)}`,
      { cache: "no-store" },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const info = await response.json();
    if (info?.error) throw new Error(info.error);
    PROBE_CACHE.set(asset.input_path, info);
    mediaInfoCache.set(asset.id, info);
    if (info.duration_ms) asset.duration_ms = info.duration_ms;
    return info;
  } catch {
    mediaBackend.probe = false;
    return {};
  }
}

export function cachedMediaInfo(assetId) {
  return mediaInfoCache.get(assetId) || null;
}

export async function probeOutputMedia(file) {
  if (!file?.filename) return {};
  const key = `${file.type || "output"}:${file.subfolder || ""}/${file.filename}`;
  if (OUTPUT_PROBE_CACHE.has(key)) return OUTPUT_PROBE_CACHE.get(key);
  try {
    const query = new URLSearchParams({
      filename: file.filename,
      subfolder: file.subfolder || "",
      type: file.type || "output",
    });
    const response = await fetch(`${MEDIA_INFO_ROUTE}?${query}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const info = await response.json();
    if (info?.error) throw new Error(info.error);
    OUTPUT_PROBE_CACHE.set(key, info);
    return info;
  } catch {
    return {};
  }
}

/**
 * Direct playback for short clips, proxied playback for long ones. The proxy
 * keeps real-time duration, so timeline positions map 1:1 onto the source.
 */
export function previewUrl(asset, info, { startMs = 0, endMs = 0 } = {}) {
  const duration = Number(info?.duration_ms || asset?.duration_ms || 0),
    segment = endMs > startMs ? endMs - startMs : duration;
  const long = duration > DIRECT_IF_SHORTER_MS;
  if (!long || !mediaBackend.preview || !endMs || endMs <= startMs) {
    return { url: inputViewUrl(asset.input_path), proxied: false };
  }
  const query = new URLSearchParams({
    input_path: asset.input_path,
    start_ms: String(Math.round(startMs)),
    end_ms: String(Math.round(endMs)),
    width: String(PREVIEW_WIDTH),
    fps: String(PREVIEW_FPS),
  });
  return { url: `${PREVIEW_ROUTE}?${query}`, proxied: true, segmentMs: segment };
}

export function mediaSummary(asset, info) {
  const parts = [];
  const duration = info?.duration_ms || asset?.duration_ms;
  if (duration) parts.push(formatClock(duration));
  if (info?.fps) parts.push(`${Number(info.fps.toFixed(3))} fps`);
  if (info?.width && info?.height) parts.push(`${info.width}×${info.height}`);
  if (info?.frames) parts.push(`${info.frames} 帧`);
  if (info?.sample_rate) parts.push(`${Math.round(info.sample_rate / 1000)} kHz`);
  return parts.join(" · ");
}

/**
 * Inline video tile preview: proportional frame, play/pause overlay and a
 * timecode badge. Long clips play through the proxy clip of the shot range.
 */
export function createVideoPreview(board, asset, { shot, binding, lightbox = true } = {}) {
  ensureVideoWorkspaceStyle();
  const info = cachedMediaInfo(asset.id) || {},
    range = binding?.range_ms,
    source = previewUrl(asset, info, {
      startMs: range?.start ?? 0,
      endMs: range?.end ?? 0,
    }),
    video = el("video", {
      class: "zdb-vp-media",
      src: source.url,
      preload: "metadata",
      muted: true,
      playsinline: true,
      loop: true,
    }),
    badge = el("span", { class: "zdb-vp-badge" },
      el("span", { text: "0:00.0" }),
      source.proxied ? el("span", { class: "zdb-vp-proxy", text: "代理" }) : null),
    toggle = el("button", {
      type: "button",
      class: "zdb-vp-play",
      text: "\u25b6",
      title: "播放 / 暂停预览",
      onclick: (event) => {
        event.stopPropagation();
        if (video.paused) playExclusive(video);
        else video.pause();
      },
    }),
    wrap = el("div", {
      class: "zdb-video-preview",
      onclick: () => {
        if (shot && binding) openTrimEditor(board, shot, asset, binding);
      },
    }, video, toggle, badge);

  const clock = badge.firstElementChild;
  let fallback = false;
  video.addEventListener("timeupdate", () => {
    const offset = source.proxied ? 0 : Number(range?.start || 0) / 1000;
    clock.textContent = formatClock((video.currentTime + offset) * 1000);
  });
  video.addEventListener("play", () => toggle.classList.add("zdb-vp-playing"));
  video.addEventListener("pause", () => toggle.classList.remove("zdb-vp-playing"));
  video.addEventListener("error", () => {
    if (source.proxied && !fallback) {
      // The proxy route may not exist on older installs; drop back to the
      // original file and stop asking for proxies from now on.
      fallback = true;
      mediaBackend.preview = false;
      video.src = inputViewUrl(asset.input_path);
      badge.replaceChildren(el("span", { text: "0:00.0" }));
      return;
    }
    wrap.replaceChildren(el("span", {
      class: "zdb-vp-error",
      text: "无法预览该视频\n可点裁剪查看片段信息",
    }));
  });
  if (lightbox) {
    toggle.title = "播放 / 暂停预览；点击画面进入裁剪";
  }
  probeMedia(asset).then((probed) => {
    if (probed?.duration_ms && !range) board.rememberDuration(asset.id, { duration: probed.duration_ms / 1000 }, false);
  });
  return wrap;
}

/**
 * Lightweight audio preview: play/pause, progress and the trimmed window.
 * Audio files stay on the direct endpoint; they are small enough to stream.
 */
export function createAudioPreview(board, asset, { binding } = {}) {
  ensureVideoWorkspaceStyle();
  const range = binding?.range_ms,
    audio = el("audio", { preload: "metadata", src: inputViewUrl(asset.input_path) }),
    fill = el("span", { class: "zdb-ap-fill" }),
    window = range ? el("span", { class: "zdb-ap-window" }) : null,
    track = el("span", { class: "zdb-ap-track", title: "点击定位" }, fill, window),
    time = el("span", { class: "zdb-ap-time", text: "0:00.0" }),
    toggle = el("button", {
      type: "button",
      class: "zdb-ap-toggle",
      text: "\u25b6",
      title: "播放 / 暂停",
      onclick: () => {
        if (audio.paused) {
          const start = Number(range?.start || 0) / 1000;
          if (Number.isFinite(audio.duration) && audio.currentTime < start) audio.currentTime = start;
          playExclusive(audio);
        } else audio.pause();
      },
    }),
    paint = () => {
      const total = Number(audio.duration) || Number(asset.duration_ms || 0) / 1000;
      if (!total) return;
      fill.style.width = `${Math.min(100, audio.currentTime / total * 100)}%`;
      if (window && range) {
        window.style.left = `${Math.min(100, range.start / 1000 / total * 100)}%`;
        window.style.width = `${Math.min(100, (range.end - range.start) / 1000 / total * 100)}%`;
      }
      time.textContent = formatClock(audio.currentTime * 1000);
    };
  audio.addEventListener("timeupdate", () => {
    const end = Number(range?.end || 0) / 1000;
    if (end && audio.currentTime >= end) {
      audio.currentTime = Number(range.start) / 1000;
      audio.pause();
    }
    paint();
  });
  audio.addEventListener("loadedmetadata", () => {
    paint();
    board?.rememberDuration?.(asset.id, audio, false);
  });
  audio.addEventListener("play", () => { toggle.textContent = "\u23f8"; });
  audio.addEventListener("pause", () => { toggle.textContent = "\u25b6"; });
  track.addEventListener("click", (event) => {
    const total = Number(audio.duration) || Number(asset.duration_ms || 0) / 1000;
    if (!total) return;
    const box = track.getBoundingClientRect();
    audio.currentTime = Math.max(0, Math.min(total, (event.clientX - box.left) / box.width * total));
    paint();
  });
  probeMedia(asset);
  return el("span", { class: "zdb-audio-player" }, toggle, track, time);
}

/**
 * Shared in/out editor for source audio and source video.
 *
 * Contract reminder: `range_ms.end - range_ms.start` always equals the shot
 * duration. When the media is shorter than the shot we shorten the shot instead
 * of padding the media, matching how the downstream sampler consumes ranges.
 */
export function openTrimEditor(board, shot, asset, binding, { notice } = {}) {
  ensureVideoWorkspaceStyle();
  if (!binding) return;
  const handle = board.modal(`裁剪 · ${shot.title}`),
    isVideo = asset.kind === "video",
    known = board.audioDuration(asset.id) || Number(asset.duration_ms || 0),
    range = binding.range_ms || { start: 0, end: shot.duration_ms },
    initialRange = normalizeMediaRange(range.start, range.end, known);
  let total = known, start = initialRange.start, end = initialRange.end;

  const stage = el("div", { class: "zdb-trim-stage" }),
    infoLine = el("div", { class: "zdb-trim-info" }),
    band = el("span", { class: "zdb-trim-selection" }),
    playhead = el("span", { class: "zdb-trim-playhead" }),
    handleStart = el("span", { class: "zdb-trim-handle", title: "入点" }),
    handleEnd = el("span", { class: "zdb-trim-handle", title: "出点" }),
    track = el("div", { class: "zdb-trim-range" }, band, playhead, handleStart, handleEnd),
    startField = el("input", { type: "number", min: "0", step: "100", "aria-label": "起点毫秒" }),
    endField = el("input", { type: "number", min: "0", step: "100", "aria-label": "终点毫秒" }),
    lengthReadout = el("span", { class: "zdb-muted" }),
    warning = el("p", { class: "zdb-trim-warning", style: "display:none" }),
    liveBox = el("div", { class: "zdb-trim-live", style: "display:none" }),
    media = isVideo
      ? el("video", { src: inputViewUrl(asset.input_path), controls: true, preload: "metadata", loop: true })
      : el("audio", { src: inputViewUrl(asset.input_path), controls: true, preload: "metadata" });
  stage.append(media);

  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const paint = () => {
    const span = Math.max(1, total || end || 1);
    band.style.left = `${clamp(start / span * 100, 0, 100)}%`;
    band.style.width = `${clamp((end - start) / span * 100, 0, 100)}%`;
    handleStart.style.left = `${clamp(start / span * 100, 0, 100)}%`;
    handleEnd.style.left = `${clamp(end / span * 100, 0, 100)}%`;
    startField.value = String(Math.round(start));
    endField.value = String(Math.round(end));
    const length = Math.max(0, end - start), fps = cachedMediaInfo(asset.id)?.fps;
    lengthReadout.textContent = `片段 ${formatClock(start)} → ${formatClock(end)} · 长度 ${seconds(length)}${
      fps ? ` · 约 ${Math.max(1, Math.round(length / 1000 * fps))} 帧` : ""
    }`;
    const over = total && end > total;
    warning.style.display = over ? "" : "none";
    warning.textContent = over ? "片段超出素材长度，请缩短终点或调整起点。" : "";
  };
  const setRange = (nextStart, nextEnd) => {
    ({ start, end } = normalizeMediaRange(nextStart, nextEnd, total));
    paint();
  };
  const drag = (handle, isStart) => {
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      handle.setPointerCapture?.(event.pointerId);
      const box = track.getBoundingClientRect(),
        move = (moveEvent) => {
          if (!total) return;
          const ratio = clamp((moveEvent.clientX - box.left) / Math.max(box.width, 1), 0, 1),
            value = ratio * total;
          if (isStart) setRange(Math.min(value, end - 1), end);
          else setRange(start, Math.max(value, start + 1));
        },
        stop = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", stop);
          handle.removeEventListener("pointercancel", stop);
        };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", stop);
      handle.addEventListener("pointercancel", stop);
    });
  };
  drag(handleStart, true);
  drag(handleEnd, false);
  track.addEventListener("click", (event) => {
    if (!total) return;
    const box = track.getBoundingClientRect(),
      at = clamp((event.clientX - box.left) / Math.max(box.width, 1), 0, 1) * total;
    if (Math.abs(at - start) < Math.abs(at - end)) start = Math.min(at, end - 1);
    else end = Math.max(at, start + 1);
    paint();
  });
  const syncFromFields = () => setRange(Number(startField.value) || 0, Number(endField.value) || 0);
  startField.addEventListener("change", syncFromFields);
  endField.addEventListener("change", syncFromFields);
  track.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 1000 : 100;
    if (event.key === "ArrowLeft") setRange(start - step, end - step);
    else if (event.key === "ArrowRight") setRange(start + step, end + step);
    else if (event.key === "[") setRange(start, end);
    else return;
    event.preventDefault();
  });
  media.addEventListener("timeupdate", () => {
    const span = Math.max(1, total || 1);
    if (total) playhead.style.left = `${clamp(media.currentTime / span * 100, 0, 100)}%`;
    if (end && media.currentTime * 1000 > end) media.currentTime = start / 1000;
  });

  const paintInfo = () => {
    infoLine.replaceChildren(
      el("span", { text: mediaSummary(asset, cachedMediaInfo(asset.id) || {}) || "时长待读取" }),
      el("span", { text: `分镜 ${seconds(shot.duration_ms)}` }),
    );
  };
  const useWholeMedia = () => {
    if (!total) return;
    setRange(0, Math.min(total, Math.max(1, total)));
  };
  const useShotLength = () => setRange(start, start + shot.duration_ms);
  const previewSegment = () => {
    const source = previewUrl(asset, cachedMediaInfo(asset.id) || {}, { startMs: start, endMs: end });
    liveBox.style.display = "";
    liveBox.replaceChildren(
      isVideo
        ? el("video", { src: source.url, controls: true, autoplay: true, loop: true, muted: true })
        : el("audio", { src: source.url, controls: true, autoplay: true }),
      el("span", {
        class: "zdb-muted",
        text: source.proxied ? "代理片段（低分辨率、仅当前片段）" : "原始文件片段",
      }),
    );
  };

  const root = el("div", { class: "zdb-trim" });
  root.append(
    el("p", {
      class: "zdb-muted",
      text: isVideo
        ? "拖动入点/出点选择要用的画面片段；片段长度会成为当前分镜时长。"
        : "拖动入点/出点选择要用的音频片段；片段长度会成为当前分镜时长。",
    }),
    stage,
    infoLine,
    track,
    el("div", { class: "zdb-trim-fields" },
      el("label", {}, "起点(ms)", startField),
      el("label", {}, "终点(ms)", endField),
      lengthReadout),
    el("div", { class: "zdb-trim-actions" },
      button("整段", useWholeMedia, "zdb-sub"),
      button("按当前分镜时长", useShotLength, "zdb-sub"),
      button("播放片段", previewSegment, "zdb-sub"),
      button("载入素材信息", async () => {
        const info = await probeMedia(asset);
        total = Number(info.duration_ms || total);
        paintInfo();
        paint();
      }, "zdb-sub")),
    warning,
    liveBox,
  );
  handle.body.append(root);
  handle.footer.append(button("应用片段", () => {
    const length = Math.max(1, end - start),
      shortened = !total || length < shot.duration_ms;
    binding.range_ms = { start, end: start + length };
    shot.duration_ms = length;
    handle.close();
    board.update();
    if (shortened) {
      const message = `分镜时长已调整为 ${seconds(length)} 以匹配所选片段。`;
      if (notice) notice(message);
      else board.notice(message);
    }
  }));
  paintInfo();
  paint();
  board.focus(handle.element);
  if (!known) {
    probeMedia(asset).then((info) => {
      total = Number(info.duration_ms || total);
      setRange(
        binding.range_ms ? start : 0,
        binding.range_ms ? end : Math.min(total || shot.duration_ms, shot.duration_ms),
      );
      paintInfo();
    });
  }
}
