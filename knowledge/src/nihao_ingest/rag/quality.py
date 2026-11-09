"""Corpus diagnostics without treating generated labels as human evaluation."""
import json,re
from collections import Counter,defaultdict
from pathlib import Path
from ..core import read_jsonl

def main():
 rows=read_jsonl(Path('data/normalized/chunks.jsonl'));groups=defaultdict(list)
 for r in rows:groups[re.sub(r'\W+','',r['text'].casefold())].append(r['id'])
 shingles=[]
 for row in rows:
  words=re.findall(r'[\u3400-\u9fff]|[a-z0-9]+',row['text'].casefold());shingles.append(set(tuple(words[i:i+5]) for i in range(max(0,len(words)-4))))
 near=[]
 for i,left in enumerate(shingles):
  if len(left)<30:continue
  for j in range(i):
   right=shingles[j]
   if not right or min(len(left),len(right))/max(len(left),len(right))<.8:continue
   score=len(left&right)/len(left|right)
   if score>=.8:near.append({'left':rows[j]['id'],'right':rows[i]['id'],'five_token_jaccard':score})
 result={'near_duplicate_pairs':near,'near_duplicate_method':'5-token shingle Jaccard >= 0.8, minimum 30 shingles; lexical only','chunks':len(rows),'exact_normalized_duplicate_groups':[v for v in groups.values() if len(v)>1],'domains':{},'limitations':['Near-duplicate and factual completeness require passage review; length is not completeness.','Source license does not guarantee factual accuracy.','No new official body text downloaded.']}
 for d in sorted({r['domain'] for r in rows}):
  selected=[r for r in rows if r['domain']==d]
  result['domains'][d]={'chunks':len(selected),'substantive':sum(bool(r.get('is_substantive_chunk')) for r in selected),'sources':dict(Counter(r['source_id'] for r in selected)),'languages':dict(Counter(r['language'] for r in selected)),'missing_source_url':sum(not r.get('source_url') for r in selected),'missing_license':sum(not r.get('license') for r in selected),'time_sensitive':sum(bool(r.get('is_time_sensitive')) for r in selected)}
 Path('reports/rag_quality.json').write_text(json.dumps(result,indent=2,ensure_ascii=False));print(json.dumps(result,indent=2))
if __name__=='__main__':main()
