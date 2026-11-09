# Internal implementation contract
Python >=3.11, requests, PyYAML, jsonschema, Pillow; optional osmium; pytest dev.

The package lives at `<Nihao-Agent>/knowledge/` (locally `/Users/haoqian3/Desktop/Nihao-Agent/knowledge`). Run the Python commands from that directory; `run.sh` resolves its own directory and sets `PYTHONPATH=src`. The chat application's npm commands run from the repository root. The ignored legacy `deepseek-harness-master/nihao-knowledge` symlink exists only to preserve older absolute paths and virtual-environment entry points.

`data/`, `reports/`, and `.venv/` are local artifacts and are not committed to Git. Retain their existing contents during migration. Source code, schemas, configuration, test fixtures, authored evaluation cases, and attribution documentation remain versioned. The original task and initial source seed are archived in [dataset-task.md](../docs/knowledge/dataset-task.md) and [source-seed.yaml](../docs/knowledge/source-seed.yaml); the active registry remains `config/sources.yaml`.

Current execution instructions come from the repository [AGENTS.md](../AGENTS.md) and the user: do not recompute or verify SHA/SHA256. Historical statements below about restoring SHA describe an earlier Pilot implementation, not current permission. The source still contains hashing and integrity-validation routines; this migration does not disable them, rewrite historical records, or run those routines. Do not run the full test suite as a migration check because some tests invoke them.

The reviewed migration checks are `PYTHONDONTWRITEBYTECODE=1 ./run.sh --help` and `PYTHONDONTWRITEBYTECODE=1 PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 PYTHONPATH=src .venv/bin/python -m pytest -q -p no:cacheprovider tests/test_connectors.py tests/test_retrieval.py`.

Root owns core.py, http.py, CLI, validation, report, packaging.
Connector owner owns connectors/*.py: `ingest_source(source: dict, ctx) -> list[dict]` exported from connectors/__init__.py.
Pipeline owner owns schemas/*.json and pipelines/*.py: `normalize(root: Path) -> dict`, `link(root: Path) -> dict`, `process_media(root: Path) -> dict`, `audit(root: Path) -> dict`. Export from pipelines/__init__.py. No network in pipelines.
Retrieval/test owner owns retrieval/*.py and tests/*: query(root, question, domain=None, limit=5) -> dict; serve(root, host, port). Coordinate fixtures with pipeline owner.

## ctx contract (root implements)
ctx.root: Path data directory; ctx.version string run ID; ctx.source dict; ctx.full_osm bool; ctx.max_items int default 50; ctx.max_images int default 15; ctx.max_videos int default 2.
ctx.http.fetch(url, source_id, *, max_bytes=..., method='GET', headers=None, purpose='data', resume=True) -> dict with path (str absolute), url, final_url, status, bytes, fetched_at, etag, last_modified, cached (bool); raises FetchError with descriptive reason. HTTP respects robots, timeouts, max-total budget, retries/Retry-After, resume. Content-Type stored as content_type. ctx.http.json(url, source_id, **kwargs) -> (parsed_data, fetch_metadata).
ctx.event(source_id, status, reason='', **fields) persists JSONL; status in discovered/eligible/downloaded/skipped/failed. HTTP transport logs distinct from record counters.
ctx.review(source_id, url, reason, **fields) appends rights_review_queue.
ctx.record(kind, payload, fetch_metadata, *, license, rights_status='approved', source_url=None, **extra) -> envelope with id, kind, payload, source_id, source_url, fetched_at, license, rights_status, data_version + extra. id stable UUID from exact source_id/kind/source_url/source key; source-key identity remains UUID3. Historical raw/file integrity uses SHA256 in the retained implementation; current instructions prohibit executing those calculations or checks.
Connector envelopes appended by CLI to data/manifests/records.jsonl. Kinds:
- wikidata: payload raw Wikidata entity JSON; qid external key; common source URLs.
- unesco: payload raw record; dataset_id plus fields schema and country_field as extras when useful; payload normalized field convenience allowed but retain original.
- osm: payload {'type':'node|way|relation','id':int,'tags':{},'lat':float|null,'lon':float|null}; only tourism/transport/amenity relevant nodes; qid from wikidata tag.
- commons: payload raw Commons API page with imageinfo/extmetadata; asset_path (absolute), modality image/video/audio, qid (if unambiguous), city optional; license canonical.
- wikivoyage: payload {'title':str,'pageid':int,'revid':int,'text':str,'sections':optional}; attribution_url, history_url, qid optional.
- official: payload {'title':str,'topics':list,'url':str}; rights_status='metadata_only'; never body text.
All envelopes include source_id/domain (single one of 5), scope, city/province nullable, language, source_published_at nullable, last_verified_at, license, rights_status, content_status. Raw envelopes include raw_sha256; text/media records include sha256. These historical fields remain unchanged. The retained audit implementation verifies active downloaded and derived artifacts, so it is not run under the current no-SHA instruction.
Sources: validation at data/manifests/source_validation.json, original registry in config/sources.yaml, normalized sources.jsonl prepared root. Each source result status eligible|metadata_only|blocked|review, license_evidence_url, reason, checked_at, robots and checks. For verified source metadata license provenance must be propagated.
Data JSONL: read/write helper available in core.py `read_jsonl(path)` and `write_jsonl(path, rows)` plus `stable_id(*parts)` and `utcnow()`.
Normalized schema common metadata as above plus type-specific task document fields. Fields and IDs communicate between agents as implemented. The former statement that the user had restored SHA256 applied to an earlier Pilot stage only; it does not override the current repository instructions or authorize recalculation during this migration.
