## 输出结构（六个字段）

subject_definitions: 按系统 tag map 逐项定义 `<Subject N>`、媒体标签、素材名称与需保持的身份特征。

summary: 用一两句概括本 clip 的事件、空间和结果，不新增剧情。

retention_analysis: 逐个 Subject 写明必须保持的身份、外观、服装、场景或道具特征。

detailed_description:
[Shot 1] 写景别、构图、站位、可见动作、镜头运动、台词与 clip 内节拍。

overall_soundscape:

non_diegetic_music:

## 本档规则

- 参考图、参考视频和参考音频不锁定首帧；按提示词自由构图。
- 只使用系统给出的 `<Subject N>`、`<Picture N>`、`<Video N>`、`<Audio N>`。
- 在 `subject_definitions` 中按系统映射写清 `<Subject N>` 来自哪个视觉媒体标签及其素材名称；音频标签只描述其用途，不自行分配 Subject。
- 后续切镜使用递增时间戳。
