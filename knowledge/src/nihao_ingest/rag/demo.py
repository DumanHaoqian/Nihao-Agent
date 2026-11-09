"""Real corpus examples; visual tests exclude the query asset to avoid self-match."""
import json
from pathlib import Path
from io import BytesIO
from PIL import Image
from . import Engine

def main():
 e=Engine();out={'text':[],'visual':[],'video':[]}
 for q in ['What was the Forbidden City used for?','请用英文资料介绍故宫。','What is mapo tofu?','麻婆豆腐起源于哪里？','What is Beijing South railway station?']:
  out['text'].append({'input':q,'output':e.search(q,{'language':'en'} if '英文' in q else {})})
 from collections import Counter
 counts=Counter(m.get('entity_id') for m in e.media if m['modality']=='image' and not m.get('derived_from'))
 food=next((m['entity_id'] for m in e.media if m.get('domain')=='food_culture' and counts[m.get('entity_id')]>=2),None)
 for eid in [v for v in ['wikidata:Q80290',food] if v]:
  m=next(m for m in e.media if m.get('entity_id')==eid and m['modality']=='image' and not m.get('derived_from'))
  im=Image.open(m['path']).convert('RGB');w,h=im.size;im=im.crop((int(w*.1),int(h*.1),int(w*.9),int(h*.9)));b=BytesIO();im.save(b,format='JPEG');b.seek(0)
  out['visual'].append({'query_asset_id':m['id'],'transformation':'center crop 80%; original asset excluded','expected_entity_id':eid,'output':e.visual(image=b,exclude_ids=[m['id']])})
 for q in ['a stone wall running along mountain ridges','山脊上的长城','a train arriving at a railway platform']:
  out['video'].append({'input':q,'output':e.visual(text=q)})
 Path('reports/rag_real_demos.json').write_text(json.dumps(out,indent=2,ensure_ascii=False))
if __name__=='__main__':main()
