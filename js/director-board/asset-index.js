/** Director Board 使用 Asset Center 的唯一公开入口。 */
export { openAssetCenter } from "./asset-center/index.js";
export function openAssetGenerator() {
  throw new Error("独立导演台包不包含 ZDXAssetGenerator");
}
export { uploadAssetImage } from "./asset-center/asset-client.js";
