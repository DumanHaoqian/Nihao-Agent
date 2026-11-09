# Nihao Knowledge

独立的 Python 采集模块，位于 Nihao Agent 仓库根目录下的 `knowledge/`。保留原有 Schema、连接器与 normalize → media-process → entity-link → retrieval → audit/report 流水线，不修改 DeepSeek Harness 核心。历史真实验收结果记录在本地 `reports/ingestion_report.md` 和 `reports/pilot_acceptance.json`；程序测试通过不等于数据采集成功。

原始任务说明和初始来源清单分别保存在 [dataset-task.md](../docs/knowledge/dataset-task.md) 和 [source-seed.yaml](../docs/knowledge/source-seed.yaml)。当前运行配置是 `config/sources.yaml`，已经包含后续调整，不要用初始清单覆盖它。

`data/`、`reports/` 和 `.venv/` 是本地采集、运行或环境产物，不纳入 Git；新克隆不包含已下载资料、索引、历史报告和虚拟环境。源码、配置、测试、评估题目及 `ATTRIBUTION.md` 保留在仓库。本文中的 `reports/` 路径指本机产物，不代表这些文件随仓库发布。

当前执行约束以根目录 [AGENTS.md](../AGENTS.md) 和用户指令为准：禁止重新计算或校验 SHA/SHA256。下文及原始任务中“恢复 SHA”的说明仅记录历史阶段，不能作为当前执行授权。源码仍包含相关计算和校验逻辑，本次目录迁移没有禁用或改写它们，也不运行这些流程；已有历史字段和文件原样保留。

## 历史功能与 Pilot 记录

- 逐 URL 区分 robots 明确禁止、robots 无法获取/HTTP 错误、无效 robots 内容、目标 HTTP 错误、限流及数据解析错误；完整证据见本地 `reports/source_access_diagnosis.md`。
- 原先把被禁止的 API 路径扩展成整个来源不可用，这是过度阻断。现保留严格 robots 检查，使用官方支持且逐路径允许的 Wikidata `Special:EntityData/QID.json`、Wikipedia/Wikivoyage 当前正文页、Commons 文件许可页和媒体下载域。未开放 `/w/api.php` 或 SPARQL 的绕过开关。
- 保留原来的 13 个种子，增加中英文 Wikipedia 两个开放许可文本源。实体标题仅用于发现，实际 QID 从下载页面获取，再与 Wikidata sitelink 核对；图片依赖真实 P18 证据。
- 历史 Pilot 阶段曾加入 SHA256：原始响应、文本、媒体、缩略图和关键帧计算/复核，以及内容寻址去重。这是对已有实现的记录；当前禁止重新执行。历史本地完整性结果也不代表独立验证了网站真实性。
- 新增真实产物验收：100 个实质 chunks、20 张许可明确的原图、10 个实际可检索实体、5 条图文链路、中英文检索、一次真实视频尝试。短事实、重复片段、缩略图/关键帧、fixture 和隔离记录不能冲抵配额。

## 安装

Python 3.11+；可选 OSM 使用 osmium；视频处理需要 ffmpeg/ffprobe。本机已安装依赖和建立 `.venv`。

```sh
cd /Users/haoqian3/Desktop/Nihao-Agent/knowledge
python3.13 -m venv .venv
.venv/bin/python -m pip install '.[osm,test]'
export NIHAO_CONTACT='真实联系邮箱或 https 项目联系页面'
```

联系地址来自环境，不写入源码。`run.sh` 使用 `.venv` 并设置 `PYTHONPATH=src`，确保运行当前源码。

以下命令均在 `knowledge/` 内执行。旧目录 `deepseek-harness-master/nihao-knowledge` 仅作为本地兼容符号链接保留，用于现有虚拟环境脚本和数据中的旧绝对路径，不是新的工作入口，也不纳入 Git。

## 迁移后的基础检查

使用现有本地环境检查 CLI 和已审查的不执行 SHA 的测试；不运行整个测试集：

```sh
PYTHONDONTWRITEBYTECODE=1 ./run.sh --help
PYTHONDONTWRITEBYTECODE=1 PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 PYTHONPATH=src .venv/bin/python -m pytest -q -p no:cacheprovider tests/test_connectors.py tests/test_retrieval.py
```

## 历史六阶段命令

以下保留历史流水线入口，便于理解源码；它们不是本次迁移的验收步骤。当前禁止 SHA 的约束下，不执行会调用相关逻辑的来源验证、采集、规范化、媒体处理、审计、验收或完整测试集。

Dry-run 不联网：

```sh
./run.sh dry-run --max-total-mb 500
```

先验证，随后一条命令启动有界 Pilot：

```sh
./run.sh validate-sources --max-total-mb 40
./run.sh ingest --profile pilot --max-items 50 --max-images 30 --max-videos 1 --max-total-mb 500
```

继续规范化、关联、测试和报告：

```sh
# 为长城补齐同一实体的文本—图片—视频链路（限定一个 QID）
./run.sh ingest --source wikimedia_commons_attractions --entity-qid Q12501 --max-images 31 --max-items 3 --max-total-mb 30
./run.sh normalize
./run.sh media-process
./run.sh entity-link
./run.sh index
./run.sh audit
PYTHONPATH=src .venv/bin/python -m pytest -q --junitxml=reports/pytest.xml
./run.sh evaluate
./run.sh acceptance
./run.sh report
```

现有实现中，`acceptance` 未达门槛返回 1；`audit` 存在校验问题返回 1；参数或前置条件错误返回 2。`ingest` 允许部分来源失败后继续，退出 0 仅表示作业结束，须查看每源 outcomes。重复运行会使用 URL/日期缓存并复核 SHA，因此当前不执行；记录按来源键替换。视频最多 80 MiB/个、图像最多 12 MiB/张，总预算 500 MiB；不下载全国 OSM，除非显式 `--full-osm` 且访问策略允许。单源可用 `--source source_id`。

新目标不要求全国一次抓齐。`config/pilot_entities.yaml` 限定北京、上海、成都、西安、广州的景点和中国文化/美食发现标题。每个来源的许可与实际访问仍须独立核验。

## Schema、存储与出处

- `src/nihao_ingest/schemas/`：保留 sources/entities/documents/chunks/media/media_segments/links 七种 JSON Schema；新增可选完整性与来源字段。
- `data/raw/{source_id}/{date}/`：真实响应和 HTTP metadata sidecar；记录 URL、状态、ETag、Last-Modified、SHA256、获取时间。
- `data/manifests/records.jsonl`：真实源 envelope、许可、版本、原始路径、QID 证据。
- `data/normalized/`：七张关系表；媒体关联通过 entity_id 和 evidence/confidence，不依靠文件夹名字或相似标题。
- `data/assets/{images,videos,audios}/{prefix}/{sha256}.{ext}`：规范化后按内容寻址；每源记录保留独立作者和许可。
- `data/derived/`：缩略图和有时间戳的稀疏关键帧；未配置 VLM/OCR/ASR 时注释保持 pending。
- `data/indexes/text/`：关键词索引，不存媒体二进制；后续 RAG 向量索引另见 `data/indexes/rag/`。
- `reports/`：真实验收、访问调查、逐来源计数、领域/城市覆盖、错误、SHA 审计、双语检索示例及测试 XML。

文本保留实际章节、语言、当前下载的修订 ID、原页与历史署名链接，分块优先约 300–600 estimated tokens。验收要求每块至少 250 estimated tokens（CJK 字符 + Latin words ×1.3），且字符偏移能复现正文、内容不重复。小的原始章节可保留检索，但不用于凑足 100。

音频 Schema 可扩展，当前没有音频采集或 ASR 成果。合法视频通过 ffprobe 获取真实时长，ffmpeg 生成稀疏关键帧；未证实地点的媒体不会强行关联 QID。食品图片不推断配方或过敏原。

## 检索接口

```sh
./run.sh query --question 'What is the Forbidden City?'
./run.sh query --question '请介绍故宫。'
./run.sh serve --host 127.0.0.1 --port 8790
curl 'http://127.0.0.1:8790/health'
```

`GET /query?q=...&domain=...&limit=5` 返回真实出处摘录和关联媒体；`GET /entity?id=wikidata:Q...` 返回实体图。仅监听本机，写操作返回 405。缺证据/所需媒体时拒答；签证、实时票价时刻和食物安全需要官方核验。双语测试使用真实源标签与预期实体 ID，不把无关关键词匹配当作验证覆盖。

## 权属、隔离和历史

`ATTRIBUTION.md` 与 `reports/license_audit.csv` 支持展示作者、原页、许可证与衍生说明。CC0、CC BY-SA、ODbL 不相互覆盖；混合实体保留每来源许可。政府/NIA/12306 来源仍仅保存引用目录，不采集未授权正文。

首轮 robots 解析器未识别 Geofabrik 通配规则，误下载的北京快照与 48 条记录仍在 `data/quarantine/osm_geofabrik_beijing/`。本轮不使用、解隔离或重新下载它们；历史报告保存在 `reports/history/pilot-v1/`。

```sh
./run.sh quarantine-source --source SOURCE_ID --reason '具体隔离原因'
./run.sh withdraw-source --source SOURCE_ID
```

隔离保留证据，撤回删除该来源内容；两者阻止自动重新引入。共享内容对象仅在没有其他活跃来源引用时移除。历史维护流程会在变更后运行 normalize/media-process/entity-link/index/audit；当前不执行其中的 SHA 流程。本次迁移不隔离、撤回或删除任何资料，整个 `data/` 和 `reports/` 均作为本地产物忽略。

## 官方访问依据

- [Wikidata Data access](https://www.wikidata.org/wiki/Wikidata:Data_access)
- [Wikimedia Robot policy](https://wikitech.wikimedia.org/wiki/Robot_policy)
- [MediaWiki API etiquette](https://www.mediawiki.org/wiki/API:Etiquette)
- [Wikimedia API usage guidelines](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_API_Usage_Guidelines)
- [Commons reuse](https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia)
- [UNESCO API console](https://data.unesco.org/api-console/explore/v2.1/)

## RAG v3 开发入口（实际模型构建结果以日志为准）

安装额外依赖：`.venv/bin/python -m pip install sentence-transformers rank-bm25 fastapi uvicorn python-multipart`。

```sh
PYTHONPATH=src .venv/bin/python -m nihao_ingest.rag build
PYTHONPATH=src .venv/bin/python -m nihao_ingest.rag query --input '北京故宫有哪些历史建筑？'
PYTHONPATH=src .venv/bin/python -m nihao_ingest.rag image --input /absolute/path/to/photo.jpg
PYTHONPATH=src .venv/bin/python -m nihao_ingest.rag visual-text --input 'a stone wall along mountain ridges'
PYTHONPATH=src .venv/bin/uvicorn nihao_ingest.rag.api:app --host 127.0.0.1 --port 8791
```

`POST /search` 接受 question、filters、limit。filters 包含 city/domain/entity_id/source/license/language。`POST /visual/image` 接受 multipart 文件；不会保存上传图片。`POST /visual/text` 使用多语言 CLIP 文本编码器。视觉相似度只给候选身份，不自动验证地点。关键帧结果保留原视频片段和来源。无声视频没有生成字幕。

此接口不生成答案，因此 Answer Accuracy 不能用命中率替代；需要单独的答案评估。当前模块处于真实模型与评估验证阶段，不能仅因 API 能启动而宣称完成。

历史 v3 实测见本地 `reports/rag_report.md`：928×1024 文本向量、34×512 视觉向量；100 个问题均实际运行，但只有 7 个临时复用的段落标签，尚不构成完整金标评估。图像留出测试两例成功；列车视频负例误检长城关键帧，拒答能力未达标。不要据此宣布生产可用。本次目录迁移不重新下载模型或构建索引。

```sh
PYTHONPATH=src .venv/bin/python -m nihao_ingest.rag.quality
PYTHONPATH=src .venv/bin/python -m nihao_ingest.rag.evaluate
PYTHONPATH=src .venv/bin/python -m nihao_ingest.rag.demo
PYTHONPATH=src .venv/bin/python -m nihao_ingest.rag.report
```

`GET /verification/{source_id}` 对配置中的官方引用执行受 robots 约束的 HEAD 检查，需要 `NIHAO_CONTACT`。这只能验证网页入口可达性，不能核验政策内容；结果始终保留 `policy_content_verified=false`。
