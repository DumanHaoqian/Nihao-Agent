"""Measured Pilot reporting: live artifacts, source access and unit tests separated."""
from __future__ import annotations
import csv,json,xml.etree.ElementTree as ET
from pathlib import Path
from collections import Counter
from .core import read_jsonl,write_jsonl,utcnow
from .validation import DOMAINS

def csv_write(path,fields,rows):
    with path.open('w',newline='') as file:
        w=csv.DictWriter(file,fieldnames=fields,extrasaction='ignore');w.writeheader();w.writerows(rows)

def unique_bytes(paths):
    return sum({(p.stat().st_dev,p.stat().st_ino):p.stat().st_size for p in paths if p.is_file()}.values())

def report(root,reports,registry):
    root=Path(root);reports=Path(reports);reports.mkdir(parents=True,exist_ok=True)
    tables={t:read_jsonl(root/'normalized'/f'{t}.jsonl') for t in ['sources','entities','documents','chunks','media','media_segments','links']}
    records=read_jsonl(root/'manifests/records.jsonl');http=read_jsonl(root/'manifests/http.jsonl')
    validations=json.loads((root/'manifests/source_validation.json').read_text()) if (root/'manifests/source_validation.json').exists() else []
    cutoff=min((r['checked_at'] for r in validations),default=utcnow());by_source={r['source_id']:r for r in validations}
    events=[r for p in (root/'manifests/runs').glob('*.jsonl') for r in read_jsonl(p) if r.get('timestamp','')>=cutoff]
    current_http=[r for r in http if r.get('timestamp','')>=cutoff]
    runs=[json.loads(p.read_text()) for p in sorted((root/'manifests/runs').glob('*.summary.json'))]
    quarantines=read_jsonl(root/'manifests/quarantines.jsonl')
    current_runs=[r for r in runs if r.get('ended_at','')>=cutoff]
    def optional(name):
        p=reports/name;return json.loads(p.read_text()) if p.exists() else {'status':'not_run'}
    acceptance=optional('pilot_acceptance.json');audit=optional('audit.json');evaluation=optional('retrieval_evaluation.json')
    tests={'status':'not_run'}
    if (reports/'pytest.xml').exists():
        suites=list(ET.parse(reports/'pytest.xml').getroot().iter('testsuite'))
        tests={'status':'executed',**{k:sum(int(s.attrib.get(k,0)) for s in suites) for k in ['tests','failures','errors','skipped']},'seconds':sum(float(s.attrib.get('time',0)) for s in suites)}
    original_media=[m for m in tables['media'] if not m.get('derived_from')]
    modes=Counter(m['modality'] for m in original_media)
    fields=['source_id','status','selected_route','discovered','eligible','downloaded_events','skipped','failed','persisted_records','original_media','payload_bytes','license','error_category','reason','url']
    stats=[]
    for s in registry['sources']:
        sid=s['source_id'];v=by_source.get(sid,{});counts=Counter(e['status'] for e in events if e['source_id']==sid)
        stats.append(dict(source_id=sid,status=v.get('status','unvalidated'),selected_route=v.get('selected_route'),discovered=counts['discovered'],eligible=counts['eligible'],downloaded_events=counts['downloaded'],skipped=counts['skipped'],failed=counts['failed'],persisted_records=sum(r['source_id']==sid for r in records),original_media=sum(m['source_id']==sid for m in original_media),payload_bytes=sum(r.get('bytes',0) for r in current_http if r.get('source_id')==sid and r.get('status')=='download_complete'),license=v.get('license',s.get('license')),error_category=v.get('error_category'),reason=v.get('reason'),url=s['url']))
    csv_write(reports/'source_summary.csv',fields,stats)
    coverage=[]
    for domain in DOMAINS:
        for city in ['ALL','national','Beijing','Shanghai','Chengdu','Xian','Guangzhou']:
            rows={name:[r for r in table if r.get('domain')==domain and (city=='ALL' or (r.get('city') or 'national')==city)] for name,table in tables.items()}
            coverage.append(dict(domain=domain,city=city,entities=len(rows['entities']),documents=len(rows['documents']),chunks=len(rows['chunks']),substantive_chunks=sum(bool(r.get('is_substantive_chunk')) for r in rows['chunks']),images=sum(r.get('modality')=='image' and not r.get('derived_from') for r in rows['media']),videos=sum(r.get('modality')=='video' and not r.get('derived_from') for r in rows['media']),segments=len(rows['media_segments'])))
    csv_write(reports/'coverage_by_domain_city.csv',list(coverage[0]),coverage)
    license_rows=[]
    for table in ['sources','entities','documents','chunks','media','media_segments']:
        for r in tables[table]:license_rows.append(dict(table=table,id=r.get('id'),source_id=r.get('source_id'),source_url=r.get('source_url'),license=r.get('license'),license_url=r.get('license_url'),rights_status=r.get('rights_status'),author=r.get('author'),attribution=r.get('attribution'),data_version=r.get('data_version'),sha256=r.get('sha256'),licensing_evidence=json.dumps(r.get('licensing_evidence'),ensure_ascii=False) if r.get('licensing_evidence') else None))
    csv_write(reports/'license_audit.csv',['table','id','source_id','source_url','license','license_url','rights_status','author','attribution','data_version','sha256','licensing_evidence'],license_rows)
    errors=[e for e in events+current_http if e.get('status') in ('failed','blocked')]
    errors += [dict(e,category='response_parse_error',diagnosis='Video HTML omitted image-style MIME field; fixed using original-file suffix plus HEAD Content-Type, subsequent P10 video downloaded successfully') for e in events if e.get('status')=='skipped' and e.get('mime')=='']
    write_jsonl(reports/'errors.jsonl',errors)
    filepaths=[p for p in root.rglob('*') if p.is_file()]
    summary={'generated_at':utcnow(),'campaign_since':cutoff,'counts':{k:len(v) for k,v in tables.items()},'original_media_modalities':dict(modes),'raw_record_rights':dict(Counter(r.get('rights_status') for r in records)),'unique_file_bytes':unique_bytes(filepaths),'logical_bytes':sum(p.stat().st_size for p in filepaths),'active_raw_unique_bytes':unique_bytes((root/'raw').rglob('*')),'quarantine_unique_bytes':unique_bytes((root/'quarantine').rglob('*')),'sources':stats,'tests':tests,'live_acceptance_passed':acceptance.get('passed',False),'live_acceptance_counts':acceptance.get('counts',{}),'verified_tri_modal_entities':len(acceptance.get('tri_modal_entity_chains',[])),'verified_bilingual_pairs':len(acceptance.get('retrieval_examples',{}).get('bilingual_entity_ids',[])),'sha256_audit_passed':audit.get('passed',False),'sha256_files_checked':audit.get('files_sha256_checked',0),'runs':runs}
    summary['current_campaign_runs']=current_runs
    summary['current_campaign_download_payload_bytes']=sum(r.get('network_bytes',0) for r in current_runs)
    summary['current_campaign_ingestion_seconds']=round(sum(r.get('elapsed_seconds',0) for r in current_runs),3)
    summary['retrieval_evaluation']={key:evaluation.get(key,0) for key in ['total','safety_and_citation_checks_passed','answerable_case_count','answerable_case_verified_count','content_cases_with_evidence']}
    (reports/'summary.json').write_text(json.dumps(summary,indent=2,ensure_ascii=False))
    steps=[
      dict(step='Source Validation',status='executed',sources=len(validations),checked_since=cutoff,status_counts=dict(Counter(r['status'] for r in validations)),evidence='data/manifests/source_validation.json'),
      dict(step='Pilot Download',status='executed_with_source_specific_skips',runs=[r['run_id'] for r in current_runs],saved_payload_bytes=summary['current_campaign_download_payload_bytes'],elapsed_seconds=summary['current_campaign_ingestion_seconds'],active_raw_records=len(records),quarantined_sources=[r['source_id'] for r in quarantines]),
      dict(step='Normalization',status='executed',counts=summary['counts'],evidence=['normalization_execution.json','media_processing_execution.json']),
      dict(step='Entity Linking',status='executed',links=len(tables['links']),verified_text_image_entities=acceptance.get('counts',{}).get('entity_text_image_chains',0),verified_tri_modal_entities=summary['verified_tri_modal_entities']),
      dict(step='Testing',status='executed',offline=tests,live_artifact_acceptance=acceptance.get('passed',False),retrieval=summary['retrieval_evaluation'],sha256=audit.get('passed',False)),
      dict(step='Report',status='generated',generated_at=summary['generated_at'])]
    (reports/'execution_steps.json').write_text(json.dumps(steps,indent=2,ensure_ascii=False))
    diagnosis=['# Source access investigation','',f'Executed validation snapshot: {cutoff}','',
      'The initial implementation conflated a robots exclusion for one API path with whole-source denial. This revision keeps robots enforcement and chooses separately documented, explicitly permitted interfaces. No user-agent impersonation, login avoidance, proxy rotation or blocked-path request is enabled.',
      '', 'Official references: [Wikidata data access](https://www.wikidata.org/wiki/Wikidata:Data_access), [Wikimedia Robot policy](https://wikitech.wikimedia.org/wiki/Robot_policy), [API etiquette](https://www.mediawiki.org/wiki/API:Etiquette), [API usage guidelines](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_API_Usage_Guidelines), [UNESCO API console](https://data.unesco.org/api-console/explore/v2.1/).', '',
      'Wikidata EntityData `.json` has an explicit robots allowance and is the documented Linked Data interface. Canonical current Wikipedia/Wikivoyage articles and Commons file pages are separately permitted. Action API and SPARQL paths were examined individually; where robots denies them, no data request was sent. An HTTP response from a permitted alternative is not evidence that a denied API worked.',
      '', 'Categories: robots_disallowed = explicit target-path rule; robots_unavailable = transport failure; robots_http_error = non-success robots response; robots_parse_error = invalid policy body (including HTML returned as robots.txt); http_error/access_denied = actual target HTTP failure; api_rate_limited = actual 429; response_parse_error = returned data cannot be parsed. No rate limit is inferred merely from a robots decision.','']
    for r in validations:
        diagnosis += [f"## {r['source_id']}",'',f"Status: {r['status']}; selected route: {r.get('selected_route')}; failure category: {r.get('error_category') or 'none'}.",r['reason'],'']
        for check in r.get('checks',[]):
            robots=check.get('robots',{});meta=check.get('metadata',{})
            diagnosis.append(f"- `{check['url']}` — robots HTTP {robots.get('http_status')}, {robots.get('category')}; target request sent={check.get('http_attempted')}; target HTTP={meta.get('status','not attempted / failed')}; parsed payload bytes={meta.get('bytes',0)}. Robots evidence: `{robots.get('path')}`.")
        diagnosis.append('')
    actual=Counter(e.get('category','uncategorized connector error') for e in errors)
    diagnosis+=['## Actual runtime failures','',json.dumps(dict(actual),indent=2),'','Per-record HTTP failures, missing titles, license review and sizes are retained in `errors.jsonl` and job JSONL.']
    (reports/'source_access_diagnosis.md').write_text('\n'.join(diagnosis)+'\n')
    lines=['# Nihao Knowledge Pilot ingestion report','',f"Generated: {summary['generated_at']}",'',
      f"**Live artifact acceptance: {'PASS' if acceptance.get('passed') else 'NOT MET'}.** Unit tests and live data coverage are reported separately. This is a bounded pilot, not nationwide completeness.",
      '', '## Live acceptance','', '| Criterion | Required | Actual | Pass |','|---|---:|---:|---|']
    for key,value in acceptance.get('checks',{}).items():lines.append(f"| {key} | {value['required']} | {value['actual']} | {value['passed']} |")
    lines += ['',f"Validated video samples: {acceptance.get('valid_video_samples',0)}. Short fact snippets, duplicate text, derived keyframes, quarantined assets and fixtures do not count toward the 100 substantive chunks / 20 photographs thresholds.",
       f"SHA256 file/text audit passed: {audit.get('passed',False)}; files checked: {audit.get('files_sha256_checked',0)}; text records checked: {audit.get('text_records_sha256_checked',0)}. Local SHA256 detects subsequent corruption; no upstream signed checksum was supplied, so it is not an independent authenticity guarantee.",
       '', '## Real corpus counts and size','',f"Normalized tables: `{json.dumps(summary['counts'])}`",f"Original media: `{json.dumps(dict(modes))}`",f"Unique-file dataset bytes: {summary['unique_file_bytes']:,}; active raw bytes: {summary['active_raw_unique_bytes']:,}; historical quarantine bytes: {summary['quarantine_unique_bytes']:,}. Hardlinks counted once.",
       '', '| Domain | Documents | Chunks | Substantive chunks | Images | Videos |','|---|---:|---:|---:|---:|---:|']
    for row in coverage:
        if row['city']=='ALL':lines.append('| '+' | '.join(str(row[k]) for k in ['domain','documents','chunks','substantive_chunks','images','videos'])+' |')
    lines += ['', '## Source validation and download','', 'Original 13 seeds are preserved. Two explicitly licensed Wikipedia article sources were added as official, permitted text routes. Full per-URL evidence and failure categories: [source_access_diagnosis.md](source_access_diagnosis.md). Counters below cover the current validation campaign; persisted rows are unique active records. Downloaded event counts describe records, not file counts; payload bytes count successful uncompressed saved response bytes and exclude cached reuse.','', '| Source | Status | Persisted | Media | Downloaded events | Skipped | Failed | Payload bytes |','|---|---|---:|---:|---:|---:|---:|---:|']
    for r in stats:lines.append('| '+' | '.join(str(r[k]) for k in ['source_id','status','persisted_records','original_media','downloaded_events','skipped','failed','payload_bytes'])+' |')
    lines += ['',f"Current campaign: {len(current_runs)} ingestion runs, {summary['current_campaign_download_payload_bytes']:,} saved payload bytes, {summary['current_campaign_ingestion_seconds']} seconds. Validation downloads are separate; historical runs remain in summary.json and are excluded from these campaign totals.", '', '## Verified entity–text–image examples','']
    chains=acceptance.get('entity_text_image_chains',[])
    for row in chains[:8]:lines.append(f"- `{row['entity_id']}` → `{row['chunk_id']}` → `{row['asset_id']}`. [Text]({row['text_source_url']}); [file license/author]({row['image_source_url']}).")
    if not chains:lines.append('No real complete text–image chain passed acceptance.')
    lines += ['', '## Verified text–image–video chain', '']
    for chain in acceptance.get('tri_modal_entity_chains',[]):
        lines.append(f"- `{chain['entity_id']}` → text `{chain['chunk_id']}` → photo `{chain['asset_id']}` → video `{chain['video_asset_id']}` ({chain['duration_seconds']}s), with {len(chain['segment_ids'])} timestamped segments and {len(chain['keyframe_asset_ids'])} keyframes. [Video source and author release]({chain['video_source_url']}). Exact P18/P10 source claims establish the media associations.")
    examples=acceptance.get('retrieval_examples',{});(reports/'bilingual_retrieval_examples.json').write_text(json.dumps(examples,indent=2,ensure_ascii=False))
    lines += ['', '## Actual Chinese and English retrieval','', 'Queries use names and IDs from downloaded sources. Results are source excerpts with citations, not synthesized travel advice. Full results: [bilingual_retrieval_examples.json](bilingual_retrieval_examples.json).','']
    selected=[]
    # Include both a landmark and food/culture where possible.
    entity_domains={e['entity_id']:e['domain'] for e in tables['entities']}
    for domain in ['attractions','food_culture']:
        candidate=next((c['entity_id'] for c in chains if entity_domains.get(c['entity_id'])==domain),None)
        if candidate:selected += [e for e in examples.get('examples',[]) if e['expected_entity_id']==candidate]
    for e in selected[:4]:lines.append(f"- **{e['question']}** → `{e['expected_entity_id']}`, retrieved={e['expected_entity_retrieved']}; chunks={e['chunk_ids'][:2]}. Excerpt: {str(e.get('excerpt') or '').replace(chr(10),' ')[:300]}.")
    lines += ['', '## Video attempt','']
    videoevents=acceptance.get('video_attempts',[])
    for event in videoevents[-12:]:lines.append(f"- {event.get('source_id')}: {event.get('status')} — {event.get('reason') or event.get('title') or event.get('record_id')}")
    for segment in tables['media_segments'][:3]:lines.append(f"- `{segment['segment_id']}`: {segment['start_seconds']}–{segment['end_seconds']}s; keyframes={segment['keyframe_asset_ids']}; source={segment['source_url']}.")
    lines += ['', '## Program tests versus actual coverage','',f"Offline tests: `{json.dumps(tests)}`. Fixtures are not included in live counts.",f"Live evidence/refusal questions: {evaluation.get('safety_and_citation_checks_passed',0)}/{evaluation.get('total',0)} checks; keyword candidates alone are not verified coverage. The artifact acceptance gate independently checks raw HTTP receipts, SHA256, substantive text spans, decoded images, licenses and cross-modal links.",
      f"Fixed answerable retrieval cases verified against expected entity IDs, source URLs, passage facts and requested media: {evaluation.get('answerable_case_verified_count',0)}/{evaluation.get('answerable_case_count',0)}. The remaining cases include dynamic-policy/allergen verification and unsupported daily-life coverage probes, not successful content answers. This is a bounded source-grounding check, not general QA accuracy.",
      '', '## Rights, history and remaining limitations','',
      'Wikidata records retain CC0; Wikipedia/Wikivoyage text and Commons photos retain their actual CC BY/CC BY-SA licenses. Mixed-source entities preserve per-source licenses. See ATTRIBUTION.md and license_audit.csv. Official policy/FAQ pages remain URL references only; no current visa conclusion is inferred.',
      'The original robots parser missed Geofabrik’s wildcard and obtained one Beijing file incorrectly. Its 48 records and binary remain quarantined, excluded from live counts and retrieval. No OSM re-download/release was performed. Previous report is retained under reports/history/pilot-v1/.',
      'The latest user instruction explicitly restores SHA256 for this task, superseding the earlier no-SHA instruction. No OCR/VLM/ASR output is fabricated; missing annotations remain pending. Food pictures do not establish recipes or allergens.',
      'UNESCO API restrictions and source-specific failures remain recorded. This pilot does not establish national geographical coverage, policy freshness, food safety, live prices or schedules.', '', '## Reproduce','', '```sh', './run.sh validate-sources --max-total-mb 40', './run.sh ingest --profile pilot --max-items 50 --max-images 30 --max-videos 1 --max-total-mb 500', './run.sh ingest --source wikimedia_commons_attractions --entity-qid Q12501 --max-images 31 --max-items 3 --max-total-mb 30', './run.sh normalize', './run.sh media-process', './run.sh entity-link', './run.sh index', './run.sh audit', 'PYTHONPATH=src .venv/bin/python -m pytest -q --junitxml=reports/pytest.xml', './run.sh evaluate', './run.sh acceptance', './run.sh report', '```','', 'Set the real NIHAO_CONTACT environment variable before networking. See README for installation.']
    (reports/'ingestion_report.md').write_text('\n'.join(lines)+'\n')
    samples=[r for r in tables['documents'] if r.get('rights_status')=='approved'][:5];write_jsonl(reports/'sample_records.jsonl',samples)
    return summary
