"""Independent collectors, selected only after the source registry validation gate."""
from . import wikidata, unesco, geofabrik, commons, wikivoyage, wikipedia, official_registry


def ingest_source(source,ctx):
    if source.get('access_strategy')=='metadata_only':
        return official_registry.ingest(source,ctx)
    kind=source['kind']
    if source['source_id']=='wikidata':return wikidata.ingest(source,ctx)
    if source.get('dataset_id'):return unesco.ingest(source,ctx)
    if kind=='osm_pbf':return geofabrik.ingest(source,ctx)
    if kind=='commons_category':return commons.ingest(source,ctx)
    if kind=='mediawiki_pages':return wikivoyage.ingest(source,ctx)
    if kind=='wikipedia_pages':return wikipedia.ingest(source,ctx)
    raise ValueError('No connector implemented for '+source['source_id'])
