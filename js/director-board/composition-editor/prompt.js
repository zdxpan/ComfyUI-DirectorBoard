export function referencePromptLine(referenceCount, peopleCount) {
  if (referenceCount === 2) return "Use image2 for the screen-left person's appearance and image3 for the screen-right person's appearance.";
  if (referenceCount === 1 && peopleCount === 2) return "Use image2 for the screen-left person's appearance; create the screen-right person from the written description.";
  if (referenceCount === 1) return "Use image2 for the person's face, hair, clothing and other identifying details.";
  return "Create realistic people using the written description for their appearance.";
}

export function draftPrompt({ mode = "pose", guideStyle = "mannequin", hasBackground = false,
  peopleCount = 1, referenceCount = 0, stickerCount = 0, detail = "" } = {}) {
  if (mode === "sticker") {
    return [
      stickerCount ?
        "Use image1 as the finished layout of the pasted people and objects. Keep their identity, shape, size, position and orientation. Blend the pasted edges and unify lighting, shadows, perspective, color and texture into a realistic image. Do not change anyone's pose or rearrange the layout." :
        "Use image1 as the source scene. Refine its realism, lighting and texture while preserving the composition, subjects and objects. Do not add or remove elements.",
      detail.trim(),
    ].filter(Boolean).join("\n");
  }
  const guide = guideStyle === "mannequin" ? "white mannequins" :
    guideStyle === "skeleton" ? "colored pose skeletons" : "mannequins with colored pose skeleton overlays";
  const lines = [
    `Use image1 as the layout guide. Follow the ${guide} for each person's exact pose, position and size. ${mode === "angle" ? "Preserve the indicated camera viewpoint and viewing angle. " : ""}Keep the same number of people.`,
  ];
  if (hasBackground) lines.push("Preserve the scene composition in image1 and integrate the people into that background.");
  lines.push(referencePromptLine(referenceCount, peopleCount));
  lines.push("Render each guided figure as a realistic person with natural skin and clothing, preserving the pose and framing. The final photograph must contain no colored skeleton lines, joint dots, pose guides, wireframes or mannequin surfaces.");
  if (detail.trim()) lines.push(detail.trim());
  return lines.join("\n");
}
