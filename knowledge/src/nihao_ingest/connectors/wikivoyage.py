"""Revision-pinned wikitext with a history link for attribution and ShareAlike."""
import re
from urllib.parse import quote
from .common import mw, accepted


def ingest(source,ctx):
    sid=source['source_id']
    site,_=mw(ctx,source,action='query',meta='siteinfo',siprop='rightsinfo')
    rights=site.get('query',{}).get('rightsinfo',{})
    url=rights.get('url','')
    match=re.fullmatch(r'https?://creativecommons.org/licenses/by-sa/(\d[.]\d)/?',url)
    if not match or match[1] not in ('3.0','4.0'):
        ctx.review(sid,source['url'],'Site rights metadata not an explicitly supported CC BY-SA license',rightsinfo=rights)
        ctx.event(sid,'skipped','Wikivoyage license unresolved')
        return []
    rows=[]
    for title in source['pages'][:min(ctx.max_items,6)]:
        try:
            ctx.event(sid,'discovered',title=title)
            data,meta=mw(ctx,source,action='query',titles=title,prop='revisions|pageprops',rvprop='ids|timestamp|content',rvslots='main',redirects=1)
            for page in data.get('query',{}).get('pages',[]):
                revs=page.get('revisions',[])
                if page.get('missing') or not revs:
                    ctx.event(sid,'skipped','Missing page or revision',title=title);continue
                revision=revs[0];text=revision.get('slots',{}).get('main',{}).get('content','')
                if not text:
                    ctx.event(sid,'skipped','Empty revision text',title=title);continue
                payload={'title':page['title'],'pageid':page['pageid'],'revid':revision['revid'],'text':text,'timestamp':revision.get('timestamp')}
                page_url='https://en.wikivoyage.org/wiki/'+quote(page['title'].replace(' ','_'))
                qid=page.get('pageprops',{}).get('wikibase_item')
                license='CC-BY-SA-'+match[1]
                ctx.event(sid,'eligible',title=title,license=license)
                row=ctx.record('wikivoyage',payload,meta,license=license,source_url=page_url+'?oldid='+str(revision['revid']),license_url=url,attribution='Wikivoyage contributors',attribution_url=page_url,history_url=page_url+'?action=history',qid=qid,city=title if title!='China' else None,scope='national' if title=='China' else 'city',language='en',domain='daily_life',source_published_at=revision.get('timestamp'),sharealike_note='Redistributed wikitext and derived chunks retain the source CC BY-SA license; preserve attribution/history links and mark transformations.')
                rows.append(accepted(ctx,source,row))
        except Exception as exc:
            ctx.event(sid,'failed',str(exc),title=title)
    return rows


ingest_api=ingest


def ingest(source,ctx):
    if source.get('collection_route')=='action_api':return ingest_api(source,ctx)
    from .html_pages import canonical_url,read_page,article_identity,article_license,article_text
    rows=[];sid=source['source_id']
    for title in source['pages'][:min(ctx.max_items,6)]:
        url=canonical_url('https://en.wikivoyage.org',title)
        ctx.event(sid,'discovered',title=title)
        try:
            soup,raw,meta=read_page(ctx,source,url)
            qid,pageid,revid=article_identity(soup,raw)
            lic,lic_url,evidence=article_license(soup);text=article_text(soup)
            if not text:raise ValueError('No substantive guide text')
            payload={'title':title,'pageid':pageid,'revid':revid,'text':text,'text_format':'plain','html_extraction':'paragraphs and headings; nav/infobox/references excluded'}
            ctx.event(sid,'eligible',title=title,license=lic)
            row=ctx.record('wikivoyage',payload,meta,license=lic,source_url=url,license_url=lic_url,attribution='Wikivoyage contributors',attribution_url=url,history_url=url+'?action=history',revision_url=url+'?oldid='+str(revid),qid=qid,city=title if title!='China' else None,scope='national' if title=='China' else 'city',language='en',domain='daily_life',license_evidence_url=url+'#footer-info-copyright',license_notice_link=evidence,sharealike_note='Licensed travel guide HTML extracted to section text and chunks; preserve attribution and ShareAlike.')
            rows.append(accepted(ctx,source,row,text_characters=len(text)))
        except Exception as exc:ctx.event(sid,'failed',str(exc),title=title)
    return rows
