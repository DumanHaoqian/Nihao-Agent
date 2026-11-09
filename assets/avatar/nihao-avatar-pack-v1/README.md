# Nihao Agent · 2D Avatar Asset Pack

这是一套用于 App 中国旅行助手的 Q 版像素角色资产：黑发单丸子头、红色发带、红色中式服装，气质亲切、欢迎。交付包含透明 PNG 分层、组合表情、交互姿态、动画序列，以及可运行的本地前端预览。

本包采用 Live2D 的分层思路，当前可直接接入的是已验证的**前端刚性木偶与 PNG 序列帧**。它不是已经绑定完成的 Live2D Cubism 工程；不包含 `.moc3`、Cubism 网格、变形器和物理模型。半身 3/4 图是角色概念参考，不能作为连续头部转角网格使用。

## 打开交互预览

在本目录运行：

```sh
node meta/serve.mjs
```

打开 [本地预览](http://127.0.0.1:8765/meta/preview.html)。预览支持表情与姿态切换、动画播放和逐帧检查、图层显隐、锚点相关的小幅头部变换，以及透明、浅色、深色背景检查。服务器只监听本机。端口被占用时可运行 `node meta/serve.mjs 8766`。

## 文件组织

| 目录 | 内容 |
| --- | --- |
| `concept/` | 半身正面 neutral、全身正面 neutral、半身 3/4、角色配色与设定说明图 |
| `layered/` | 面部基底、前后发、左右侧发、丸子头、发带、眉眼嘴状态、躯干、左右上臂/前臂/手、下肢，以及替换手势和关节遮缝补片 |
| `expressions/` | neutral、happy、excited、thinking、concerned、apologetic 六种组合表情 |
| `animations/poses/` | 待机、招手、向左右指示、讲解、拱手欢迎、庆祝姿态 |
| `animations/` | `blink/`、`idle_loop/`、`talking/`、`waving/`、`nodding/` 序列及 `talking_mouth_set/` 嘴型层 |
| `meta/` | 清单、锚点、规格、接入说明、预览、源图、提示词记录和可复现导出脚本 |

实际文件列表、图层顺序与时长以 [manifest.json](meta/manifest.json) 为准；锚点见 [anchors.json](meta/anchors.json)。详细规则见 [ASSET_SPEC.md](meta/ASSET_SPEC.md)，前端接入见 [INTEGRATION.md](meta/INTEGRATION.md)。

路径基准：清单中的 `file`、`source` 路径，以及 `meta/source/*_prompts.json` 中的 `reference` / `references`，均相对本素材包根目录。制作记录中不带目录的部件文件名（例如 `eyes_open.png`）及 `derivedFrom` 相对记录文件所在的 `meta/source/`；设定图记录的 `file` 为素材包根目录下的 `concept/` 路径。脚本通过自身文件位置定位素材包，可随整个目录迁移。`validation-ui.json` 中的本地 URL 仅记录当时的预览测试地址，启动当前预览请使用上文命令。

## 接入时的约定

- `layered/`、`expressions/`、姿态和动画帧统一使用 **1024 × 1536** 透明画布；两张半身概念图为 **1024 × 1024**。不要分别自动居中或裁去透明留白。
- 以画布左上角为原点，X 向右、Y 向下。图层名称中的 `left/right` 是角色自身左右；`pointing_left/right` 是观众看到的屏幕方向。
- 所有图层先在 `(0, 0)` 同点叠加，再依据 `z`、`parent` 和 `pivot` 进行分组变换。`eyes`、`eyebrows`、`mouth` 每组一次只显示一个状态，不能把所有变体叠在一起。
- 使用 4 像素网格，优先最近邻与整数倍缩放。Canvas 设置 `imageSmoothingEnabled = false`，图片设置 `image-rendering: pixelated`。
- 播放时读取各帧 `durationMs` 和序列 `loop`；不要把所有序列当成同一个固定 FPS。嘴型是视觉开口状态，接入语音时按业务需要映射，不是强制音素对照表。

## 制作与维护

角色与拆分部件由内置 **imagegen** 生成，提示词和源图保存在 `meta/source/`。运行时 PNG 使用固定画布、统一色板、二值 alpha 和最近邻 4 倍导出；表情、姿态与连续帧由同一套部件进行确定性木偶变换生成，避免逐帧重画带来的角色漂移。

`face_base` 保留肤色、耳部和腮红，眉毛、眼睛、嘴巴独立替换。被遮挡区域已按分层使用补绘，肩、肘、腕保留重叠并附遮缝补片。推荐使用已导出的姿态和幅度范围；扩展大幅变形时仍需检查遮挡与关节连接。

`meta/scripts/build-pack.cjs` 可从源图重建运行时图层与序列，需要 Node.js、`sharp` 和 `pngjs`。生成原图不需要在每次构建时重新调用模型。构建与校验关注文件、尺寸、透明度、色板、锚点、帧序列和渲染结果，不执行 SHA 或 SHA256 校验。
