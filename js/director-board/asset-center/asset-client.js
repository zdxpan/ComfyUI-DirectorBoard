let comfyApi = null;

async function api() {
  if (!comfyApi) comfyApi = (await import("../../../../scripts/api.js")).api;
  return comfyApi;
}

async function json(path, options = {}) {
  const response = await (await api()).fetchApi(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

export async function listAssets() {
  return (await json("/zdx/assets")).assets || [];
}

export async function saveAsset(asset) {
  return (await json(asset.id ? `/zdx/assets/${asset.id}` : "/zdx/assets", {
    method: asset.id ? "PUT" : "POST", body: JSON.stringify(asset),
  })).asset;
}

export async function deleteAsset(id) {
  return json(`/zdx/assets/${id}`, { method: "DELETE" });
}

export async function captionAsset(imagePath, provider) {
  return (await json("/zdx/assets/caption", {
    method: "POST", body: JSON.stringify({ image_path: imagePath, provider }),
  })).caption || "";
}

export async function uploadAssetImage(file) {
  if (!file) throw new Error("请选择图片文件");
  const form = new FormData();
  form.append("image", file);
  const response = await (await api()).fetchApi("/upload/image", { method: "POST", body: form });
  const payload = await response.json();
  if (!response.ok || !payload.name) throw new Error(payload.error || "上传失败");
  return payload.subfolder ? `${payload.subfolder}/${payload.name}` : payload.name;
}

export async function importGeneratedImage(file) {
  return (await json("/zdx/assets/import-generated", {
    method: "POST", body: JSON.stringify(file),
  })).image_path;
}
