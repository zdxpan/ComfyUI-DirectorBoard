import { normalizeMediaRange } from "./project-operations.js";

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function node(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") element.className = value;
    else if (key === "text") element.textContent = value;
    else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else element.setAttribute(key, value === true ? "" : value);
  }
  element.append(...children.flat().filter(Boolean));
  return element;
}

function seconds(ms) {
  return `${(Number(ms || 0) / 1000).toFixed(1)}s`;
}

export function clampAudioRange(start, length, total) {
  const safeLength = Math.max(1, Number(length || 0));
  return normalizeMediaRange(start, Number(start || 0) + safeLength, total).start;
}

export function audioRangeState(start, length, total) {
  const duration = Math.max(0, Number(total || 0)),
    blockLength = Math.max(1, Number(length || 0)),
    valid = !duration || blockLength <= duration,
    range = valid
      ? normalizeMediaRange(start, Number(start || 0) + blockLength, duration)
      : { start: 0, end: blockLength };
  return {
    valid,
    ...range,
    available: duration,
  };
}

export function audioTimeline({
  asset,
  shots,
  durationMs,
  timelineMs,
  selectedShotId,
  onSelect,
  onMove,
  placementMode = "source",
}) {
  let outputCursor = 0;
  const ranges = shots.flatMap((shot) => {
      const binding = shot.bindings.find((item) =>
        item.asset_id === asset.id && item.role === "source_audio" && item.range_ms
      ), outputStart = outputCursor;
      outputCursor += shot.duration_ms;
      return binding ? [{ shot, binding, outputStart }] : [];
    }),
    total = Number(timelineMs || 0) || Number(durationMs || 0) || Math.max(
      ...ranges.map(({ binding }) => binding.range_ms.end),
      1,
    ),
    track = node("div", {
      class: "zdb-audio-track",
      role: "group",
      "aria-label": `${asset.name || "音频"}切片轨道`,
    });

  for (const [index, { shot, binding, outputStart }] of ranges.entries()) {
    const range = binding.range_ms,
      length = shot.duration_ms,
      state = audioRangeState(range.start, length, Number(durationMs || 0)),
      block = node("button", {
        type: "button",
        class: `zdb-audio-block ${shot.id === selectedShotId ? "zdb-active" : ""} ${state.valid ? "" : "zdb-invalid-range"}`,
        title: state.valid
          ? "拖动或使用左右方向键选择音频起点；区间长度跟随分镜时长"
          : `音频只有 ${seconds(state.available)}，短于当前分镜 ${seconds(length)}`,
        "aria-disabled": state.valid ? null : "true",
        onclick: () => onSelect?.(shot.id),
        onkeydown: (event) => {
          if (!state.valid || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const step = event.shiftKey ? 1000 : 100,
            desired = event.key === "Home"
              ? 0
              : event.key === "End"
              ? Math.max(0, Number(durationMs || total) - length)
              : range.start + (event.key === "ArrowRight" ? step : -step),
            next = clampAudioRange(desired, length, Number(durationMs || total));
          if (next !== range.start) onMove?.(shot, binding, next, next + length);
        },
      });
    block.append(
      node("span", { class: "zdb-audio-label-full", text: `${shot.title} · ${seconds(length)}` }),
      node("span", { class: "zdb-audio-label-compact", text: String(index + 1) }),
    );
    const place = (start) => {
      block.style.left = `${start / total * 100}%`;
      block.style.width = `${Math.min(100, length / total * 100)}%`;
    };
    place(placementMode === "output" ? outputStart : range.start);
    block.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !state.valid) return;
      event.preventDefault();
      const startX = event.clientX,
        initial = range.start,
        bounds = track.getBoundingClientRect();
      let next = initial;
      block.setPointerCapture?.(event.pointerId);
      const move = (moveEvent) => {
        next = clampAudioRange(
          initial + (moveEvent.clientX - startX) / Math.max(bounds.width, 1) * total,
          length,
          total,
        );
        next = clampAudioRange(next, length, Number(durationMs || total));
        if (placementMode !== "output") place(next);
      };
      const end = () => {
        block.removeEventListener("pointermove", move);
        block.removeEventListener("pointerup", end);
        block.removeEventListener("pointercancel", end);
        if (next !== initial) onMove?.(shot, binding, next, next + length);
      };
      block.addEventListener("pointermove", move);
      block.addEventListener("pointerup", end);
      block.addEventListener("pointercancel", end);
    });
    track.append(block);
  }

  return node(
    "section",
    { class: "zdb-audio-timeline" },
    node("div", { class: "zdb-audio-ruler" },
      node("b", { text: asset.name || "全局音频" }),
      node("span", { text: "当前音轨" }),
    ),
    ...ranges.filter(({ shot }) =>
      durationMs && shot.duration_ms > durationMs
    ).map(({ shot }) => node("p", {
      class: "zdb-error zdb-audio-error",
      text: `“${shot.title}”时长 ${seconds(shot.duration_ms)}，超过音频 ${seconds(durationMs)}，请缩短分镜或更换音频。`,
    })),
    track,
  );
}
