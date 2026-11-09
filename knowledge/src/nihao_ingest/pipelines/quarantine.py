"""Retain downloaded evidence while removing a source from the usable corpus.

This does not grant permission to re-download, publish or index quarantined data.
"""
from __future__ import annotations
import json
import shutil
from pathlib import Path
from nihao_ingest.core import read_jsonl,write_jsonl,append_jsonl,utcnow


def quarantine_source(root, source_id, reason):
    root=Path(root).resolve()
    if not source_id or source_id in ('.','..') or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in source_id):
        raise ValueError('Invalid source_id')
    if not reason or not str(reason).strip(): raise ValueError('A quarantine reason is required')
    target=root/'quarantine'/source_id
    target.mkdir(parents=True,exist_ok=True)
    mappings=[]; moved_files=0
    all_media=read_jsonl(root/'normalized/media.jsonl')
    source_media=[row for row in all_media if row.get('source_id')==source_id]
    other_paths={str(Path(row[key]).resolve()) for row in all_media if row.get('source_id')!=source_id for key in ('path','thumbnail_path') if row.get(key)}
    for subtree in ('raw','assets/images','assets/videos','assets/audios','derived/thumbnails','derived/keyframes'):
        origin=root/subtree/source_id
        destination=target/subtree
        if origin.exists():
            if origin.is_symlink(): raise ValueError('Refusing symlink source directory')
            if destination.exists(): raise ValueError('Quarantine destination already exists while active data remains: '+str(destination))
            moved_files+=sum(path.is_file() for path in origin.rglob('*'))
            destination.parent.mkdir(parents=True,exist_ok=True)
            shutil.move(str(origin),str(destination));mappings.append((str(origin),str(destination)))
    # Shared content-addressed assets survive if another active source uses them.
    # The quarantine receives its own evidence link; unshared files are moved.
    copied_shared_assets=0
    for row in source_media:
        for key in ('path','thumbnail_path'):
            if not row.get(key): continue
            origin=Path(row[key]).resolve()
            if not origin.is_file() or not origin.is_relative_to(root): continue
            if any(str(origin)==old or str(origin).startswith(old+'/') for old,new in mappings): continue
            if not (origin.is_relative_to(root/'assets') or origin.is_relative_to(root/'derived')): continue
            destination=target/'content_objects'/origin.relative_to(root)
            destination.parent.mkdir(parents=True,exist_ok=True)
            if str(origin) in other_paths:
                if not destination.exists():
                    try: destination.hardlink_to(origin)
                    except OSError: shutil.copy2(origin,destination)
                copied_shared_assets+=1
            else:
                if destination.exists(): raise ValueError('Quarantine content object already exists')
                shutil.move(str(origin),str(destination));moved_files+=1
            mappings.append((str(origin),str(destination)))
    def remap(value):
        if isinstance(value,dict): return {key:remap(item) for key,item in value.items()}
        if isinstance(value,list): return [remap(item) for item in value]
        if isinstance(value,str):
            for old,new in mappings:
                if value==old or value.startswith(old+'/'): return new+value[len(old):]
        return value
    write_jsonl(target/'media_records.jsonl',[remap(row) for row in source_media])
    active=read_jsonl(root/'manifests/records.jsonl')
    removed=[row for row in active if row['source_id']==source_id]
    quarantined=read_jsonl(target/'records.jsonl')
    now=utcnow()
    for row in removed:
        item=remap(row)
        item.update(previous_rights_status=item.get('rights_status'),rights_status='needs_review',
                    content_status='quarantined',quarantined_at=now,quarantine_reason=reason)
        quarantined.append(item)
    write_jsonl(target/'records.jsonl',{row['id']:row for row in quarantined}.values())
    write_jsonl(root/'manifests/records.jsonl',[row for row in active if row['source_id']!=source_id])
    # References to binaries in preserved HTTP receipts are remapped inside quarantine.
    for path in target.rglob('*.json'):
        if path.name=='quarantine_event.json': continue
        try:
            data=json.loads(path.read_text()); updated=remap(data)
            if updated!=data: path.write_text(json.dumps(updated,ensure_ascii=False,indent=2)+'\n')
        except (ValueError,UnicodeDecodeError): pass
    sources=read_jsonl(root/'normalized/sources.jsonl')
    for row in sources:
        if row['source_id']==source_id:
            row.update(status='quarantined',rights_status='needs_review',content_status='quarantined',quarantine_reason=reason)
    write_jsonl(root/'normalized/sources.jsonl',sources)
    # Remove stale source rows immediately; root rebuilds from remaining envelopes next.
    for table in ('entities','documents','chunks','media','media_segments','links'):
        path=root/'normalized'/(table+'.jsonl')
        write_jsonl(path,[row for row in read_jsonl(path) if row.get('source_id')!=source_id and source_id not in row.get('source_ids',[])])
    if (root/'indexes').exists(): shutil.rmtree(root/'indexes')
    seen=set(); unique_bytes=0; retained_files=0
    for path in target.rglob('*'):
        if path.is_file():
            stat=path.stat(); inode=(stat.st_dev,stat.st_ino)
            retained_files+=1
            if inode not in seen: unique_bytes+=stat.st_size;seen.add(inode)
    event={'source_id':source_id,'stage':'policy_quarantine','quarantined_at':now,'reason':reason,
           'records_quarantined':len(removed),'total_quarantined_records':len({row['id'] for row in quarantined}),
           'shared_assets_copied':copied_shared_assets,'files_moved':moved_files,'retained_files':retained_files,'unique_inode_bytes_before_event':unique_bytes,
           'quarantine_path':str(target),'path_mappings':[{'from':old,'to':new} for old,new in mappings],
           'binary_policy':'Retained solely as incident evidence; excluded from normalized data, retrieval and publication.'}
    (target/'quarantine_event.json').write_text(json.dumps(event,ensure_ascii=False,indent=2)+'\n')
    append_jsonl(root/'manifests/quarantines.jsonl',event)
    return event
