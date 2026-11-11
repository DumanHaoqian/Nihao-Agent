# 在朋友的电脑上运行 Nihao Agent

## macOS 一键配置（推荐）

下载或复制最新项目代码，放在本机可写的文件夹中。不需要预装 Node、npm、Python、venv 或设置 shell alias。

1. 双击根目录 **`setup.command`**，等待终端提示配置完成。首次运行需要联网下载 Node 和 npm 依赖。
2. 用文本编辑器打开根目录 **`.env`**，填好三个 API Key 并保存。
3. 双击 **`start.command`**，保持终端窗口打开，然后访问 http://127.0.0.1:8787 。停止时在终端按 Ctrl+C。

`.env` 是隐藏文件：Finder 中按 **Command + Shift + .** 显示它，或者在项目终端运行 `open -e .env`，用 TextEdit 打开。

如果 macOS 因下载文件权限不允许双击，在终端进入项目目录执行：

```sh
bash scripts/setup-env.sh
bash scripts/run.sh start
```

项目是 Node.js 应用，使用项目专属的 Node 环境来提供类似 Python venv 的隔离效果。脚本按 `.node-version` 下载官方 Node **24.22.2**，自动区分 Apple Silicon / Intel；Linux 支持 arm64 / x64 的 glibc 发行版。Linux 也使用上面的两条 Bash 命令。脚本依赖系统的 Bash、curl、tar；macOS 自带这些工具。Windows 的手动方式见下方。

脚本会：

- 将 Node/npm 安装到 `.local/node-env/`，将 npm 缓存保留在 `.local/npm-cache/`。
- 使用项目 Node 执行 `npm ci --include=dev`，按 `package-lock.json` 安装项目内的 `node_modules/`，然后构建网页和服务端。
- 仅在 `.env` 不存在时创建空白模板；已填写的文件保持不变。
- 显示配置是否已填写，不打印密钥，不调用 Poe、百度或豆包服务。

无需退出 Conda；配套启动脚本会优先使用项目 Node，包括它启动的子进程。不需要 `sudo`，不会修改全局 Node、shell 配置或 Python 环境。运行目录和配置文件已被 Git 忽略；不要把另一台电脑的 `.local/`、`node_modules/` 打包过来，应在目标电脑上执行配置脚本。

## API 配置

`.env` 中填写三个值，保留引号：

```dotenv
POE_API_KEY="填写 Poe API Key"
BAIDU_MAP_API_KEY="填写百度地图服务端 AK"
DOUBAO_API_KEY="填写豆包语音 API Key"
```

上面是填写说明，不要把“填写……”保留为实际值。

- `POE_API_KEY`：聊天和图片理解，默认模型 `gpt-5.4-mini`。
- `BAIDU_MAP_API_KEY`：地图服务端类型 AK，需要 MCP 服务权限。
- `DOUBAO_API_KEY`：朗读和听写共用，需要启用 TTS 2.0 和流式 ASR 2.0。默认朗读音色 Vivi 2.0。

填写后可以执行 `bash scripts/run.sh check`。检查只判断是否存在非空值，不验证额度、权限或密钥有效性。缺少配置时启动脚本会明确提示，不会启动一个无法调用服务的页面。终端已导出的同名变量优先于 `.env`；配置变化后重启应用。

`.env` 只留在本机，不要提交 Git 或加入前端 `VITE_` 变量。可分享不含密钥的 `.env.example`。

## 日常使用与更新

以后直接双击 `start.command` 即可。更新代码后再次运行 `setup.command`：会复用相同版本的 Node，重新安装锁定依赖并构建，保留 `.env`。下载或安装失败时脚本会停止，修复网络等问题后可重跑。若提示有其他 setup 正在运行，先关闭它；只有确认没有安装进程时，才移除提示中的空锁目录。

所有命令都可以绕过系统旧 Node：

```sh
bash scripts/run.sh check
bash scripts/run.sh dev
bash scripts/run.sh typecheck
bash scripts/run.sh test
bash scripts/run.sh build
```

开发模式访问 http://127.0.0.1:5173 。生产启动访问 http://127.0.0.1:8787（如修改 `.env` 的 `PORT`，使用对应端口）。

## Windows 或已自行安装 Node 的电脑

一键脚本目前面向 macOS / Linux。Windows 请安装 Node.js 24.9 或更新版本，然后在项目根目录将 `.env.example` 复制为 `.env`、填写 Key 并执行：

```sh
npm ci
npm run env:check
npm run build
npm start
```

文件名必须为 `.env`，不要保存成 `.env.txt`。`npm start` 和 `npm run dev` 自动读取根目录 `.env`。已有 zsh alias 的电脑也仍可使用 `npm run start:local`、`npm run dev:local` 和 `npm run env:check:local`。
