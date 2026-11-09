"""Store only supplied URLs and descriptive registry metadata, never page bodies."""
from .common import accepted

TITLES={
 'national_immigration_administration':'National Immigration Administration — official entry and visa information',
 'gov_cn_guide_foreigners':'China government — guide for foreign visitors',
 'china_railway_12306_faq':'China Railway 12306 — official passenger FAQ',
}


def ingest(source,ctx):
    sid=source['source_id'];rows=[]
    for domain in source['domains']:
        payload={'title':TITLES.get(sid,sid),'topics':[domain],'url':source['url']}
        row=ctx.record('official',payload,{},license='unknown',rights_status='metadata_only',source_url=source['url'],domain=domain,language='en',scope='national',rights_review_status='no_fulltext_permission',source_key=domain)
        # Distinct per-domain metadata records, no assertion that the page was successfully fetched.
        from ..core import stable_id
        row['id']=stable_id(sid,'official',domain,source['url'])
        rows.append(row)
        ctx.event(sid,'discovered',domain=domain)
        ctx.event(sid,'skipped','Metadata-only registry entry; no body or asset download authorized',record_id=row['id'],domain=domain)
    return rows
