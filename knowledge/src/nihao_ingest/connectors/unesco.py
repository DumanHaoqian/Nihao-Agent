"""Schema-led Opendatasoft v2.1 downloads, explicitly restricted to China."""
import json
import re
from .common import api_url, accepted
from ..core import stable_id


def license_is_open(schema):
    """Only license metadata can authorize a download, not arbitrary record text."""
    metas = schema.get('metas', {})
    values = []
    for block in metas.values():
        if isinstance(block, dict):
            values += [str(v) for k, v in block.items() if 'license' in k.lower()]
    values += [str(v) for k, v in schema.items() if k.lower() in ('license', 'license_url')]
    text = ' '.join(values).lower()
    return bool(re.search(r'cc[ -]?by[ -]?sa[ -]?4[.]0|creativecommons.org/licenses/by-sa/4[.]0', text))


def select_field(fields, names, words=()):
    for desired in names:
        for field in fields:
            if field.get('name', '').lower() == desired:
                return field['name']
    for field in fields:
        label = (field.get('name', '') + ' ' + field.get('label', '')).lower()
        if any(word in label for word in words) and field.get('type') not in ('geo_point_2d', 'geo_shape'):
            return field['name']
    return None


def china_value(value):
    if isinstance(value, (list, dict)):
        return any(china_value(v) for v in (value.values() if isinstance(value, dict) else value))
    # Exact country tokens include multilingual and ISO representations. Avoid matching descriptions.
    return any(v.strip().lower() in {'china', "people's republic of china", 'chn', 'cn', '中国', 'chine', 'china (people’s republic of)'}
               for v in re.split(r'[;,|]', str(value or '')))


def ingest(source, ctx):
    sid = source['source_id']; dataset = source['dataset_id']
    base = 'https://data.unesco.org/api/explore/v2.1/catalog/datasets/' + dataset
    schema, schema_meta = ctx.http.json(base, sid, max_bytes=3*1024*1024, purpose='schema')
    if not license_is_open(schema):
        ctx.review(sid, base, 'Dataset license metadata does not explicitly establish CC BY-SA 4.0')
        ctx.event(sid, 'skipped', 'Dataset license unresolved')
        return []
    fields = schema.get('fields', [])
    country = select_field(fields, ['states_name_en','country','countries','country_en','countries_en','states_parties','states','iso_code'], ['country', 'countries', 'states part'])
    if not country or not re.fullmatch(r'[a-zA-Z_][a-zA-Z0-9_]*', country):
        raise ValueError('No unambiguous country field in live dataset schema; not guessing')
    title = select_field(fields, ['name_en','name','title_en','title','element_name_en','site'], ['name english', 'title'])
    desc = select_field(fields, ['short_description_en','description_en','description','short_description'], ['description'])
    ident = select_field(fields, ['id_no','id_number','id','element_id','id_element'], ['identifier'])
    # Probe the records route before export. search() supports scalar and multivalue text fields.
    expression = f'search({country}, "China")'
    probe, _ = ctx.http.json(api_url(base+'/records', where=expression, limit=1), sid, max_bytes=2*1024*1024, purpose='export_probe')
    if not isinstance(probe.get('results'), list):
        raise ValueError('UNESCO records response has no results array')
    if not probe['results']:
        ctx.event(sid, 'skipped', 'No China records returned by schema-derived query', country_field=country)
        return []
    exported, meta = ctx.http.json(api_url(base+'/exports/json', where=expression, limit=ctx.max_items), sid, max_bytes=12*1024*1024)
    if not isinstance(exported, list):
        raise ValueError('UNESCO JSON export is not an array')
    rows=[]
    for record in exported[:ctx.max_items]:
        ctx.event(sid, 'discovered', source_key=record.get(ident) if ident else None)
        if not china_value(record.get(country)):
            ctx.event(sid, 'skipped', 'Country value could not be confirmed as China', country_field=country, country_value=record.get(country))
            continue
        ctx.event(sid, 'eligible', license='CC-BY-SA-4.0')
        key = str(record.get(ident, '')) if ident else str(record.get(title, ''))
        if not key:
            ctx.event(sid, 'skipped', 'No stable record key or title')
            continue
        row = ctx.record('unesco', record, meta, license='CC-BY-SA-4.0', source_url=source['url'], dataset_id=dataset, schema=fields, country_field=country, title_field=title, description_field=desc, id_field=ident, language='en', scope='national', attribution='UNESCO', license_url='https://creativecommons.org/licenses/by-sa/4.0/', schema_path=schema_meta['path'])
        row['id'] = stable_id(sid, dataset, key)
        row['record_key'] = key
        row['export_url'] = meta['url']
        rows.append(accepted(ctx, source, row))
    return rows
