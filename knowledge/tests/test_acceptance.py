"""Mocked local receipt mechanics only. These fixtures never prove live coverage."""
import hashlib
import json
from pathlib import Path
import pytest
from PIL import Image
from nihao_ingest.core import Context,write_jsonl,read_jsonl
from nihao_ingest.pipelines import normalize,process_media,link
from nihao_ingest.acceptance import accept,substantive,bilingual_examples


def test_substantive_quality_rejects_short_fact_and_accepts_realistic_passage_length():
    assert not substantive('Forbidden City: palace in Beijing.')
    assert not substantive('word '*40)
    assert substantive('Historical palace architecture includes courtyards, ceremonial buildings, and museum collections. '*30)


@pytest.fixture
def simulated_artifacts(tmp_path):
    root=tmp_path/'data';records=[]
    registry=[]
    def envelope(sid,kind,payload,url,license='CC0',**extra):
        # The tests simulate receipt mechanics; no network retrieval occurs here.
        source={'source_id':sid,'url':url,'domains':['attractions']}
        raw=root/'raw'/sid/'2026-11-09'/'sample.bin';raw.parent.mkdir(parents=True,exist_ok=True)
        raw.write_text(json.dumps(payload))
        sha=hashlib.sha256(raw.read_bytes()).hexdigest()
        metadata={'url':url,'path':str(raw),'bytes':raw.stat().st_size,'status':200,'sha256':sha,'fetched_at':'2026-11-09T12:00:00+00:00'}
        raw.with_suffix('.metadata.json').write_text(json.dumps(metadata))
        row=Context(root,None,source,'unit-simulated-receipts').record(kind,payload,metadata,license=license,source_url=url,**extra)
        records.append(row)
        registry.append({'id':sid,'source_id':sid,'status':'eligible','rights_status':'approved'})
        return row
    envelope('wikidata','wikidata',{'id':'Q1','labels':{'en':{'value':'Forbidden City'},'zh':{'value':'紫禁城'}},'descriptions':{'en':{'value':'A palace in Beijing.'}},'claims':{}},'https://www.wikidata.org/wiki/Q1',qid='Q1')
    words='Historical architecture includes ceremonial halls, spacious courtyards, wooden buildings, roof decoration, gates, gardens, and museum collections. '
    text='== History ==\n'+words*30
    envelope('wikivoyage_en_china','wikivoyage',{'title':'Forbidden City','pageid':10,'revid':12,'text':text},'https://en.wikivoyage.org/wiki/Forbidden_City',license='CC-BY-SA-4.0',qid='Q1',domain='attractions')
    envelope('wikipedia_zh_china','wikipedia',{'title':'紫禁城','pageid':11,'revid':13,'text':'紫禁城是历史宫殿建筑群，包含院落、殿宇、园林与博物馆展览。'*30},'https://zh.wikipedia.org/wiki/紫禁城',license='CC-BY-SA-4.0',qid='Q1',domain='attractions',language='zh')
    image=root/'assets/images/wikimedia_commons_attractions/original.png';image.parent.mkdir(parents=True,exist_ok=True);Image.new('RGB',(128,96),(10,20,30)).save(image)
    payload={'pageid':1,'title':'File:Palace.png','imageinfo':[{'url':'https://upload.wikimedia.org/wikipedia/commons/a/a1/Palace.png','descriptionurl':'https://commons.wikimedia.org/wiki/File:Palace.png','mime':'image/png','size':image.stat().st_size,'extmetadata':{'Artist':{'value':'Test creator'},'LicenseUrl':{'value':'https://creativecommons.org/licenses/by-sa/4.0/'},'Credit':{'value':'Mocked test metadata'}}}]}
    envelope('wikimedia_commons_attractions','commons',payload,'https://commons.wikimedia.org/wiki/File:Palace.png',license='CC-BY-SA-4.0',qid='Q1',qid_evidence='Mocked exact QID fixture',asset_path=str(image),modality='image')
    write_jsonl(root/'manifests/records.jsonl',records);write_jsonl(root/'normalized/sources.jsonl',registry)
    normalize(root);process_media(root);link(root)
    media=read_jsonl(root/'normalized/media.jsonl')
    for row in media:row['sha256']=hashlib.sha256(Path(row['path']).read_bytes()).hexdigest()
    write_jsonl(root/'normalized/media.jsonl',media)
    (root/'manifests/source_validation.json').write_text(json.dumps([{'source_id':'wikimedia_commons_video_china','checked_at':'2026-11-09T12:00:00+00:00'}]))
    write_jsonl(root/'manifests/runs/unit.jsonl',[{'source_id':'wikimedia_commons_video_china','timestamp':'2026-11-09T12:01:00+00:00','status':'failed','reason':'Explicit simulated unavailable video for unit test'}])
    return root


def test_artifact_acceptance_checks_actual_files_graph_and_queries(simulated_artifacts):
    result=accept(simulated_artifacts,thresholds={'substantive_chunks':1,'licensed_original_images':1,'retrievable_entities':1,'entity_text_image_chains':1})
    assert result['passed'],result['rejection_reasons']
    assert result['counts']['entity_text_image_chains']==1
    assert result['retrieval_examples']['bilingual_entity_ids']==['wikidata:Q1']
    assert result['valid_video_samples']==0


def test_original_thresholds_do_not_pass_small_simulated_corpus(simulated_artifacts):
    result=accept(simulated_artifacts)
    assert not result['passed']
    assert result['checks']['licensed_original_images']['required']==20
    assert result['checks']['substantive_chunks']['required']==100


def test_fixture_marker_and_missing_receipt_exclude_coverage(simulated_artifacts):
    records=read_jsonl(simulated_artifacts/'manifests/records.jsonl')
    for row in records:row['is_fixture']=True
    write_jsonl(simulated_artifacts/'manifests/records.jsonl',records)
    result=accept(simulated_artifacts)
    assert all(n==0 for n in result['counts'].values())
    assert any('synthetic' in reason for reason in result['rejection_reasons'])


def test_tampered_image_does_not_count_or_form_chain(simulated_artifacts):
    row=read_jsonl(simulated_artifacts/'normalized/media.jsonl')[0]
    Image.new('RGB',(128,96),(255,255,255)).save(row['path'])
    result=accept(simulated_artifacts)
    assert result['counts']['licensed_original_images']==0
    assert result['counts']['entity_text_image_chains']==0
    assert 'asset SHA256 missing or mismatched' in result['rejection_reasons']


def test_invalid_offsets_do_not_count_as_substantive_chunks(simulated_artifacts):
    chunks=read_jsonl(simulated_artifacts/'normalized/chunks.jsonl')
    for chunk in chunks:chunk['char_start']=900000
    write_jsonl(simulated_artifacts/'normalized/chunks.jsonl',chunks)
    result=accept(simulated_artifacts)
    assert result['counts']['substantive_chunks']==0
    assert result['counts']['retrievable_entities']==0


def test_missing_exact_graph_edge_does_not_count_chain(simulated_artifacts):
    edges=read_jsonl(simulated_artifacts/'normalized/links.jsonl')
    write_jsonl(simulated_artifacts/'normalized/links.jsonl',[e for e in edges if e['relation']!='depicted_by'])
    result=accept(simulated_artifacts)
    assert result['counts']['licensed_original_images']==1
    assert result['counts']['entity_text_image_chains']==0


def test_normalized_text_tampering_is_rejected_even_with_valid_raw_receipt(simulated_artifacts):
    docs=read_jsonl(simulated_artifacts/'normalized/documents.jsonl')
    for doc in docs:doc['text']='Modified '+doc['text']
    write_jsonl(simulated_artifacts/'normalized/documents.jsonl',docs)
    result=accept(simulated_artifacts)
    assert result['counts']['substantive_chunks']==0
    assert 'normalized document/chunk SHA256 mismatch' in result['rejection_reasons']


def test_video_attempt_requires_current_campaign_event(simulated_artifacts):
    run=simulated_artifacts/'manifests/runs/unit.jsonl'
    event={'source_id':'wikimedia_commons_video_china','timestamp':'2026-11-09T11:00:00+00:00','status':'failed','reason':'Old campaign robots-only failure'}
    write_jsonl(run,[event])
    result=accept(simulated_artifacts)
    assert not result['checks']['video_attempt_recorded']['passed']
    assert result['video_attempts']==[]
    event.update(timestamp='2026-11-09T12:10:00+00:00',reason='Current campaign video category request failed')
    write_jsonl(run,[event])
    result=accept(simulated_artifacts)
    assert result['checks']['video_attempt_recorded']['passed']
    assert len(result['video_attempts'])==1


def test_current_unattempted_video_cap_skip_does_not_count(simulated_artifacts):
    write_jsonl(simulated_artifacts/'manifests/runs/unit.jsonl',[{'source_id':'wikimedia_commons_video_china','timestamp':'2026-11-09T12:10:00+00:00','status':'skipped','reason':'Global media cap reached'}])
    assert not accept(simulated_artifacts)['checks']['video_attempt_recorded']['passed']


def test_pd_author_acceptance_rechecks_raw_declaration(tmp_path):
    from bs4 import BeautifulSoup
    from nihao_ingest.connectors.commons import file_html_metadata
    from nihao_ingest.acceptance import media_license_reason
    raw='''<html><script>{"wgArticleId":123,"wgRevisionId":456}</script><table><tr><td id="fileinfotpl_aut">Author</td><td>Alice Example</td></tr></table><div id="mw-content-text"><table class="layouttemplate"><tr><td><span class="licensetpl_short">Public domain</span><p>This work has been released into the public domain by its author Alice Example. This applies worldwide. Alice Example grants anyone the right to use this work for any purpose without any conditions.</p></td></tr></table></div><div class="fullMedia"><a class="internal" href="https://upload.wikimedia.org/original.webm">Original</a><span class="mime-type">video/webm</span></div></html>'''
    url='https://commons.wikimedia.org/wiki/File:Original.webm'
    page,license,license_url,_=file_html_metadata(BeautifulSoup(raw,'html.parser'),raw,url)
    path=tmp_path/'raw.html';path.write_text(raw)
    envelope={'raw_path':str(path),'payload':page}
    row={'license':license,'license_url':license_url,'author':'Alice Example','restrictions':'','file_page_url':url,'original_url':'https://upload.wikimedia.org/original.webm'}
    assert media_license_reason(row,envelope) is None
    assert media_license_reason(row|{'author':'Someone else'},envelope)
    assert media_license_reason(row,{'raw_path':str(path),'payload':{}})
    envelope['payload']['licensing_evidence']['declaration']='Public domain'
    assert media_license_reason(row,envelope)
