"""Parse documented, robots-permitted canonical Wikimedia HTML pages.

No API parameters are hidden inside these requests. Rights are read from each
article footer or each file's licensing template, never inferred from host alone.
"""
import re
from pathlib import Path
from urllib.parse import quote, urljoin, unquote
from bs4 import BeautifulSoup


def canonical_url(base,title):
    return base.rstrip('/')+'/wiki/'+quote(title.replace(' ','_'),safe=":'(),")


def read_page(ctx,source,url,max_bytes=8*1024*1024):
    meta=ctx.http.fetch(url,source['source_id'],max_bytes=max_bytes)
    text=Path(meta['path']).read_text(encoding='utf-8')
    if '<html' not in text[:2000].lower():raise ValueError('Expected canonical HTML page')
    return BeautifulSoup(text,'html.parser'),text,meta


def config_value(raw,name):
    match=re.search(r'"'+re.escape(name)+r'"\s*:\s*("[^"\\]*"|[0-9]+)',raw)
    if not match:return None
    return match[1][1:-1] if match[1].startswith('"') else int(match[1])


def article_identity(soup,raw):
    qid=None;link=soup.select_one('#t-wikibase a[href]')
    if link:
        match=re.search(r'/Q([1-9]\d*)$',link['href'])
        if match:qid='Q'+match[1]
    qid=qid or config_value(raw,'wgWikibaseItemId')
    pageid=config_value(raw,'wgArticleId');revid=config_value(raw,'wgRevisionId')
    if not pageid or not revid:raise ValueError('Missing article/page revision identifiers')
    return qid,pageid,revid


def article_license(soup):
    footer=soup.select_one('#footer-info-copyright')
    if not footer:raise ValueError('No article copyright footer')
    for a in footer.select('a[href]'):
        href=unquote(a['href']);txt=a.get_text(' ',strip=True)
        if ('creativecommons.org/licenses/by-sa/4.0' in href or 'CC_BY-SA_4.0' in href or 'Attribution-ShareAlike_4.0' in href or ('Attribution-ShareAlike 4.0' in txt)):
            return 'CC-BY-SA-4.0','https://creativecommons.org/licenses/by-sa/4.0/',href
        if 'creativecommons.org/licenses/by-sa/3.0' in href:return 'CC-BY-SA-3.0','https://creativecommons.org/licenses/by-sa/3.0/',href
    raise ValueError('Article footer did not explicitly establish supported CC BY-SA license')


def article_text(soup):
    body=soup.select_one('#mw-content-text .mw-parser-output') or soup.select_one('.mw-parser-output')
    if body is None:raise ValueError('No article body')
    body=BeautifulSoup(str(body),'html.parser')
    for el in body.select('script,style,table,figure,nav,aside,sup,.mw-editsection,.reflist,.navbox,.metadata,.hatnote,.mw-empty-elt,.noprint'):
        el.decompose()
    parts=[]
    for el in body.find_all(['h2','h3','h4','p']):
        text=el.get_text(' ',strip=True)
        if not text:continue
        if el.name.startswith('h'):parts.append('\n'+'#'*int(el.name[1])+' '+text+'\n')
        else:parts.append(text)
    return '\n\n'.join(parts).strip()
