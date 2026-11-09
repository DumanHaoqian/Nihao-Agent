"""Bounded official Wikibase entity retrieval from exact curated sitelinks.

The source registry retains the original SPARQL seed. For the pilot, published
Wikibase site/title lookup resolves known article titles to real QIDs without
costly label joins or assumptions about an entity's identifier.
"""
from pathlib import Path
import yaml
from .common import api_url, accepted, is_qid


def pilot_seeds(source):
    configured=source.get('pilot_entities_file')
    candidates=[Path(configured)] if configured else [Path.cwd()/'config/pilot_entities.yaml',Path(__file__).resolve().parents[3]/'config/pilot_entities.yaml']
    path=next((p for p in candidates if p.is_file()),None)
    if path is None:raise FileNotFoundError('pilot_entities.yaml missing; set source pilot_entities_file or run from the module directory')
    seeds=yaml.safe_load(path.read_text())['entities']
    if not isinstance(seeds,list) or not all(isinstance(s.get('title'),str) and s.get('domain') for s in seeds):
        raise ValueError('pilot_entities must define title and domain')
    return seeds


def ingest_api(source, ctx):
    sid=source['source_id'];rows=[];seen=set();seeds=pilot_seeds(source)[:ctx.max_items]
    api=source.get('api','https://www.wikidata.org/w/api.php')
    # Exact site-title mapping is a documented Wikibase read operation. It is not
    # a fallback around a denial: policy and transport decisions remain in HTTP.
    for offset in range(0,len(seeds),10):
        batch=seeds[offset:offset+10];by_title={s['title'].replace('_',' ').casefold():s for s in batch}
        url=api_url(api,action='wbgetentities',sites='enwiki',titles='|'.join(s['title'] for s in batch),props='info|labels|descriptions|aliases|claims|sitelinks',languages='en|zh',format='json',maxlag=5)
        try:
            data,meta=ctx.http.json(url,sid,max_bytes=12*1024*1024)
            if 'error' in data:raise ValueError('Wikibase API: '+str(data['error']))
            matched=set()
            for qid,entity in data.get('entities',{}).items():
                if not is_qid(qid) or 'missing' in entity:continue
                title=entity.get('sitelinks',{}).get('enwiki',{}).get('title','')
                seed=by_title.get(title.replace('_',' ').casefold())
                if not seed:
                    ctx.event(sid,'skipped','Returned sitelink title does not exactly match configured discovery title',qid=qid,title=title)
                    continue
                matched.add(seed['title'])
                if qid in seen:continue
                seen.add(qid);ctx.event(sid,'discovered',qid=qid,title=title)
                ctx.event(sid,'eligible',qid=qid,license='CC0')
                row=ctx.record('wikidata',entity,meta,license='CC0',source_url=f'https://www.wikidata.org/wiki/{qid}',qid=qid,domain=seed['domain'],city=seed.get('city'),language='mul',scope='poi',license_url='https://creativecommons.org/publicdomain/zero/1.0/',attribution='Wikidata contributors',source_published_at=entity.get('modified'),discovery_method='official wbgetentities enwiki sitelink',discovery_title=seed['title'])
                rows.append(accepted(ctx,source,row))
            for seed in batch:
                if seed['title'] not in matched:ctx.event(sid,'skipped','Exact enwiki sitelink not resolved',title=seed['title'])
        except Exception as exc:
            ctx.event(sid,'failed',str(exc),discovery_titles=[s['title'] for s in batch])
    return rows


def ingest(source,ctx):
    if source.get('collection_route')=='action_api':return ingest_api(source,ctx)
    from .html_pages import canonical_url,read_page,article_identity
    sid=source['source_id'];rows=[];seen=set()
    for seed in pilot_seeds(source)[:ctx.max_items]:
        try:
            page_url=canonical_url('https://en.wikipedia.org',seed['title'])
            soup,raw,discovery=read_page(ctx,source,page_url)
            qid,_,_=article_identity(soup,raw)
            if not is_qid(qid):raise ValueError('Canonical Wikipedia page has no valid Wikidata item link')
            if qid in seen:continue
            seen.add(qid);ctx.event(sid,'discovered',qid=qid,title=seed['title'])
            data,meta=ctx.http.json(f'https://www.wikidata.org/wiki/Special:EntityData/{qid}.json',sid,max_bytes=12*1024*1024)
            entity=data.get('entities',{}).get(qid)
            if not entity or entity.get('id')!=qid:raise ValueError('Linked Data response entity identity mismatch')
            ctx.event(sid,'eligible',qid=qid,license='CC0')
            row=ctx.record('wikidata',entity,meta,license='CC0',source_url=f'https://www.wikidata.org/wiki/{qid}',qid=qid,domain=seed['domain'],city=seed.get('city'),language='mul',scope='poi',license_url='https://creativecommons.org/publicdomain/zero/1.0/',attribution='Wikidata contributors',source_published_at=entity.get('modified'),discovery_method='Canonical Wikipedia Wikidata item link; official Wikidata Linked Data JSON',discovery_url=page_url,discovery_title=seed['title'],discovery_raw_path=discovery['path'])
            rows.append(accepted(ctx,source,row))
        except Exception as exc:ctx.event(sid,'failed',str(exc),discovery_title=seed['title'])
    return rows
