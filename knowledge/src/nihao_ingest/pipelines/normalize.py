"""Offline, provenance-preserving transformations of downloaded source records."""
from __future__ import annotations
import html
import math
import json
import re
import shutil
from html.parser import HTMLParser
from pathlib import Path

from nihao_ingest.core import read_jsonl, write_jsonl, stable_id
from .integrity import file_sha256, text_sha256, verify_file

TABLES = ('entities', 'documents', 'chunks', 'media', 'media_segments', 'links')
COMMON = ('domain','scope','province','city','language','source_id','source_url','fetched_at',
          'source_published_at','last_verified_at','license','rights_status','data_version')
DOMAINS = ('entry_visa','daily_life','attractions','food_culture','transportation')

class PlainText(HTMLParser):
    def __init__(self):
        super().__init__(); self.parts=[]; self.hidden=0
    def handle_starttag(self, tag, attrs):
        if tag in ('script','style'): self.hidden += 1
        if tag in ('p','br','div','li','h1','h2','h3'): self.parts.append('\n')
    def handle_endtag(self, tag):
        if tag in ('script','style'): self.hidden=max(0,self.hidden-1)
        if tag in ('p','div','li','h1','h2','h3'): self.parts.append('\n')
    def handle_data(self, value):
        if not self.hidden: self.parts.append(value)

def plain(value):
    if value is None: return ''
    if isinstance(value, (dict,list)): return json.dumps(value, ensure_ascii=False)
    parser=PlainText(); parser.feed(str(value)); return html.unescape(''.join(parser.parts)).strip()

def common(row):
    item={k:row.get(k) for k in COMMON}
    item.update(domain=row.get('domain','attractions'), scope=row.get('scope','national'),
                language=row.get('language') or 'und', content_status='normalized',
                source_record_id=row.get('source_record_id') or row.get('id'), raw_path=row.get('raw_path'), raw_sha256=row.get('raw_sha256'),
                normalization_version='nihao-normalize-2.0',source_city=row.get('source_city') or row.get('city'))
    if item.get('city') in ("Xi'an",'Xi’an'): item['city']='Xian'
    if item['scope'] not in ('national','province','city','poi'): item['scope']='national'
    return item

def qid(value):
    return str(value) if re.fullmatch(r'Q[1-9]\d*',str(value)) else None

def claim_values(payload, prop):
    values=[]
    for claim in payload.get('claims',{}).get(prop,[]):
        if claim.get('rank') == 'deprecated': continue
        snak=claim.get('mainsnak',{})
        if snak.get('snaktype')=='value' and 'datavalue' in snak:
            values.append(snak['datavalue']['value'])
    return values

def lang_value(values, lang):
    v=values.get(lang,{})
    return v.get('value','') if isinstance(v,dict) else str(v)

def make_entity(row, entity_id, name_en='', name_zh='', **extra):
    return dict(common(row), id=entity_id, entity_id=entity_id, name_en=name_en, name_zh=name_zh,
                aliases=[], entity_type=row.get('domain','attractions'), latitude=None, longitude=None,
                qid=qid(row.get('qid')), osm_id=None, external_ids={}, source_ids=[row['source_id']], licenses=[row['license']],
                provenance=[{'source_id':row['source_id'],'source_url':row['source_url'],'license':row['license'],
                             'data_version':row['data_version'],'fetched_at':row['fetched_at'],'attribution':row.get('attribution',''),'license_url':row.get('license_url',''),'source_record_id':row.get('id'),'raw_path':row.get('raw_path'),'raw_sha256':row.get('raw_sha256')}]) | extra

def make_document(row, entity_id, title, text, **extra):
    document_id='document:'+stable_id(row['id'],'document')
    return dict(common(row), id=document_id, document_id=document_id, entity_id=entity_id,
                title=title, text=text, section=title, revision_or_retrieved_at=row.get('revision') or row['fetched_at'],
                char_start=0, char_end=len(text), is_time_sensitive=row['kind']=='official' or row['domain']=='entry_visa' or (row['kind']=='wikivoyage' and row['domain'] in ('daily_life','transportation')),
                valid_from=None, valid_until=None, attribution=row.get('attribution',''), license_url=row.get('license_url',''), source_kind=row['kind'],sha256=text_sha256(text),
                revision_url=row.get('revision_url'),license_evidence_url=row.get('license_evidence_url'),
                metadata_route=row.get('metadata_route')) | extra

def wikivoyage_text(text):
    """Parse markup while retaining headings and raw source in the manifest."""
    try:
        import mwparserfromhell
    except ImportError as exc:
        raise RuntimeError('mwparserfromhell unavailable; Wikivoyage normalization quarantined') from exc
    code=mwparserfromhell.parse(text)
    return ''.join(str(node) if isinstance(node,mwparserfromhell.nodes.Heading)
                   else mwparserfromhell.parse(str(node)).strip_code(normalize=True,collapse=False)
                   for node in code.nodes)

def section_domain(section, fallback='daily_life'):
    value=section.lower()
    if re.search(r'visa|entry conditions|immigration|passport|entry requirements',value): return 'entry_visa'
    if re.search(r'get in|get around|train|rail|bus|transport|flight|airport',value): return 'transportation'
    if re.search(r'eat|drink|cuisine|food|culture|festival',value): return 'food_culture'
    if re.search(r'\bsee\b|attraction|sight|museum|\bdo\b',value): return 'attractions'
    if re.search(r'connect|sleep|stay safe|cope|buy|payment|sim|health|money|emergenc',value): return 'daily_life'
    return fallback

def estimated_tokens(text):
    """Documented estimate, not a claim to a particular model tokenizer."""
    cjk=len(re.findall(r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]',text))
    latin=len(re.findall(r"[A-Za-z0-9]+(?:[’'-][A-Za-z0-9]+)*",text))
    return math.ceil(cjk+latin*1.3)

def chunk_spans(text, sensitive=False, target=450):
    """Chapter-aware approximate 300–600 token chunks with exact char offsets.

    Policy conditions remain intact. A naturally short section stays short and is
    explicitly excluded from the substantive-chunk acceptance count.
    """
    sections=[]; stack=[]; cursor=0; context=''
    for match in re.finditer(r'(?m)^(={2,6}|#{1,6}) ?([^\n]+)$',text):
        if match.start()>cursor: sections.append((cursor,match.start(),context))
        level=len(match[1]); label=match[2].strip('=# ')
        while stack and stack[-1][0]>=level: stack.pop()
        stack.append((level,label)); context=' / '.join(item[1] for item in stack);cursor=match.start()
    if cursor<len(text): sections.append((cursor,len(text),context))
    # Merge small neighbouring subsections of the same chapter/domain only.
    grouped=[]
    for begin,end,section in sections:
        if grouped:
            pb,pe,ps=grouped[-1]
            same_chapter=bool(ps and section and ps.split(' / ')[0]==section.split(' / ')[0])
            same_domain=section_domain(ps,'')==section_domain(section,'')
            if same_chapter and same_domain and estimated_tokens(text[pb:pe])<300 and estimated_tokens(text[pb:end])<=600:
                grouped[-1]=(pb,end,ps.split(' / ')[0]);continue
        grouped.append((begin,end,section))
    for begin,end,section in grouped:
        cursor=begin; preserve=sensitive or section_domain(section,'')=='entry_visa'
        while cursor<end:
            remaining=text[cursor:end]
            if preserve or estimated_tokens(remaining)<=600:
                stop=end
            else:
                low=cursor+1; high=end
                while low<high:
                    mid=(low+high)//2
                    if estimated_tokens(text[cursor:mid])<target: low=mid+1
                    else: high=mid
                desired=low
                # Prefer complete paragraphs/sentences close to the target.
                candidates=[cursor+m.end() for m in re.finditer(r'\n\s*\n|[.!?。！？](?:\s|$)',text[cursor:desired])]
                stop=next((c for c in reversed(candidates) if estimated_tokens(text[cursor:c])>=300),desired)
                if estimated_tokens(text[stop:end])<250:
                    # Rebalance two substantive pieces instead of producing a tiny tail.
                    total=estimated_tokens(remaining); target_half=min(600,max(300,total//2))
                    low=cursor+1; high=end
                    while low<high:
                        mid=(low+high)//2
                        if estimated_tokens(text[cursor:mid])<target_half:low=mid+1
                        else:high=mid
                    candidates=[cursor+m.end() for m in re.finditer(r'\n\s*\n|[.!?。！？](?:\s|$)',text[cursor:low])]
                    stop=next((c for c in reversed(candidates) if estimated_tokens(text[cursor:c])>=300),low)
            if text[cursor:stop].strip(): yield cursor,stop,section
            cursor=stop

def make_chunks(doc):
    if doc['rights_status']!='approved' or not doc['text']: return []
    rows=[]
    for start,end,section in chunk_spans(doc['text'],sensitive=doc['domain']=='entry_visa'):
        chunk_id='chunk:'+stable_id(doc['document_id'],start,end)
        domain=section_domain(section,doc['domain']) if doc.get('source_kind')=='wikivoyage' else doc['domain']
        sensitive=domain in ('entry_visa','daily_life','transportation') if doc.get('source_kind')=='wikivoyage' else doc['is_time_sensitive']
        text=doc['text'][start:end]
        body=re.sub(r'(?m)^\s*(?:#{1,6}[^\S\n]+[^\n]*|={2,6}[^\n]+={2,6})[^\S\n]*$', '', text)
        # Empty navigational/reference headings are not evidence-bearing chunks.
        # Keep actual short facts (including CJK and numeric facts) unchanged.
        if not any(character.isalnum() for character in body): continue
        count=estimated_tokens(text)
        rows.append(dict(doc,id=chunk_id,chunk_id=chunk_id,text=text,domain=domain,is_time_sensitive=sensitive,
                         char_start=start,char_end=end,section=section or doc['title'],sha256=text_sha256(text),
                         document_sha256=doc['sha256'],estimated_tokens=count,is_substantive_chunk=count>=250,
                         chunk_size_class='substantive' if count>=250 else 'source_short_section',
                         chunking_version='chapter-token-estimate-2.0'))
    return rows

def discover_field(payload, explicit, fragments):
    if explicit and explicit in payload: return explicit
    for fragment in fragments:
        for key in payload:
            if fragment == key.lower() or fragment in key.lower(): return key
    return None

def media_record(row, root):
    payload=row['payload']; info=(payload.get('imageinfo') or [{}])[0]; ext=info.get('extmetadata',{})
    value=lambda key:plain(ext.get(key,{}).get('value',''))
    asset_id=row.get('asset_id') or 'asset:'+stable_id(row['source_id'],info.get('url') or row['source_url'])
    original=Path(row['asset_path']); modality=row.get('modality','image')
    if not original.is_file(): raise ValueError('downloaded asset file does not exist')
    expected=row.get('binary_metadata',{}).get('sha256') or row.get('asset_sha256')
    digest=verify_file(original,expected)
    extname=original.suffix.lower()
    if extname not in ('.jpg','.jpeg','.png','.webp','.gif','.svg','.webm','.ogv','.mp4','.ogg','.mp3','.wav'):
        extname={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','video/webm':'.webm','video/ogg':'.ogv'}.get(info.get('mime'),'.bin')
    dest=root/'assets'/(modality+'s')/digest[:2]/(digest+extname)
    dest.parent.mkdir(parents=True,exist_ok=True)
    if dest.exists(): verify_file(dest,digest)
    elif original.resolve()!=dest.resolve():
        try: dest.hardlink_to(original)
        except OSError: shutil.copy2(original,dest)
    verify_file(dest,digest)
    entity_id='wikidata:'+row['qid'] if qid(row.get('qid')) and row.get('qid_evidence') else None
    return dict(common(row),id=asset_id,asset_id=asset_id,entity_id=entity_id,
                modality=modality,path=str(dest.resolve()),original_url=info.get('url',row['source_url']),
                file_page_url=info.get('descriptionurl',row['source_url']),mime=info.get('mime','application/octet-stream'),
                width=info.get('width'),height=info.get('height'),duration_seconds=info.get('duration'),
                author=value('Artist'),attribution=value('Credit') or value('Artist'),
                license_url=row.get('license_url') or value('LicenseUrl'),restrictions=value('Restrictions'),
                retrieved_at=row['fetched_at'],caption_zh=None,caption_en=None,ocr_text=None,
                original_description=value('ImageDescription'),annotation_status='pending',
                derived_annotations=[],bytes=dest.stat().st_size,sha256=digest,content_id='sha256:'+digest,
                original_asset_path=str(original.resolve()),binary_metadata=row.get('binary_metadata'),
                qid_evidence=row.get('qid_evidence'),entity_link_status='linked' if entity_id else 'needs_review',
                copyright_notice=value('Copyrighted'),attribution_required=value('AttributionRequired'),
                license_evidence_url=row.get('license_evidence_url',row['source_url']),metadata_route=row.get('metadata_route'),
                licensing_evidence=row.get('licensing_evidence') or payload.get('licensing_evidence'))

def normalize(root):
    root=Path(root); rows=read_jsonl(root/'manifests/records.jsonl'); tables={name:[] for name in TABLES}
    entities={}; errors=[]; raw_digests={}
    for row in rows:
        try:
            row=dict(row); payload=row['payload']; kind=row['kind']; ent=None; doc=None
            if row.get('raw_path'):
                raw=Path(row['raw_path']); key=str(raw.resolve())
                if key not in raw_digests: raw_digests[key]=verify_file(raw,row.get('raw_sha256'))
                if row.get('raw_sha256') and row['raw_sha256']!=raw_digests[key]: raise ValueError('Raw source SHA256 mismatch')
                row['raw_sha256']=raw_digests[key]
            if row.get('rights_status') not in ('approved','metadata_only'): continue
            if kind=='official':
                entity_id='nihao:'+stable_id(row['source_id'],'reference')
                ent=make_entity(row,entity_id,payload.get('title',row['source_id']),entity_type='official_reference',
                                content_status='metadata_only')
                doc=make_document(row,entity_id,payload.get('title',row['source_id']),'',
                                  content_status='metadata_only',topics=payload.get('topics',[row['domain']]),
                                  rights_review_status='requires_permission',last_checked_at=row['last_verified_at'])
            elif row['rights_status']!='approved': continue
            elif kind=='wikidata':
                external=qid(row.get('qid') or payload.get('id'))
                if not external: raise ValueError('Wikidata record has no valid QID')
                entity_id='wikidata:'+external
                coords=claim_values(payload,'P625'); coord=coords[0] if coords else {}
                external_ids={prop:claim_values(payload,prop) for prop in ('P1435','P757','P373','P18','P17','P131') if claim_values(payload,prop)}
                ent=make_entity(row,entity_id,lang_value(payload.get('labels',{}),'en'),lang_value(payload.get('labels',{}),'zh'),
                                qid=external,latitude=coord.get('latitude'),longitude=coord.get('longitude'),external_ids=external_ids,
                                aliases=[a['value'] for lang in ('en','zh') for a in payload.get('aliases',{}).get(lang,[])])
                description=lang_value(payload.get('descriptions',{}),'en')
                text=ent['name_en']+('\n'+description if description else '')
                if ent['name_zh']: text+='\nChinese name: '+ent['name_zh']
                doc=make_document(row,entity_id,ent['name_en'] or external,text,language='en',
                                  source_revision=payload.get('lastrevid'),revision_or_retrieved_at=payload.get('lastrevid') or row['fetched_at'])
            elif kind=='unesco':
                title_field=discover_field(payload,row.get('title_field'),('name_en','name','title','element'))
                id_field=discover_field(payload,row.get('id_field'),('id_no','id_number','id','code'))
                desc_field=discover_field(payload,row.get('description_field'),('description_en','description','short_description'))
                title=plain(payload.get(title_field)) or 'UNESCO record'
                source_key=payload.get(id_field) if id_field else row['id']
                external=qid(row.get('qid'))
                entity_id='wikidata:'+external if external else 'nihao:'+stable_id(row['source_id'],source_key)
                ent=make_entity(row,entity_id,title,qid=external,external_ids={row.get('dataset_id',row['source_id']):source_key})
                text=title+('\n'+plain(payload[desc_field]) if desc_field and payload[desc_field] else '')
                doc=make_document(row,entity_id,title,text,language='en',structured_fields=payload,
                                  license_evidence_url=row.get('license_evidence_url'))
            elif kind=='osm':
                tags=payload.get('tags',{}); external=qid(tags.get('wikidata'))
                osm_id=f"{payload.get('type','node')}:{payload['id']}"
                entity_id='wikidata:'+external if external else 'osm:'+osm_id
                ent=make_entity(row,entity_id,tags.get('name:en',tags.get('name','')),tags.get('name:zh',''),
                                qid=external,osm_id=osm_id,latitude=payload.get('lat'),longitude=payload.get('lon'),
                                external_ids={'osm':osm_id},entity_type=tags.get('tourism') or tags.get('railway') or tags.get('amenity','place'))
                text=ent['name_en']+'\n'+'\n'.join(f'{k}: {v}' for k,v in tags.items() if k in ('tourism','railway','amenity','name:zh','name:en','wheelchair','website'))
                doc=make_document(row,entity_id,ent['name_en'] or osm_id,text,language='mul',structured_fields=tags,source_revision=payload.get('version'),attribution='© OpenStreetMap contributors',license_url='https://opendatacommons.org/licenses/odbl/1-0/')
            elif kind in ('wikivoyage','wikipedia'):
                external=qid(row.get('qid')); title=payload['title']
                entity_id='wikidata:'+external if external else 'nihao:'+stable_id(row['source_id'],payload.get('pageid',title))
                language=row.get('language','en')
                ent=make_entity(row,entity_id,title if language=='en' else '',title if language.startswith('zh') else '',
                                qid=external,entity_type='travel_guide' if kind=='wikivoyage' else 'encyclopedia_topic')
                text=payload['text'] if payload.get('text_format')=='plain' else wikivoyage_text(payload['text'])
                doc=make_document(row,entity_id,title,text,language=language,source_revision=payload.get('revid'),parsing_version='mwparserfromhell-headings-v2' if payload.get('text_format')!='plain' else 'source-plaintext-v1',
                                  revision_or_retrieved_at=payload.get('revid') or row['fetched_at'],
                                  attribution_url=row.get('attribution_url',row['source_url']),history_url=row.get('history_url'),
                                  qid_evidence=row.get('qid_evidence'),author=row.get('author') or row.get('attribution',''),
                                  adaptation_notice='Extracted text and section chunks; retain source attribution and ShareAlike license.')
            elif kind=='commons':
                tables['media'].append(media_record(row,root)); continue
            else: raise ValueError('unsupported envelope kind: '+kind)
            if ent:
                if ent['entity_id'] in entities:
                    old=entities[ent['entity_id']]
                    old['source_ids']=sorted(set(old['source_ids']+ent['source_ids']))
                    old['provenance']+=ent['provenance']
                    old['licenses']=sorted(set(old['licenses']+ent['licenses']))
                    if len(old['licenses'])>1: old['license']='MULTIPLE: '+', '.join(old['licenses'])
                    for key,value in ent['external_ids'].items():
                        prior=old['external_ids'].get(key)
                        if prior is None or prior==value: old['external_ids'][key]=value
                        else:
                            values=(prior if isinstance(prior,list) else [prior])+(value if isinstance(value,list) else [value])
                            old['external_ids'][key]=[v for i,v in enumerate(values) if v not in values[:i]]
                    for key in ('name_en','name_zh','latitude','longitude','osm_id'):
                        if old.get(key) in (None,''): old[key]=ent.get(key)
                else: entities[ent['entity_id']]=ent
            if doc:
                tables['documents'].append(doc); tables['chunks'].extend(make_chunks(doc))
        except Exception as exc:
            errors.append({'record_id':row.get('id'),'source_id':row.get('source_id'),'stage':'normalization','reason':str(exc)})
    tables['entities']=list(entities.values())
    for name,items in tables.items():
        unique={item['id']:item for item in items}; write_jsonl(root/'normalized'/f'{name}.jsonl',unique.values())
    for path in ('derived/ocr','derived/captions','derived/transcripts','derived/keyframes','indexes/text','indexes/vision','quarantine'):
        (root/path).mkdir(parents=True,exist_ok=True)
    write_jsonl(root/'manifests/normalization_errors.jsonl',errors)
    write_jsonl(root/'quarantine/normalization.jsonl',errors)
    result={name:len({item['id'] for item in items}) for name,items in tables.items()} | {'errors':errors,
        'substantive_chunks':sum(row['is_substantive_chunk'] for row in tables['chunks']),
        'raw_files_sha256_verified':len(raw_digests),'unique_original_media_sha256':len({row['sha256'] for row in tables['media']})}
    (root/'manifests/normalization.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
    return result
