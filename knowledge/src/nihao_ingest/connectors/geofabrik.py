"""Official regional OSM snapshot with bounded local POI extraction."""
import shutil
from pathlib import Path
from .common import accepted, is_qid


def domain_for(tags):
    if tags.get('railway') in ('station','halt','tram_stop') or tags.get('public_transport') == 'station' or tags.get('aeroway') == 'aerodrome':
        return 'transportation'
    if tags.get('tourism') in ('attraction','museum','viewpoint','artwork','gallery') or tags.get('historic'):
        return 'attractions'
    if tags.get('amenity') in ('atm','bank','hospital','pharmacy','toilets','police'):
        return 'daily_life'
    return None


def ingest(source, ctx):
    sid=source['source_id']
    if source.get('requires_flag') == 'full-osm' and not ctx.full_osm:
        ctx.event(sid,'skipped','Requires explicit --full-osm; nationwide PBF not downloaded')
        return []
    ctx.event(sid,'discovered',url=source['url'])
    ctx.event(sid,'eligible',license='ODbL-1.0')
    meta=ctx.http.fetch(source['url'],sid,max_bytes=(3*1024**3 if ctx.full_osm and source.get('requires_flag') else 450*1024**2))
    # pyosmium chooses decoder from extension. Hardlink avoids duplicating a large raw snapshot.
    path=Path(meta['path']).with_suffix('.osm.pbf')
    if not path.exists():
        try:path.hardlink_to(meta['path'])
        except OSError:shutil.copyfile(meta['path'],path)
    ctx.event(sid,'downloaded','Raw PBF downloaded; extraction tracked separately',bytes=meta['bytes'],path=str(path),kind='raw_osm_snapshot')
    try:
        import osmium
    except ImportError:
        ctx.event(sid,'skipped','osmium dependency unavailable; PBF retained, parse not completed')
        return []
    rows=[]
    # Bounded, evenly allocated node sampling; ways/relations are deliberately not fabricated as points.
    cap=max(1,ctx.max_items//3); counts={d:0 for d in ('attractions','transportation','daily_life')}
    class Handler(osmium.SimpleHandler):
        def node(self,node):
            if len(rows)>=ctx.max_items:return
            tags=dict(node.tags);domain=domain_for(tags)
            if not domain or counts[domain]>=cap or not node.location.valid():return
            if not (tags.get('name') or tags.get('name:en') or tags.get('name:zh')):return
            payload={'type':'node','id':node.id,'tags':tags,'lat':node.location.lat,'lon':node.location.lon,'version':node.version,'timestamp':str(node.timestamp)}
            qid=tags.get('wikidata') if is_qid(tags.get('wikidata')) else None
            row=ctx.record('osm',payload,meta,license='ODbL-1.0',source_url=f'https://www.openstreetmap.org/node/{node.id}',domain=domain,qid=qid,source_published_at=str(node.timestamp),city='Beijing' if 'beijing' in sid else None,province='Beijing' if 'beijing' in sid else None,scope='poi',language='mul',attribution='© OpenStreetMap contributors',license_url='https://opendatacommons.org/licenses/odbl/1-0/',qid_evidence='OSM wikidata tag' if qid else None)
            rows.append(row);counts[domain]+=1
    handler=Handler();handler.apply_file(str(path))
    for row in rows:accepted(ctx,source,row)
    ctx.event(sid,'skipped','Pilot extracts named POI nodes only; ways/relations retained in raw PBF for future parser',node_records=len(rows))
    return rows
