import { renderMediaSlicer, renderSliceModeMenu } from "./media-slicer.js";
import { button, el } from "./ui.js";

export function renderTimelineWorkspace(board, projectModeControl) {
  if (board.slicer.kind) return renderMediaSlicer(board);
  const metrics = board.timelineMetrics();
  const busy = board.dispatch?.isBusy?.() ?? (board.dispatch?.isRunning?.() || board.dispatch?.isPaused?.());
  const runDisabled = busy ? "zdb-disabled" : "";
  const runProgress = board.dispatch?.getProgress?.();
  return el("footer", { class: "zdb-timeline" },
    el("div", { class: "zdb-timeline-side" },
      el("div", { class: "zdb-row zdb-spread" },
        el("b", { text: "分镜时间轴" }),
        el("span", { class: "zdb-muted zdb-zoom-state zdb-timeline-live", text: runProgress
          ? `${runProgress.index + 1}/${runProgress.batchTotal} · ${runProgress.label} 生成中`
          : board.timelineFit ? "适应窗口" : "标准" })),
      projectModeControl(),
      button(metrics.asset ? "♪ 调整音频" : "＋ 准备音频",
        () => board.openAudioPreparation(), "zdb-timeline-audio-link"),
      el("div", { class: "zdb-timeline-tools" },
        button(board.timelineFit ? "标准" : "适应窗口", () => board.toggleTimelineFit(), "zdb-sub"),
      ),
      el("div", { class: "zdb-timeline-actions" },
        button(board.wall ? "收起总览" : "展开总览", () => { board.wall = !board.wall; board.draw(); }, "zdb-sub"),
        renderSliceModeMenu(board),
      ),
      // Batch execution is secondary to the in-prompt current-shot send.
      el("div", { class: "zdb-timeline-run" },
        button("批量生成", () => board.dispatch?.preflightAll(), `zdb-sub ${runDisabled}`),
        (board.dispatch?.isRunning?.() || board.dispatch?.isPaused?.())
          ? button("停止全部", () => board.dispatch?.stopAll(), "zdb-danger") : null,
      ),
    ),
    el("div", { class: "zdb-timeline-track-wrap" },
    el("div", { class: "zdb-timeline-scroll", onscroll: (event) => board.timelineScrollLeft = event.currentTarget.scrollLeft },
      el("div", { class: "zdb-timeline-canvas", style: `width:${metrics.width}px` },
        board.timelineShotTrack(metrics))),
    ));
}
