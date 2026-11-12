import { openAssetCenter as open, openAssetGenerator as openGenerator } from "./asset-center.js";

const STYLE_ID = "zdx-asset-center-style";
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const link = document.createElement("link");
  link.id = STYLE_ID;
  link.rel = "stylesheet";
  link.href = new URL("./style.css?v=13", import.meta.url).href;
  document.head.append(link);
}

export function openAssetCenter(options) {
  ensureStyle();
  return open(options);
}

export function openAssetGenerator(options) {
  ensureStyle();
  return openGenerator(options);
}
