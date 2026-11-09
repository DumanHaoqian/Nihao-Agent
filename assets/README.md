# Nihao Agent 素材

这里保留项目的原始品牌与角色素材，供后续设计、导出和动画集成使用。下文命令均在包含 `package.json` 的项目根目录运行。

| 路径 | 用途 |
| --- | --- |
| `brand/logo-source.png` | 用户提供的原始 Nihao Agent Logo；网页透明横版 Logo、蓝色 N 标记和 favicon 由它导出 |
| `avatar/chat-head.png` | 用户提供的原始角色头像 |
| `avatar/nihao-avatar-pack-v1/` | 完整角色素材包，包含概念图、透明分层、表情、姿态、动画帧与图集，以及清单、源图、制作记录、预览和导出脚本 |

网页实际加载的素材保留在 `apps/nihao/web/public/brand/`，其中头像副本继续通过 `/brand/chat-head.png` 提供。源文件与网页副本各自保留，便于维护原稿和稳定的运行资源地址。素材包中的 `meta/source/reference_avatar.png` 也保留，以保持该素材包可独立使用。

素材包采用 PNG 分层与序列帧，尚不是完成绑定的 Live2D Cubism 工程。动画接入设计见 [动画接入方案](../docs/avatar-integration-plan.md)，素材结构与规格见 [素材包说明](avatar/nihao-avatar-pack-v1/README.md)。普通网页构建不会重建或预载整个素材包。

## 本地预览

```sh
node assets/avatar/nihao-avatar-pack-v1/meta/serve.mjs
```

打开终端提示的本地地址；默认是 `http://127.0.0.1:8765/meta/preview.html`。预览服务只监听本机。

## 可选素材重建

已提交的 PNG 与图集可以直接使用。只有需要重新导出素材时，才运行重建脚本；脚本会更新素材包内的图层、动画、清单和校验报告，源图仍保留在 `meta/source/`。

重建需要 Node.js、`sharp` 和 `pngjs`。正常安装项目依赖后已有 `sharp`；`pngjs` 是可选制作依赖，可临时安装而不修改项目依赖声明和锁文件：

```sh
npm install --no-save --package-lock=false pngjs
node assets/avatar/nihao-avatar-pack-v1/meta/scripts/build-pack.cjs
node assets/avatar/nihao-avatar-pack-v1/meta/scripts/finalize-pack.cjs
```

重建使用现有源图进行确定性导出，无需重新调用图像模型。脚本检查尺寸、透明度、图层、锚点和动画帧，不执行 SHA 或 SHA256 校验。制作依赖和素材重建步骤不属于聊天应用的启动要求。
