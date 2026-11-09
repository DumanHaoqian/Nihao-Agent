# Nihao Agent 资产包接入说明

这套资产采用透明 PNG 和分层木偶结构。可以直接以序列帧播放，也可以按图层顺序组合，替换眉眼嘴型，并围绕锚点做小幅变换。它不是已经绑定完成的 Live2D Cubism 模型：本包未提供 `.cmo3`、`.moc3`、`.model3.json` 或 Cubism 变形器。

## 运行交互预览

在资产包目录运行 `node meta/serve.mjs`，打开 `http://127.0.0.1:8765/meta/preview.html`。可通过 `node meta/serve.mjs 8766` 更换端口。服务器仅监听本机回环地址，不对外发布资产。

也可以使用项目已有的开发服务器，将资产包作为静态资源目录。不要直接双击 HTML；浏览器的 `file://` 模式通常禁止读取 JSON 清单。

预览页按 `meta/manifest.json` 动态发现文件，支持：

- 动画序列播放、暂停、逐帧检查、循环与播放速度。
- 表情切换、动作姿态切换。
- 透明网格、浅色和深色背景检查。
- 对齐图层组合、图层显隐，以及围绕头部锚点的小幅转动检查。

页面的网格和颜色仅用于预览，不写入任何 PNG。不要把截图作为透明素材使用。

## 目录与路径

`concept/` 存放母版与角色设定图；`layered/` 存放拆分图层与眉眼嘴型；`expressions/` 存放组合表情；`animations/` 存放姿态、动画序列和嘴型动画素材；`meta/` 存放清单、锚点、生成记录、接入文档和预览。

`manifest.json` 中的 `file` 字段均相对资产包根目录，不能相对 `meta/` 目录直接拼接。例如 `layered/face_base.png` 对应根目录下的 `layered` 子目录。

```js
const packRoot = new URL('/assets/nihao-avatar-pack-v1/', location.origin);
const manifest = await fetch(new URL('meta/manifest.json', packRoot)).then(r => r.json());
const imageUrl = new URL(manifest.layers[0].file, packRoot);
```

## 坐标、锚点与朝向

以 `manifest.canvas` 的实际宽高为准。画布左上角为 `(0, 0)`，X 向右，Y 向下。锚点以画布像素表示，渲染缩放时和图像一起等比例缩放。浏览器 Canvas 中正旋转角度为顺时针。`left` / `right` 图层名称以角色自身为准，指向动作名称以观众看到的画面方向为准；请以包内最终锚点说明中的坐标核对接入。

完整画布图层直接叠加在 `(0, 0)`，不能分别居中、自动裁边或者按各自包围盒缩放。图层透明留白也是对齐数据的一部分。如需打包精灵图，可裁边，但必须在图集中保留原始画布尺寸、裁边偏移和 pivot。

基本变换顺序为：移动到锚点 → 旋转或缩放 → 移回锚点 → 绘制图层。同一头部组中的脸、前后发、发髻、发带、眼睛、眉毛和嘴型应采用相同的组变换。手臂则采用肩—肘—腕父子层级，不能分别绕画布中心转动。

## 图层组合

按 `z` 从小到大绘制，数值较大的图层覆盖较小的图层。每组表情变体只显示一个状态，例如 `eyes=open`、`eyebrows=neutral`、`mouth=closed`。对齐图层示例：

```js
ctx.imageSmoothingEnabled = false;
for (const layer of selectedLayers.sort((a, b) => a.z - b.z)) {
  const img = await loadImage(new URL(layer.file, packRoot));
  ctx.drawImage(img, 0, 0);
}
```

预览运行时支持以下清单结构；实际文件名和参数应始终从本包清单读取：

```json
{
  "canvas": {"width": 1024, "height": 1536},
  "layers": [
    {"id": "eyes_open", "file": "layered/eyes_open.png", "z": 50,
     "group": "eyes", "state": "open", "parent": "head", "pivot": [512, 720]}
  ],
  "expressions": {
    "neutral": {"eyes": "open", "eyebrows": "neutral", "mouth": "closed"}
  },
  "poses": {
    "idle_pose": {"file": "animations/poses/pose_idle.png"}
  },
  "animations": {
    "blink": {
      "loop": false,
      "frames": [{"file": "animations/blink/frame_000.png", "durationMs": 100}]
    }
  }
}
```

此 JSON 只说明结构，示例锚点不是角色真实测量值。真实坐标和可用资源请读包内最终清单与锚点文件。

## 动画与嘴型

优先使用导出的 PNG 序列验证效果。逐帧按 `durationMs` 播放，不能假定所有序列固定 FPS。移动端可预解码当前动画，复用图片纹理；对闲置序列按需加载，避免同时常驻所有全尺寸 PNG。连续待机应按 `loop` 属性循环；眨眼、点头等动作可在结束后返回待机状态。

嘴型图集提供闭口、微开、中开、大开、微笑和 O 形。它们是视觉嘴型，不等同于完整音素集。接入 TTS 时可按音量包络映射开口幅度；若已有音素或 viseme 时间戳，再映射到最接近的嘴型。声音停止时回到闭口。不要将随机嘴型切换描述为已实现精确唇形同步。

像素画优先整数倍缩放，Canvas 关闭 `imageSmoothingEnabled`，DOM 图片使用 `image-rendering: pixelated`。如果 UI 必须以非整数倍缩放，应在目标尺寸检查眼睛、嘴巴和边缘是否仍清晰。透明 PNG 需要保持 alpha；不要转换为 JPEG。

## 接入 Live2D Cubism

可将独立图层整理为分层 PSD 后在 Cubism 中导入。然后还需要人工或专门工具完成网格、旋转与曲面变形器、参数、遮罩、物理与动作曲线。眼睛闭合、嘴型开合、头部转动及关节连接都要在最终参数极值下检查。像素风素材更适合小幅刚性变换和替换帧；大幅连续拉伸会破坏像素格。

素材包中的 PNG 分层和序列帧可以直接被常规前端渲染系统使用；「采用 Live2D 分层思路」不代表已交付 Cubism 可执行模型。
