import json
from pathlib import Path
import pytest
from nihao_ingest.core import write_jsonl
from nihao_ingest.retrieval import query, entity_bundle, build_index, serve
from nihao_ingest.retrieval.evaluation import evaluate

@pytest.fixture
def corpus(tmp_path):
    root = tmp_path / 'data'
    common = {'source_id':'fixture', 'source_url':'https://example.org/fixture', 'license':'CC0', 'rights_status':'approved', 'content_status':'normalized', 'data_version':'fixture-1', 'domain':'attractions'}
    write_jsonl(root/'normalized/entities.jsonl', [common | {'entity_id':'wikidata:Q1', 'name_en':'Forbidden City', 'name_zh':'紫禁城'}])
    write_jsonl(root/'normalized/documents.jsonl', [common | {'document_id':'doc1', 'title':'Forbidden City'}, common | {'document_id':'official', 'rights_status':'metadata_only', 'domain':'entry_visa', 'text':'', 'source_url':'https://example.org/official', 'title':'Official immigration information'}])
    write_jsonl(root/'normalized/chunks.jsonl', [common | {'chunk_id':'chunk1','document_id':'doc1', 'entity_id':'wikidata:Q1', 'text':'The Forbidden City is a palace complex in Beijing.', 'is_time_sensitive':False}, common | {'chunk_id':'chunk2','document_id':'doc2', 'entity_id':'wikidata:Q2', 'text':'Unlicensed private palace records', 'rights_status':'needs_review'}, common | {'chunk_id':'chunk3','document_id':'doc3', 'entity_id':'wikidata:Q1','text':'The current ticket price is an unverified amount.', 'is_time_sensitive':True}])
    write_jsonl(root/'normalized/media.jsonl', [common | {'asset_id':'image1', 'entity_id':'wikidata:Q1', 'modality':'image','path':'fixture-only.jpg', 'author':'Fixture author'}, common | {'asset_id':'image2', 'entity_id':'wikidata:Q1', 'modality':'image', 'rights_status':'needs_review'}])
    write_jsonl(root/'normalized/links.jsonl', [{'from_id':'wikidata:Q1','to_id':'image1','relation':'depicted_by','confidence':1,'evidence':'explicit fixture QID'}, {'from_id':'wikidata:Q1','to_id':'image2','relation':'depicted_by','confidence':1,'evidence':'explicit fixture QID'}])
    return root

def test_licensed_evidence_and_exact_media_citations(corpus):
    answer = query(corpus, 'What is the Forbidden City?', 'attractions')
    assert answer['status'] == 'evidence_found'
    assert [r['chunk_id'] for r in answer['results']] == ['chunk1']
    assert [m['asset_id'] for m in answer['media']] == ['image1']
    assert all(c['source_url'] and c['license'] for c in answer['citations'])
    assert answer['answer_mode'] == 'evidence_only'

def test_no_matching_evidence_refuses(corpus):
    answer = query(corpus, 'Intergalactic teleportation terminal', 'transportation')
    assert answer['status'] == 'insufficient_evidence'
    assert answer['results'] == []

@pytest.mark.parametrize('question,domain', [('Can my passport enter visa-free today?', 'entry_visa'), ('What is the train fare today?', 'transportation'), ('Can this food photo prove allergens?', 'food_culture')])
def test_dynamic_or_visual_inference_requires_verification(corpus, question, domain):
    answer = query(corpus, question, domain)
    assert answer['status'] == 'verification_required'
    assert answer['results'] == []

def test_official_metadata_remains_external_not_text(corpus):
    answer = query(corpus, 'Do I need a visa?', 'entry_visa')
    assert answer['external_references'][0]['body_indexed'] is False
    assert not answer['citations']

def test_index_has_no_unapproved_or_binary_content(corpus):
    result = build_index(corpus)
    index = (corpus/'indexes/text/chunks.jsonl').read_text()
    assert result['indexed_chunks'] == 2
    assert 'Unlicensed private' not in index
    assert 'fixture-only.jpg' not in index

def test_withdrawal_cannot_leak_from_stale_index(corpus):
    build_index(corpus)
    write_jsonl(corpus/'normalized/chunks.jsonl', [])
    answer = query(corpus, 'Forbidden City')
    assert answer['status'] == 'insufficient_evidence'

def test_exact_entity_bundle_and_missing_entity(corpus):
    assert len(entity_bundle(corpus, 'wikidata:Q1')['media']) == 1
    assert entity_bundle(corpus, 'wikidata:unknown')['status'] == 'not_found'

def test_invalid_arguments_and_nonlocal_server_blocked(corpus):
    with pytest.raises(ValueError): query(corpus, '', 'attractions')
    with pytest.raises(ValueError): query(corpus, 'food', 'bad-domain')
    with pytest.raises(ValueError): query(corpus, 'food', limit=21)
    with pytest.raises(ValueError): serve(corpus, host='0.0.0.0')

def test_evaluation_distinguishes_refusal_success_from_coverage(corpus, tmp_path):
    report = evaluate(corpus, report_path=tmp_path/'evaluation.json')
    assert report['total'] == 13
    assert report['safety_and_citation_checks_passed'] == 13
    assert report['content_cases_with_evidence'] < 13
    assert json.loads((tmp_path/'evaluation.json').read_text())['total'] == 13


def test_local_read_only_http_endpoints(corpus):
    import socket
    import subprocess
    import sys
    import time
    import requests
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    code='from nihao_ingest.retrieval import serve; serve('+repr(str(corpus))+',port='+str(port)+')'
    import os
    env=dict(os.environ, PYTHONPATH=str(Path(__file__).parents[1]/'src'))
    process=subprocess.Popen([sys.executable,'-c',code],stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env)
    client=requests.Session();client.trust_env=False
    base=f'http://127.0.0.1:{port}'
    try:
        for _ in range(100):
            if process.poll() is not None:
                raise AssertionError(process.stderr.read().decode())
            try:
                health=client.get(base+'/health',timeout=.3)
                break
            except requests.ConnectionError:
                time.sleep(.02)
        else:
            raise AssertionError('Loopback retrieval server did not start')
        assert health.status_code==200 and health.json()['read_only']
        response=client.get(base+'/query',params={'q':'Forbidden City','domain':'attractions'},timeout=2)
        assert response.status_code==200 and response.json()['status']=='evidence_found'
        assert client.post(base+'/query',json={'q':'write'},timeout=2).status_code==405
        assert client.get(base+'/query',params={'q':'x','domain':'invalid'},timeout=2).status_code==400
        assert client.get(base+'/missing',timeout=2).status_code==404
    finally:
        process.terminate();process.wait(timeout=5);client.close()


def test_named_poi_cannot_match_unrelated_city_overlap(corpus):
    common={'source_id':'fixture','source_url':'https://example.org/unrelated','license':'CC0','rights_status':'approved','content_status':'normalized','domain':'attractions','entity_id':'wikidata:Q9'}
    write_jsonl(corpus/'normalized/entities.jsonl',[common|{'name_en':'Beijing generic museum'}])
    write_jsonl(corpus/'normalized/chunks.jsonl',[common|{'chunk_id':'unrelated','document_id':'doc9','text':'A generic museum in Beijing.','is_time_sensitive':False}])
    answer=query(corpus,'What is the Forbidden City in Beijing?','attractions')
    assert answer['status']=='insufficient_evidence' and not answer['results']


def test_media_request_requires_exact_linked_requested_modality(corpus):
    assert query(corpus,'Show licensed photographs of the Forbidden City.','attractions')['status']=='evidence_found'
    answer=query(corpus,'Show a licensed video of the Forbidden City.','attractions')
    assert answer['status']=='insufficient_evidence' and not answer['media']
    write_jsonl(corpus/'normalized/media.jsonl',[])
    assert query(corpus,'Show licensed photographs of the Forbidden City.','attractions')['status']=='insufficient_evidence'


def test_timestamp_request_requires_segment(corpus):
    from nihao_ingest.core import read_jsonl
    media=read_jsonl(corpus/'normalized/media.jsonl')[0]
    media['modality']='video';write_jsonl(corpus/'normalized/media.jsonl',[media])
    question='Show a licensed Forbidden City video with a source timestamp.'
    assert query(corpus,question,'attractions')['status']=='insufficient_evidence'
    segment={'segment_id':'segment1','asset_id':media['asset_id'],'entity_id':'wikidata:Q1','start_seconds':0,'end_seconds':1,'rights_status':'approved','content_status':'normalized','source_url':'https://example.org/video#t=0'}
    write_jsonl(corpus/'normalized/media_segments.jsonl',[segment])
    answer=query(corpus,question,'attractions')
    assert answer['status']=='evidence_found' and answer['segments'][0]['start_seconds']==0


def test_evaluation_keyword_candidates_are_not_verified_coverage(corpus,tmp_path):
    questions=tmp_path/'questions.json'
    questions.write_text(json.dumps([{'id':'unverified','domain':'attractions','question':'What is the Forbidden City?'},{'id':'verified','domain':'attractions','question':'What is the Forbidden City?','expected_entity_ids':['wikidata:Q1']}]))
    result=evaluate(corpus,questions, tmp_path/'result.json')
    assert result['cases'][0]['content_coverage']=='candidate_matches_unverified'
    assert result['cases'][1]['content_coverage']=='verified_expected_evidence'
    assert result['content_cases_with_evidence']==1


def test_withdrawn_registry_source_is_not_returned_as_external_reference(corpus):
    row={'source_id':'withdrawn_official','source_url':'https://example.org/withdrawn','access_strategy':'metadata_only','domain':'entry_visa','status':'withdrawn','rights_status':'withdrawn'}
    write_jsonl(corpus/'normalized/sources.jsonl',[row])
    answer=query(corpus,'Which official visa information should I check?','entry_visa')
    assert all(r['source_id']!='withdrawn_official' for r in answer['external_references'])


def test_chinese_query_uses_actual_entity_label_without_visual_inference(corpus):
    answer=query(corpus,'请介绍紫禁城。','attractions')
    assert answer['status']=='evidence_found'
    assert {c['entity_id'] for c in answer['results']}=={'wikidata:Q1'}
    assert query(corpus,'请展示紫禁城的照片。','attractions')['status']=='evidence_found'
    assert query(corpus,'请展示紫禁城的视频。','attractions')['status']=='insufficient_evidence'
    assert query(corpus,'请介绍故宫附近的素食餐馆。','attractions')['status']=='insufficient_evidence'
    assert query(corpus,'当前的免签政策是什么？','entry_visa')['status']=='verification_required'


@pytest.mark.parametrize('question',['我今天可以免签入境吗？','北京到上海明天高铁多少钱？','请告诉我当前票价。','花生过敏的人能安全吃这道菜吗？','今天故宫开放吗？'])
def test_undomained_chinese_time_sensitive_or_allergy_questions_require_verification(corpus,question):
    answer=query(corpus,question)
    assert answer['status']=='verification_required'
    assert not answer['results'] and not answer['media']


def test_overview_queries_rank_real_prose_and_query_language_first(corpus):
    common={'source_id':'wikipedia_fixture','source_url':'https://example.org/article','license':'CC-BY-SA-4.0','rights_status':'approved','content_status':'normalized','domain':'food_culture','entity_id':'wikidata:Q10','document_id':'mapo-doc','source_kind':'wikipedia','is_time_sensitive':False}
    write_jsonl(corpus/'normalized/entities.jsonl',[common|{'name_en':'Mapo tofu','name_zh':'麻婆豆腐'}])
    en_lead='Mapo tofu is a dish from Sichuan cuisine. This explicitly synthetic test paragraph describes its cultural setting and distinguishes an overview from a history section. Visitors can use the source article for general background, while the retrieval service preserves citations and does not infer food safety from an image.'
    zh_lead='麻婆豆腐是川菜中的一道菜肴。这段明确标注为测试的文字用于检验中文概述的排序，确保中文问题优先返回中文正文，而不是空白的参考文献标题或英文段落。'
    chunks=[common|{'chunk_id':'000-empty-reference','language':'en','char_start':9000,'section':'References','text':'## References\n\n'},common|{'chunk_id':'001-history','language':'en','char_start':700,'section':'History','text':'## History\n'+('This synthetic history paragraph provides background details about the example dish. '*40)},common|{'chunk_id':'999-lead-en','language':'en','char_start':0,'section':'Mapo tofu','text':en_lead},common|{'chunk_id':'002-lead-zh','language':'zh','char_start':0,'section':'麻婆豆腐','text':zh_lead}]
    write_jsonl(corpus/'normalized/chunks.jsonl',chunks)
    english=query(corpus,'What is Mapo tofu?','food_culture')
    chinese=query(corpus,'请介绍麻婆豆腐。','food_culture')
    assert english['results'][0]['chunk_id']=='999-lead-en'
    assert chinese['results'][0]['chunk_id']=='002-lead-zh'
    assert english['results'][0]['overview_match'] and english['results'][0]['language_match']
    assert all(r['chunk_id']!='000-empty-reference' for r in english['results']+chinese['results'])


def test_heading_only_corpus_cannot_establish_knowledge(corpus):
    from nihao_ingest.core import read_jsonl
    chunk=read_jsonl(corpus/'normalized/chunks.jsonl')[0]
    chunk['text']='## References\n\n### Bibliography\n\n';write_jsonl(corpus/'normalized/chunks.jsonl',[chunk])
    assert query(corpus,'What is the Forbidden City?')['status']=='insufficient_evidence'
    assert build_index(corpus)['indexed_chunks']==0


def test_fixed_grounded_case_requires_source_url_and_expected_facts(corpus,tmp_path):
    questions=tmp_path/'fixed.json'
    questions.write_text(json.dumps([{'id':'wrong-source','domain':'attractions','question':'What is the Forbidden City?','expected_entity_ids':['wikidata:Q1'],'expected_source_urls':['https://example.org/unavailable']},{'id':'wrong-fact','domain':'attractions','question':'What is the Forbidden City?','expected_entity_ids':['wikidata:Q1'],'required_evidence_terms':['unverified invented fact']},{'id':'grounded','domain':'attractions','question':'What is the Forbidden City?','expected_entity_ids':['wikidata:Q1'],'expected_source_urls':['https://example.org/fixture'],'required_evidence_terms':['palace','Beijing']}]))
    result=evaluate(corpus,questions,tmp_path/'fixed-result.json')
    assert result['answerable_case_count']==3 and result['answerable_case_verified_count']==1
    assert [r['answerable_case_verified'] for r in result['cases']]==[False,False,True]
    assert 'palace complex' in result['cases'][2]['verified_excerpt']


def test_fixed_photo_case_requires_actual_media_file(corpus,tmp_path):
    questions=tmp_path/'photo.json'
    questions.write_text(json.dumps([{'id':'photo','domain':'attractions','question':'Show photographs of the Forbidden City.','expected_entity_ids':['wikidata:Q1'],'modality':'image','minimum_linked_media':1}]))
    result=evaluate(corpus,questions,tmp_path/'photo-result.json')
    assert result['answerable_case_count']==1 and result['answerable_case_verified_count']==0
    assert result['cases'][0]['verified_asset_ids']==[]
