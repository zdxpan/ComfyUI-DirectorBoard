import { COMMON_POSES } from "./vendor/fisher-editor/common-poses.mjs";

export const POSE_CATEGORIES = [
  { id: "basic", name: "基础" }, { id: "daily", name: "日常" },
  { id: "emotion", name: "情绪" }, { id: "rest", name: "坐卧" },
  { id: "sport", name: "运动" }, { id: "action", name: "动作/武打" },
  { id: "dance", name: "舞蹈" }, { id: "intimacy", name: "亲密互动" },
  { id: "photo", name: "合照" },
];

const thumbnail = (name) => new URL(`./pose-thumbs/${name}`, import.meta.url).href;
const pose = (id, category, scope, poseId, keywords = "") => ({
  id, name: COMMON_POSES.find((entry) => entry.id === poseId)?.name || id,
  category, scope, poseId, keywords, thumbnail: thumbnail(`${poseId}.webp`),
});
const namedPose = (id, name, category, scope, poseId, keywords = "") => ({
  ...pose(id, category, scope, poseId, keywords), name,
});
const pair = (id, name, category, people, keywords = "") => ({
  id, name, category, scope: "pair", people, keywords, thumbnail: thumbnail(`${id}.svg`),
});
const HUG_POSE = { id: "hug-arms", name: "环抱", arms: {
  l: [[0.55, -0.1, 0.83], [-0.18, -0.15, 0.98]],
  r: [[-0.55, -0.1, 0.83], [0.18, -0.15, 0.98]],
} };
const SAD_POSE = { id: "sad", name: "低头沮丧", torso: [0, 0.98, 0.2], head: [0, 0.45, 0.9],
  arms: { l: [[0.12, -1, 0.14], [0.04, -1, 0.12]], r: [[-0.12, -1, 0.14], [-0.04, -1, 0.12]] } };

export const POSE_PRESETS = [
  pose("stand", "basic", "full", "stand", "正面 站立"),
  pose("stand-relaxed", "basic", "full", "stand-relaxed", "放松 站姿"),
  { ...pose("three-quarter", "basic", "full", "three-quarter", "侧身 45度"), rotation: [0, 40, 0] },
  { ...pose("side", "basic", "full", "side", "侧面"), rotation: [0, 90, 0] },
  { ...pose("back", "basic", "full", "back", "背影 背面"), rotation: [0, 180, 0] },
  pose("walk", "daily", "full", "walk", "走路 散步"),
  pose("lean", "daily", "full", "lean", "倚靠 叉腰"),
  pose("hands-on-hips", "daily", "upper", "hands-on-hips", "叉腰"),
  pose("hands-in-pockets", "daily", "upper", "hands-in-pockets", "插兜"),
  pose("phone", "daily", "upper", "phone", "通话 手机"),
  pose("salute", "daily", "upper", "salute", "敬礼"),
  pose("wave", "emotion", "upper", "wave", "招手 再见 欢迎"),
  pose("think", "emotion", "upper", "think", "思考 托腮"),
  pose("arms-crossed", "emotion", "upper", "arms-crossed", "抱胸 生气 防备"),
  pose("hands-up", "emotion", "upper", "hands-up", "欢呼 开心 投降"),
  { ...namedPose("sad", "低头沮丧", "emotion", "upper", "sad", "悲伤 伤心 垂肩"),
    thumbnail: thumbnail("bow.webp") },
  pose("pray", "emotion", "upper", "pray", "祈祷 合十"),
  pose("bow", "emotion", "upper", "bow", "鞠躬 道歉 感谢"),
  pose("sit-chair", "rest", "full", "sit-chair", "坐下 椅子"),
  pose("sit-cross", "rest", "full", "sit-cross", "盘腿"),
  pose("sit-hug-knees", "rest", "full", "sit-hug-knees", "抱膝"),
  pose("kneel", "rest", "full", "kneel", "跪地"),
  pose("kneel-one", "rest", "full", "kneel-one", "单膝"),
  namedPose("sit-legs", "坐姿下身", "rest", "lower", "sit-chair", "坐下 椅子"),
  namedPose("cross-legs", "盘腿下身", "rest", "lower", "sit-cross", "盘腿"),
  { ...pose("lie", "rest", "full", "stand-relaxed", "躺着 平躺 倒地"), name: "侧身躺下",
    rotation: [0, 0, 90], thumbnail: thumbnail("lie.svg") },
  pose("run", "sport", "full", "run", "奔跑 冲刺"),
  pose("jump", "sport", "full", "jump", "跳跃 欢呼"),
  namedPose("stride-legs", "跨步", "sport", "lower", "walk", "迈步 行走"),
  namedPose("run-legs", "奔跑下身", "sport", "lower", "run", "冲刺 跑步"),
  namedPose("jump-legs", "跃起下身", "sport", "lower", "jump", "跳跃"),
  namedPose("squat-legs", "蹲姿下身", "sport", "lower", "squat", "下蹲"),
  namedPose("kneel-legs", "跪姿下身", "sport", "lower", "kneel-one", "单膝 跪"),
  pose("guard", "action", "full", "guard", "格斗 防守 打斗"),
  pose("kick", "action", "full", "kick", "侧踢 武打"),
  namedPose("guard-arms", "格斗防守上身", "action", "upper", "guard", "拳击 防守"),
  namedPose("kick-legs", "侧踢下身", "action", "lower", "kick", "踢腿"),
  pose("point", "action", "upper", "point", "指向 指挥"),
  namedPose("dance-arms", "舞蹈张臂", "dance", "upper", "open-arms", "起舞 展臂"),
  namedPose("dance-turn", "舞蹈转身", "dance", "full", "three-quarter", "转圈 旋转"),
  namedPose("dance-jump", "舞蹈跃起", "dance", "full", "jump", "腾跃"),
  namedPose("dance-step", "舞步下身", "dance", "lower", "walk", "舞步 跨步"),
  pose("open-arms", "intimacy", "upper", "open-arms", "张开双臂 迎接"),
  pair("embrace", "面对面拥抱", "intimacy", [
    { poseId: "hug-arms", x: -1.8, turn: 80 }, { poseId: "hug-arms", x: 1.8, turn: -80 },
  ], "拥抱 亲密 爱情"),
  pair("shoulder", "并肩靠近", "intimacy", [
    { poseId: "wave", x: -2.1, turn: 5 }, { poseId: "hands-on-hips", x: 2.1, turn: -5 },
  ], "搭肩 靠近 朋友"),
  pair("portrait", "并肩合照", "photo", [
    { poseId: "stand-relaxed", x: -2.5, turn: 8 }, { poseId: "stand-relaxed", x: 2.5, turn: -8 },
  ], "合影 并肩 双人"),
  pair("staggered", "前后合照", "photo", [
    { poseId: "arms-crossed", x: -1.8, z: 1.1, turn: 0 }, { poseId: "stand-relaxed", x: 1.8, z: -1.1, turn: 0 },
  ], "前后 站位 合影"),
  pair("faceoff", "出招与躲闪", "action", [
    { poseId: "kick", x: -3.2, turn: 45 }, { poseId: "guard", x: 3.2, turn: -45 },
  ], "对打 打斗 武打 冲突"),
];

export const poseSpec = (id) => id === HUG_POSE.id ? HUG_POSE : id === SAD_POSE.id ? SAD_POSE :
  COMMON_POSES.find((entry) => entry.id === id);

export function findPosePresets(category, query = "") {
  const text = query.trim().toLowerCase();
  return POSE_PRESETS.filter((entry) => text
    ? `${entry.name} ${entry.keywords} ${POSE_CATEGORIES.find((group) => group.id === entry.category)?.name || ""}`.toLowerCase().includes(text)
    : entry.category === category);
}
