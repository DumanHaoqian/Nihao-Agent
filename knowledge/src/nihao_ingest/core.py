from __future__ import annotations
import json
import uuid
from pathlib import Path
from datetime import datetime, timezone

def utcnow():
    return datetime.now(timezone.utc).isoformat()

def stable_id(*parts):
    # UUID3 identifies source keys only; never reads or verifies file contents.
    return str(uuid.uuid3(uuid.NAMESPACE_URL, json.dumps(parts, ensure_ascii=False, separators=(',', ':'))))

def read_jsonl(path):
    path = Path(path)
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()] if path.exists() else []

def write_jsonl(path, rows):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    with tmp.open('w') as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, default=str) + '\n')
    tmp.replace(path)

def append_jsonl(path, row):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a') as f:
        f.write(json.dumps(row, ensure_ascii=False, default=str) + '\n')

class Context:
    def __init__(self, root, http, source, version, max_items=50, max_images=15, max_videos=2, full_osm=False):
        self.root = Path(root); self.http = http; self.source = source; self.version = version
        self.max_items = max_items; self.max_images = max_images; self.max_videos = max_videos; self.full_osm = full_osm
    def event(self, source_id, status, reason='', **fields):
        append_jsonl(self.root / 'manifests/runs' / f'{self.version}.jsonl', dict(timestamp=utcnow(), run_id=self.version, source_id=source_id, status=status, reason=reason, **fields))
    def review(self, source_id, url, reason, **fields):
        append_jsonl(self.root / 'rights_review_queue.jsonl', dict(source_id=source_id, url=url, reason=reason, checked_at=utcnow(), **fields))
    def record(self, kind, payload, fetch_metadata, *, license, rights_status='approved', source_url=None, **extra):
        source_url = source_url or fetch_metadata.get('url', self.source['url'])
        key = extra.get('qid') or payload.get('id') or payload.get('pageid') or payload.get('title') or source_url
        return dict(id=stable_id(self.source['source_id'], kind, source_url, key), kind=kind, payload=payload,
            source_id=self.source['source_id'], source_url=source_url,
            fetched_at=fetch_metadata.get('fetched_at', utcnow()), source_published_at=None, last_verified_at=utcnow(),
            domain=self.source['domains'][0], scope='national', city=None, province=None, language='und',
            license=license, rights_status=rights_status, content_status='metadata_only' if rights_status=='metadata_only' else 'downloaded',
            data_version=self.version, raw_path=fetch_metadata.get('path'), raw_sha256=fetch_metadata.get('sha256'),
            **{k:v for k,v in extra.items() if k not in {'domain','scope','city','province','language','source_published_at','last_verified_at','content_status'}}) | {k:v for k,v in extra.items() if k in {'domain','scope','city','province','language','source_published_at','last_verified_at','content_status'}}
