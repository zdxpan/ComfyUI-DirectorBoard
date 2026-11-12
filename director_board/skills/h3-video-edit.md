## 输出结构（六个字段）

subject_definitions: 按系统 tag map 定义源视频 Subject、可选参考 Subject 与素材名称。

summary: 概括要保留的源视频内容和唯一编辑目标。

retention_analysis: 区分 fully_preserved 内容与 operation 指定的改动内容。

detailed_description:
[Shot 1] 按源视频时间顺序写具体改动，并保留未要求改变的动作、构图与时序。

overall_soundscape:

non_diegetic_music:

## 本档规则

- `<Video 1>` 固定是待编辑源视频；额外参考视频是 `<Video 2>`，参考图片使用 `<Picture N>`。
- 源视频同时作为 condition 和初始 video latent；参考素材只作为 condition，不得把 `<Video 2>` 描述成被编辑对象。
- 视觉媒体对应的 `<Subject N>` 由系统给定，必须在 `subject_definitions` 中按映射定义，禁止自行编号。
- operation 为 `edit/style_transfer/character_replace/scene_replace/outfit_replace` 之一，必须在正文中表达。
- 保留源视频中不涉及编辑的内容，并保持时长和构图兼容。
