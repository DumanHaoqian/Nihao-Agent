"""Remove a source and every derived/indexed representation of its content."""
import shutil
from pathlib import Path
from nihao_ingest.core import read_jsonl,write_jsonl,append_jsonl,utcnow
from .normalize import normalize
from .entity_link import link
from .media_process import process_media
from .audit import audit

def withdraw_source(root, source_id):
    root=Path(root).resolve()
    if not source_id or source_id in ('.','..') or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in source_id):
        raise ValueError('Invalid source_id')
    original=read_jsonl(root/'manifests/records.jsonl')
    old_media=read_jsonl(root/'normalized/media.jsonl')
    old_paths={str(Path(row[key]).resolve()) for row in old_media if row['source_id']==source_id for key in ('path','thumbnail_path') if row.get(key)}
    removed=[r for r in original if r['source_id']==source_id]
    write_jsonl(root/'manifests/records.jsonl',[r for r in original if r['source_id']!=source_id])
    for subtree in ('raw','assets/images','assets/videos','assets/audios','derived/thumbnails','derived/keyframes'):
        target=(root/subtree/source_id).resolve()
        if target.is_relative_to(root) and target.is_dir(): shutil.rmtree(target)
    # Indexes are disposable derived data. Rebuilding through retrieval is explicit.
    if (root/'indexes').exists(): shutil.rmtree(root/'indexes')
    sources=read_jsonl(root/'normalized/sources.jsonl')
    for row in sources:
        if row['source_id']==source_id: row.update(status='withdrawn',rights_status='withdrawn',content_status='withdrawn')
    write_jsonl(root/'normalized/sources.jsonl',sources)
    append_jsonl(root/'manifests/withdrawals.jsonl',{'source_id':source_id,'withdrawn_at':utcnow(),'records_removed':len(removed)})
    normalized=normalize(root);processed=process_media(root);linked=link(root)
    retained_media=read_jsonl(root/'normalized/media.jsonl')
    retained_paths={str(Path(row[key]).resolve()) for row in retained_media for key in ('path','thumbnail_path') if row.get(key)}
    for removed_path in old_paths-retained_paths:
        path=Path(removed_path)
        if path.is_relative_to(root/'assets') or path.is_relative_to(root/'derived'):
            path.unlink(missing_ok=True)
    checked=audit(root)
    return {'source_id':source_id,'records_removed':len(removed),'normalized':normalized,'media':processed,'links':linked,'audit_passed':checked['passed']}
