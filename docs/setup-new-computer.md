# 在朋友的电脑上运行 Nihao Agent

安装 Node.js 24.9 或更新版本，以及 Git。在终端进入项目根目录（含 `package.json`）：

```sh
git clone https://github.com/DumanHaoqian/Nihao-Agent.git
cd Nihao-Agent
npm ci
```

把根目录的 `.env.example` 复制为 `.env`，用文本编辑器打开，填入三个值：

```dotenv
POE_API_KEY="填写 Poe API Key"
BAIDU_MAP_API_KEY="填写百度地图服务端 AK"
DOUBAO_API_KEY="填写豆包语音 API Key"
```

上面是填写说明，不要把“填写……”这些文字保留为实际值。三个 key 的用途：

- `POE_API_KEY`：聊天和图片理解，默认模型为 `gpt-5.4-mini`。
- `BAIDU_MAP_API_KEY`：地点搜索、路线和行程工具；需要服务端类型 AK 和 MCP 服务权限。
- `DOUBAO_API_KEY`：朗读和听写共用；需要启用 TTS 2.0 和流式 ASR 2.0。默认朗读音色为 Vivi 2.0。

保存后执行：

```sh
npm run env:check
npm run build
npm start
```

打开 http://127.0.0.1:8787 。这些命令可在 Windows、macOS 和 Linux 使用，不需要创建 `poe`、`baidumap`、`doubao` alias。Windows 注意文件名应为 `.env`，不要保存成 `.env.txt`。

`env:check` 只显示每个变量是否已填写，缺失时返回非零退出码；不会打印密钥或调用真实服务，因此不验证额度、权限或密钥有效性。`npm start` 和 `npm run dev` 自动读取根目录 `.env`；修改后需要重启。终端已导出的同名变量优先于文件内容。

开发时运行 `npm run dev`，访问 http://127.0.0.1:5173 。已有 zsh alias 的电脑仍可使用 `npm run start:local`、`npm run dev:local` 和 `npm run env:check:local`；这些命令先加载原有 shell 配置及 alias。

`.env` 已被 Git 忽略，只留在本机。可分享不含密钥的 `.env.example` 和项目代码；不要把实际密钥加入 `VITE_` 变量或前端代码。
