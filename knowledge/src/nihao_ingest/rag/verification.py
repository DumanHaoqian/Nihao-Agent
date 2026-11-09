"""Policy-respecting official endpoint availability, never policy eligibility."""
from pathlib import Path
from ..validation import load_registry
from ..http import HttpClient,FetchError
from ..core import utcnow

def verify(source_id):
 source=next((s for s in load_registry('config/sources.yaml')['sources'] if s['source_id']==source_id and s['access_strategy']=='metadata_only'),None)
 if source is None:raise ValueError('Unknown official reference')
 result={'source_id':source_id,'official_url':source['url'],'checked_at':utcnow(),'verification_required':True,'policy_content_verified':False}
 try:
  meta=HttpClient(Path('data/verification'),max_total_mb=2,retries=0).fetch(source['url'],source_id,method='HEAD',max_bytes=1024,purpose='official_availability')
  result.update(status='endpoint_reachable',http_status=meta.get('status'),metadata=meta)
 except FetchError as error:result.update(status='blocked_or_failed',category=error.category,reason=str(error))
 result['note']='Checks endpoint availability under robots rules only. Does not verify eligibility, rules, timetables or prices.'
 return result
