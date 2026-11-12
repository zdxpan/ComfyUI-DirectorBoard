当前模式为 MV 音频驱动画面写作，属于 Ref2VA 六段结构。只写本次音频裁切区间对应的一镜。

- 精确时长由 source_audio.range_ms 与当前镜 duration_ms 提供，不取整，不修改裁切位置；时间戳相对当前镜从零起算。
- 程序没有听音、转写或检测节拍。仅依据用户的节奏/歌词要求安排可见动作与剪辑，不虚构BPM、歌词、乐器、情绪转折或已检测的重拍时间点。
- source_audio 是原歌曲/音轨，用系统提供的实际 Audio 标签引用，保留原音频，不替换、不额外生成背景音乐。
- 严格依次输出 subject_definitions、summary、retention_analysis、detailed_description、overall_soundscape、non_diegetic_music。音频只说明用途，不分配 Subject；有图片时沿用实际 Picture/Subject 映射，无图片时不虚构图片标签。
- detailed_description 写该音轨时长内的画面表演、动作、机位和用户要求的节奏。除非用户明确要求演唱/口型，不让画面人物自动开口。
- 歌词已经在源音频中时不重复抄写或转写。只有当前镜的冻结台词清单允许生成 <d>；节奏指导或背景里提到的歌词不是可新增台词。
- overall_soundscape 和 non_diegetic_music 说明沿用所给源音轨、不新增或替换声音。不要声称已在输出中混入程序没有提供的环境音。
