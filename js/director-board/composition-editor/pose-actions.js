// Pose actions taken from Fisher's free-pose editor. Only the active VNCCS person changes.
import { liftOpenPose, WORLD_KEYPOINT_NAMES } from "./vendor/fisher-editor/openpose-lift.mjs";
import { directionKeypoints } from "./vendor/fisher-editor/common-poses.mjs";

const JOINT_BONES = { ls: "upperarm_l", le: "lowerarm_l", lw: "hand_l", rs: "upperarm_r", re: "lowerarm_r", rw: "hand_r", lh: "thigh_l", lk: "calf_l", la: "foot_l", rh: "thigh_r", rk: "calf_r", ra: "foot_r" };
const IMPORT_OPTIONS = { drawFigure: false, placeHipRoots: false, alignHead: false,
  alignHands: false, alignFeet: false, dispatchPoseChange: false };

function restJoints(viewer) {
  viewer.skinnedMesh.updateMatrixWorld(true);
  const worldOf = (name) => viewer.bones[name].getWorldPosition(new viewer.THREE.Vector3()).toArray();
  const rest = Object.fromEntries(Object.entries(JOINT_BONES).map(([key, bone]) => [key, worldOf(bone)]));
  rest.neck = rest.ls.map((value, axis) => (value + rest.rs[axis]) / 2);
  rest.hipMid = rest.lh.map((value, axis) => (value + rest.rh[axis]) / 2);
  return { rest, head: worldOf("head"), pelvis: worldOf("pelvis") };
}

function applyKeypoints(viewer, pelvis, keypoints) {
  const targets = Object.fromEntries(Object.entries(WORLD_KEYPOINT_NAMES).map(([key, name]) =>
    [name, new viewer.THREE.Vector3(...keypoints[key].map((value, axis) => value + pelvis[axis]))]));
  viewer.applyWorldKeypointImport(targets, IMPORT_OPTIONS);
}

function withNeutralPose(viewer, transform, build) {
  const previous = { ...transform };
  Object.assign(transform, { x: 0, y: 0, z: 0, zoom: 1 });
  viewer.setActiveCharacterAppearance({ transform });
  try {
    viewer.resetPose();
    const { rest, head, pelvis } = restJoints(viewer);
    build(rest, head, pelvis);
  } finally {
    Object.assign(transform, previous);
    viewer.setActiveCharacterAppearance({ transform });
  }
}

function finish(viewer) {
  viewer.skeleton?.update();
  viewer.updateIKEffectorPositions?.();
  viewer.updateMarkers?.();
  viewer.requestRender();
}

const UPPER_BONE = /^(spine_|neck_|head$|clavicle_|upperarm_|lowerarm_|hand_|index_|middle_|pinky_|ring_|thumb_)/;
const LOWER_BONE = /^(thigh_|calf_|foot_|ball_)/;
const UPPER_EFFECTOR = /^(head$|hand_|upperarm_)/;
const LOWER_EFFECTOR = /^foot_/;
const UPPER_CHAIN = /^(spine|leftArm|rightArm|leftShoulder|rightShoulder)$/;
const LOWER_CHAIN = /^(leftLeg|rightLeg)$/;

function mergeSelected(before = {}, after = {}, selected) {
  const merged = { ...before };
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!selected(name)) continue;
    if (Object.hasOwn(after, name)) merged[name] = after[name];
    else delete merged[name];
  }
  return merged;
}

/** Keep the untouched half and the current camera/model angle when applying a preset. */
export function mergePoseByScope(before, after, scope) {
  if (scope !== "upper" && scope !== "lower") throw new Error(`Unsupported pose scope: ${scope}`);
  const bone = scope === "upper" ? UPPER_BONE : LOWER_BONE;
  const effector = scope === "upper" ? UPPER_EFFECTOR : LOWER_EFFECTOR;
  const chain = scope === "upper" ? UPPER_CHAIN : LOWER_CHAIN;
  return {
    ...before,
    bones: mergeSelected(before.bones, after.bones, (name) => bone.test(name)),
    bonePositions: mergeSelected(before.bonePositions, after.bonePositions, (name) => bone.test(name)),
    ikEffectorPositions: mergeSelected(before.ikEffectorPositions, after.ikEffectorPositions,
      (name) => effector.test(name)),
    poleTargetPositions: mergeSelected(before.poleTargetPositions, after.poleTargetPositions,
      (name) => chain.test(name)),
  };
}

export function applyDetectedPose(viewer, transform, points, body) {
  viewer.recordState();
  if (!body.complete) {
    const THREE = viewer.THREE;
    for (const [a, b, boneName, childName] of body.segments) {
      const bone = viewer.bones[boneName], child = viewer.bones[childName];
      const from = bone.getWorldPosition(new THREE.Vector3());
      const current = child.getWorldPosition(new THREE.Vector3()).sub(from).normalize();
      const target = new THREE.Vector3(points[b][0] - points[a][0], points[a][1] - points[b][1], 0).normalize();
      const delta = new THREE.Quaternion().setFromUnitVectors(current, target);
      const world = bone.getWorldQuaternion(new THREE.Quaternion());
      const parent = bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
      bone.quaternion.copy(parent.multiply(delta).multiply(world));
      bone.updateMatrixWorld(true);
    }
  } else {
    withNeutralPose(viewer, transform, (rest, head, pelvis) => {
      const lifted = liftOpenPose(points, rest, {}, "planar");
      const distance = Math.hypot(...head.map((value, axis) => value - rest.neck[axis]));
      const direction = lifted.kps.head.map((value, axis) => value - lifted.kps.neck[axis]);
      const magnitude = Math.hypot(...direction) || 1;
      lifted.kps.head = lifted.kps.neck.map((value, axis) => value + direction[axis] * distance / magnitude);
      applyKeypoints(viewer, pelvis, lifted.kps);
    });
  }
  finish(viewer);
}

export function applyCommonPose(viewer, transform, preset, scope = "full", rotation = null) {
  const before = viewer.getPose();
  viewer.recordState();
  withNeutralPose(viewer, transform, (rest, head, pelvis) => {
    applyKeypoints(viewer, pelvis, directionKeypoints(preset, rest, head));
  });
  if (scope === "upper" || scope === "lower") viewer.setPose(mergePoseByScope(before, viewer.getPose(), scope), true);
  else if (scope !== "full") throw new Error(`Unsupported pose scope: ${scope}`);
  viewer.setModelRotation(...(rotation || before.modelRotation || [0, 0, 0]));
  finish(viewer);
}
