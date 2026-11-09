"""Conservative links: exact identifiers only; no fuzzy-name merging."""
from pathlib import Path
from nihao_ingest.core import read_jsonl, write_jsonl, stable_id
from .normalize import common

def link(root):
    root=Path(root); norm=root/'normalized'
    entities=read_jsonl(norm/'entities.jsonl'); ids={e['entity_id'] for e in entities}
    rows=[]
    def add(record,from_id,relation,to_id,evidence,confidence=1.0):
        key='link:'+stable_id(from_id,relation,to_id)
        rows.append(dict(common(record),id=key,entity_id=from_id,from_id=from_id,relation=relation,to_id=to_id,
                         evidence=evidence,confidence=confidence))
    for table in ('documents','chunks'):
        for doc in read_jsonl(norm/(table+'.jsonl')):
            if doc.get('entity_id') in ids:
                add(doc,doc['entity_id'],'described_by',doc['id'],'Document originated from this exact source entity identifier.')
    media=read_jsonl(norm/'media.jsonl')
    unresolved=0
    for asset in media:
        if asset.get('rights_status')!='approved': continue
        entity_id=asset.get('entity_id')
        if entity_id in ids:
            add(asset,entity_id,'appears_in_video' if asset['modality']=='video' else 'depicted_by',asset['asset_id'],
                asset.get('qid_evidence') or asset.get('derivation_evidence') or 'Explicit source entity identifier.')
        elif entity_id:
            asset['candidate_entity_id']=entity_id; asset['entity_id']=None; asset['entity_link_status']='needs_review'; unresolved+=1
    write_jsonl(norm/'media.jsonl',media)
    for segment in read_jsonl(norm/'media_segments.jsonl'):
        if segment.get('entity_id') in ids:
            add(segment,segment['entity_id'],'appears_in_video',segment['segment_id'],
                'Segment inherits verified entity link from its parent video; timestamp points to original file.')
    whc={}
    for entity in entities:
        for external in entity.get('external_ids',{}).get('P757',[]):
            whc.setdefault(str(external),[]).append(entity)
    for entity in entities:
        external=entity.get('external_ids',{}).get('whc001')
        matches=whc.get(str(external),[]) if external is not None else []
        if len(matches)==1 and matches[0]['entity_id']!=entity['entity_id']:
            add(entity,entity['entity_id'],'same_as',matches[0]['entity_id'],f'Exact UNESCO World Heritage ID {external} equals Wikidata P757.')
        for parent in entity.get('external_ids',{}).get('P131',[]):
            if isinstance(parent,dict) and 'wikidata:'+parent.get('id','') in ids:
                add(entity,entity['entity_id'],'located_in','wikidata:'+parent['id'],'Wikidata P131 administrative-territory claim.')
    write_jsonl(norm/'links.jsonl',{r['id']:r for r in rows}.values())
    return {'links':len({r['id'] for r in rows}),'unresolved_media':unresolved,
            'automatic_matching':'exact external IDs only; no name similarity'}
