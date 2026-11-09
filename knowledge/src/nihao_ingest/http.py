"""Bounded serial HTTP, conservative robots handling, validator-based resumption."""
from __future__ import annotations
import json, os, re, time, hashlib
from pathlib import Path
from urllib.parse import urlparse, urljoin
from protego import Protego
from email.utils import parsedate_to_datetime
import requests
from .core import stable_id, utcnow, append_jsonl

class FetchError(RuntimeError):
    def __init__(self, message, category='unknown', status=None):
        super().__init__(message); self.category=category; self.status=status

def sha256_file(path):
    digest=hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):digest.update(block)
    return digest.hexdigest()

class HttpClient:
    def __init__(self, root, contact=None, max_total_mb=500, timeout=30, retries=2, delay=1.0, session=None):
        contact = contact or os.getenv('NIHAO_CONTACT', '')
        if not contact or not ('@' in contact or contact.startswith('https://')) or '\n' in contact:
            raise FetchError('NIHAO_CONTACT must be a real contact email or project contact URL')
        self.root=Path(root); self.contact=contact; self.max_bytes=int(max_total_mb*1024*1024)
        self.transferred=0; self.timeout=timeout; self.retries=retries; self.delay=delay
        self.session=session or requests.Session()
        self.session.headers.update({'User-Agent':f'NihaoKnowledge/0.1 ({contact})', 'Accept-Encoding':'gzip'})
        self.robots_cache={}; self.last_request={}; self.date=utcnow()[:10]
        self.log_path=self.root/'manifests/http.jsonl'
    def _log(self, **kw): append_jsonl(self.log_path, dict(timestamp=utcnow(), **kw))
    def _request(self, method, url, **kwargs):
        host='wikimedia-global' if any(urlparse(url).hostname.endswith(x) for x in ('wikimedia.org','wikipedia.org','wikidata.org','wikivoyage.org')) else urlparse(url).netloc
        wait=self.delay-(time.monotonic()-self.last_request.get(host,0))
        if wait>0: time.sleep(wait)
        self.last_request[host]=time.monotonic()
        return self.session.request(method,url,timeout=(10,self.timeout),allow_redirects=False,stream=True,**kwargs)
    def _consume(self, response, cap):
        data=bytearray()
        for part in response.iter_content(65536):
            self.transferred+=len(part)
            if len(data)+len(part)>cap or self.transferred>self.max_bytes: raise FetchError('response or total byte budget exceeded')
            data.extend(part)
        return bytes(data)
    def robots(self, url, source_id='validation'):
        p=urlparse(url)
        if p.scheme not in ('http','https') or not p.netloc or p.username or p.password: raise FetchError('invalid public HTTP URL')
        origin=f'{p.scheme}://{p.netloc}'
        if origin not in self.robots_cache:
            robots_url=origin+'/robots.txt'; result={'url':robots_url,'checked_at':utcnow()}
            try:
                r=self._request('GET',robots_url)
                # No silent follow of robots redirects to unrelated hosts.
                redirects=0
                while r.status_code in (301,302,303,307,308) and redirects<3:
                    target=urljoin(robots_url,r.headers.get('Location','')); r.close()
                    if urlparse(target).hostname!=p.hostname: raise FetchError('cross-host robots redirect needs review')
                    robots_url=target; r=self._request('GET',robots_url); redirects+=1
                result['http_status']=r.status_code
                if r.status_code in (404,410):
                    result.update(allowed=True, reason='robots absent (404/410)',category='robots_absent'); parser=None
                elif r.status_code==200:
                    body=self._consume(r,1024*1024).decode('utf-8','replace')
                    if '<html' in body[:1000].lower(): raise FetchError('robots response is HTML, not valid policy text','robots_parse_error')
                    parser=Protego.parse(body.lstrip("\ufeff"))
                    result.update(allowed=True,reason='robots parsed',category='robots_allowed')
                    path=self.root/'raw'/source_id/self.date/(stable_id(robots_url)+'.robots.txt')
                    path.parent.mkdir(parents=True,exist_ok=True);path.write_text(body)
                    result['path']=str(path.resolve())
                    crawl_delay=parser.crawl_delay('NihaoKnowledge') or parser.crawl_delay('*')
                    if crawl_delay: self.delay=max(self.delay,float(crawl_delay))
                    rate=parser.request_rate('NihaoKnowledge')
                    if rate: self.delay=max(self.delay,rate.seconds/rate.requests)
                else:
                    parser=None;result.update(allowed=False,reason=f'robots HTTP {r.status_code}; fail closed',category='robots_rate_limited' if r.status_code==429 else 'robots_http_error')
                r.close()
            except (requests.RequestException,FetchError) as e:
                parser=None;result.update(allowed=False,reason=str(e),category=getattr(e,'category','robots_unavailable'))
            self.robots_cache[origin]=(result,parser)
            self._log(source_id=source_id,purpose='robots',**result)
        result,parser=self.robots_cache[origin]
        allowed=result['allowed'] and (parser is None or parser.can_fetch(url,'NihaoKnowledge'))
        return dict(result,allowed=allowed,target_url=url,category=('robots_disallowed' if result['allowed'] and not allowed else result.get('category')),reason=result['reason'] if allowed else ('robots explicitly disallows target path' if result['allowed'] else result['reason']))
    def fetch(self,url,source_id,*,max_bytes=8*1024*1024,method='GET',headers=None,purpose='data',resume=True):
        if max_bytes<=0: raise FetchError('invalid per-URL limit')
        policy=self.robots(url,source_id)
        if not policy['allowed']:
            self._log(source_id=source_id,url=url,status='blocked',purpose=purpose,reason=policy['reason'])
            raise FetchError(f"{url}: {policy['reason']}",policy.get('category','robots_unavailable'),policy.get('http_status'))
        directory=self.root/'raw'/source_id/self.date;directory.mkdir(parents=True,exist_ok=True)
        key=stable_id(url,method);dest=directory/(key+'.bin');meta_path=directory/(key+'.metadata.json')
        part=dest.with_suffix('.part');part_meta=dest.with_suffix('.part.json')
        if resume and method=='GET' and dest.exists() and meta_path.exists():
            old=json.loads(meta_path.read_text())
            if old.get('url')==url and old.get('bytes')==dest.stat().st_size and old['bytes']<=max_bytes:
                digest=sha256_file(dest)
                if old.get('sha256') and old['sha256']!=digest: raise FetchError('cached SHA256 mismatch: '+str(dest),'integrity_error')
                old.update(sha256=digest,sha256_verified=True,sha256_checked_at=utcnow(),integrity_basis='local_re_read; upstream digest not supplied')
                meta_path.write_text(json.dumps(old,indent=2))
                return dict(old,cached=True)
        current=url; redirs=0
        for attempt in range(self.retries+1):
            request_headers=dict(headers or {}); offset=0; validators={}
            if urlparse(url).hostname=='upload.wikimedia.org' or urlparse(url).path.endswith('.pbf'): request_headers['Accept-Encoding']='identity'
            if resume and method=='GET' and part.exists() and part_meta.exists():
                validators=json.loads(part_meta.read_text());validator=validators.get('etag') or validators.get('last_modified')
                if validator and not str(validator).startswith('W/') and validators.get('content_encoding','identity')=='identity':
                    offset=part.stat().st_size;request_headers.update({'Accept-Encoding':'identity','Range':f'bytes={offset}-','If-Range':validator})
            r=None;started=time.monotonic();written=0
            try:
                r=self._request(method,current,headers=request_headers)
                if r.status_code in (301,302,303,307,308):
                    # Every destination must pass its own robots rules before requesting.
                    while r.status_code in (301,302,303,307,308):
                        if redirs>=5: raise FetchError('redirect limit')
                        current=urljoin(current,r.headers.get('Location',''));r.close();redirs+=1
                        rp=self.robots(current,source_id)
                        if not rp['allowed']: raise FetchError(rp['reason'])
                        r=self._request(method,current,headers=request_headers)
                self._log(source_id=source_id,url=url,final_url=current,status=r.status_code,purpose=purpose,attempt=attempt,etag=r.headers.get('ETag'),last_modified=r.headers.get('Last-Modified'))
                if r.status_code in (429,500,502,503,504):
                    retry=r.headers.get('Retry-After');pause=2**attempt
                    if retry:
                        try: pause=max(pause,float(retry))
                        except ValueError:
                            try: pause=max(pause,parsedate_to_datetime(retry).timestamp()-time.time())
                            except (ValueError,TypeError): pass
                    if attempt==self.retries or pause>60: raise FetchError(f'HTTP {r.status_code}; retry deferred ({pause}s)','api_rate_limited' if r.status_code==429 else 'http_server_error',r.status_code)
                    r.close();time.sleep(pause);continue
                if r.status_code not in (200,206): raise FetchError(f'HTTP {r.status_code}','http_access_denied' if r.status_code in (401,403) else 'http_error',r.status_code)
                if r.status_code==206:
                    if r.headers.get('Content-Encoding','identity')!='identity': raise FetchError('encoded 206 response cannot safely resume decoded bytes','invalid_resume')
                    match=re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)',r.headers.get('Content-Range',''))
                    if not offset or not match or int(match[1])!=offset: raise FetchError('invalid resume Content-Range')
                    if validators.get('etag') and r.headers.get('ETag')!=validators['etag']: raise FetchError('resume ETag changed')
                    if not validators.get('etag') and validators.get('last_modified') != r.headers.get('Last-Modified'): raise FetchError('resume Last-Modified changed')
                    if int(match[3])>max_bytes: raise FetchError('resume total exceeds per-URL cap')
                else: offset=0
                size=int(r.headers.get('Content-Length','0'))
                if method!='HEAD' and (size+offset>max_bytes or self.transferred+size>self.max_bytes): raise FetchError('Content-Length exceeds download budget')
                result=dict(url=url,final_url=current,status=r.status_code,path=str(dest.resolve()),bytes=0,fetched_at=utcnow(),etag=r.headers.get('ETag'),last_modified=r.headers.get('Last-Modified'),content_type=r.headers.get('Content-Type',''),content_length=size,content_encoding=r.headers.get('Content-Encoding','identity'),cached=False,purpose=purpose)
                if method=='HEAD':
                    result.update(path=None,bytes=0);meta_path.write_text(json.dumps(result,indent=2));return result
                part_meta.write_text(json.dumps(result))
                with part.open('ab' if offset else 'wb') as f:
                    for block in r.iter_content(65536):
                        self.transferred+=len(block);written+=len(block)
                        if offset+written>max_bytes or self.transferred>self.max_bytes: raise FetchError('stream exceeds per-URL or total budget')
                        f.write(block)
                        if urlparse(current).hostname=='upload.wikimedia.org':
                            pause=written/(2*1024*1024)-(time.monotonic()-started)
                            if pause>0: time.sleep(pause)
                if size and r.headers.get('Content-Encoding','identity')=='identity' and written!=size: raise FetchError('incomplete transfer length')
                if r.status_code==206 and offset+written!=int(match[3]): raise FetchError('incomplete resumed object')
                part.replace(dest);part_meta.unlink(missing_ok=True)
                result['bytes']=dest.stat().st_size
                result['sha256']=sha256_file(dest);result['sha256_verified']=result['sha256']==sha256_file(dest)
                result['integrity_basis']='local_re_read; upstream digest not supplied';result['sha256_checked_at']=utcnow()
                result['content_encoding']=r.headers.get('Content-Encoding','identity');result['elapsed_seconds']=round(time.monotonic()-started,3)
                meta_path.write_text(json.dumps(result,indent=2))
                self._log(source_id=source_id,url=url,purpose=purpose,status='download_complete',bytes=written,path=str(dest.resolve()))
                return result
            except (requests.RequestException,FetchError,ValueError) as e:
                self._log(source_id=source_id,url=url,purpose=purpose,status='failed',reason=str(e),category=getattr(e,'category','transport_error'),bytes=written,attempt=attempt)
                if isinstance(e,requests.RequestException) and attempt<self.retries:
                    time.sleep(2**attempt);continue
                raise FetchError(f'{url}: {e}',getattr(e,'category','transport_error'),getattr(e,'status',None)) from e
            finally:
                if r is not None:r.close()
        raise FetchError('retry limit exhausted')
    def json(self,url,source_id,**kwargs):
        meta=self.fetch(url,source_id,**kwargs)
        try: return json.loads(Path(meta['path']).read_text()),meta
        except (ValueError,TypeError) as e: raise FetchError(f'JSON parse failed: {url}: {e}','response_parse_error') from e
