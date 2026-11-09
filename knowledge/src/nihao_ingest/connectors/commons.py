"""Bounded category discovery with a per-file commercial reuse gate.

P18 and explicit MediaInfo depicts statements are the only automatic entity
associations. Similar filenames or category names do not establish identity.
"""
import re
import json
import shutil
from collections import deque
from pathlib import Path
from ..core import read_jsonl, stable_id
from .common import mw, field_value, accepted, is_qid

MIB=1024*1024
EXTENSIONS={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/gif':'.gif','video/webm':'.webm','video/mp4':'.mp4','video/ogg':'.ogv','application/ogg':'.ogv','audio/ogg':'.ogg','audio/mpeg':'.mp3'}


def license_gate(ext):
    """Return canonical license, license URL, reason. Unknown restrictions fail closed."""
    name=field_value(ext,'LicenseShortName');url=field_value(ext,'LicenseUrl').strip()
    if url.startswith('//'):url='https:'+url
    restrictions=field_value(ext,'Restrictions').strip()
    if restrictions:
        return None,url,'Additional restrictions require review: '+restrictions
    forbidden=' '.join([name,field_value(ext,'UsageTerms')]).lower()
    if any(token in forbidden for token in ('non-commercial','noncommercial','no derivatives','-nc','-nd','all rights reserved')):
        return None,url,'Commercial reuse or derivatives not explicitly permitted'
    match=re.fullmatch(r'https?://creativecommons.org/licenses/(by|by-sa)/(1[.]0|2[.]0|2[.]5|3[.]0|4[.]0)/?(?:deed[.][a-z-]+)?',url,re.I)
    if match:
        if not field_value(ext,'Artist').strip():
            return None,url,'Missing author attribution'
        return 'CC-'+match[1].upper()+'-'+match[2],url,None
    if re.fullmatch(r'https?://creativecommons.org/publicdomain/zero/1[.]0/?',url,re.I):
        if not field_value(ext,'Artist').strip():
            return None,url,'Missing author provenance'
        return 'CC0',url,None
    if re.fullmatch(r'https?://creativecommons.org/publicdomain/mark/1[.]0/?',url,re.I) and name.lower() in ('public domain','pd'):
        if not field_value(ext,'Artist').strip():
            return None,url,'Missing author provenance'
        return 'Public-domain',url,None
    return None,url,'No supported, explicit per-file license URL'


def p18_candidates(ctx,source):
    rows=read_jsonl(ctx.root/'manifests/records.jsonl')
    candidates=[]
    for row in rows:
        if row.get('kind')!='wikidata' or row.get('domain') not in source['domains']:
            continue
        qid=row.get('qid')
        if not is_qid(qid):continue
        for claim in row.get('payload',{}).get('claims',{}).get('P18',[]):
            if claim.get('rank')=='deprecated':continue
            filename=claim.get('mainsnak',{}).get('datavalue',{}).get('value')
            if isinstance(filename,str):
                candidates.append({'title':'File:'+filename,'qid':qid,'qid_evidence':f'Wikidata {qid} P18 exact Commons filename', 'domain':row['domain'],'city':row.get('city')})
    return candidates


def p10_candidates(ctx,source):
    candidates=[]
    for row in read_jsonl(ctx.root/'manifests/records.jsonl'):
        if row.get('kind')!='wikidata' or row.get('domain') not in source['domains'] or not is_qid(row.get('qid')):continue
        for claim in row.get('payload',{}).get('claims',{}).get('P10',[]):
            filename=claim.get('mainsnak',{}).get('datavalue',{}).get('value')
            if claim.get('rank')!='deprecated' and isinstance(filename,str):
                candidates.append({'title':'File:'+filename,'qid':row['qid'],'qid_evidence':f"Wikidata {row['qid']} P10 exact Commons video filename",'domain':row['domain'],'city':row.get('city')})
    return candidates


def category_candidates(ctx,source,max_candidates):
    """At most 12 category API pages, depth <=2, one bounded page per category."""
    queue=deque([(source['category'],0)]);seen=set();result=[]
    while queue and len(seen)<12 and len(result)<max_candidates:
        category,depth=queue.popleft()
        if category in seen:continue
        seen.add(category)
        data,_=mw(ctx,source,action='query',list='categorymembers',cmtitle=category,cmtype='file|subcat',cmlimit=min(50,max_candidates))
        for page in data.get('query',{}).get('categorymembers',[]):
            if page.get('ns')==6:
                result.append({'title':page['title']})
            elif page.get('ns')==14 and depth<2:
                queue.append((page['title'],depth+1))
            if len(result)>=max_candidates:break
    return result


def depicts_qid(ctx,source,pageid):
    data,_=mw(ctx,source,action='wbgetentities',ids='M'+str(pageid),props='claims')
    entity=data.get('entities',{}).get('M'+str(pageid),{})
    statements=entity.get('statements',entity.get('claims',{}))
    qids=set()
    for claim in statements.get('P180',[]):
        if claim.get('rank')=='deprecated':continue
        value=claim.get('mainsnak',{}).get('datavalue',{}).get('value',{})
        if isinstance(value,dict) and is_qid(value.get('id')):qids.add(value['id'])
    return next(iter(qids)) if len(qids)==1 else None


def ingest(source,ctx):
    sid=source['source_id'];is_video='video' in sid
    prior=[r for r in read_jsonl(ctx.root/'manifests/records.jsonl') if r.get('kind')=='commons']
    count=sum(r.get('modality')==('video' if is_video else 'image') for r in prior)
    cap=(ctx.max_videos if is_video else ctx.max_images)
    if count>=cap:
        ctx.event(sid,'skipped','Global media sample cap already reached',cap=cap)
        return []
    candidates=p10_candidates(ctx,source) if is_video else p18_candidates(ctx,source)
    # Category API is mandatory discovery for each selected seed. Fail closed on restrictions.
    candidates+=category_candidates(ctx,source,ctx.max_items)
    seen=set();rows=[]
    for candidate in candidates:
        title=candidate['title'].replace('_',' ')
        if title in seen:continue
        seen.add(title)
        if len(seen)>ctx.max_items or count+len(rows)>=cap:break
        ctx.event(sid,'discovered',title=title)
        try:
            data,meta=mw(ctx,source,action='query',titles=title,prop='imageinfo',iiprop='url|size|mime|mediatype|extmetadata|timestamp',iiextmetadatalanguage='en',redirects=1)
            pages=data.get('query',{}).get('pages',[])
            if not pages or not pages[0].get('imageinfo'):
                ctx.event(sid,'skipped','No imageinfo metadata',title=title);continue
            page=pages[0];info=page['imageinfo'][0];ext=info.get('extmetadata',{})
            license,license_url,reason=license_gate(ext)
            file_url=info.get('descriptionurl') or source['url']
            if reason:
                ctx.review(sid,file_url,reason,title=title,extmetadata=ext)
                ctx.event(sid,'skipped',reason,title=title);continue
            mime=info.get('mime','');modality='video' if mime.startswith('video/') or mime=='application/ogg' else 'audio' if mime.startswith('audio/') else 'image'
            if modality!=('video' if is_video else 'image'):
                ctx.event(sid,'skipped','Candidate modality differs from seed target',title=title,mime=mime);continue
            if mime not in EXTENSIONS:
                ctx.event(sid,'skipped','Unsupported safe media MIME',title=title,mime=mime);continue
            max_bytes=80*MIB if is_video else 12*MIB
            size=info.get('size')
            if not isinstance(size,int) or size<=0 or size>max_bytes:
                ctx.event(sid,'skipped','Missing size or exceeds per-media byte limit',title=title,size=size);continue
            original=info.get('url','')
            if not original.startswith('https://upload.wikimedia.org/'):
                ctx.review(sid,file_url,'Unexpected media download origin',original_url=original)
                ctx.event(sid,'skipped','Unexpected media download origin',title=title);continue
            ctx.event(sid,'eligible',title=title,license=license,size=size)
            binary=ctx.http.fetch(original,sid,max_bytes=max_bytes)
            if binary['bytes']!=size:
                ctx.event(sid,'failed','Imageinfo size differs from downloaded file; excluded',title=title,expected=size,actual=binary['bytes']);continue
            asset_key=stable_id('commons',page['pageid'],info.get('timestamp'),original)
            asset=ctx.root/'assets'/('videos' if is_video else 'images')/sid/(asset_key+EXTENSIONS[mime]);asset.parent.mkdir(parents=True,exist_ok=True)
            if not asset.exists():
                try:asset.hardlink_to(binary['path'])
                except OSError:shutil.copyfile(binary['path'],asset)
            qid=candidate.get('qid');evidence=candidate.get('qid_evidence')
            if not qid:
                try:
                    qid=depicts_qid(ctx,source,page['pageid'])
                    if qid:evidence=f'Commons MediaInfo M{page["pageid"]} P180 unique depicts statement'
                except Exception as exc:
                    ctx.event(sid,'skipped','Entity metadata unavailable; retained unlinked: '+str(exc),title=title)
            row=ctx.record('commons',page,meta,license=license,source_url=file_url,asset_path=str(asset.resolve()),asset_id='asset:'+asset_key,modality=modality,qid=qid,qid_evidence=evidence,city=candidate.get('city'),domain=candidate.get('domain',source['domains'][0]),language='und',scope='poi' if qid else 'national',license_url=license_url,source_published_at=info.get('timestamp'),original_url=original,binary_metadata=binary)
            rows.append(accepted(ctx,source,row,bytes=binary['bytes']))
        except Exception as exc:
            ctx.event(sid,'failed',str(exc),title=title)
    if not rows:ctx.event(sid,'skipped','No eligible downloadable media in bounded candidate sample')
    return rows

# Canonical HTML route is preferred for the executed pilot. The Action API
# implementation remains available only when its own robots gate permits it.
ingest_api = ingest


def category_html_candidates(ctx,source,max_candidates):
    from .html_pages import canonical_url,read_page
    from urllib.parse import unquote
    queue=deque([(source['category'],0)]);seen=set();files=[]
    while queue and len(seen)<12 and len(files)<max_candidates:
        title,depth=queue.popleft()
        if title in seen:continue
        seen.add(title)
        try:
            soup,_,_=read_page(ctx,source,canonical_url('https://commons.wikimedia.org',title))
            for link in soup.select('#mw-category-media a[href]'):
                href=unquote(link['href'])
                if href.startswith('/wiki/File:'):
                    files.append({'title':href[len('/wiki/'):].replace('_',' ')})
            if depth<2:
                for link in soup.select('#mw-subcategories a[href]'):
                    href=unquote(link['href'])
                    if href.startswith('/wiki/Category:'):queue.append((href[len('/wiki/'):].replace('_',' '),depth+1))
        except Exception as exc:ctx.event(source['source_id'],'failed','Category HTML discovery: '+str(exc),category=title)
    return files[:max_candidates]


def file_html_metadata(soup,raw,url):
    """Return source HTML metadata in the existing imageinfo-compatible envelope.

    Only per-file license templates can authorize binary download. The Commons
    footer's general page-text or structured-data license is never considered.
    """
    from .html_pages import config_value
    def field(key):
        label=soup.select_one('#fileinfotpl_'+key)
        value=label.find_next_sibling('td') if label else None
        return str(value) if value else ''
    author=field('aut');description=field('desc');credit=field('src')
    restrictions='; '.join(x.get_text(' ',strip=True) for x in soup.select('.restrictiontemplate, .licensetpl_restrictions'))
    selected=None;reasons=[]
    for template in soup.select('.licensetpl'):
        short=template.select_one('.licensetpl_short');license_link=template.select_one('.licensetpl_link')
        if not short or not license_link:continue
        license_url=license_link.get_text(' ',strip=True)
        if license_link.select_one('a[href]'):license_url=license_link.select_one('a[href]')['href']
        ext={'Artist':{'value':author},'Credit':{'value':credit},'ImageDescription':{'value':description},'Restrictions':{'value':restrictions},'LicenseShortName':{'value':short.get_text(' ',strip=True)},'LicenseUrl':{'value':license_url}}
        lic,lic_url,reason=license_gate(ext)
        if reason:reasons.append(reason);continue
        selected=(ext,lic,lic_url);break
    licensing_evidence=None
    if not selected and not restrictions:
        # PD-author is a specific per-file grant, not Commons' site footer or a
        # blanket public-domain guess. Preserve the complete actual declaration.
        for template in soup.select('#mw-content-text table.layouttemplate'):
            short=template.select_one('.licensetpl_short')
            declaration=template.get_text(' ',strip=True)
            if (short and short.get_text(' ',strip=True)=='Public domain'
                    and 'This work has been released into the public domain by its author' in declaration
                    and 'This applies worldwide.' in declaration
                    and 'grants anyone the right to use this work for any purpose' in declaration
                    and 'without any conditions' in declaration):
                from bs4 import BeautifulSoup
                author_text=BeautifulSoup(author,'html.parser').get_text(' ',strip=True)
                if not author_text or author_text not in declaration:continue
                evidence_url=url+'#Licensing'
                licensing_evidence={'method':'explicit per-file PD-author release','declaration':declaration,'evidence_url':evidence_url,'permission_urls':[a['href'] for a in template.select('a.external[href]')]}
                ext={'Artist':{'value':author},'Credit':{'value':credit},'ImageDescription':{'value':description},'Restrictions':{'value':''},'LicenseShortName':{'value':'Public domain'},'LicenseUrl':{'value':evidence_url},'LicenseDeclaration':{'value':declaration}}
                selected=(ext,'Public-domain',evidence_url);break
    if not selected:raise ValueError('No approved per-file HTML license: '+'; '.join(reasons or ['missing license templates']))
    from bs4 import BeautifulSoup
    if not BeautifulSoup(author,'html.parser').get_text(' ',strip=True):
        raise ValueError('Missing substantive author provenance')
    link=soup.select_one('.fullMedia a.internal[href]') or soup.select_one('.fullImageLink a[href]')
    if not link:raise ValueError('Missing original binary download link')
    original=link['href'];mime_el=soup.select_one('.fullMedia .mime-type');mime=mime_el.get_text(strip=True) if mime_el else ''
    mime_from_extension=False
    if not mime:
        from urllib.parse import urlsplit
        extension=Path(urlsplit(original).path).suffix.lower()
        mime={'.webm':'video/webm','.ogv':'video/ogg','.mp4':'video/mp4'}.get(extension,'')
        mime_from_extension=bool(mime)
    img=soup.select_one('.fullImageLink img');width=int(img.get('data-file-width',0)) if img else None;height=int(img.get('data-file-height',0)) if img else None
    ext,lic,lic_url=selected
    title=soup.select_one('#firstHeading')
    page={'pageid':config_value(raw,'wgArticleId'),'title':title.get_text(' ',strip=True) if title else 'Commons file','imageinfo':[{'url':original,'descriptionurl':url,'mime':mime,'width':width,'height':height,'timestamp':None,'extmetadata':ext,'mime_requires_head_confirmation':mime_from_extension}], 'licensing_evidence':licensing_evidence}
    if not page['pageid']:raise ValueError('Missing Commons file page ID')
    return page,lic,lic_url,config_value(raw,'wgRevisionId')


def ingest(source,ctx):
    if source.get('collection_route')=='action_api':return ingest_api(source,ctx)
    from .html_pages import canonical_url,read_page
    sid=source['source_id'];is_video='video' in sid;modality='video' if is_video else 'image'
    prior=[r for r in read_jsonl(ctx.root/'manifests/records.jsonl') if r.get('kind')=='commons']
    prior_keys={r.get('payload',{}).get('pageid') for r in prior}
    count=len({r.get('asset_id') or r['id'] for r in prior if r.get('modality')==modality})
    global_cap=ctx.max_videos if is_video else ctx.max_images
    source_cap=int(source.get('max_media',global_cap));remaining=min(source_cap,max(0,global_cap-count))
    if remaining<=0:
        ctx.event(sid,'skipped','Global media sample cap reached');return []
    candidates=p10_candidates(ctx,source) if is_video else p18_candidates(ctx,source)
    target_qids=source.get('target_qids',[])
    if not isinstance(target_qids,list) or not all(is_qid(value) for value in target_qids):
        raise ValueError('target_qids must be a list of exact Wikidata QIDs')
    if target_qids:
        # A targeted follow-up consumes only already evidenced P18/P10 claims;
        # it never broadens into categories or filename-based entity guesses.
        candidates=[candidate for candidate in candidates if candidate.get('qid') in target_qids]
        ctx.event(sid,'skipped','Exact source target_qids filter; category discovery disabled',target_qids=target_qids,candidate_count=len(candidates))
    else:
        # General pilot discovery inspects the registered seed category too.
        candidates+=category_html_candidates(ctx,source,ctx.max_items if is_video else min(15,ctx.max_items))
    rows=[];seen=set()
    for candidate in candidates:
        title=candidate['title'].replace('_',' ')
        if title in seen:continue
        if len(seen)>=ctx.max_items or len(rows)>=remaining:break
        seen.add(title);ctx.event(sid,'discovered',title=title)
        file_url=canonical_url('https://commons.wikimedia.org',title)
        try:
            soup,raw,meta=read_page(ctx,source,file_url)
            try:page,lic,lic_url,revid=file_html_metadata(soup,raw,file_url)
            except ValueError as exc:
                ctx.review(sid,file_url,str(exc),title=title);ctx.event(sid,'skipped',str(exc),title=title);continue
            if page['pageid'] in prior_keys:
                ctx.event(sid,'skipped','Exact Commons file page already collected',title=title);continue
            info=page['imageinfo'][0];mime=info['mime'];original=info['url']
            actual='video' if mime.startswith('video/') or mime=='application/ogg' else 'image' if mime.startswith('image/') else 'audio'
            if actual!=modality or mime not in EXTENSIONS:
                ctx.event(sid,'skipped','Unsupported or different media modality',title=title,mime=mime);continue
            if not original.startswith('https://upload.wikimedia.org/'):
                raise ValueError('Original binary does not use official Wikimedia upload host')
            cap=80*MIB if is_video else 12*MIB
            head=ctx.http.fetch(original,sid,method='HEAD',max_bytes=cap,purpose='media_size_validation')
            if info.get('mime_requires_head_confirmation') and head.get('content_type','').split(';')[0].strip()!=mime:
                raise ValueError('Original video MIME was not corroborated by HEAD Content-Type')
            size=head.get('content_length',0)
            if size and size>cap:
                ctx.event(sid,'skipped','Original exceeds media byte cap',title=title,bytes=size);continue
            ctx.event(sid,'eligible',title=title,license=lic,expected_bytes=size)
            binary=ctx.http.fetch(original,sid,max_bytes=cap)
            if size and binary['bytes']!=size:raise ValueError('Original size changed between metadata and download')
            info['size']=binary['bytes'];info['timestamp']=binary.get('last_modified')
            asset_key=stable_id('commons',page['pageid'],original)
            asset=ctx.root/'assets'/('videos' if is_video else 'images')/sid/(asset_key+EXTENSIONS[mime]);asset.parent.mkdir(parents=True,exist_ok=True)
            if not asset.exists():
                try:asset.hardlink_to(binary['path'])
                except OSError:shutil.copyfile(binary['path'],asset)
            if not candidate.get('qid'):
                depicts=soup.select_one('[data-mw-property="P180"][data-mw-statements]')
                if depicts:
                    statements=json.loads(depicts['data-mw-statements']);qids=set()
                    for claim in statements:
                        value=claim.get('mainsnak',{}).get('datavalue',{}).get('value',{})
                        if claim.get('rank')!='deprecated' and isinstance(value,dict) and is_qid(value.get('id')):qids.add(value['id'])
                    if len(qids)==1:
                        candidate['qid']=next(iter(qids));candidate['qid_evidence']=f"Canonical Commons MediaInfo M{page['pageid']} P180 unique depicts statement"
            row=ctx.record('commons',page,meta,license=lic,source_url=file_url,asset_path=str(asset.resolve()),asset_id='asset:'+asset_key,modality=modality,qid=candidate.get('qid'),qid_evidence=candidate.get('qid_evidence'),licensing_evidence=page.get('licensing_evidence'),city=candidate.get('city'),domain=candidate.get('domain',source['domains'][0]),language='und',scope='poi' if candidate.get('qid') else 'national',license_url=lic_url,source_published_at=binary.get('last_modified'),original_url=original,binary_metadata=binary,sha256=binary.get('sha256'),source_revision=revid,metadata_route='per-file canonical HTML licensing templates and original file HEAD')
            rows.append(accepted(ctx,source,row,bytes=binary['bytes']));prior_keys.add(page['pageid'])
        except Exception as exc:ctx.event(sid,'failed',str(exc),title=title)
    if not rows:ctx.event(sid,'skipped','No approved media acquired from bounded canonical candidates')
    return rows
