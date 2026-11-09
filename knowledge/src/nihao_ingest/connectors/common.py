"""Shared bounded API helpers; no hidden scraping or credential fallback."""
from urllib.parse import urlencode
import re


def api_url(base, **params):
    return base + ('&' if '?' in base else '?') + urlencode(params)


def mw(ctx, source, **params):
    params.setdefault('maxlag', 5)
    data, meta = ctx.http.json(api_url(source['api'], format='json', formatversion=2, **params), source['source_id'], max_bytes=8*1024*1024)
    if 'error' in data:
        raise ValueError('MediaWiki API error: ' + str(data['error']))
    return data, meta


def field_value(metadata, key):
    value = metadata.get(key, '')
    return str(value.get('value', '')) if isinstance(value, dict) else str(value or '')


def is_qid(value):
    return bool(re.fullmatch(r'Q[1-9][0-9]*', str(value or '')))


def accepted(ctx, source, row, **info):
    ctx.event(source['source_id'], 'downloaded', record_id=row['id'], kind=row['kind'], **info)
    return row
