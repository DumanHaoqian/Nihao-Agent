# Codex 工作指令：Nihao Agent 全国多模态旅游知识库（MVP）

> 目标：**现在就实现可运行的采集流水线，并在网络、许可和依赖允许的情况下执行一次小规模真实下载**。不要仅给计划或虚构采集统计。
>
> 背景：Nihao Agent 是面向赴华国际游客的创业 App，基于 `deepseek-ai/deepseek-harness` 开发。知识库覆盖全国，五大领域：`entry_visa`、`daily_life`、`attractions`、`food_culture`、`transportation`。首先覆盖全国性规则，并以北京、上海、成都、西安、广州做媒体与地点的试点；后续可以扩展其他省市。

## 0. 首先检查代码库

1. 阅读项目 `README`、已有 monorepo 结构和安全约束；不要猜测 DeepSeek Harness 内部接口或修改其核心执行循环。
2. 将采集、解析、存储实现为独立 Python 包 `nihao-knowledge/`；给 Harness 提供单独的只读检索接口，以后再进行 Agent Tool 集成。
3. 如果仓库中已有同类结构，优先复用，避免重复目录。不要删除或重写原项目文件。
4. 开始前打印计划，完成后输出真实的文件清单、许可证审核结果、成功/失败计数和运行命令。

## 1. 数据源和抓取权限

阅读 `nihao_sources.yaml`（放到 `nihao-knowledge/config/sources.yaml`）。为每个源建立 Source Registry，包含 `source_id/domain/url/source_type/license/status/access_strategy/refresh_policy`。

**明确允许做的事：**
- 下载 Wikidata 的 CC0 结构化记录（使用官方查询服务，小批量检索、设置可联系的 User-Agent）；
- 下载 UNESCO DataHub `whc001` 与 `ich001` 官方发布的、标为 CC BY-SA 4.0 的开放数据集；先读取数据集 schema、试通导出 API，再以结构化记录筛选中国数据；不要臆测 CSV 的字段名、URL 可用性或是否需要 API key；
- 下载 Geofabrik 正式发布的 OSM 地区 `.osm.pbf` 快照（ODbL），默认**只下一个省级/直辖市样本（例如北京）**；全国约 1.5GB 的包仅在 `--full-osm` 用户显式开启时下载；
- 通过 Wikimedia Commons API 搜索中国景点、菜品、铁路的图片与视频，逐文件读取许可与作者信息，仅下载确认适合商用及满足署名条款的媒体。必须保留页面 URL、作者、license、license URL、credit、下载 URL、原始描述、SHA256。许可不明的文件进 review queue，不下载；
- Wikivoyage 的中国及试点城市条目可以在核对页面许可、署名以及 ShareAlike 履行方式后做独立来源入库；不与 CC0 数据混淆。

**默认不做的事：**
- 不对 NIA、政府、12306、地方景区、官方旅游网站批量抓全文/图片/视频，除非其条款明确许可或取得授权。初期这些来源只存 `source_url/title/domain/topic/last_checked_at/rights_review_status`，在检索时跳转/核验官方原网页。
- 不批量下载 YouTube、Bilibili、抖音、小红书、携程、大众点评等平台视频或图文；不绕过付费、登录、反爬、robots、限流和防盗链。
- 不对政府旅游指南或其他版权材料做未经授权的全文再分发或默认训练集收集。
- 不将用户上传的护照、车票、面孔、位置等私密内容混入公共 RAG；用户数据另走私有存储，并默认采用最小保留策略。

请求服务时识别自身 `User-Agent`（含可联系地址，配置值从环境读取）、设置合理速率与指数退避；遇到 429 使用 `Retry-After`；保留 raw response metadata、`ETag`、`Last-Modified`、HTTP 状态和错误。控制并发（Wikimedia 建议不超过 3 个，并优先串行请求）。每个 URL 都要有下载尺寸上限、超时、去重和断点恢复；记录每次作业的 JSONL 日志。

## 2. 数据布局：原始文件按来源，归一化数据按实体；不要把所有图片混在一个目录

```text
nihao-knowledge/
├── README.md
├── config/
│   └── sources.yaml
├── src/nihao_ingest/
│   ├── cli.py
│   ├── connectors/                 # wikidata, unesco, geofabrik, commons, wikivoyage, official_registry
│   ├── pipelines/                  # ingest, normalize, entity_link, media_process, audit
│   ├── schemas/                    # pydantic/jsonschema
│   └── retrieval/                  # hybrid retrieval (MVP can be local files first)
├── tests/                          # offline fixture-based tests; no network required
├── data/                           # gitignored except samples and metadata
│   ├── raw/{source_id}/{snapshot_date}/
│   ├── normalized/
│   │   ├── sources.jsonl
│   │   ├── entities.jsonl
│   │   ├── documents.jsonl
│   │   ├── chunks.jsonl
│   │   ├── media.jsonl
│   │   ├── media_segments.jsonl
│   │   └── links.jsonl
│   ├── assets/images/{sha256_prefix}/{sha256}.{ext}
│   ├── assets/videos/{sha256_prefix}/{sha256}.{ext}
│   ├── derived/ocr/
│   ├── derived/captions/
│   ├── derived/transcripts/
│   ├── derived/keyframes/
│   ├── indexes/text/
│   ├── indexes/vision/             # 第一版允许为空
│   ├── manifests/runs/
│   ├── rights_review_queue.jsonl
│   └── quarantine/
└── reports/
    ├── ingestion_report.md
    ├── coverage_by_domain_city.csv
    ├── license_audit.csv
    └── errors.jsonl
```

**主组织原则**：目录用于存储层，不要用文件夹名称替代实体关系。业务查询通过 `entity_id` 关联一个景点的英文文档、中文名称、照片、视频片段、地理坐标和其他来源。

## 3. 最小统一元数据 schema

每条记录保留：`id`, `entity_id`(可空), `domain`, `scope`(national/province/city/poi), `province`, `city`, `language`, `source_id`, `source_url`, `fetched_at`, `source_published_at`(如可得), `last_verified_at`, `license`, `rights_status`, `sha256`(文件记录), `content_status`。

实体 `entities.jsonl`：
- `entity_id`: 首选 `wikidata:Q...`，OSM 实体用 `osm:node/way/relation:...`，无法识别时稳定的 `nihao:uuid`；
- `name_zh`, `name_en`, `aliases`, `entity_type`, `latitude`, `longitude`, `city`, `province`, `qid`, `osm_id`, `external_ids`, `source_ids`；
- 别把两个只有相似名字但不同地点的实体自动合并。跨源链接要有 evidence 和 confidence。

文本 `documents/chunks`：
- `document_id`, `chunk_id`, `entity_id`, `text`, `language`, `section`, `source_url`, `revision_or_retrieved_at`, `license`, `char_start`, `char_end`, `is_time_sensitive`, `valid_from`, `valid_until`（能确定时）；
- 以标题/章节分块，优先约 300–600 tokens，少跨章节；对签证规则保留条件、适用国籍、期限，严禁拆坏语义；
- 禁止用过时知识向游客提供确定的当前签证结论。

媒体 `media.jsonl`：
- `asset_id`, `entity_id`(可能 null), `modality`(image/video), `path`, `original_url`, `file_page_url`, `mime`, `width`, `height`, `duration_seconds`, `author`, `attribution`, `license`, `license_url`, `restrictions`, `sha256`, `rights_status`, `caption_zh`, `caption_en`, `ocr_text`, `language`, `source_id`, `retrieved_at`；
- 许可未知或存在模糊限制 -> review queue，不进入商用可展示索引；
- 视觉模型生成的 caption 与 OCR 属于 **derived annotations**，必须标注机器生成、模型版本、置信/未验证状态，不能冒充原始数据事实。

视频 `media_segments.jsonl`：
- `segment_id`, `asset_id`, `entity_id`, `start_seconds`, `end_seconds`, `transcript`, `transcript_language`, `keyframe_asset_ids`, `visual_summary`, `source_url`, `license`, `processing_version`；
- 只做许可明确、体积较小的视频 MVP。优先读取已有合法字幕；有本地 ASR 才生成转录。用 ffprobe 获取实际时长，ffmpeg 以场景或稀疏时间采样生成关键帧，避免整段视频每秒采样。必须让时间戳可以回到原视频位置。不要将视频片段中的过时票价/规则自动写入事实表。

关系 `links.jsonl`：
- `{ "from_id": "wikidata:...", "relation": "depicted_by|described_by|appears_in_video|located_in|same_as", "to_id": "asset_or_document_id", "evidence": "...", "confidence": 0.9 }`。

## 4. 五大领域映射

- `entry_visa`：NIA、使领馆规则（官方 URL registry 为主），必要时把合法授权材料按国家、护照、目的、时间拆为可核验条件；**不索引未授权官方全文**。
- `daily_life`：中国政府英文生活指南、Wikivoyage、合法许可的旅行操作图片；围绕支付、SIM、住宿、紧急服务创建 FAQ 实体；动态步骤须标记时效。
- `attractions`：Wikidata + UNESCO whc001 + Geofabrik OSM + Commons 景点图片，合并 POI 与实体关系。
- `food_culture`：UNESCO ich001 + Wikidata 菜系/食物实体 + Wikimedia Commons `Category:Cuisine of China` + Wikivoyage 内容。食物照片不能凭画面臆断配方或过敏原。
- `transportation`：Geofabrik OSM 的站点/线路/道路 + 12306 官方 FAQ 元数据 + Commons 铁路视频/图片；实时班次/票价不是静态 RAG，留给授权 API 和官方外链。

## 5. 分阶段实现和执行，**请真的跑一次**

**Stage A: Discovery / Rights**
1. 实现 `validate-sources`，对 URL 做可访问性及 robots/条款检查，生成 `rights_review_queue.jsonl`。不能确定许可时默认 metadata-only。
2. 验证 UNESCO API schema 和导出路线，Wikidata SPARQL，Commons API 分类与 `imageinfo` 的 `extmetadata`，Geofabrik 样本 URL；不可访问就报告，不造数据。
3. 实现 dry-run，报告预计下载数量、字节上限和来源状态。

**Stage B: Real Small-Batch Ingestion**
1. 全国结构化数据：UNESCO whc001 + ich001（只保留与中国相关的记录），Wikidata 进行有界分页/分类查询；避免一次全站 SPARQL。
2. 地点数据：Geofabrik 北京 PBF 样本（省级样本，便于先验证流程）。如果依赖不可用，可先保留文件和解析步骤，报告解析未完成。
3. Commons：试点城市和各领域图片，每个候选读取具体文件的 `imageinfo` 元数据、许可、尺寸，然后只下载商用兼容的样本（如 10–30 张）；视频选可确认许可且下载小于配置上限（例如 80 MB）的样本（0–3 个），没有合适文件允许为 0，说明原因。
4. Wikivoyage：仅在版权和归属方案明确后采集全国页及少量城市页，保留可用于页面署名的贡献者/历史及章节来源信息。
5. 官方政策/FAQ：只建立可核验来源目录，**未获许可时不要下载正文并入向量库**。

**Stage C: Normalize & Link**
1. 生成所有 JSONL 与实体跨模态链接；保存所有原始二进制和记录 SHA256；优先利用 Wikidata QID、OSM ID、Commons 描述数据关联。
2. 对已获许可文本生成 chunks；对图片生成缩略图和 metadata；如用户提供可用 VLM，再生成视觉摘要/OCR；否则标为 `pending`，不要伪造。
3. 视频处理只生成有时戳的关键帧、提取合法字幕/可用 ASR，并链接地点实体；未经核验的地点识别设置 `needs_review`。
4. 去重以 SHA256 为基础，允许不同来源指向同一 asset；记录数据版本和快照日期。

**Stage D: Retrieval & QA**
1. 建立最小文本关键词索引，若环境可用再加入 pgvector/BGE-M3，保留从 `chunk_id` 到来源 URL 的可追溯性。**不应把整张图片或视频的二进制放进向量数据库**；索引中保存 embedding、asset_id/segment_id 和回源路径。
2. 给出 5 个领域各 2 条英语测试问题（共 10 条）和至少 3 条图片/视频场景的测试样例；测试有来源引用和缺失时拒答。
3. `pytest` 覆盖 source parser、许可阻断、断点重试、SHA 去重、实体链接、视频时间戳、JSON schema；做一次真实小规模采集并列出真实成功/失败数量。

## 6. 验收标准和交付格式

- `README.md` 有一条命令启动 dry-run、一条命令启动允许来源的小批量采集；各命令可重复执行。
- `data/raw/` 有实际下载产物（如网络允许）；不是空目录或编造的伪数据。网络受限时必须报告阻塞原因和可本地继续执行的命令。
- `data/normalized/` 生成可通过 schema 验证的记录，至少能展示一组 `POI entity → text chunk → photo / video segment` 链接（没有可用视频时报告限制，不要造视频）。
- `reports/ingestion_report.md` 表示每个数据源的 `discovered/eligible/downloaded/skipped/failed`, 字节数、SHA 校验、许可分类、实际来源 URL、耗时、故障、下一步。
- `license_audit.csv` 与 `ATTRIBUTION.md` 用于未来 App 自动向游客展示署名。
- `source_id` 级别可删除数据，且可以撤回/移除有权属问题的资产及其索引。
- 不抓取需认证或未经许可的站点内容；不泄露 API Key；大文件和媒体默认不加入 Git。

## 7. 建议 CLI（以实际实现为准，不是已有命令）

```bash
cd nihao-knowledge
python -m nihao_ingest.cli validate-sources --registry config/sources.yaml
python -m nihao_ingest.cli dry-run --registry config/sources.yaml --max-total-mb 500
python -m nihao_ingest.cli ingest --registry config/sources.yaml --profile pilot --max-total-mb 500
python -m nihao_ingest.cli normalize
python -m nihao_ingest.cli audit
python -m nihao_ingest.cli report
pytest -q
```

注：若 pilot 需下载整个北京 OSM 文件，仍在 500 MB 总预算以内；按最新大小评估，不能保证。实际允许下载何种源，以来源条款核验和脚本实际状态为准。

## 8. 结束时给我回报

请给出：代码 diff 的摘要、具体运行命令、各领域和各模态的记录数量、数据总大小、许可状态统计、5 个样本记录的 ID 和来源、失败/跳过原因。不要声称你完成了未真正下载或未真实运行的部分。
