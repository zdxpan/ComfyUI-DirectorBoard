import { app } from "../../scripts/app.js";
import { Board, el, ensureDirectorBoardStyle, widget } from "./director-board/index.js";
import { ensureAssistantStorage } from "./director-board/agent-index.js";

const NODE = "ZDXDirectorBoard";

/**
 * 锚点插槽由前端兜底保证存在。
 *
 * Python 侧 INPUT_TYPES 也声明了这三个可选输入，但改 Python 需要重启 ComfyUI，
 * 已经存在的节点实例/已保存的工作流也未必会自动补上插槽——而"接模型"是这个节点
 * 唯一的连线动作，缺插槽就完全没法用。补插槽是幂等的：
 * ComfyUI 的执行器只校验声明过的输入，多出来的插槽不会让节点跑不起来
 * （见 execution.py 的 `valid_inputs = required ∪ optional`）。
 */
const ANCHOR_INPUTS = [
  ["model", "MODEL"],
  ["vae", "VAE"],
  ["clip", "CLIP"],
];

function ensureAnchorInputs(node) {
  for (const [name, type] of ANCHOR_INPUTS) {
    if ((node.inputs ?? []).some((input) => input?.name === name)) continue;
    node.addInput(name, type);
  }
}

app.registerExtension({
  name: "zdx.director.board",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if ((nodeData?.name || nodeType?.comfyClass) !== NODE || nodeType.prototype.__zdxDirectorBoard) return;
    nodeType.prototype.__zdxDirectorBoard = true;
    const created = nodeType.prototype.onNodeCreated;
    const configured = nodeType.prototype.onConfigure;
    const removed = nodeType.prototype.onRemoved;

    nodeType.prototype.onNodeCreated = function () {
      const result = created?.apply(this, arguments);
      const hidden = widget(this);
      if (hidden) {
        hidden.type = "converted-widget";
        hidden.computeSize = () => [0, -4];
      }
      ensureAssistantStorage(this);
      ensureDirectorBoardStyle();
      const root = el("div");
      this.__zdxDirectorBoard = new Board(this, root);
      const dom = this.addDOMWidget("director_board", "zdx_director_board", root, {
        serialize: false,
        hideOnZoom: false,
      });
      dom.computeSize = () => [255, 94];
      ensureAnchorInputs(this);
      this.size = [275, Math.max(130, this.size?.[1] || 0)];
      return result;
    };

    nodeType.prototype.onConfigure = function () {
      const result = configured?.apply(this, arguments);
      ensureAssistantStorage(this);
      ensureAnchorInputs(this);
      queueMicrotask(() => this.__zdxDirectorBoard?.reload());
      return result;
    };

    nodeType.prototype.onRemoved = function () {
      this.__zdxDirectorBoard?.dispose?.();
      this.__zdxDirectorBoard = null;
      return removed?.apply(this, arguments);
    };
  },
});
