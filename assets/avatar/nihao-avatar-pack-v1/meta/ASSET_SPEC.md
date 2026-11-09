# Nihao Agent 资产规格

本文件说明 PNG 分层、序列帧及前端木偶动画的坐标与组织约定。资源及数值以同目录的 `manifest.json`、`anchors.json` 为准，导出行为以 `scripts/build-pack.cjs` 为准。

## 画布、透明度与像素网格

| 资源 | 画布与用途 |
| --- | --- |
| `layered/*.png` | 1024 × 1536；全画布对齐的独立部件或状态层 |
| `expressions/*.png` | 1024 × 1536；已经组合好的透明全身表情图 |
| `animations/poses/*.png` | 1024 × 1536；已经组合好的透明动作姿态 |
| `animations/*/frame_*.png` | 1024 × 1536；透明动画序列帧 |
| `animations/talking_mouth_set/*.png` | 1024 × 1536；与脸部位置对齐的独立嘴型层 |
| `concept/nihao_full_front_neutral.png` | 1024 × 1536；由同一分层木偶组合的全身正面母版 |
| `concept/nihao_half_front_neutral.png` | 1024 × 1024；正面母版的半身展示 |
| `concept/nihao_half_three_quarter.png` | 1024 × 1024；3/4 造型参考 |
| `concept/nihao_character_sheet.png` | 独立设定说明版面；不作为动画图层使用 |

运行时分层与帧使用 RGBA PNG。透明区 alpha 为 0，角色实体为 255；alpha 边缘经过技术导出清理，保留阶梯式像素轮廓。逻辑画布为 256 × 384，按最近邻放大 4 倍得到最终画布，单个逻辑像素对应 4 × 4 输出像素。统一色板记录于 `manifest.palette`。

半身概念图不与全身图层直接叠加。`meta/source/` 保留内置 imagegen 原始生成结果及提示词，源图可能有不同尺寸和中间 alpha；前端应引用最终目录中的 PNG，而不是直接引用源图。

## 命名规则

使用小写英文和下划线 `snake_case`，扩展名统一 `.png`。

| 类别 | 规则与示例 |
| --- | --- |
| 概念图 | `nihao_<framing>_<view>_<state>.png`，例如 `nihao_half_front_neutral.png` |
| 固定部件 | `<part>.png`，例如 `face_base.png`、`hair_back.png`、`bun.png`、`torso.png` |
| 左右部件 | `<part>_<side>.png`，例如 `side_hair_left.png`、`arm_upper_right.png`、`forearm_left.png` |
| 表情替换层 | `<group>_<state>.png`，例如 `eyebrows_concerned.png`、`eyes_half_closed.png`、`mouth_o_shape.png` |
| 关节补片 | `joint_<joint>_<side>.png`，例如 `joint_elbow_left.png` |
| 组合表情 | `<expression>.png`，例如 `happy.png`、`apologetic.png` |
| 动作 | 清单中的 pose key，例 `waving_pose.png`、`pointing_left.png` |
| 序列帧 | `animations/<clip>/frame_<NNN>.png`，从 `frame_000.png` 开始，三位补零 |

`manifest` 中所有 `file` 路径相对**资产包根目录**，而不是相对 `meta/`。保留这些相对路径即可把整个包迁移到 App 静态资源目录。

## 坐标与 anchor point

坐标采用输出画布像素：原点 `(0, 0)` 位于左上角，X 向右、Y 向下。锚点 `pivot` 是**全局画布坐标**，不是裁切部件内部坐标，也不是归一化坐标。`layers[].alphaBounds` 同样采用输出像素；`sources[].alphaBounds` 则属于各自原始源图。

常用组锚点如下，逐部件精确锚点读取 `anchors.json`：

| 锚点 | 坐标 | 用途 |
| --- | --- | --- |
| `root` | `(512, 1480)` | 整体角色放置参考点 |
| `head` / `neck` | `(512, 748)` | 头部整体转动和小幅点头 |
| `torso` | `(512, 912)` | 躯干组参考点 |
| `shoulder_left` | `(660, 884)` | 角色左肩，位于屏幕右侧 |
| `shoulder_right` | `(364, 884)` | 角色右肩，位于屏幕左侧 |

正面站立时，角色自身左侧对应屏幕右侧。所有左右发束和手臂部件遵循角色自身视角；`pointing_left` 和 `pointing_right` 特指屏幕上的指示方向。

PNG 已保留透明留白并放置在同一画布坐标中。静态组合时将每一层直接绘制到 `(0, 0)`。不要给每层重新计算居中位置，也不要按其 alpha 包围盒单独缩放。如果裁边建立 texture atlas，必须同时记录原始画布尺寸、裁边偏移与 pivot；裁后局部 pivot = 全局 pivot − 裁边左上角。

## 层级、遮挡与状态选择

`z` 控制绘制顺序，按从小到大排序，较大的值覆盖较小的值。`parent` 描述变换关系：`root`、`head`、`torso` 可以是逻辑组；`arm_upper_left/right`、`forearm_left/right` 也可以是父部件。不要把同名逻辑组（例如 torso 组与 torso 图层）解释成自引用递归。

头部相关部件应一起跟随 `head` 变换，包括脸底、前后发、两侧发束、丸子头、发带、眉毛、眼睛和嘴巴。手臂沿肩 → 上臂 → 肘 → 前臂 → 腕 → 手的关系更新。一个父级转动后，子级的位置和锚点也要随父级变换。对已在 neutral 姿态旋转过的 PNG 施加变化时，应基于 neutral 姿态计算增量变换，参考导出脚本的骨段放置逻辑。

`face_base` 含脸部肤色、耳部与腮红，并补全头发和五官覆盖下的脸面；眉、眼、嘴分别位于独立层。它们的状态集合为：

- `eyebrows`：`neutral` / `happy` / `concerned` / `surprised`。
- `eyes`：`open` / `half_closed` / `closed` / `smiling`。
- `mouth`：`closed` / `slight_open` / `medium_open` / `wide_open` / `smile` / `o_shape`，另补 `downturned` 用于关切和抱歉。

每个 group 仅显示一个 state。`default` / `visible` 不替代表情选择条件；不能因为这些字段为 true 就同时显示全部眉眼嘴变体。组合表情的选择读 `manifest.expressions`。替换手势如 `hand_wave`、`hand_point`、`hands_welcome` 默认不显示，使用时替换对应原手，不能叠出额外手掌；其静态图层展示位置也不等于所有动作下的腕部连接位置。

前后发、脸底、躯干以及手臂关节包含被遮挡区域的补绘和连接余量。当前 rig 的骨段参考长度为上臂 116、前臂 104 输出像素，重叠参考值为 16 输出像素。肘、腕遮缝补片随所属关节移动，按清单的 z 覆盖连接缝，不覆盖独立五官。现有序列已使用这些覆盖关系；放大变换范围时需重新检查袖口、肘部、腕部与下巴附近。

## 帧时长与播放

以每帧 `durationMs` 为准，不从文件名猜帧率，也不要按浏览器每次刷新直接推进一帧。下表是当前导出的时间结构；更新后以 manifest 为准。

| 序列 | 当前时序 | 循环 |
| --- | --- | --- |
| `blink` | 1000 / 60 / 90 / 60 / 800 ms，共 2010 ms | 是 |
| `idle_loop` | 每帧 125 ms，共 2000 ms | 是 |
| `talking` | 前七帧各 100 ms，最后闭口 180 ms，共 880 ms | 是 |
| `waving` | 每帧 100 ms，共 1200 ms | 是 |
| `nodding` | 每帧 90 ms，共 1080 ms | 否 |

`talking` 是口型切换的示范循环，`talking_mouth_set` 是独立替换图层。六种基础嘴型与新增的关切嘴型都是视觉状态，不是语言学音素的强制映射，也不是已对齐某段音频的精确唇形。接入 TTS 时可由音量包络控制开口大小；若有 viseme/音素时间戳，再按产品语言映射到最接近的状态。音频结束时恢复闭口。不要让嘴型播放与音频各自无关地无限循环。

## 生成流程、复现与适用范围

绘制阶段使用内置 imagegen 生成角色及拆分部件；生成提示、重试说明和技术派生记录保存在 `meta/source/`。导出阶段使用固定布局、统一色板与 alpha 清理，将同一批部件组成母版、表情、姿态和序列帧。连续帧采用确定性的刚性木偶变换与最近邻采样，未逐帧调用图像模型重画。

在包根目录执行 `node meta/serve.mjs` 可查看实际 PNG 与组合效果。`scripts/build-pack.cjs` 是源图到运行时素材的构建入口，依赖 Node.js、`sharp` 和 `pngjs`。构建不执行 SHA/SHA256；验证集中在路径、可解码性、尺寸、alpha、像素格、清单一致性和实际渲染。

本包是前端刚性木偶和序列帧交付，适合 Canvas、WebGL 或常规图片动画系统。若要制作 Live2D Cubism 模型，需要继续导入分层、建立 ArtMesh、变形器、参数、物理和动作并导出 `.moc3`。当前 3/4 图只有概念参考用途，没有对应连续转头的网格、遮罩或角度插值参数。现有头部小幅旋转与点头范围见 `manifest.rig.head`；大幅连续拉伸会破坏像素格，应另行设计。

## 纹理图集

每个动画目录另附透明 `atlas.png`，每格256×384；对应帧矩形、时长及0.25比例记录于 `manifest.animations[clip].atlas`。原1024×1536单帧同时保留。`meta/expression-overview.png` 是透明表情总览，依次为 neutral、happy、excited、thinking、concerned、apologetic。
