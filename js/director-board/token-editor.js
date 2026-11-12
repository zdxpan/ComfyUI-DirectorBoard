/** 纯文本提示词编辑器：textarea 是唯一真相，`@` 只负责插入官方媒体标签。 */
import { el } from "./ui.js";

const TAG_SOURCE = /<(Picture|Video|Audio)\s+(\d+)\s*>/gi;

const EDITOR_STYLES = `
.zdb-prompt-wrap{position:relative;min-height:90px;flex:1;display:flex;flex-direction:column;gap:5px}
.zdb-prompt-editor{width:100%;min-height:80px;max-height:260px;flex:1 1 auto;box-sizing:border-box;resize:none;
  background:var(--zdb-input,#fff);border:1px solid var(--zdb-line,#dcb3c1);border-radius:6px;
  color:var(--zdb-text,#563d47);padding:8px 10px;font:13px/1.5 system-ui;outline:none;overflow:auto}
.zdb-prompt-editor:focus{border-color:var(--zdb-primary,#d75f8c);box-shadow:0 0 0 1px rgba(215,95,140,.22)}
.zdb-token-preview{display:flex;align-items:center;gap:5px;min-height:20px;overflow-x:auto}
.zdb-token-preview:empty{display:none}
.zdb-token-preview-item{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;padding:2px 5px;border-radius:4px;background:var(--zdb-match-soft,#e6f5ec);font-size:10px}
.zdb-token-preview-item.is-missing{background:var(--zdb-audio-soft,#fbf1de);color:var(--zdb-audio-ink,#8a6320)}
.zdb-token-thumb{width:18px;height:18px;border-radius:3px;object-fit:cover;background:#111;border:1px solid rgba(0,0,0,.25)}
.zdb-token-glyph{width:18px;height:18px;border-radius:3px;display:inline-flex;align-items:center;justify-content:center;background:var(--zdb-panel,#fff)}
.zdb-mention-menu{position:fixed;z-index:30;max-height:240px;overflow:auto;
  padding:3px;border:1px solid var(--zdb-line,#dcb3c1);border-radius:6px;background:var(--zdb-input,#fff);box-shadow:0 8px 24px #0000002b}
.zdb-mention-item{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:4px;cursor:pointer;font-size:11px;color:var(--zdb-text,#563d47)}
.zdb-mention-group{padding:5px 6px 2px;color:var(--zdb-muted,#927480);font-size:10px;font-weight:600}
.zdb-mention-item.is-active{background:var(--zdb-match-soft,#e6f5ec);color:var(--zdb-match-ink,#256b4a)}
.zdb-mention-item .zdb-mention-slot{margin-left:auto;font-size:10px;color:var(--zdb-muted,#927480)}
.zdb-mention-empty{padding:6px 8px;font-size:11px;color:var(--zdb-muted,#927480)}
`;

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = EDITOR_STYLES;
  document.head.append(style);
}

export function mentionQueryBeforeCaret(text) {
  const match = /(?<![\w@])@([^\s@]*)$/.exec(String(text ?? ""));
  return match ? { start: match.index, query: match[1] } : null;
}

export function fuzzyMatchScore(query, value) {
  const needle = String(query || "").normalize("NFKC").toLowerCase().replace(/[\s_\-·]/g, "");
  const haystack = String(value || "").normalize("NFKC").toLowerCase().replace(/[\s_\-·]/g, "");
  if (!needle) return 1;
  const exact = haystack.indexOf(needle);
  if (exact >= 0) return 100 - Math.min(exact, 30);
  let position = -1, gaps = 0;
  for (const char of needle) {
    const next = haystack.indexOf(char, position + 1);
    if (next < 0) {
      if (needle.length < 2) return 0;
      for (let start = 0; start <= haystack.length - needle.length; start++) {
        let differences = 0;
        for (let index = 0; index < needle.length; index++) {
          if (needle[index] !== haystack[start + index]) differences++;
          if (differences > 1) break;
        }
        if (differences === 1) return Math.max(1, 15 - start);
      }
      return 0;
    }
    gaps += next - position - 1;
    position = next;
  }
  return Math.max(1, 40 - gaps);
}

function previewNode(item) {
  if (item?.thumb) return el("img", { class: "zdb-token-thumb", src: item.thumb, alt: "" });
  if (item?.video) return el("video", { class: "zdb-token-thumb", src: item.video, muted: true, preload: "metadata" });
  return el("span", { class: "zdb-token-glyph", text: item?.asset?.kind === "audio" ? "♪" : item ? "▣" : "!" });
}

export function createTokenEditor(textarea, options = {}) {
  injectStyles();
  textarea.className = `${textarea.className || ""} zdb-prompt-editor`.trim();
  textarea.placeholder ||= "描述画面、动作、镜头……输入 @ 引用参考素材";
  const wrap = el("div", { class: "zdb-prompt-wrap" }),
    menu = el("div", { class: "zdb-mention-menu" }),
    preview = el("div", { class: "zdb-token-preview", "aria-label": "提示词媒体引用" });
  menu.style.display = "none";
  wrap.append(textarea, menu, preview);

  const slots = () => options.slots?.() ?? [];
  const slotFor = (tag) => slots().find((slot) => slot.tag.toLowerCase() === tag.toLowerCase());
  const paintPreview = () => {
    const items = [...String(textarea.value || "").matchAll(TAG_SOURCE)].map((match) => {
      const tag = `<${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()} ${Number(match[2])}>`,
        slot = slotFor(tag);
      return el("span", {
        class: `zdb-token-preview-item ${slot ? "" : "is-missing"}`,
        title: slot ? `${slot.asset?.name || slot.asset?.id || tag}` : `${tag} 没有对应素材`,
      }, previewNode(slot), el("span", { text: slot ? `${tag} · ${slot.asset?.name || slot.asset?.id || "素材"}` : `${tag} · 失效` }));
    });
    preview.replaceChildren(...items);
  };

  let menuState = null;
  const placeMenu = () => {
    const rect = textarea.getBoundingClientRect();
    const viewportWidth = globalThis.window?.innerWidth || document.documentElement?.clientWidth || 1024;
    const viewportHeight = globalThis.window?.innerHeight || document.documentElement?.clientHeight || 768;
    const width = Math.min(rect.width || 320, viewportWidth - 16);
    const above = rect.top - 8, below = viewportHeight - rect.bottom - 8;
    const useBelow = below > above;
    menu.style.left = `${Math.max(8, Math.min(rect.left, viewportWidth - width - 8))}px`;
    menu.style.width = `${width}px`;
    menu.style.maxHeight = `${Math.max(60, Math.min(240, useBelow ? below : above))}px`;
    menu.style.top = useBelow ? `${rect.bottom + 4}px` : "auto";
    menu.style.bottom = useBelow ? "auto" : `${viewportHeight - rect.top + 4}px`;
  };
  const closeMenu = () => {
    menuState = null;
    menu.style.display = "none";
    menu.replaceChildren();
  };
  const mentionItems = (query) => {
    const bound = slots().map((slot) => ({
        label: slot.asset?.name || slot.asset?.id || slot.tag, tag: slot.tag, asset: slot.asset,
        thumb: slot.thumb, video: slot.video, bound: true, group: "已绑定",
      })),
      library = (options.libraryAssets?.() ?? []).map((asset) => ({
        label: asset.name || asset.asset_id, tag: "", asset, bound: false,
        thumb: asset.thumb, source: "creative", group: "当前项目资产",
      })),
      libraryIds = new Set(library.map((item) => item.asset.asset_id)),
      free = (options.unbound?.() ?? []).filter((asset) =>
        !asset.creative_asset_id || !libraryIds.has(asset.creative_asset_id)).map((asset) => ({
        label: asset.name || asset.id, tag: "", asset, bound: false,
        group: asset.creative_asset_id ? "创作资产" : asset.scope === "shot" ? "本镜上传" : "项目素材",
      }));
    const score = (item) => Math.max(fuzzyMatchScore(query, item.label),
      fuzzyMatchScore(query, item.tag) - 10,
      fuzzyMatchScore(query, item.asset?.description) - 20,
      fuzzyMatchScore(query, item.asset?.asset_id || item.asset?.id) - 20);
    return [...bound, ...library, ...free].map((item) => ({ ...item, score: score(item) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 16);
  };
  const renderMenu = () => {
    if (!menuState) return;
    if (!menuState.items.length) {
      menu.replaceChildren(el("div", { class: "zdb-mention-empty", text: `没有匹配「${menuState.query}」的素材` }));
    } else {
      let group = "";
      menu.replaceChildren(...menuState.items.flatMap((item, index) => {
        const nodes = [];
        if (item.group !== group) {
          group = item.group;
          nodes.push(el("div", { class: "zdb-mention-group", text: group }));
        }
        const actionLabel = item.asset?._requiresTaskConversion
          ? `${item.label}（将切换为多参考）`
          : item.bound ? item.label : `${item.label}（未绑定）`;
        nodes.push(el("div", {
          class: `zdb-mention-item ${index === menuState.index ? "is-active" : ""}`,
          onmousedown: (event) => { event.preventDefault(); void insertMention(item); },
        }, previewNode(item), el("span", { text: actionLabel }),
        item.tag ? el("span", { class: "zdb-mention-slot", text: item.tag }) : null));
        return nodes;
      }));
    }
    menu.style.display = "";
    placeMenu();
  };
  const updateMenu = () => {
    const caret = Number.isInteger(textarea.selectionStart) ? textarea.selectionStart : String(textarea.value || "").length,
      found = mentionQueryBeforeCaret(String(textarea.value || "").slice(0, caret));
    if (!found) return closeMenu();
    const items = mentionItems(found.query), same = menuState?.query === found.query;
    menuState = { ...found, caret, items, index: same ? Math.min(menuState.index, Math.max(0, items.length - 1)) : 0 };
    renderMenu();
  };
  const replaceSelection = (text, start = textarea.selectionStart ?? 0, end = textarea.selectionEnd ?? start) => {
    const value = String(textarea.value || "");
    textarea.value = value.slice(0, start) + text + value.slice(end);
    textarea.selectionStart = textarea.selectionEnd = start + text.length;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const insertMention = async (item) => {
    const insertion = menuState ? { start: menuState.start, caret: menuState.caret } : null;
    const tag = item.bound ? item.tag : await options.bindAsset?.(item.asset, item.source) || "";
    if (!tag || !insertion) return closeMenu();
    closeMenu();
    replaceSelection(`${tag} `, insertion.start, insertion.caret);
    options.onMentionInserted?.(item.asset, tag);
  };

  textarea.addEventListener("input", () => { paintPreview(); updateMenu(); });
  textarea.addEventListener("blur", closeMenu);
  textarea.addEventListener("keydown", (event) => {
    if (!menuState?.items.length) return;
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      menuState.index = (menuState.index + (event.key === "ArrowDown" ? 1 : -1) + menuState.items.length) % menuState.items.length;
      renderMenu();
    } else if (["Enter", "Tab"].includes(event.key)) {
      event.preventDefault(); insertMention(menuState.items[menuState.index]);
    } else if (event.key === "Escape") {
      event.preventDefault(); closeMenu();
    }
  });
  textarea.addEventListener("paste", (event) => {
    const raw = event.clipboardData?.getData?.("text/plain");
    if (!raw || !options.normalizeText) return;
    event.preventDefault(); replaceSelection(options.normalizeText(raw));
  });

  paintPreview();
  return {
    element: wrap,
    hydrate: paintPreview,
    serialize: () => textarea.value,
    refresh: paintPreview,
    setValue(value) { textarea.value = String(value || ""); paintPreview(); },
    getValue: () => textarea.value,
  };
}
