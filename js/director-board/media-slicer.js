/** MV / 长视频全片切分工作面；普通时间轴与单镜裁剪不在这里。 */
import { SLICE_KINDS_BY_TEMPLATE } from "./model.js";
import {
  removeTimelineRange, replaceTimelineWithSlices, sourceRanges,
} from "./project-operations.js";
import { button, el, inputViewUrl, seconds } from "./ui.js";

export function equalSliceCuts(durationMs, count) {
  const total = Math.max(0, Math.round(Number(durationMs) || 0)),
    parts = Math.max(2, Math.min(24, Math.round(Number(count) || 2)));
  if (!total) return [];
  return Array.from({ length: parts + 1 }, (_, index) => Math.round(total * index / parts));
}

export function splitSliceCuts(ranges, at, totalMs) {
  const point = Math.round(Number(at) || 0), total = Math.round(Number(totalMs) || 0);
  if (!total || point <= 0 || point >= total) return null;
  const active = ranges.find((range) => range.start < point && point < range.end);
  if (ranges.length && !active) return null;
  return ranges.length
    ? [...new Set([...ranges.flatMap((range) => [range.start, range.end]), point])].sort((left, right) => left - right)
    : [0, point, total];
}

function ranges(board, asset) {
  return sourceRanges(board.project, asset).map(({ shot, binding, ...range }) => ({
    ...range, shot, binding,
  }));
}

function repartition(board, asset, cuts) {
  replaceTimelineWithSlices(board.project, asset, cuts);
  board.slicer.selectedRange = null;
  board.update();
}

function sliceTrack(board, asset) {
  const items = ranges(board, asset),
    total = board.slicer.durationMs || Math.max(...items.map((item) => item.end), 1),
    track = el("div", { class: "zdb-slices" });
  for (const item of items) {
    track.append(el("button", {
      type: "button",
      class: `zdb-slice ${board.slicer.selectedRange?.start === item.start && board.slicer.selectedRange?.end === item.end ? "zdb-active" : ""}`,
      style: `left:${item.start / total * 100}%;width:${(item.end - item.start) / total * 100}%`,
      text: `${seconds(item.start)}–${seconds(item.end)}`,
      onclick: () => {
        board.slicer.selectedRange = { assetId: asset.id, start: item.start, end: item.end };
        board.draw();
      },
    }));
  }
  const selected = board.slicer.selectedRange;
  if (!selected || selected.assetId !== asset.id) return track;
  const start = el("input", { type: "number", value: selected.start, class: "zdb-small" }),
    end = el("input", { type: "number", value: selected.end, class: "zdb-small" });
  return el("div", {}, track,
    el("div", { class: "zdb-range" },
      el("span", { class: "zdb-muted", text: "选中片段（毫秒）" }), start,
      el("span", { text: "至" }), end,
      button("移动边界", () => {
        const nextStart = Number(start.value), nextEnd = Number(end.value),
          rest = ranges(board, asset).filter((item) => item.start !== selected.start || item.end !== selected.end);
        if (!Number.isInteger(nextStart) || !Number.isInteger(nextEnd) || nextStart < 0 || nextEnd <= nextStart ||
          (board.slicer.durationMs && nextEnd > board.slicer.durationMs)) {
          return board.notice("请输入媒体范围内有效的毫秒区间。");
        }
        if (rest.some((item) => nextStart < item.end && nextEnd > item.start)) {
          return board.notice("移动后不能和其他切片重叠。");
        }
        repartition(board, asset,
          [...new Set([...rest.flatMap((item) => [item.start, item.end]), nextStart, nextEnd])]
            .sort((left, right) => left - right));
      }, "zdb-sub"),
      button("删除切片", () => {
        removeTimelineRange(board.project, asset, selected);
        board.slicer.selectedRange = null;
        board.update();
      }, "zdb-danger")));
}

export function renderSliceModeMenu(board) {
  const kinds = SLICE_KINDS_BY_TEMPLATE[board.project.project.template_id] || [];
  if (!kinds.length) return null;
  const enter = (kind) => {
    board.slicer = { kind, assetId: null, durationMs: 0, selectedRange: null };
    board.draw();
  };
  if (kinds.length === 1) return button("全片切分", () => enter(kinds[0]), "zdb-sub");
  return el("details", { class: "zdb-timeline-mode-menu" },
    el("summary", { text: "全片切分" }),
    el("div", { class: "zdb-timeline-mode-popover" }, ...kinds.map((kind) =>
      button(kind === "audio" ? "音频切分" : "视频切分", () => enter(kind), "zdb-sub"))));
}

export function renderMediaSlicer(board) {
  const state = board.slicer, kind = state.kind, label = kind === "audio" ? "音频" : "视频",
    assets = board.project.assets.filter((asset) => asset.scope === "global" && asset.kind === kind);
  if (!assets.some((asset) => asset.id === state.assetId)) state.assetId = assets[0]?.id || null;
  const asset = board.asset(state.assetId);
  const side = el("div", { class: "zdb-timeline-side zdb-slice-side" },
    el("div", { class: "zdb-row zdb-spread" },
      el("b", { text: `${label}切分分镜` }),
      button("返回", () => { board.slicer = { kind: null, assetId: null, durationMs: 0, selectedRange: null }; board.draw(); }, "zdb-sub")),
    el("p", { class: "zdb-muted zdb-slice-help", text: kind === "audio"
      ? "MV/数字人：按音频打点生成连续音频驱动分镜。"
      : "长视频编辑：按源视频打点生成连续二创分镜。" }));
  if (!asset) {
    side.append(button(`上传全局${label}`, () => board.upload(null, null, kind)));
    return el("footer", { class: "zdb-timeline zdb-slice-workspace" }, side,
      el("section", { class: "zdb-slice-empty" },
        el("b", { text: `请先上传一个${label}文件` }),
        el("span", { text: "上传后可播放、打点、均分并生成对应分镜。" })));
  }
  const select = el("select", { "aria-label": `选择全局${label}` }, ...assets.map((item) =>
      el("option", { value: item.id, text: item.name || item.id }))),
    player = el(kind === "video" ? "video" : "audio", {
      class: "zdb-slice-player", src: inputViewUrl(asset.input_path), controls: true, preload: "metadata",
    }),
    count = el("input", { type: "number", min: "2", max: "24", value: "4", class: "zdb-small", "aria-label": "均分段数" });
  select.value = asset.id;
  select.addEventListener("change", () => {
    board.slicer = { ...state, assetId: select.value, durationMs: 0, selectedRange: null };
    board.draw();
  });
  player.addEventListener("loadedmetadata", () => {
    const duration = Math.round(player.duration * 1000);
    if (duration && duration !== state.durationMs) {
      state.durationMs = duration;
      board.rememberDuration(asset.id, player);
      board.draw();
    }
  });
  side.append(select, el("div", { class: "zdb-row zdb-slice-actions" },
    button("在播放点切分", () => {
      const cuts = splitSliceCuts(ranges(board, asset), player.currentTime * 1000, state.durationMs);
      if (!cuts) return board.notice("请将播放器移动到现有切片内部的有效位置。");
      repartition(board, asset, cuts);
    }, "zdb-sub"),
    el("label", { class: "zdb-inline" }, el("span", { text: "均分" }), count, el("span", { text: "段" })),
    button("应用", () => {
      const cuts = equalSliceCuts(state.durationMs, count.value);
      if (!cuts.length) return board.notice("素材时长尚未读取完成。");
      repartition(board, asset, cuts);
    }, "zdb-sub")));
  return el("footer", { class: "zdb-timeline zdb-slice-workspace" }, side,
    el("section", { class: "zdb-slice-stage" },
      el("div", { class: "zdb-row zdb-spread zdb-slice-stage-head" },
        el("b", { text: asset.name || asset.id }),
        el("span", { class: "zdb-muted", text: state.durationMs ? seconds(state.durationMs) : "读取时长…" })),
      player,
      el("div", { class: `zdb-slice-wave zdb-slice-wave-${kind}` }, sliceTrack(board, asset))));
}
