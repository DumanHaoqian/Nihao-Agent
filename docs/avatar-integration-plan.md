# Nihao Agent 动画接入方案

检查日期：2026-11-09。此文是基于当前源码的接入设计，未修改产品代码，未调用在线聊天、地图、TTS 或 ASR 服务。

## 推荐方向

第一版采用「欢迎页半身角色 + 当前回复动态头像」，并接入现有听写与朗读状态。角色表达真实的产品状态；文字和旅行结果始终是主要内容。技术上使用 React + Canvas 2D，复用 PNG 图集与分层素材。

现有资产是像素风刚性木偶，适合低频待机、替换眼口和小幅动作。当前范围无需新增 Cubism 运行时，也无需修改 Harness AgentLoop 或服务端动画协议。

## 当前代码中的接入位置

代码根目录：`Nihao-Agent/`，即包含 `package.json` 的项目根目录。下文源码与资源路径均相对该目录。

| 源码位置 | 已有内容 | 接入设计 |
| --- | --- | --- |
| `apps/nihao/web/src/App.tsx`，约30行 | messages、pending、speech、dictation | 汇总角色状态与当前活动对象 |
| 同文件，约209行 | welcome-content，首页标题及输入框 | 加半身角色，首次欢迎招手一次 |
| `components/Message.tsx`，约57行 | 48×48 的 chat-head.png | 替换为支持静态回退的 NihaoAvatar |
| `components/Composer.tsx`，约82行 | 听写状态、波形、计时与操作 | 复用状态；扩展语音面板时放在输入框上方，保持操作可达 |
| `speech.ts`，约142行 | StreamingPcmPlayer / Web Audio | 给实际播放流加音量读取点 |
| `useSpeech.ts`，约51行 | 单个朗读会话及缓存重播 | 向动画提供 messageId、播放状态和稳定的音量读取函数 |
| `useDictation.ts`，约47行 | permission / connecting / recording / finishing，真实音量 | 驱动听写反馈，保持角色闭口 |
| `App.tsx`，约80行；`shared/travel.ts`，约56行 | tool-status 与 artifact 事件 | 查询时思考，有效行程展示时短点头或讲解 |
| `components/TravelArtifacts.tsx` | 地点、路线、行程卡片 | 第二阶段接讲解动作；按实际目标位置决定指向 |

检查期间上述旅行卡片相关代码有更新，文档中的行号仅作为定位提示。地图能力是否可用依赖实际配置，本次未验证在线服务。

## 产品中的表现

### 欢迎页

标题附近展示约144–192px的半身角色；手机采用更紧凑尺寸并重新分配现有上下留白，保证输入框仍容易看到。进入空态时招手一次，之后轻微待机、间隔眨眼。页面普通重渲染不重复欢迎动作。

### 聊天消息

保留当前48px头像槽位。只有当前生成、执行工具或朗读的消息拥有动态反馈；历史消息显示同一造型的静态头像。读取旧消息时以 speech.messageId 选择活动头像，不能默认让最新回复动嘴。

### 语音交互

第一步用现有头像承接朗读表现。若48px的嘴型不够显著，第二步在输入框上方提供可收起的80–120px半身语音面板；手机使用更紧凑布局。面板出现时消息头像保持静止，避免重复动作。

录音工具栏已经包含取消、状态、波形、时间和完成键，不再挤入大人物。监听状态采用注视和轻微点头，用户的语音只驱动输入波形及少量倾听反馈。

## 状态与动画

| 真实事件 | 动画表现 | 约束 |
| --- | --- | --- |
| 首次进入欢迎页 / 新会话空态 | waving 一次 → idle | 对同一次进入只触发一次 |
| 回复 streaming 且内容为空 | thinking | 闭口 |
| search/details/route/plan running | thinking | 对应当前工具提示，不暗示结果已经完成 |
| 正在输出文字 | neutral + 低频眨眼 | 文字流不驱动说话口型 |
| 有效行程 artifact 随回复 complete 展示 | nodding 一次，可接 explaining | 单次工具 complete 不等于整份行程成功 |
| TTS loading | 中立等待 | 不提前张嘴 |
| TTS 实际有声 | 闭口 / 微开 / 中开 / 大开 | 依据实际播放音量；静音间隙闭口 |
| TTS 实际播放结束 | 闭口 → idle | 等声音播放完成，不以网络 done 为准 |
| ASR permission / connecting | 中立等待 | 不能提前表现为已经听到用户 |
| ASR recording | listening，偶发小点头 | 用户说话时角色嘴巴闭合 |
| ASR finishing | 短暂等待 | 此时麦克风已停止或在收尾 |
| 当前请求失败 | concerned / apologetic | 错误文字仍是主要反馈 |
| 用户取消、停止、新对话 | 立即闭口、取消动作队列 | 主动取消不表现成失败 |

状态由 activity（idle/thinking/listening/speaking）、expression、一次性动作和活动 messageId 分开管理。优先级：用户取消/重置 → 实际朗读 → 听写会话 → TTS准备 → 当前工具执行/模型生成 → 一次性完成动作 → idle。取消事件处理完立即退出，不作为永久状态。

旧消息朗读可能与新消息流式输出同时存在；只允许选定的可见角色连续运动。旅行结果的庆祝、指向动作保留到有明确交互的场景；不能从自由文本中的关键词判断成功或事实可信度。

## 实际口型同步

现有音频是24kHz单声道PCM；每个音频块都在 StreamingPcmPlayer.enqueue 内创建 AudioBufferSourceNode 并排入 AudioContext 时间线。

建议改为：

```text
AudioBufferSourceNode（每个PCM块）
        ↓
共享 AnalyserNode（每次朗读会话一个）
        ↓
AudioContext.destination

当前时域样本 → RMS → 平滑与迟滞 → mouthOpenRef → Canvas
```

AnalyserNode 可在不改变音频流的同时提供实时分析数据，参见 [MDN AnalyserNode](https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode)。另一种可行方式是按PCM样本预计算音量包络，再按 [AudioContext.currentTime](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/currentTime) 和既有排队时间读取。

关键时序：

- useSpeech 的 playing 在 enqueue 后就会置位；音频块至少有约40ms调度提前量，也可能存在网络空档。因此 playing 只能表示播放会话活跃，不能直接等同嘴巴持续运动。
- 网络数据可能比播放进度领先很多，不以收到SSE包的时刻切嘴型。
- useSpeech 已等待 player.finish()，后者等排队音频全部 onended。沿用这一真正结束点。
- 缓存重播经过同一播放器，可复用相同音量驱动。
- Stop、报错、新聊天、卸载时清除音量值与 RAF，马上闭口。
- 声音驱动使用 ref/readLevel()，不每帧 setState 更新整个聊天树。
- 当前协议没有音素/viseme时间戳。第一版明确是音量同步，不能称为精确唇语同步。O形不能只靠音量准确推断。

## 素材到运行时的转换

当前素材包：`assets/avatar/nihao-avatar-pack-v1/`。原始头像保存在 `assets/avatar/chat-head.png`，网页运行副本保存在 `apps/nihao/web/public/brand/chat-head.png`。素材用途与可选重建方式见 [assets/README.md](../assets/README.md)。

1. 导出 portrait / bust / full 三个固定裁切窗口。所有帧使用相同窗口并保留原始偏移；48px头像使用 portrait，欢迎页使用 bust。全身1024×1536帧不能直接塞入48px头像框。
2. 从母版确定性导出128/256像素的头像运行资源；生成过程不重新调用图像模型。
3. 普通待机、挥手、点头使用小尺寸atlas；朗读使用可独立替换嘴型的分层绘制。
4. 五官的合成顺序为「底层/脸底 → 眼眉嘴 → 前发/发带/侧发」。不能把完整带嘴头像当底图再叠新嘴，也不能将眉毛画在遮挡它的刘海上。
5. 运行目录只发布经过筛选的PNG和轻量清单。原始源图、提示词、设定图、QA截图仍留在美术资产目录。

本次直接统计：53张全尺寸帧按RGBA全部解码约318MiB；已有5张小尺寸atlas文件总计140354字节（约137KiB），按RGBA解码约22.9MiB。37张全尺寸拆件另需约222MiB。这些是尺寸推算的像素内存，不是浏览器实测峰值，尚未包括缓存、纹理副本等。运行时应按需加载、避免预载整个源包。

## 建议代码结构

```text
apps/nihao/web/src/
  components/NihaoAvatar.tsx       # Canvas宿主、固定viewport、静态fallback
  avatar/controller.ts            # 纯状态转换、优先级、一次性动作去重
  avatar/useAvatarState.ts         # 连接现有App状态和生命周期
  avatar/renderer.ts              # 图集/分层绘制，不依赖聊天业务
  avatar/assets.ts                # 小尺寸资源加载与缓存
  avatar/types.ts                 # activity、expression、framing类型

apps/nihao/web/public/avatar/nihao-v1/
  manifest.json
  portrait/...
  bust/...
  layers/...

scripts/prepare-avatar.mjs         # 原始资产 → 精简运行资源
```

App 负责传递事实状态，NihaoAvatar 负责表现，StreamingPcmPlayer 负责提供实际播放音量。前端现有 copy.ts 继续管理中英文可访问标签。后端模型继续输出现在的文字与旅行事件，不要求它返回动画指令。

## 执行顺序与验收

第一步：运行素材导出、NihaoAvatar、欢迎页及当前消息接入；实现招手、待机、眨眼、思考、完成点头、错误表情与静态回退。

第二步：在现有PCM播放器中加入音量读取；接真实朗读、缓存重播、停止和听写。随后接旅行工具状态及行程展示动作。连续大幅转头、复杂肢体变形若成为产品需求，再评估Cubism绑定工作。

实现后按仓库要求运行 typecheck、单元测试、build、浏览器检查，并明确区分模拟测试与真实服务验证。关键验收：

- 文本流不会让角色说话；TTS静音间隙及停止立即闭口，SSE完成不抢先结束口型。
- 听写权限等待、实际录音和收尾状态不混淆；听写不自动发送。
- 朗读旧回复时只对应角色动嘴；取消或New chat后旧回调不能重启动画。
- 头像裁切、眨眼和换嘴不跳位置；小尺寸仍看得清。
- reduced-motion必须控制JS动画；仅关闭CSS transition不足。离屏及后台停止视觉循环，恢复后读取最新业务状态，不回放积压动作。
- 动画加载失败回退到现有 /brand/chat-head.png，不影响聊天、朗读和听写操作。
- 在320px、390px和桌面视口确认角色不遮挡输入、取消、完成、停止、路线链接及结果文字。

本次仅完成源码与素材审阅以及方案文件，没有修改或测试产品运行行为。
