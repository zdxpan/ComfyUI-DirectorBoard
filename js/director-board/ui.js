export function el(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") element.className = value;
    else if (key === "text") element.textContent = value;
    else if (key === "value") element.value = value;
    else if (key === "checked") element.checked = Boolean(value);
    else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else element.setAttribute(key, value === true ? "" : value);
  }
  element.append(...children.flat().filter(Boolean));
  return element;
}

export function button(text, onclick, style = "") {
  return el("button", { type: "button", class: `zdb-btn ${style}`, text, onclick });
}

export function seconds(milliseconds) {
  return `${(Number(milliseconds || 0) / 1000).toFixed(1)}秒`;
}

export function inputViewUrl(path) {
  const parts = String(path).split("/"), filename = parts.pop(),
    query = new URLSearchParams({ filename, type: "input" });
  if (parts.length) query.set("subfolder", parts.join("/"));
  return `/view?${query}`;
}

/** 预览服务端产出的文件（VHS_VideoCombine 的 `gifs` 项：filename/subfolder/type）。 */
export function outputViewUrl(file) {
  return `/view?${new URLSearchParams({
    filename: file?.filename ?? "",
    subfolder: file?.subfolder || "",
    type: file?.type || "output",
  })}`;
}
