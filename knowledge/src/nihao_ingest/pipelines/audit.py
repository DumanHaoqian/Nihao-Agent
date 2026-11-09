"""Schema and referential checks; reproducible rights/attribution outputs."""
from __future__ import annotations
import csv
import json
from pathlib import Path
from nihao_ingest.core import read_jsonl
from nihao_ingest.schemas import validate_record
from .normalize import TABLES, estimated_tokens
from .integrity import file_sha256,text_sha256

def audit(root):
    root=Path(root); norm=root/'normalized'; report=root.parent/'reports'; report.mkdir(parents=True,exist_ok=True)
    tables={name:read_jsonl(norm/(name+'.jsonl')) for name in ('sources',)+TABLES}
    issues=[]; known=set(); all_rows=[]; file_receipts={}
    def check_file(path,expected,table,record_id):
        path=Path(path)
        if not path.is_file():
            issues.append({'table':table,'id':record_id,'reason':'file missing: '+str(path)});return
        key=str(path.resolve())
        if key not in file_receipts:
            file_receipts[key]={'path':key,'bytes':path.stat().st_size,'sha256':file_sha256(path)}
        actual=file_receipts[key]['sha256']
        if not expected or expected!=actual:
            issues.append({'table':table,'id':record_id,'reason':'SHA256 missing or mismatch: '+key})
    for table,records in tables.items():
        seen=set()
        for row in records:
            known.add(row.get('id')); all_rows.append(row)
            try: validate_record(table,row)
            except Exception as exc: issues.append({'table':table,'id':row.get('id'),'reason':str(exc).split('\n')[0]})
            if row.get('id') in seen: issues.append({'table':table,'id':row.get('id'),'reason':'duplicate id'})
            seen.add(row.get('id'))
            if row.get('raw_path'):
                check_file(row['raw_path'],row.get('raw_sha256'),table,row.get('id'))
    docs={r['document_id']:r for r in tables['documents']}; media={r['asset_id']:r for r in tables['media']}
    for row in tables['chunks']:
        if row.get('sha256')!=text_sha256(row['text']): issues.append({'table':'chunks','id':row['id'],'reason':'Chunk text SHA256 mismatch'})
        if row.get('estimated_tokens')!=estimated_tokens(row['text']): issues.append({'table':'chunks','id':row['id'],'reason':'Chunk token estimate mismatch'})
        doc=docs.get(row['document_id'])
        if not doc or doc['text'][row['char_start']:row['char_end']]!=row['text']:
            issues.append({'table':'chunks','id':row['id'],'reason':'chunk offsets do not reproduce source document text'})
        if row['rights_status']!='approved': issues.append({'table':'chunks','id':row['id'],'reason':'non-approved text in chunk table'})
    for row in tables['documents']:
        if row.get('sha256')!=text_sha256(row['text']): issues.append({'table':'documents','id':row['id'],'reason':'Document text SHA256 mismatch'})
        if row['rights_status']=='metadata_only' and row['text']:
            issues.append({'table':'documents','id':row['id'],'reason':'metadata-only source contains body text'})
    for row in tables['media']:
        check_file(row['path'],row.get('sha256'),'media',row['id'])
        if row.get('thumbnail_path'): check_file(row['thumbnail_path'],row.get('thumbnail_sha256'),'thumbnails',row['id'])
        if row['rights_status']!='approved': issues.append({'table':'media','id':row['id'],'reason':'non-approved media in display table'})
        if not Path(row['path']).is_file(): issues.append({'table':'media','id':row['id'],'reason':'asset file missing'})
        if not row.get('license_url') or (row['license'].startswith('CC-BY') and not row.get('author')):
            issues.append({'table':'media','id':row['id'],'reason':'required per-file license URL or author missing'})
    for row in tables['media_segments']:
        asset=media.get(row['asset_id']); duration=asset.get('duration_seconds') if asset else None
        if not duration or not 0<=row['start_seconds']<row['end_seconds']<=duration:
            issues.append({'table':'media_segments','id':row['id'],'reason':'timestamp outside original video duration'})
        for key in row['keyframe_asset_ids']:
            if key not in media: issues.append({'table':'media_segments','id':row['id'],'reason':'missing keyframe asset'})
        for timestamp in row.get('keyframe_timestamps',[]):
            if not row['start_seconds']<=timestamp<=row['end_seconds']:
                issues.append({'table':'media_segments','id':row['id'],'reason':'keyframe timestamp outside segment'})
    for row in tables['links']:
        if row['from_id'] not in known or row['to_id'] not in known:
            issues.append({'table':'links','id':row['id'],'reason':'dangling link endpoint'})
    columns=['record_id','source_id','license','rights_status','source_url','author','license_url','attribution','licensing_evidence']
    with (report/'license_audit.csv').open('w',newline='') as file:
        writer=csv.DictWriter(file,fieldnames=columns);writer.writeheader()
        for table in ('sources','documents','media'):
            for row in tables[table]: writer.writerow({key:row.get('id','') if key=='record_id' else json.dumps(row.get(key),ensure_ascii=False) if key=='licensing_evidence' and row.get(key) else row.get(key,'') for key in columns})
    lines=['# Attribution and reuse','',
           'Licenses remain source-specific. Structured facts, ODbL databases and ShareAlike texts/media must not be relabeled as CC0.',
           'Media thumbnails/keyframes are transformations of their attributed original files. Generated captions/OCR/transcripts remain pending unless separately recorded.','']
    for row in tables['media']:
        lines += [f"- `{row['asset_id']}` — {row['author']}. {row['attribution']}. [{row['license']}]({row['license_url']}); [original file page]({row['file_page_url']})."+
                  (' Adapted: '+row['transformation']+'.' if row.get('transformation') else ' Original preserved; thumbnail may be resized.')]
        evidence=row.get('licensing_evidence')
        if evidence:
            lines.append(f"  License basis: {evidence.get('method','documented per-file grant')}; [preserved declaration source]({evidence.get('evidence_url',row['file_page_url'])}). The declaration and permission links are retained in the media record.")
    for row in tables['documents']:
        if row.get('sha256')!=text_sha256(row['text']): issues.append({'table':'documents','id':row['id'],'reason':'Document text SHA256 mismatch'})
        if row['rights_status']!='approved': continue
        url=row.get('attribution_url') or row['source_url']
        line=f"- `{row['document_id']}` — [{row['title']}]({url}), {row['source_id']}, {row['license']}. Revision/retrieval: {row['revision_or_retrieved_at']}."
        if row.get('attribution'): line+=' Attribution: '+row['attribution']+'.'
        if row.get('license_url'): line+=f" [License]({row['license_url']})."
        if row.get('revision_url'): line+=f" [Specific revision]({row['revision_url']})."
        if row.get('history_url'): line+=f" [Contributor history]({row['history_url']})."
        if row.get('adaptation_notice'): line+=' '+row['adaptation_notice']
        lines.append(line)
    (root.parent/'ATTRIBUTION.md').write_text('\n'.join(lines)+'\n')
    for table in tables:
        path=norm/(table+'.jsonl')
        if path.is_file():
            file_receipts[str(path.resolve())]={'path':str(path.resolve()),'bytes':path.stat().st_size,'sha256':file_sha256(path)}
    (report/'file_integrity.json').write_text(json.dumps(list(file_receipts.values()),ensure_ascii=False,indent=2)+'\n')
    result={'passed':not issues,'issues':issues,'counts':{name:len(items) for name,items in tables.items()},
            'checksum_policy':'SHA256 computed and verified for active raw artifacts, normalized text, media, derivatives and normalized JSONL files, per current user authorization.',
            'files_sha256_checked':len(file_receipts),'text_records_sha256_checked':len(tables['documents'])+len(tables['chunks']),
            'unique_original_media_sha256':len({row.get('sha256') for row in tables['media'] if not row.get('derived_from')}),
            'substantive_chunks':sum(row.get('is_substantive_chunk',False) for row in tables['chunks'])}
    (report/'audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    return result
