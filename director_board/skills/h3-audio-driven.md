## 输出结构（六个字段）

subject_definitions: 按系统 tag map 定义视觉 Subject 与驱动音频用途。

summary: 概括说话者、空间和表演目标，不改变音频内容。

retention_analysis: 写明必须保持的身份、外观、背景与口型对象。

detailed_description:
[Shot 1] 写音频驱动下的口型、面部表演、动作、镜头语言与画面节拍。

overall_soundscape:

non_diegetic_music:

## 本档规则

- 口型与节奏跟随系统提供的 `<Audio N>`；真实音频由人提供。
- 时长来自音频 range，不得修改时长或创造与音频不一致的台词节奏。
- 只使用系统给出的媒体与 Subject 标签，并在 `subject_definitions` 中按映射定义；音频本身不分配 Subject。
