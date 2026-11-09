"""Execute all scenarios; metrics remain null until independent qrels exist."""
import json,time
from pathlib import Path
from collections import defaultdict
import numpy as np
from . import Engine

def main():
 Path('reports/rag_evaluation_results.jsonl').write_text('')
 e=Engine();cases=[json.loads(l) for l in Path('evaluation/rag_questions.jsonl').read_text().splitlines()];out=[]
 for case in cases:
  response=e.search(case['question'],{'domain':case['domain']});row=dict(case,response=response)
  expected=case.get('relevant_chunk_ids');ranked=[r['chunk_id'] for r in response['results']]
  row['recall_at_5']=len(set(ranked)&set(expected))/len(expected) if expected else None
  row['mrr']=next((1/(i+1) for i,x in enumerate(ranked) if x in expected),0) if expected else None
  row['citation_provenance_valid']=all(r['citation'].get('source_url') and r['citation'].get('license') for r in response['results']) if response['results'] else None
  out.append(row)
  Path('reports/rag_evaluation_results.jsonl').open('a').write(json.dumps(row,ensure_ascii=False)+'\n')
 groups={}
 for domain in sorted({c['domain'] for c in cases}):
  rows=[r for r in out if r['domain']==domain];lat=[r['response']['latency_ms'] for r in rows]
  groups[domain]={'questions':len(rows),'judged_questions':sum(r['recall_at_5'] is not None for r in rows),'Recall@5':float(np.mean([r['recall_at_5'] for r in rows if r['recall_at_5'] is not None])) if any(r['recall_at_5'] is not None for r in rows) else None,'MRR':float(np.mean([r['mrr'] for r in rows if r['mrr'] is not None])) if any(r['mrr'] is not None for r in rows) else None,'Citation Accuracy':None,'Answer Accuracy':None,'latency_p50_ms':float(np.median(lat)),'latency_p95_ms':float(np.percentile(lat,95)),'limitation':'Provisional subset only: Pilot v2 passage labels reused for rephrased questions; independent 100-question judgments and answer entailment pending. No generated answer.'}
 Path('reports/rag_evaluation_summary.json').write_text(json.dumps(groups,indent=2))
if __name__=='__main__':main()
