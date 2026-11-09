"""Contract checks; these do not count as real retrieval evaluation."""
import json
from pathlib import Path
import pytest
from nihao_ingest.rag import Engine

def test_unknown_filter_rejected_before_embedding():
    e=Engine(load_models=False)
    with pytest.raises(ValueError,match='Unsupported filters'):e.search('history',{'unknown':'x'})

def test_dynamic_query_does_not_claim_live_verification():
    e=Engine(load_models=False)
    r=e.search('Can I enter visa-free today?',{'domain':'entry_visa'})
    assert r['status']=='verification_required' and not r['results']

def test_authored_scenarios_have_five_domains_and_bilingual_inputs():
    rows=[json.loads(x) for x in Path('evaluation/rag_questions.jsonl').read_text().splitlines()]
    assert len(rows)==100 and len({r['id'] for r in rows})==100
    assert len({r['domain'] for r in rows})==5
    for domain in {r['domain'] for r in rows}:
        assert {r['language'] for r in rows if r['domain']==domain}=={'zh','en'}
