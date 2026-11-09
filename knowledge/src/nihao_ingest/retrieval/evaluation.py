"""Execute fixed grounded evidence cases and refusal/coverage probes on local artifacts."""
import json
from pathlib import Path
from . import query, has_content
from ..core import utcnow

def evaluate(root, questions_path=None, report_path=None):
    root = Path(root)
    questions_path = Path(questions_path) if questions_path else Path(__file__).with_name('evaluation_questions.json')
    cases = json.loads(questions_path.read_text())
    rows = []
    for case in cases:
        answer = query(root, case['question'], case['domain'])
        citations_ok = all(c.get('source_url') and c.get('license') for c in answer['citations'])
        no_uncited_evidence = answer['status'] != 'evidence_found' or bool(answer['citations'])
        expected_ok = not case.get('expect') or answer['status'] == case['expect']
        expected_ids = set(case.get('expected_entity_ids') or [])
        expected_urls = set(case.get('expected_source_urls') or [])
        media = [m for m in answer['media'] if m.get('modality') == case.get('modality')]
        candidates=[r for r in answer['results'] if (not expected_ids or r.get('entity_id') in expected_ids) and (not expected_urls or r.get('source_url') in expected_urls) and has_content(r.get('text','')) and len(r.get('text',''))>=case.get('minimum_excerpt_characters',1)]
        # Expected facts must occur in a returned source passage, not a generated
        # answer or a concatenation of unrelated entities' excerpts.
        evidence=[r for r in candidates if all(term.casefold() in r['text'].casefold() for term in case.get('required_evidence_terms',[]))]
        matched_ids={r.get('entity_id') for r in evidence}
        media_evidence=[m for m in media if (not expected_ids or m.get('entity_id') in expected_ids) and (not case.get('expected_media_page_urls') or m.get('file_page_url') in case['expected_media_page_urls']) and m.get('rights_status')=='approved' and Path(m.get('path','')).is_file() and m.get('license') and m.get('file_page_url')]
        media_ok=not case.get('modality') or len(media_evidence)>=case.get('minimum_linked_media',1)
        valid_segments=[]
        media_by_id={m['asset_id']:m for m in media_evidence}
        for segment in answer.get('segments',[]):
            asset=media_by_id.get(segment.get('asset_id'))
            if asset and segment.get('source_url') and segment.get('license') and 0<=segment.get('start_seconds',-1)<segment.get('end_seconds',-1)<=asset.get('duration_seconds',0) and segment.get('keyframe_asset_ids'):
                valid_segments.append(segment)
        segment_ok=len(valid_segments)>=case.get('minimum_timestamped_segments',0)
        verified=bool(expected_ids and expected_ids.issubset(matched_ids) and media_ok and segment_ok and citations_ok)
        found=bool(answer['results']) and (not case.get('modality') or bool(media))
        coverage='verified_expected_evidence' if verified else 'candidate_matches_unverified' if found else 'not_demonstrated'
        rows.append(case | {'status':answer['status'],'matched_chunks':len(answer['results']),'matching_media':len(media),'verified_chunk_ids':[r['chunk_id'] for r in evidence],'verified_asset_ids':[m['asset_id'] for m in media_evidence],'verified_segment_ids':[s['segment_id'] for s in valid_segments],'verified_excerpt':evidence[0]['text'][:700] if evidence else None,'citations':answer['citations'],'external_reference_count':len(answer['external_references']),'safety_and_citation_check_passed':bool(citations_ok and no_uncited_evidence and expected_ok),'content_coverage':coverage,'answerable_case':bool(expected_ids),'answerable_case_verified':verified})
    verified_count=sum(r['answerable_case_verified'] for r in rows)
    result={'executed_at':utcnow(),'cases':rows,'total':len(rows),'safety_and_citation_checks_passed':sum(r['safety_and_citation_check_passed'] for r in rows),'answerable_case_count':sum(r['answerable_case'] for r in rows),'answerable_case_verified_count':verified_count,'content_cases_with_evidence':verified_count,'candidate_cases_unverified':sum(r['content_coverage']=='candidate_matches_unverified' for r in rows),'note':'Fixed answerable cases require explicit source entity IDs, source URLs, expected terms within real returned passages, and existing licensed media/timestamps when requested. Refusal checks and unsupported coverage probes are reported separately. Excerpts are not generated answers; this is not a general question-answering accuracy benchmark.'}
    path=Path(report_path) if report_path else root.parent/'reports/retrieval_evaluation.json'
    path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(result,ensure_ascii=False,indent=2))
    return result
