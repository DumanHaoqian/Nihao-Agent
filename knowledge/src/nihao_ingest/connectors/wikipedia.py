"""License-checked, revision-pinned bilingual articles with verified QID identity."""
import re
from urllib.parse import quote, urlsplit
from ..core import read_jsonl
from .common import mw, accepted, is_qid


def ingest_api(source,ctx):
    sid=source['source_id'];language=source.get('language','en');site=language+'wiki'
    rights_data,_=mw(ctx,source,action='query',meta='siteinfo',siprop='rightsinfo')
    rights=rights_data.get('query',{}).get('rightsinfo',{})
    license_url=rights.get('url','')
    match=re.fullmatch(r'https?://creativecommons.org/licenses/by-sa/(3[.]0|4[.]0)/?',license_url)
    if not match:
        ctx.review(sid,source['url'],'Wikipedia site rightsinfo not an explicitly supported license',rightsinfo=rights)
        ctx.event(sid,'skipped','Wikipedia fulltext license unresolved');return []
    license='CC-BY-SA-'+match[1];base='https://'+urlsplit(source['api']).netloc
    # Balanced selection follows the interleaved, reviewed pilot seed ordering.
    seeds=[]
    for row in read_jsonl(ctx.root/'manifests/records.jsonl'):
        if row.get('kind')!='wikidata' or not is_qid(row.get('qid')):continue
        title=row.get('payload',{}).get('sitelinks',{}).get(site,{}).get('title')
        if title:seeds.append((title,row))
    rows=[]
    for title,entity in seeds[:min(ctx.max_items,int(source.get('max_pages',24)))]:
        ctx.event(sid,'discovered',title=title,qid=entity['qid'])
        try:
            data,meta=mw(ctx,source,action='query',titles=title,prop='revisions|pageprops',rvprop='ids|timestamp|content',rvslots='main',redirects=1)
            pages=data.get('query',{}).get('pages',[])
            if not pages or pages[0].get('missing') or not pages[0].get('revisions'):
                ctx.event(sid,'skipped','Article or revision missing',title=title);continue
            page=pages[0];qid=page.get('pageprops',{}).get('wikibase_item')
            if qid!=entity['qid']:
                ctx.event(sid,'skipped','Wikipedia page QID does not match verified Wikidata sitelink',title=title,expected_qid=entity['qid'],actual_qid=qid);continue
            revision=page['revisions'][0];text=revision.get('slots',{}).get('main',{}).get('content','')
            if not text.strip():ctx.event(sid,'skipped','Empty revision text',title=title);continue
            page_url=base+'/wiki/'+quote(page['title'].replace(' ','_'))
            payload={'title':page['title'],'pageid':page['pageid'],'revid':revision['revid'],'text':text,'text_format':'wikitext','timestamp':revision.get('timestamp')}
            ctx.event(sid,'eligible',title=title,license=license)
            row=ctx.record('wikipedia',payload,meta,license=license,source_url=page_url+'?oldid='+str(revision['revid']),qid=qid,qid_evidence='Verified Wikidata sitelink and Wikipedia pageprops.wikibase_item agree',domain=entity['domain'],city=entity.get('city'),scope='poi',language=language,source_published_at=revision.get('timestamp'),license_url=license_url,attribution='Wikipedia contributors',attribution_url=page_url,history_url=page_url+'?action=history',sharealike_note='Licensed article revision transformed into plain-text section chunks; preserve attribution and license, disclose adaptation.')
            rows.append(accepted(ctx,source,row,text_characters=len(text)))
        except Exception as exc:ctx.event(sid,'failed',str(exc),title=title)
    return rows


def ingest(source,ctx):
    if source.get('collection_route')=='action_api':return ingest_api(source,ctx)
    from .html_pages import canonical_url,read_page,article_identity,article_license,article_text
    language=source.get('language','en');site=language+'wiki';sid=source['source_id'];rows=[]
    candidates=[]
    for entity in read_jsonl(ctx.root/'manifests/records.jsonl'):
        title=entity.get('payload',{}).get('sitelinks',{}).get(site,{}).get('title')
        if entity.get('kind')=='wikidata' and title and is_qid(entity.get('qid')):candidates.append((title,entity))
    for title,entity in candidates[:min(ctx.max_items,int(source.get('max_pages',24)))]:
        url=canonical_url('https://'+language+'.wikipedia.org',title)
        ctx.event(sid,'discovered',title=title,qid=entity['qid'])
        try:
            soup,raw,meta=read_page(ctx,source,url)
            qid,pageid,revid=article_identity(soup,raw)
            if qid!=entity['qid']:raise ValueError('Canonical article QID disagrees with Wikidata sitelink')
            license,license_url,evidence=article_license(soup)
            text=article_text(soup)
            if not text:raise ValueError('No substantive article text')
            page_title=soup.select_one('#firstHeading');actual_title=page_title.get_text(' ',strip=True) if page_title else title
            payload={'title':actual_title,'pageid':pageid,'revid':revid,'text':text,'text_format':'plain','html_extraction':'paragraphs and headings; nav/infobox/references excluded'}
            ctx.event(sid,'eligible',title=actual_title,license=license)
            row=ctx.record('wikipedia',payload,meta,license=license,source_url=url,qid=qid,qid_evidence='Canonical article Wikidata item link agrees with Wikidata sitelink',domain=entity['domain'],city=entity.get('city'),scope='poi',language=language,license_url=license_url,license_evidence_url=url+'#footer-info-copyright',license_notice_link=evidence,attribution='Wikipedia contributors',attribution_url=url,history_url=url+'?action=history',revision_url=url+'?oldid='+str(revid),sharealike_note='Licensed article HTML extracted to paragraphs/headings and section chunks; preserve attribution and CC BY-SA.')
            rows.append(accepted(ctx,source,row,text_characters=len(text)))
        except Exception as exc:
            ctx.event(sid,'failed',str(exc),title=title)
    return rows
