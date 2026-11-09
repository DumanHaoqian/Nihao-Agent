from pathlib import Path
import json
from collections import Counter

def main():
 p=Path('reports');manifest=json.loads(Path('data/indexes/rag/manifest.json').read_text());quality=json.loads((p/'rag_quality.json').read_text());metrics=json.loads((p/'rag_evaluation_summary.json').read_text());demo=json.loads((p/'rag_real_demos.json').read_text())
 lines=['# Nihao RAG v3 measured baseline','','Status: real indexing/retrieval executed; full RAG acceptance NOT COMPLETE. No generated-answer accuracy is claimed.','','## Models and actual indexes',json.dumps({k:v for k,v in manifest.items() if not k.endswith('_ids')},indent=2),'','## Per-domain evaluation','100 authored scenarios, 20 per domain, Chinese and English. All executed. Recall/MRR below cover only provisional reused passage judgments; they are not a 100-question gold benchmark. Citation entailment and Answer Accuracy remain unscored.','', '| Domain | Questions | Provisional judged | Recall@5 | MRR | p50 ms | p95 ms |','|---|---:|---:|---:|---:|---:|---:|']
 for domain,m in metrics.items():lines.append(f"| {domain} | {m['questions']} | {m['judged_questions']} | {m['Recall@5']} | {m['MRR']} | {m['latency_p50_ms']:.2f} | {m['latency_p95_ms']:.2f} |")
 lines+=['','## Real text inputs and evidence']
 for row in demo['text']:
  hits=row['output']['results'];lines.append(f"\nInput: {row['input']}\n")
  if hits:
   h=hits[0];lines.append(f"Entity: {h['entity_id']}; chunk: {h['chunk_id']}; [source]({h['citation']['source_url']})\n\n> {h['text'][:500].replace(chr(10),' ')}")
 lines+=['','## Visual held-out tests','Query image cropped; original excluded from gallery. This tests image embedding retrieval, not pre-existing entity lookup. Only entities with another gallery photograph were selected; tiny, selected test set, not general image accuracy.']
 for r in demo['visual']:
  hits=r['output']['results'];rank=next((i+1 for i,h in enumerate(hits) if h['entity_id']==r['expected_entity_id']),None)
  lines.append(f"- Query asset {r['query_asset_id']}; expected {r['expected_entity_id']}; first matching entity rank: {rank}; top entity: {hits[0]['entity_id'] if hits else None}.")
 lines+=['','## Video semantic probes','34 visual records comprise 31 original photos and 3 keyframes. Video processing and semantic ranking are distinct. No transcript was created. Negative query “a train arriving at a railway platform” also retrieved Great Wall frames: semantic abstention FAILED. Positive ranking alone is not sufficient for reliable video search.']
 for r in demo['video']:
  frames=[{'rank':i+1,'asset_id':h['asset_id'],'segments':[(s['start_seconds'],s['end_seconds'],s['source_url']) for s in h['segments']]} for i,h in enumerate(r['output']['results']) if h['segments']]
  lines.append(f"- Query `{r['input']}`: keyframes in top five: {json.dumps(frames,ensure_ascii=False)}")
 lines+=['','## Corpus quality and rights',f"928 chunks: {len(quality['exact_normalized_duplicate_groups'])} normalized exact duplicate groups; {len(quality['near_duplicate_pairs'])} five-token Jaccard >=0.8 pairs. This lexical test does not prove semantic uniqueness.",'Domain labels are broad: daily_life contains city history and transportation includes border/customs material. Counts do not establish answerability.','Source audit: license_audit.csv and ATTRIBUTION.md retained. Model audit: rag_model_licenses.json. CLIP wrapper model metadata omitted a license; upstream OpenAI CLIP code uses MIT (https://github.com/openai/CLIP/blob/main/LICENSE); wrapper weight license still requires explicit resolution before distribution.','','## Outstanding acceptance work','- Independent passage-level relevance judgments for all 100 scenarios; current seven seeded judgments need review for rephrased queries.','- Citation entailment and Answer Accuracy. No answer generator is enabled; candidates are not confirmed answers.','- Calibrated abstention for off-topic queries. Dense retrieval always finds neighbors; candidate status must not be treated as factual confirmation.','- More held-out images and independent video samples; one video cannot establish general video semantic accuracy.','- Official verification interface now performs robots-gated HEAD availability checks, with actual results in rag_online_verification.json. It does not verify policy content; no new official text was ingested.','- Entry/visa and transportation knowledge enrichment remains incomplete. Dynamic queries are directed to verification; fetched_at does not establish freshness.','', '## Run', 'See README RAG v3 commands. API: http://127.0.0.1:8791/docs. Full actual results: rag_evaluation_results.jsonl; demos: rag_real_demos.json; tests: rag_pytest.log.']
 (p/'rag_report.md').write_text('\n'.join(lines)+'\n')
if __name__=='__main__':main()
