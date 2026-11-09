import json
import shutil
import subprocess
from pathlib import Path
import pytest
from PIL import Image
from jsonschema import ValidationError
from nihao_ingest.core import Context, read_jsonl, write_jsonl
from nihao_ingest.pipelines import normalize, link, process_media, audit, withdraw_source
from nihao_ingest.schemas import validate_record


def record(root, kind, payload, source_id='fixture', domain='attractions', **extra):
    source = {'source_id':source_id, 'url':'https://example.org/'+source_id, 'domains':[domain]}
    ctx = Context(root, None, source, 'test-fixture-v1')
    return ctx.record(kind, payload, {'url':source['url'],'fetched_at':'2026-11-09T12:00:00+00:00'}, license=extra.pop('license','CC0'), **extra)


def wikidata(root, qid='Q1', label='Palace', **extra):
    return record(root,'wikidata',{'id':qid,'labels':{'en':{'value':label}},'descriptions':{'en':{'value':'An explicitly synthetic offline fixture.'}},'claims':{}},qid=qid, source_url='https://www.wikidata.org/wiki/'+qid, **extra)


def media(root, path, *, qid='Q1', evidence='Wikidata Q1 P18 exact Commons filename', modality='image', source_id='commons_fixture'):
    payload = {'pageid':10, 'title':'File:Palace fixture', 'imageinfo':[{'url':'https://upload.wikimedia.org/fixture/'+path.name,'descriptionurl':'https://commons.wikimedia.org/wiki/File:Fixture','mime':'image/png' if modality=='image' else 'video/mp4','size':path.stat().st_size,'extmetadata':{'Artist':{'value':'Offline test author'},'LicenseUrl':{'value':'https://creativecommons.org/licenses/by-sa/4.0/'},'Credit':{'value':'Explicitly synthetic unit-test media'},'ImageDescription':{'value':'Palace fixture'}}}]}
    return record(root,'commons',payload,source_id=source_id,license='CC-BY-SA-4.0',qid=qid,qid_evidence=evidence,modality=modality,asset_path=str(path))


def test_exact_qid_merges_but_same_names_do_not(tmp_path):
    rows = [wikidata(tmp_path,'Q1','Same Palace'), wikidata(tmp_path,'Q2','Same Palace'), record(tmp_path,'osm',{'type':'node','id':42,'tags':{'name':'Same Palace','wikidata':'Q1','tourism':'museum'},'lat':39.0,'lon':116.0},source_id='osm_fixture',license='ODbL-1.0')]
    write_jsonl(tmp_path/'manifests/records.jsonl',rows)
    normalize(tmp_path); link(tmp_path)
    entities = read_jsonl(tmp_path/'normalized/entities.jsonl')
    assert {e['entity_id'] for e in entities} == {'wikidata:Q1','wikidata:Q2'}
    entity = next(e for e in entities if e['entity_id']=='wikidata:Q1')
    assert set(entity['source_ids']) == {'fixture','osm_fixture'}
    assert entity['osm_id'] == 'node:42'
    assert set(entity['licenses'])=={'CC0','ODbL-1.0'}
    assert entity['license'].startswith('MULTIPLE:')


def test_text_photo_chain_and_idempotent_normalization(tmp_path):
    image = tmp_path/'fixture.png'; Image.new('RGB',(20,10),(255,0,0)).save(image)
    write_jsonl(tmp_path/'manifests/records.jsonl',[wikidata(tmp_path),media(tmp_path,image)])
    normalize(tmp_path); processed = process_media(tmp_path); link(tmp_path)
    first_chunks = read_jsonl(tmp_path/'normalized/chunks.jsonl')
    links = read_jsonl(tmp_path/'normalized/links.jsonl')
    assert any(l['relation']=='depicted_by' and l['from_id']=='wikidata:Q1' for l in links)
    assert any(l['relation']=='described_by' and l['to_id']==first_chunks[0]['chunk_id'] for l in links)
    assert processed['thumbnails'] == 1
    assert audit(tmp_path)['passed']
    normalize(tmp_path)
    assert read_jsonl(tmp_path/'normalized/chunks.jsonl') == first_chunks


def test_no_media_name_based_entity_link(tmp_path):
    image = tmp_path/'fixture.png'; Image.new('RGB',(8,8)).save(image)
    write_jsonl(tmp_path/'manifests/records.jsonl',[wikidata(tmp_path),media(tmp_path,image,qid='Q1',evidence=None)])
    normalize(tmp_path); link(tmp_path)
    item = read_jsonl(tmp_path/'normalized/media.jsonl')[0]
    assert item['entity_id'] is None
    assert item['entity_link_status'] == 'needs_review'
    assert not any(l['relation']=='depicted_by' for l in read_jsonl(tmp_path/'normalized/links.jsonl'))


def test_official_metadata_never_chunked(tmp_path):
    rows=[record(tmp_path,'official',{'title':'Official visa reference','topics':['entry_visa'],'url':'https://example.org/policy'},source_id='official_fixture',domain='entry_visa',rights_status='metadata_only',license='unknown')]
    write_jsonl(tmp_path/'manifests/records.jsonl',rows)
    normalize(tmp_path)
    assert read_jsonl(tmp_path/'normalized/documents.jsonl')[0]['text'] == ''
    assert read_jsonl(tmp_path/'normalized/chunks.jsonl') == []


def test_section_chunk_offsets_and_policy_conditions_preserved(tmp_path):
    text='== Entry conditions ==\n'+'Nationality, purpose, passport validity, and period must all be checked. '*80+'\n== Other information ==\nSee the official source.'
    row=record(tmp_path,'wikivoyage',{'title':'China','pageid':1,'revid':2,'text':text},domain='entry_visa',license='CC-BY-SA-4.0')
    write_jsonl(tmp_path/'manifests/records.jsonl',[row]);normalize(tmp_path)
    chunks=read_jsonl(tmp_path/'normalized/chunks.jsonl')
    assert len(chunks)==2
    assert len(chunks[0]['text'])>2200  # Conditions were not broken at a length cap.
    for chunk in chunks:
        assert text[chunk['char_start']:chunk['char_end']]==chunk['text']
        validate_record('chunks',chunk)
    invalid=dict(chunks[0]);invalid.pop('license')
    with pytest.raises(ValidationError):validate_record('chunks',invalid)


@pytest.mark.skipif(not shutil.which('ffmpeg') or not shutil.which('ffprobe'),reason='ffmpeg/ffprobe optional local dependency')
def test_actual_video_processing_timestamps_and_audit(tmp_path):
    video=tmp_path/'synthetic-fixture.mp4'
    subprocess.run(['ffmpeg','-nostdin','-v','error','-y','-f','lavfi','-i','color=c=red:s=64x48:d=1','-c:v','mpeg4',str(video)],check=True,timeout=30)
    write_jsonl(tmp_path/'manifests/records.jsonl',[wikidata(tmp_path),media(tmp_path,video,modality='video')])
    normalize(tmp_path);result=process_media(tmp_path);link(tmp_path)
    assert result['video_segments']==1 and result['keyframes']==1 and not result['errors']
    segment=read_jsonl(tmp_path/'normalized/media_segments.jsonl')[0]
    assert 0<=segment['start_seconds']<segment['end_seconds']<=1.1
    assert segment['start_seconds']<=segment['keyframe_timestamps'][0]<=segment['end_seconds']
    assert segment['transcript'] is None and segment['visual_summary'] is None
    assert audit(tmp_path)['passed']
    segment['end_seconds']=999
    write_jsonl(tmp_path/'normalized/media_segments.jsonl',[segment])
    assert any('timestamp outside' in issue['reason'] for issue in audit(tmp_path)['issues'])


def test_source_withdrawal_removes_assets_links_and_index(tmp_path):
    image=tmp_path/'fixture.png';Image.new('RGB',(8,8)).save(image)
    write_jsonl(tmp_path/'manifests/records.jsonl',[wikidata(tmp_path),media(tmp_path,image)])
    normalize(tmp_path);process_media(tmp_path);link(tmp_path)
    assets=read_jsonl(tmp_path/'normalized/media.jsonl')
    (tmp_path/'indexes/text/stale.txt').write_text('stale fixture media')
    result=withdraw_source(tmp_path,'commons_fixture')
    assert result['records_removed']==1 and result['audit_passed']
    assert not any(Path(a['path']).exists() for a in assets)
    assert read_jsonl(tmp_path/'normalized/media.jsonl')==[]
    assert not (tmp_path/'indexes/text/stale.txt').exists()
    assert all(l['relation']!='depicted_by' for l in read_jsonl(tmp_path/'normalized/links.jsonl'))
    assert read_jsonl(tmp_path/'normalized/entities.jsonl')[0]['entity_id']=='wikidata:Q1'
    with pytest.raises(ValueError):withdraw_source(tmp_path,'../escape')


def test_withdrawal_rebuilds_shared_entity_from_remaining_source(tmp_path):
    rows=[wikidata(tmp_path,source_id='first_source'), wikidata(tmp_path,source_id='second_source'),wikidata(tmp_path,'Q2','Unique withdrawn entity',source_id='first_source')]
    write_jsonl(tmp_path/'manifests/records.jsonl',rows);normalize(tmp_path);link(tmp_path)
    result=withdraw_source(tmp_path,'first_source')
    entities=read_jsonl(tmp_path/'normalized/entities.jsonl')
    assert result['records_removed']==2 and result['audit_passed']
    assert len(entities)==1 and entities[0]['entity_id']=='wikidata:Q1'
    assert entities[0]['source_ids']==['second_source']
    assert all(p['source_id']=='second_source' for p in entities[0]['provenance'])
    assert all(d['source_id']=='second_source' for d in read_jsonl(tmp_path/'normalized/documents.jsonl'))


def test_audio_extension_schema_and_static_transport_retrieval(tmp_path):
    image=tmp_path/'fixture.png';Image.new('RGB',(8,8)).save(image)
    row=wikidata(tmp_path,'Q1','Beijing railway station',domain='transportation')
    write_jsonl(tmp_path/'manifests/records.jsonl',[row,media(tmp_path,image)])
    normalize(tmp_path)
    item=read_jsonl(tmp_path/'normalized/media.jsonl')[0]
    item.update(modality='audio',mime='audio/ogg',width=None,height=None,duration_seconds=10)
    validate_record('media',item)
    from nihao_ingest.retrieval import query
    assert query(tmp_path,'Where is Beijing railway station?','transportation')['status']=='evidence_found'


def test_wikivoyage_sections_render_map_and_preserve_visa_conditions(tmp_path):
    text='== Get in ==\nArrive carefully.\n=== Visa ===\n'+'Check nationality, passport validity and permitted duration together. '*80+'\n== Eat ==\nTry [[Sichuan cuisine|local food]] with care.\n== See ==\nVisit [[Forbidden City|the palace]].'
    row=record(tmp_path,'wikivoyage',{'title':'China','pageid':11,'revid':22,'text':text},domain='daily_life',license='CC-BY-SA-4.0')
    write_jsonl(tmp_path/'manifests/records.jsonl',[row]);normalize(tmp_path)
    docs=read_jsonl(tmp_path/'normalized/documents.jsonl');chunks=read_jsonl(tmp_path/'normalized/chunks.jsonl')
    assert '[[Sichuan' not in docs[0]['text'] and 'local food' in docs[0]['text']
    visa=[c for c in chunks if c['domain']=='entry_visa']
    assert len(visa)==1 and len(visa[0]['text'])>2200
    assert any(c['domain']=='food_culture' and 'local food' in c['text'] for c in chunks)
    assert any(c['domain']=='attractions' and 'the palace' in c['text'] for c in chunks)
    assert all(docs[0]['text'][c['char_start']:c['char_end']]==c['text'] for c in chunks)


def test_quarantine_retains_evidence_but_removes_retrievable_data(tmp_path):
    from nihao_ingest.pipelines import quarantine_source
    from nihao_ingest.retrieval import query,build_index
    sid='quarantined_fixture'
    raw=tmp_path/'raw'/sid/'2026-11-09'/'fixture.bin';raw.parent.mkdir(parents=True)
    body=b'Explicit synthetic offline quarantine evidence'
    raw.write_bytes(body)
    alias=raw.with_suffix('.pbf');alias.hardlink_to(raw)
    row=wikidata(tmp_path,'Q1','Forbidden City',source_id=sid)
    row['raw_path']=str(raw.resolve())
    write_jsonl(tmp_path/'manifests/records.jsonl',[row]);normalize(tmp_path);link(tmp_path);build_index(tmp_path)
    assert query(tmp_path,'Forbidden City','attractions')['status']=='evidence_found'
    result=quarantine_source(tmp_path,sid,'Fixture policy restriction')
    assert result['records_quarantined']==1
    assert read_jsonl(tmp_path/'manifests/records.jsonl')==[]
    assert read_jsonl(tmp_path/'normalized/links.jsonl')==[]
    assert not (tmp_path/'indexes').exists()
    assert query(tmp_path,'Forbidden City','attractions')['status']=='insufficient_evidence'
    retained=read_jsonl(tmp_path/'quarantine'/sid/'records.jsonl')[0]
    retained_path=Path(retained['raw_path'])
    assert retained['content_status']=='quarantined' and retained['rights_status']=='needs_review'
    assert retained_path.read_bytes()==body and retained_path.stat().st_size==len(body)
    assert not raw.exists()
    assert retained_path.stat().st_ino==retained_path.with_suffix('.pbf').stat().st_ino
    unique={}
    for path in (tmp_path/'quarantine'/sid).rglob('*'):
        if path.is_file() and path.name!='quarantine_event.json':
            stat=path.stat();unique[(stat.st_dev,stat.st_ino)]=stat.st_size
    assert result['unique_inode_bytes_before_event']==sum(unique.values())


def test_integrity_audit_rejects_modified_media_binary(tmp_path):
    image=tmp_path/'fixture.png';Image.new('RGB',(80,80),(4,5,6)).save(image)
    write_jsonl(tmp_path/'manifests/records.jsonl',[wikidata(tmp_path),media(tmp_path,image)])
    normalize(tmp_path);process_media(tmp_path);link(tmp_path)
    row=read_jsonl(tmp_path/'normalized/media.jsonl')[0]
    Path(row['path']).write_bytes(b'modified binary')
    result=audit(tmp_path)
    assert not result['passed']
    assert any('SHA256' in issue['reason'] and issue['table']=='media' for issue in result['issues'])


def test_normalize_rejects_mismatched_raw_sha256(tmp_path):
    raw=tmp_path/'source.bin';raw.write_text('actual raw file')
    row=wikidata(tmp_path);row.update(raw_path=str(raw),raw_sha256='0'*64)
    write_jsonl(tmp_path/'manifests/records.jsonl',[row])
    result=normalize(tmp_path)
    assert result['errors'] and 'SHA256' in result['errors'][0]['reason']
    assert read_jsonl(tmp_path/'normalized/chunks.jsonl')==[]


def test_shared_sha_asset_survives_withdrawal_of_one_source(tmp_path):
    image=tmp_path/'fixture.png';Image.new('RGB',(80,80),(11,22,33)).save(image)
    rows=[wikidata(tmp_path),media(tmp_path,image,source_id='commons_first'),media(tmp_path,image,source_id='commons_second')]
    write_jsonl(tmp_path/'manifests/records.jsonl',rows);normalize(tmp_path);process_media(tmp_path);link(tmp_path)
    media_rows=read_jsonl(tmp_path/'normalized/media.jsonl')
    assert len(media_rows)==2
    assert media_rows[0]['sha256']==media_rows[1]['sha256']
    assert media_rows[0]['path']==media_rows[1]['path']
    shared=Path(media_rows[0]['path']);withdraw_source(tmp_path,'commons_first')
    retained=read_jsonl(tmp_path/'normalized/media.jsonl')
    assert len(retained)==1 and retained[0]['source_id']=='commons_second' and shared.is_file()
    assert audit(tmp_path)['passed']


def test_wikipedia_bilingual_labels_and_substantive_chunks(tmp_path):
    en_text='== History ==\n'+'The museum preserves historical architecture and documents the development of the city through its public collections and exhibitions. '*30
    zh_text='== 历史 ==\n'+'博物馆保存历史建筑，并通过公共藏品和展览介绍城市的发展。'*25
    rows=[record(tmp_path,'wikipedia',{'title':'Museum','pageid':1,'revid':2,'text':en_text},source_id='wikipedia_en',language='en',qid='Q1',license='CC-BY-SA-4.0'),record(tmp_path,'wikipedia',{'title':'博物馆','pageid':2,'revid':3,'text':zh_text},source_id='wikipedia_zh',language='zh',qid='Q1',license='CC-BY-SA-4.0')]
    write_jsonl(tmp_path/'manifests/records.jsonl',rows);result=normalize(tmp_path)
    entities=read_jsonl(tmp_path/'normalized/entities.jsonl');chunks=read_jsonl(tmp_path/'normalized/chunks.jsonl')
    assert not result['errors'] and result['substantive_chunks']>=2
    assert len(entities)==1 and entities[0]['name_en']=='Museum' and entities[0]['name_zh']=='博物馆'
    assert {'en','zh'}=={c['language'] for c in chunks}
    from nihao_ingest.retrieval import query
    assert query(tmp_path,'请介绍博物馆。')['status']=='evidence_found'


def test_heading_only_chunks_are_dropped_but_short_actual_prose_preserved(tmp_path):
    row=record(tmp_path,'wikipedia',{'title':'Example Palace','pageid':9,'revid':10,'text':'A short but genuine prose fixture describes a palace.\n\n## References\n\n### Bibliography\n\n## Gallery\n\n','text_format':'plain'},source_id='wikipedia_fixture',language='en',qid='Q1',license='CC-BY-SA-4.0')
    write_jsonl(tmp_path/'manifests/records.jsonl',[row]);normalize(tmp_path)
    chunks=read_jsonl(tmp_path/'normalized/chunks.jsonl')
    assert len(chunks)==1 and 'prose fixture' in chunks[0]['text']
    assert not chunks[0]['is_substantive_chunk']


def test_xian_city_alias_normalizes_but_preserves_original(tmp_path):
    row=wikidata(tmp_path,city="Xi'an")
    write_jsonl(tmp_path/'manifests/records.jsonl',[row]);normalize(tmp_path)
    chunk=read_jsonl(tmp_path/'normalized/chunks.jsonl')[0]
    assert chunk['city']=='Xian' and chunk['source_city']=="Xi'an"
