/** Content-specific expressions complement the existing bilingual camera presets. */
export const PROMPT_ELEMENTS = {
  "人物": [["少女", "一位少女", "a young woman"], ["老人", "一位老人", "an elderly person"], ["双人", "两个人自然互动", "two people interacting naturally"]],
  "环境": [["海边", "海边，海风轻拂", "by the sea in a gentle breeze"], ["街道", "城市街道", "a city street"], ["森林", "安静的森林", "a quiet forest"]],
  "时间": [["清晨", "清晨柔和的光线", "soft early morning light"], ["黄昏", "黄昏，暖色夕阳", "warm sunset at dusk"], ["夜晚", "夜晚，点点灯光", "night with scattered lights"]],
  "光线": [["逆光", "柔和逆光，轮廓清晰", "soft backlighting with a clear silhouette"], ["自然光", "自然光，真实质感", "natural light and realistic texture"], ["侧光", "侧光强调面部轮廓", "side lighting defines the facial contours"]],
  "情绪": [["平静", "神态平静，动作舒缓", "calm expression and unhurried movement"], ["惊喜", "露出惊喜的表情", "an expression of delighted surprise"], ["紧张", "气氛紧张，动作克制", "tense atmosphere and restrained movement"]],
  "收束": [["停住", "最后缓缓停住，保持姿态", "slowly comes to a stop and holds the pose"], ["回望", "最后回头望向镜头", "finally looks back toward the camera"], ["远去", "身影逐渐远去", "the figure gradually recedes into the distance"]],
};

export function insertPromptAtSelection(value, text, selection) {
  const source = String(value || "");
  const start = Math.max(0, Math.min(source.length, selection?.start ?? source.length));
  const end = Math.max(start, Math.min(source.length, selection?.end ?? start));
  const before = source.slice(0, start), after = source.slice(end);
  const insertion = `${before && !/\s$/.test(before) ? '\n' : ''}${text}${after && !/^\s/.test(after) ? '\n' : ''}`;
  return { value: before + insertion + after, caret: start + insertion.length };
}
