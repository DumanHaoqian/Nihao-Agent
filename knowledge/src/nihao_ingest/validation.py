from __future__ import annotations
import json
from pathlib import Path
from urllib.parse import urlencode
import yaml
from .core import utcnow, write_jsonl
from .http import FetchError
DOMAINS=['entry_visa','daily_life','attractions','food_culture','transportation']

def load_registry(path):
    data=yaml.safe_load(Path(path).read_text());sources=data.get('sources',[])
    ids=[s['source_id'] for s in sources]
    if len(ids)!=len(set(ids)):raise ValueError('duplicate source IDs')
    for s in sources:
        if not set(s['domains']).issubset(DOMAINS):raise ValueError('unknown domain')
        if not s['url'].startswith('https://'):raise ValueError('only HTTPS sources supported')
    return data

def validate_sources(registry,root,http,full_osm=False):
    root=Path(root);results=[]
    def check(r,url,*,json_data=False,method='GET',purpose='source_validation',max_bytes=5000000):
        policy=http.robots(url,r['source_id']);r['checks'].append(dict(url=url,robots=policy,http_attempted=False))
        if not policy['allowed']:raise FetchError(url+': '+policy['reason'],policy.get('category','robots_unavailable'),policy.get('http_status'))
        item=r['checks'][-1];item['http_attempted']=True
        try:
            if json_data:data,meta=http.json(url,r['source_id'],purpose=purpose,max_bytes=max_bytes)
            else:
                meta=http.fetch(url,r['source_id'],method=method,purpose=purpose,max_bytes=max_bytes)
                data=Path(meta['path']).read_text(errors='replace') if meta.get('path') else None
            item.update(status='success',metadata=meta);return data,meta
        except FetchError as e:item.update(status='failed',error_category=e.category,reason=str(e));raise
    def probe_restricted_api(r,url):
        p=http.robots(url,r['source_id'])
        r['checks'].append(dict(url=url,robots=p,http_attempted=False,status='not_requested',reason='API route considered; canonical/linked-data route chosen for this bounded pilot'))
    for s in registry['sources']:
        sid=s['source_id'];r=dict(s,status='review',checked_at=utcnow(),license_evidence_url=None,reason='',checks=[],error_category=None,api_http_result='not_requested')
        try:
            if s.get('requires_flag') and not full_osm:
                r.update(status='blocked',error_category='explicit_flag_required',reason='requires explicit --full-osm; no full-country file request')
            elif s['access_strategy']=='metadata_only':
                check(r,s['url'],method='HEAD');r.update(status='metadata_only',reason='Official reference only; no full-text/media republication license established')
            elif sid=='wikidata':
                probe_restricted_api(r,s['url'])
                probe_restricted_api(r,'https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q80290&format=json')
                license_url='https://www.wikidata.org/wiki/Wikidata:Licensing'
                body,_=check(r,license_url,purpose='license_validation')
                if 'creativecommons.org/publicdomain/zero' not in body:raise FetchError('CC0 evidence missing','license_unverified')
                url='https://www.wikidata.org/wiki/Special:EntityData/Q80290.json'
                data,_=check(r,url,json_data=True)
                if 'Q80290' not in data.get('entities',{}):raise FetchError('entity JSON schema missing','response_parse_error')
                r.update(status='eligible',selected_route='linked_data_json',license_evidence_url=license_url,reason='Official documented EntityData JSON route explicitly robots-allowed and HTTP/JSON verified; SPARQL/Action API not used')
            elif s.get('dataset_id'):
                check(r,s['url'],purpose='source_validation')
                url=f"https://data.unesco.org/api/explore/v2.1/catalog/datasets/{s['dataset_id']}"
                data,_=check(r,url,json_data=True)
                from .connectors.unesco import license_is_open
                if not license_is_open(data):raise FetchError('Dataset metadata does not establish CC BY-SA 4.0','license_unverified')
                if not data.get('fields'):raise FetchError('Dataset schema fields missing','response_parse_error')
                r.update(status='eligible',license_evidence_url=url,reason='Dataset schema+license verified',schema_fields=data['fields'])
            elif s['kind']=='osm_pbf':
                _,m=check(r,s['url'],method='HEAD');r.update(status='eligible',expected_bytes=m['content_length'],reason='Snapshot reachable; source-specific quarantine still applies')
            elif s['kind']=='commons_category':
                probe_restricted_api(r,s['api']+'?'+urlencode({'action':'query','format':'json','list':'categorymembers','cmtitle':s['category'],'cmlimit':1}))
                license_url='https://commons.wikimedia.org/wiki/Commons:Licensing'
                check(r,license_url,purpose='license_validation');check(r,s['url'])
                r.update(status='eligible',selected_route='canonical_html',license_evidence_url=license_url,reason='Canonical category/file HTML permitted; each actual file still requires author/license/URL review before binary download')
            elif s['kind'] in ('mediawiki_pages','wikipedia_pages'):
                probe_restricted_api(r,s['api']+'?action=query&format=json&meta=siteinfo&siprop=rightsinfo')
                body,_=check(r,s['url'])
                if 'creativecommons.org/licenses/by-sa/4.0' not in body:raise FetchError('Page CC BY-SA 4.0 attribution footer missing','license_unverified')
                r.update(status='eligible',selected_route='canonical_html',license='CC-BY-SA-4.0',license_evidence_url=s['url'],reason='Canonical current article HTML + license footer verified; preserve revision, history attribution and per-article entity IDs')
            else:raise FetchError('Unsupported connector kind','configuration_error')
        except Exception as e:r.update(status='metadata_only' if s['access_strategy']=='metadata_only' else 'blocked',reason=str(e),error_category=getattr(e,'category','code_or_parse_error'))
        results.append(r);print(f"{sid}: {r['status']} [{r.get('error_category') or 'ok'}] {r['reason']}",flush=True)
    out=root/'manifests/source_validation.json';out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(results,ensure_ascii=False,indent=2))
    history=root/'manifests/validation_runs'/f'{utcnow().replace(chr(58),chr(45))}.json';history.parent.mkdir(parents=True,exist_ok=True);history.write_text(out.read_text())
    queue=[dict(source_id=r['source_id'],url=r['url'],reason=r['reason'],error_category=r['error_category'],checked_at=r['checked_at'],rights_status='needs_review') for r in results if r['status']!='eligible']
    old_queue=[]
    from .core import read_jsonl
    for row in read_jsonl(root/'rights_review_queue.jsonl'):
        if row.get('url') not in {s['url'] for s in registry['sources']}:old_queue.append(row)
    write_jsonl(root/'rights_review_queue.jsonl',old_queue+queue)
    quarantined={q['source_id'] for q in read_jsonl(root/'manifests/quarantines.jsonl')}
    normalized=[]
    for r in results:
        normalized.append(dict(r,id=r['source_id'],entity_id=None,domain=r['domains'][0],scope='national',province=None,city=None,language='und',source_url=r['url'],fetched_at=r['checked_at'],last_verified_at=r['checked_at'],source_published_at=None,rights_status='needs_review' if r['source_id'] in quarantined else ('approved' if r['status']=='eligible' else 'metadata_only'),content_status='quarantined' if r['source_id'] in quarantined else 'source_registry',data_version=r['checked_at'],source_type=r['kind'],refresh_policy=r.get('refresh_policy','manual_snapshot')))
    write_jsonl(root/'normalized/sources.jsonl',normalized)
    return results
