"""Local, evidence-only retrieval for future Agent tools; never writes through HTTP."""
from __future__ import annotations
import json
import math
import re
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from ..core import read_jsonl, write_jsonl

DOMAINS = {'entry_visa', 'daily_life', 'attractions', 'food_culture', 'transportation'}
FOCUS_BOILERPLATE = set('information available licensed photographs photograph photos photo pictures picture images image videos video source sources timestamp timestamps find documented records record show provide tell details about international visitors location located'.split())
PILOT_LOCATIONS = {'beijing', 'shanghai', 'chengdu', 'xian', 'guangzhou'}

STOP = set('a an and are as at be by can could do does for from how i in is it me my of on or show some tell the this to what where which with would china chinese travel tourist visitors please'.split())

def tokens(value):
    text = str(value).casefold()
    result = [s for s in re.findall(r'[a-z0-9]+', text) if s not in STOP and len(s) > 1]
    for run in re.findall(r'[\u3400-\u9fff]+', text):
        result.extend(run[i:i+2] for i in range(len(run)-1))
        if len(run) == 1: result.append(run)
    return result

def _entity_mentions(question, entities):
    # Names are read from source labels/aliases; this is textual identity retrieval,
    # never a claim that media depicts a place based on visual appearance.
    found = []
    folded = question.casefold()
    for entity_id, entity in entities.items():
        aliases = entity.get('aliases') or []
        names = [entity.get('name_en'), entity.get('name_zh')] + aliases
        for name in names:
            if not isinstance(name, str) or len(name.strip()) < 2:
                continue
            name = name.strip()
            if re.search(r'[\u3400-\u9fff]', name):
                mentioned = name in question
            else:
                mentioned = bool(re.search(r'(?<!\w)' + re.escape(name.casefold()) + r'(?!\w)', folded))
            if mentioned:
                found.append((entity_id, name))
    # A longer named POI supersedes a city/short alias contained within its name.
    return [(eid, name) for eid, name in found if not any(name.casefold() != other.casefold() and name.casefold() in other.casefold() for _, other in found)]

def _focused_question(question):
    for phrase in ('请给我介绍', '请介绍', '请展示', '请提供', '给我看看', '请问', '介绍一下', '介绍', '是什么', '有哪些信息', '的信息', '相关信息', '在哪里', '照片', '图片', '视频', '时间戳', '合法', '许可明确', '展示', '查看', '关于'):
        question = question.replace(phrase, ' ')
    return question.replace('的', ' ')



def content_body(text):
    """Remove section headings solely for relevance checks; retain original excerpts."""
    lines=[line for line in str(text).splitlines() if not re.match(r'^\s*(?:#{1,6}\s+.*|={2,6}.*={2,6}\s*)$',line)]
    return '\n'.join(lines).strip()

def has_content(text):
    return any(character.isalnum() for character in content_body(text))

def infer_query_language(question):
    if re.search(r'请|介绍|什么|哪里|怎样|哪些|如何|吗[？?]?|呢[？?]?',question):return 'zh'
    if re.search(r'\b(what|where|how|show|tell|please|is|are)\b',question,re.I):return 'en'
    return 'zh' if re.search(r'[\u3400-\u9fff]',question) else 'en'

def text_units(text):
    text=content_body(text)
    return len(re.findall(r'[\u3400-\u9fff]',text))+1.3*len(re.findall(r'[A-Za-z0-9]+',text))


def approved(row):
    return row.get('rights_status') == 'approved' and row.get('content_status') not in {'metadata_only', 'quarantined', 'withdrawn', 'needs_review', 'failed'}

def build_index(root):
    """Explicit mutable indexing command. Query itself reads current source records.

    The small JSONL index is inspectable metadata/text only. Live queries use normalized
    files so withdrawn content cannot be served from a stale persisted index.
    """
    root = Path(root)
    chunks = [c for c in read_jsonl(root / 'normalized/chunks.jsonl') if approved(c) and has_content(c.get('text',''))]
    rows = [dict(c, search_terms=dict(Counter(tokens(c.get('text', ''))))) for c in chunks]
    write_jsonl(root / 'indexes/text/chunks.jsonl', rows)
    return {'indexed_chunks': len(rows), 'backend': 'local_keyword', 'embeddings': False}

def _reference(row, kind='chunk'):
    return {key: row.get(key) for key in ('source_id', 'source_url', 'license', 'last_verified_at', 'data_version')} | {
        'kind': kind, 'id': row.get('chunk_id') or row.get('document_id') or row.get('asset_id') or row.get('source_id'),
        'attribution': row.get('attribution'), 'history_url': row.get('history_url'),
        'license_url': row.get('license_url'), 'attribution_url': row.get('attribution_url'),
    }

def _external_references(root, domain):
    docs = read_jsonl(root / 'normalized/documents.jsonl')
    sources = read_jsonl(root / 'normalized/sources.jsonl')
    rows = [r for r in docs if r.get('rights_status') == 'metadata_only']
    rows += [dict(r, source_url=r.get('source_url') or r.get('url')) for r in sources if r.get('access_strategy') == 'metadata_only']
    unique = {}
    for row in rows:
        if row.get('status') in {'withdrawn', 'quarantined'} or row.get('rights_status') == 'withdrawn' or row.get('content_status') in {'withdrawn', 'quarantined'}:
            continue
        domains = row.get('domains') or [row.get('domain')]
        if domain and domain not in domains and domain != row.get('domain'):
            continue
        url = row.get('source_url')
        if url:
            unique[url] = _reference(row, 'official_external_reference') | {
                'title': row.get('title') or row.get('source_id'), 'body_indexed': False,
                'access_status': row.get('status'), 'rights_status': 'metadata_only',
            }
    return list(unique.values())

def entity_bundle(root, entity_id):
    """Return exact entity associations with evidence. No name-based media inference."""
    root = Path(root)
    entities = read_jsonl(root / 'normalized/entities.jsonl')
    entity = next((e for e in entities if e.get('entity_id') == entity_id), None)
    if not entity:
        return {'status': 'not_found', 'entity': None, 'chunks': [], 'media': [], 'segments': [], 'links': []}
    chunks = [c for c in read_jsonl(root / 'normalized/chunks.jsonl') if c.get('entity_id') == entity_id and approved(c) and has_content(c.get('text',''))]
    links = [l for l in read_jsonl(root / 'normalized/links.jsonl') if l.get('from_id') == entity_id and l.get('confidence', 0) >= .9]
    linked = {l.get('to_id') for l in links}
    media = [m for m in read_jsonl(root / 'normalized/media.jsonl') if m.get('asset_id') in linked and approved(m)]
    assets = {m['asset_id'] for m in media}
    segments = [s for s in read_jsonl(root / 'normalized/media_segments.jsonl') if s.get('asset_id') in assets and approved(s)]
    return {'status': 'found', 'entity': entity, 'chunks': chunks, 'media': media, 'segments': segments, 'links': links}

def query(root, question, domain=None, limit=5):
    """Retrieve licensed excerpts, never synthesize eligibility, schedules or allergens.

    An evidence_found response means matching source excerpts exist, not that the
    question has been fully answered. Consumers must retain citations and rights.
    """
    if domain is not None and domain not in DOMAINS:
        raise ValueError('unknown domain')
    if not isinstance(question, str) or not question.strip() or len(question) > 2000:
        raise ValueError('question must be 1–2000 characters')
    if not 1 <= limit <= 20:
        raise ValueError('limit must be between 1 and 20')
    root = Path(root)
    query_language = infer_query_language(question)
    external = _external_references(root, domain)
    unsafe = bool(re.search(r'\b(visa|visa[- ]free|passport|entry eligibility|transit exemption|ticket price|fare|timetable|next train|allergens?|allerg(?:y|ies)|ingredients from|safe to eat)\b|签证|免签|护照|入境资格|过敏|能否安全食用|是否安全食用|票价|车票价格|时刻表|实时班次', question, re.I))
    requires_current = bool(re.search(r'\b(current|today|tonight|tomorrow|latest|now|this week)\b|今天|明天|今晚|现在|当前|最新|本周|这周|实时|目前', question, re.I))
    base = {'question': question, 'query_language': query_language, 'domain': domain, 'results': [], 'media': [], 'segments': [], 'citations': [], 'external_references': external, 'answer_mode': 'evidence_only', 'backend': 'local_keyword'}
    if domain == 'entry_visa' or unsafe or requires_current:
        return base | {'status': 'verification_required', 'message': 'This local snapshot cannot establish current entry eligibility, live prices or schedules, or food safety. Verify the relevant official source; no factual conclusion was generated.'}
    entities = {e.get('entity_id'): e for e in read_jsonl(root / 'normalized/entities.jsonl')}
    mentions = _entity_mentions(question, entities)
    mentioned_ids = {eid for eid, _ in mentions}
    residual = question
    for _, name in sorted(mentions, key=lambda item: -len(item[1])):
        residual = re.sub(re.escape(name), ' ', residual, flags=re.I)
    focused = _focused_question(residual if mentions else question)
    raw_terms = set(tokens(focused))
    locations = raw_terms & PILOT_LOCATIONS
    terms = raw_terms - FOCUS_BOILERPLATE - PILOT_LOCATIONS
    # City overlap alone must never answer a question about a specific POI.
    terms = terms or locations
    requested_modality = 'video' if re.search(r'\bvideos?\b|视频', question, re.I) else 'image' if re.search(r'\b(photos?|photographs?|pictures?|images?)\b|图片|照片', question, re.I) else None
    needs_timestamp = requested_modality == 'video' and bool(re.search(r'\btimestamps?\b|时间戳', question, re.I))
    chunks = [c for c in read_jsonl(root / 'normalized/chunks.jsonl') if approved(c) and has_content(c.get('text','')) and (not domain or c.get('domain') == domain)]
    documents = {d.get('document_id'): d for d in read_jsonl(root / 'normalized/documents.jsonl')}
    entities = {e.get('entity_id'): e for e in read_jsonl(root / 'normalized/entities.jsonl')}
    overview_query = bool(mentioned_ids and not terms and re.search(r'^\s*(?:what (?:is|are)\b|请介绍|介绍)',question,re.I))
    scored = []
    bundles = {}
    for chunk in chunks:
        if chunk.get('is_time_sensitive'):
            continue
        if mentioned_ids and chunk.get('entity_id') not in mentioned_ids:
            continue
        entity = entities.get(chunk.get('entity_id'), {})
        title = ' '.join(str(entity.get(k) or '') for k in ('name_en', 'name_zh'))
        haystack = title + ' ' + chunk['text'] + ' ' + str(entity.get('city') or chunk.get('city') or '')
        wordcounts = Counter(tokens(haystack))
        overlap = terms & set(wordcounts)
        if (not terms and not mentioned_ids) or not terms.issubset(wordcounts) or not locations.issubset(wordcounts):
            continue
        if requested_modality:
            eid = chunk.get('entity_id')
            if eid not in bundles:
                bundles[eid] = entity_bundle(root, eid)
            matching = [m for m in bundles[eid]['media'] if m.get('modality') == requested_modality]
            if not matching:
                continue
            if needs_timestamp and not any(s.get('asset_id') in {m['asset_id'] for m in matching} and isinstance(s.get('start_seconds'), (int, float)) and isinstance(s.get('end_seconds'), (int, float)) and s['end_seconds'] > s['start_seconds'] >= 0 for s in bundles[eid]['segments']):
                continue
        score = sum(1 + math.log1p(wordcounts[t]) for t in overlap) / max(1, len(terms))
        score += 2 * len(overlap & set(tokens(title))) + (10 if mentioned_ids else 0)
        units=text_units(chunk['text'])
        language_match=str(chunk.get('language','')).lower().startswith(query_language)
        overview_match=overview_query and chunk.get('char_start',0)==0 and units>=40 and chunk.get('source_kind') in {'wikipedia','wikivoyage','unesco'}
        row = chunk | {'score': round(score, 6), 'matched_terms': sorted(overlap), 'matched_entity_ids': sorted(mentioned_ids), 'language_match':language_match, 'overview_match':bool(overview_match), 'content_units':round(units,1)}
        # Page revision attribution may live on the parent document.
        for key in ('attribution_url', 'history_url', 'attribution', 'license_url'):
            row.setdefault(key, documents.get(chunk.get('document_id'), {}).get(key))
        scored.append(row)
    # Ranking is shared by the public query API and live examples. Language,
    # a sourced lead paragraph, and actual prose outrank opaque chunk IDs.
    scored.sort(key=lambda r: (-int(r['language_match']),-int(r['overview_match']),-int(r['content_units']>=40),-r['score'],-int(r.get('source_kind') in {'wikipedia','wikivoyage','unesco'}),r.get('char_start',0),str(r.get('chunk_id'))))
    results = scored[:limit]
    if not results:
        return base | {'status': 'insufficient_evidence', 'message': 'No licensed evidence matches all focused query terms and any requested media/timestamp requirements in this snapshot. I cannot answer from this knowledge base.'}
    media_by_id = {}
    segments_by_id = {}
    for entity_id in {r.get('entity_id') for r in results if r.get('entity_id')}:
        bundle = bundles.get(entity_id) or entity_bundle(root, entity_id)
        for media in bundle['media']:
            if not requested_modality or media.get('modality') == requested_modality:
                media_by_id[media['asset_id']] = media
        for segment in bundle['segments']:
            if segment.get('asset_id') in media_by_id:
                segments_by_id[segment['segment_id']] = segment
    media = list(media_by_id.values())
    return base | {'status': 'evidence_found', 'message': 'Candidate source excerpts match the focused terms and requested media requirements. Their relevance to a complete answer remains unverified; no factual answer was generated.', 'results': results, 'media': media, 'segments': list(segments_by_id.values()), 'citations': [_reference(r) for r in results] + [_reference(m, m.get('modality', 'media')) for m in media]}

def serve(root, host='127.0.0.1', port=8790):
    """Unauthenticated MVP binds loopback only, GET /query and /entity only."""
    if host not in {'127.0.0.1', 'localhost', '::1'}:
        raise ValueError('read-only MVP server must bind loopback')
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # Questions may contain personal information; do not log them.
        def _send(self, status, value):
            body = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers(); self.wfile.write(body)
        def do_GET(self):
            parsed = urlparse(self.path); args = parse_qs(parsed.query)
            try:
                if parsed.path == '/query':
                    result = query(root, args.get('q', [''])[0], args.get('domain', [None])[0], int(args.get('limit', ['5'])[0]))
                elif parsed.path == '/entity':
                    result = entity_bundle(root, args.get('id', [''])[0])
                elif parsed.path == '/health':
                    result = {'status': 'ok', 'read_only': True}
                else:
                    self._send(404, {'error': 'not_found'}); return
                self._send(200, result)
            except (ValueError, TypeError) as exc:
                self._send(400, {'error': str(exc)})
        def do_POST(self):
            self._send(405, {'error': 'read_only'})
        do_PUT = do_DELETE = do_PATCH = do_POST
    server = ThreadingHTTPServer((host, port), Handler)
    try:
        server.serve_forever()
    finally:
        server.server_close()
