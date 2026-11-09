"""Live artifact acceptance, separate from mock/unit correctness tests.

This gate inspects current artifacts and recorded download receipts. It does not
turn synthetic fixtures into live coverage or infer facts from a picture. SHA256
is enabled here by the user's later explicit instruction to restore integrity
checks for this Pilot. Missing download evidence fails closed.
"""
from __future__ import annotations
import hashlib
import json
import math
import re
from collections import Counter
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse
from PIL import Image
from .core import read_jsonl, utcnow
from .retrieval import approved, query
from .connectors.commons import license_gate

DEFAULT_THRESHOLDS = {'substantive_chunks':100, 'licensed_original_images':20, 'retrievable_entities':10, 'entity_text_image_chains':5}


def estimated_tokens(text):
    return math.ceil(len(re.findall(r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]',text)) + 1.3*len(re.findall(r"[A-Za-z0-9]+(?:[’'-][A-Za-z0-9]+)*",text)))


def substantive(text):
    return len(re.sub(r'\s+','',text))>=240 and estimated_tokens(text)>=250


def _real_url(url):
    try:
        parsed=urlparse(url or '');host=(parsed.hostname or '').lower()
        return parsed.scheme in {'https','http'} and bool(host) and not any(host==bad or host.endswith('.'+bad) for bad in ('example.org','example.com','example.net','invalid','test','localhost')) and not re.fullmatch(r'[\d.]+',host)
    except ValueError:
        return False


def _fixture(row):
    return any(row.get(k) for k in ('is_fixture','synthetic','is_synthetic','is_mock','is_test')) or row.get('record_origin') in {'fixture','mock','synthetic','test'} or bool(re.search(r'(^|[_-])(fixture|mock|test)([_-]|$)',str(row.get('source_id','')),re.I))


def _digest(path):
    digest=hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):
            digest.update(block)
    return digest.hexdigest()


def bilingual_examples(root, entity_ids=None, max_entities=None):
    """Expected IDs and names come from the actual normalized entities.

    Chinese names are never invented or translated by the evaluator. An absent
    Chinese source label is reported as absent, even if an English query works.
    """
    root=Path(root);allowed=set(entity_ids) if entity_ids is not None else None
    examples=[];retrieved=set();pairs=set()
    for entity in read_jsonl(root/'normalized/entities.jsonl'):
        eid=entity.get('entity_id')
        if allowed is not None and eid not in allowed:continue
        if _fixture(entity) or not approved(entity):continue
        names={'en':entity.get('name_en'),'zh':entity.get('name_zh')}
        if not names['zh']:
            names['zh']=next((a for a in entity.get('aliases',[]) if isinstance(a,str) and re.search(r'[\u3400-\u9fff]',a)),None)
        success=[]
        for language,name in names.items():
            if not name:continue
            question=f'What is {name}?' if language=='en' else f'请介绍{name}。'
            answer=query(root,question,limit=20)
            matched=[r for r in answer['results'] if r.get('entity_id')==eid]
            citations=[c for c in answer['citations'] if c.get('id') in {r.get('chunk_id') for r in matched}]
            passed=bool(matched and citations and all(_real_url(c.get('source_url')) and c.get('license') for c in citations))
            same_language=bool(matched and str(matched[0].get('language','')).lower().startswith(language))
            if passed:retrieved.add(eid)
            if passed and same_language:success.append(language)
            examples.append({'question':question,'query_language':language,'expected_entity_id':eid,'entity_name_from_source':name,'status':answer['status'],'expected_entity_retrieved':passed,'chunk_ids':[r['chunk_id'] for r in matched],'citations':citations,'excerpt':matched[0]['text'][:700] if matched else None,'excerpt_chunk_id':matched[0]['chunk_id'] if matched else None,'excerpt_language':matched[0].get('language') if matched else None,'same_language_evidence':same_language,'overview_ranked_first':bool(matched and matched[0].get('overview_match')),'answer_type':'source_excerpt_not_generated_answer'})
        if set(success)=={'en','zh'}:pairs.add(eid)
        if max_entities is not None and len({e['expected_entity_id'] for e in examples})>=max_entities:break
    return {'examples':examples,'retrieved_entity_ids':sorted(retrieved),'bilingual_entity_ids':sorted(pairs),'note':'Queries are constructed from actual source labels and checked against explicit IDs. These examples use the public query ranking unchanged. Bilingual pairs require retrieved excerpts in the corresponding query language. They verify retrieval, not answer completeness or nationwide coverage.'}



def media_license_reason(row, envelope):
    """Revalidate supported licenses; PD-author requires the actual source grant.

    A public-domain label or arbitrary file-page URL is insufficient. For the
    specific PD-author route, reparse the integrity-checked original HTML and
    compare its explicit declaration, author, source URL and original file URL.
    """
    ext={k:{'value':v} for k,v in {'LicenseShortName':row.get('license',''),'LicenseUrl':row.get('license_url',''),'Artist':row.get('author',''),'Restrictions':row.get('restrictions','')}.items()}
    _licensed,_url,reason=license_gate(ext)
    if not reason:return None
    if row.get('license')!='Public-domain' or row.get('restrictions') or not envelope:
        return reason
    evidence=row.get('licensing_evidence') or envelope.get('licensing_evidence') or envelope.get('payload',{}).get('licensing_evidence')
    if not isinstance(evidence,dict) or evidence.get('method')!='explicit per-file PD-author release':
        return 'Public-domain asset lacks explicit per-file PD-author evidence'
    url=row.get('file_page_url','');parsed=urlparse(url)
    if parsed.scheme!='https' or parsed.hostname!='commons.wikimedia.org' or not parsed.path.startswith('/wiki/File:'):
        return 'PD-author evidence must reference its canonical Commons file page'
    try:
        from bs4 import BeautifulSoup
        from .connectors.commons import file_html_metadata
        raw=Path(envelope['raw_path']).read_text()
        page,license,license_url,_revision=file_html_metadata(BeautifulSoup(raw,'html.parser'),raw,url)
        original=page['imageinfo'][0]
        author=BeautifulSoup(original['extmetadata']['Artist']['value'],'html.parser').get_text(' ',strip=True)
        actual=page.get('licensing_evidence')
        if license!='Public-domain' or not actual or actual.get('method')!='explicit per-file PD-author release':
            return 'Raw source does not establish the asserted PD-author grant'
        if evidence.get('declaration')!=actual.get('declaration') or evidence.get('evidence_url')!=actual.get('evidence_url'):
            return 'Stored public-domain declaration differs from raw source'
        if author!=row.get('author') or license_url!=row.get('license_url') or original['url']!=row.get('original_url'):
            return 'PD-author identity, license URL or original file URL differs from raw source'
    except (OSError,ValueError,TypeError,KeyError) as exc:
        return 'PD-author raw source review failed: '+str(exc)
    return None


def accept(root, *, thresholds=None, report_path=None):
    root=Path(root).resolve();thresholds=DEFAULT_THRESHOLDS|dict(thresholds or {})
    norm=root/'normalized';records=read_jsonl(root/'manifests/records.jsonl')
    envelopes={r['id']:r for r in records if r.get('id')};sources={r['source_id']:r for r in read_jsonl(norm/'sources.jsonl')}
    docs={r['document_id']:r for r in read_jsonl(norm/'documents.jsonl')};entities={r['entity_id']:r for r in read_jsonl(norm/'entities.jsonl')}
    media=read_jsonl(norm/'media.jsonl');segments=read_jsonl(norm/'media_segments.jsonl');links=read_jsonl(norm/'links.jsonl')
    rejected=[];digest_cache={};provenance_cache={}
    def reject(table,row,reason):rejected.append({'table':table,'id':row.get('id'),'source_id':row.get('source_id'),'reason':reason})
    def digest(path):
        path=Path(path).resolve();stat=path.stat();key=(str(path),stat.st_size,stat.st_mtime_ns)
        if key not in digest_cache:digest_cache[key]=_digest(path)
        return digest_cache[key]
    def provenance(row):
        sid=row.get('source_id')
        if _fixture(row):return 'fixture/mock/synthetic record excluded'
        if not approved(row):return 'record is not approved active content'
        if not _real_url(row.get('source_url')):return 'missing real public source URL'
        source=sources.get(sid)
        if not source:return 'source absent from normalized registry'
        if source.get('status') in {'blocked','review','withdrawn','quarantined'} or source.get('rights_status')=='withdrawn':return 'source is blocked, unreviewed, withdrawn or quarantined'
        envelope=envelopes.get(row.get('source_record_id'))
        if envelope is None:
            matches=[r for r in records if r.get('source_id')==sid and r.get('source_url')==row.get('source_url')]
            envelope=matches[0] if len(matches)==1 else None
        if not envelope:return 'cannot trace normalized row to one active raw envelope'
        if _fixture(envelope) or not approved(envelope):return 'raw envelope is synthetic or not approved'
        key=envelope['id']
        if key in provenance_cache:return provenance_cache[key]
        try:
            path=Path(envelope.get('raw_path') or '').resolve()
            if not path.is_relative_to(root/'raw') or not path.is_file():raise ValueError('raw file missing or outside active raw storage')
            receipt_path=path.with_suffix('.metadata.json')
            if not receipt_path.is_file():raise ValueError('download HTTP metadata receipt absent')
            receipt=json.loads(receipt_path.read_text())
            if receipt.get('status') not in (200,206) or not _real_url(receipt.get('url')):raise ValueError('receipt is not a successful public HTTP download')
            if receipt.get('bytes')!=path.stat().st_size:raise ValueError('receipt byte length mismatch')
            if not re.fullmatch(r'[0-9a-f]{64}',str(receipt.get('sha256',''))) or digest(path)!=receipt['sha256']:raise ValueError('raw SHA256 missing or mismatched')
            expected=envelope.get('raw_sha256') or envelope.get('sha256')
            if expected and expected!=receipt['sha256']:raise ValueError('envelope raw SHA256 differs from receipt')
            reason=None
        except (OSError,ValueError,TypeError) as exc:reason=str(exc)
        provenance_cache[key]=reason
        return reason
    eligible_chunks=[];substantive_chunks=[];seen_content=set()
    for row in read_jsonl(norm/'chunks.jsonl'):
        doc=docs.get(row.get('document_id'));reason=provenance(doc) if doc else 'parent document absent'
        if reason:reject('chunks',row,reason);continue
        if not approved(row) or _fixture(row):reject('chunks',row,'chunk not approved or synthetic');continue
        if doc.get('sha256')!=hashlib.sha256(doc.get('text','').encode()).hexdigest() or row.get('sha256')!=hashlib.sha256(row.get('text','').encode()).hexdigest():reject('chunks',row,'normalized document/chunk SHA256 mismatch');continue
        text=row.get('text','');start=row.get('char_start');end=row.get('char_end')
        if not isinstance(start,int) or not isinstance(end,int) or not 0<=start<end<=len(doc.get('text','')) or doc['text'][start:end]!=text:reject('chunks',row,'chunk offsets do not reproduce raw-derived document');continue
        if not text.strip():reject('chunks',row,'empty text');continue
        eligible_chunks.append(row)
        content_key=hashlib.sha256(re.sub(r'\s+',' ',text).strip().encode()).hexdigest()
        if not substantive(text) or row.get('is_substantive_chunk') is False:reject('chunks',row,'short fact/snippet below substantive 250-token floor');continue
        if content_key in seen_content:reject('chunks',row,'duplicate normalized chunk text');continue
        seen_content.add(content_key);substantive_chunks.append(row)
    valid_images=[];valid_videos=[];seen_media=set()
    for row in media:
        if row.get('derived_from'):continue
        reason=provenance(row)
        if reason:reject('media',row,reason);continue
        reason=media_license_reason(row,envelopes.get(row.get('source_record_id')))
        if reason:reject('media',row,reason);continue
        try:
            path=Path(row.get('path','')).resolve()
            if not path.is_relative_to(root/'assets') or not path.is_file():raise ValueError('original asset missing or outside active asset storage')
            actual=digest(path)
            if not re.fullmatch(r'[0-9a-f]{64}',str(row.get('sha256',''))) or actual!=row['sha256']:raise ValueError('asset SHA256 missing or mismatched')
            if actual in seen_media:raise ValueError('duplicate original binary content')
            if row.get('modality')=='image':
                with Image.open(path) as image:
                    image.verify()
                with Image.open(path) as image:
                    if min(image.size)<64:raise ValueError('tiny icon/thumbnail does not qualify as pilot original image')
                valid_images.append(row);seen_media.add(actual)
            elif row.get('modality')=='video':
                from .pipelines.media_process import probe_video
                duration=probe_video(path)['duration_seconds']
                good=[s for s in segments if s.get('asset_id')==row['asset_id'] and approved(s) and 0<=s.get('start_seconds',-1)<s.get('end_seconds',-1)<=duration and s.get('keyframe_asset_ids')]
                if not good:raise ValueError('video has no valid timestamped keyframe segments')
                valid_videos.append(row|{'validated_duration_seconds':duration,'validated_segment_ids':[s['segment_id'] for s in good]});seen_media.add(actual)
        except (OSError,ValueError,TypeError,RuntimeError) as exc:reject('media',row,str(exc))
    eligible_entity_ids={r.get('entity_id') for r in eligible_chunks if r.get('entity_id') in entities}
    examples=bilingual_examples(root,eligible_entity_ids)
    retrieved=set(examples['retrieved_entity_ids'])
    linked={}
    for edge in links:
        if edge.get('confidence',0)>=.9 and edge.get('evidence') and approved(edge):linked.setdefault((edge.get('from_id'),edge.get('relation')),set()).add(edge.get('to_id'))
    chains=[]
    for eid in sorted(retrieved):
        described=linked.get((eid,'described_by'),set())
        chunks=[c for c in eligible_chunks if c.get('entity_id')==eid and (c['chunk_id'] in described or c['document_id'] in described)]
        photos=[m for m in valid_images if m.get('entity_id')==eid and m.get('qid_evidence') and m['asset_id'] in linked.get((eid,'depicted_by'),set())]
        if chunks and photos:
            chunk=max(chunks,key=lambda c:len(c['text']));photo=photos[0]
            chains.append({'entity_id':eid,'chunk_id':chunk['chunk_id'],'document_id':chunk['document_id'],'asset_id':photo['asset_id'],'text_source_url':chunk['source_url'],'image_source_url':photo['file_page_url'],'image_path':photo['path'],'sha256':photo['sha256'],'link_evidence':[l for l in links if l.get('from_id')==eid and l.get('to_id') in {chunk['chunk_id'],chunk['document_id'],photo['asset_id']}]})
    tri_modal=[]
    media_by_id={m['asset_id']:m for m in media}
    for chain in chains:
        eid=chain['entity_id'];video_edges=linked.get((eid,'appears_in_video'),set())
        for video in valid_videos:
            if video.get('entity_id')!=eid or video['asset_id'] not in video_edges or not video.get('qid_evidence'):continue
            video_segments=[s for s in segments if s.get('asset_id')==video['asset_id'] and s.get('segment_id') in video.get('validated_segment_ids',[])]
            frames=[fid for segment in video_segments for fid in segment.get('keyframe_asset_ids',[]) if fid in media_by_id and Path(media_by_id[fid].get('path','')).is_file()]
            if not video_segments or not frames:continue
            tri_modal.append(chain|{'video_asset_id':video['asset_id'],'video_source_url':video['file_page_url'],'video_sha256':video['sha256'],'duration_seconds':video['validated_duration_seconds'],'segment_ids':[s['segment_id'] for s in video_segments],'keyframe_asset_ids':frames,'video_link_evidence':[edge for edge in links if edge.get('from_id')==eid and edge.get('relation')=='appears_in_video' and edge.get('to_id')==video['asset_id']]})
    attempts=[]
    validation_path=root/'manifests/source_validation.json'
    validation=json.loads(validation_path.read_text()) if validation_path.is_file() else []
    if isinstance(validation,dict):validation=validation.get('sources',[])
    campaign_cutoffs={r['source_id']:r.get('checked_at') for r in validation if 'video' in r.get('source_id','') and r.get('checked_at')}
    def current_event(event):
        cutoff=campaign_cutoffs.get(event.get('source_id'))
        try:
            return bool(cutoff and event.get('timestamp') and datetime.fromisoformat(event['timestamp'].replace('Z','+00:00'))>=datetime.fromisoformat(cutoff.replace('Z','+00:00')))
        except (TypeError,ValueError):return False
    current_events=[]
    for path in sorted((root/'manifests/runs').glob('*.jsonl')):
        current_events += [r for r in read_jsonl(path) if current_event(r) and r.get('status') in {'discovered','eligible','downloaded','skipped','failed'}]
    # A former campaign's robots-only skip or an unattempted cap skip cannot
    # satisfy this campaign. Require a current candidate/transfer/failure event.
    attempted_sources={r['source_id'] for r in current_events if r['status']=='failed' and r.get('reason') or r['status'] in {'discovered','eligible'} and (r.get('title') or r.get('url')) or r['status']=='downloaded' and (r.get('bytes') or r.get('record_id'))}
    attempts=[r for r in current_events if r.get('source_id') in attempted_sources]
    counts={'substantive_chunks':len(substantive_chunks),'licensed_original_images':len(valid_images),'retrievable_entities':len(retrieved),'entity_text_image_chains':len(chains)}
    checks={key:{'required':minimum,'actual':counts[key],'passed':counts[key]>=minimum} for key,minimum in thresholds.items()}
    checks['bilingual_retrieval_examples']={'required':1,'actual':len(examples['bilingual_entity_ids']),'passed':bool(examples['bilingual_entity_ids'])}
    video_attempt_ok=bool(valid_videos and attempts) or any(r.get('status') in {'failed','skipped'} and r.get('reason') for r in attempts)
    checks['video_attempt_recorded']={'required':1,'actual':len(attempts),'passed':video_attempt_ok}
    result={'executed_at':utcnow(),'evaluation_kind':'live_artifact_acceptance_not_unit_tests','passed':all(c['passed'] for c in checks.values()),'checks':checks,'counts':counts,'eligible_text_chunks_including_short_facts':len(eligible_chunks),'valid_video_samples':len(valid_videos),'video_sample_ids':[v['asset_id'] for v in valid_videos],'video_attempts':attempts,'video_campaign_validation_cutoffs':campaign_cutoffs,'entity_text_image_chains':chains,'tri_modal_entity_chains':tri_modal,'retrieval_examples':examples,'rejected_records':rejected,'rejection_reasons':dict(Counter(r['reason'] for r in rejected)),'integrity_policy':'SHA256 restored by explicit user instruction for current Pilot; raw receipt and original asset digests checked.','limitations':['Record/download receipts are local provenance evidence, not independent proof of website authorship.','Entity retrieval and cited excerpts do not establish complete answers or nationwide coverage.','Short facts, duplicate chunks, derived images, metadata-only and quarantined records do not satisfy substantive data thresholds.']}
    destination=Path(report_path) if report_path else root.parent/'reports/pilot_acceptance.json'
    destination.parent.mkdir(parents=True,exist_ok=True);destination.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    return result
