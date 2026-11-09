"""Evidence-only dense/BM25 and visual retrieval, independent of ingestion."""
from pathlib import Path
import json,time,re
import numpy as np
from ..core import read_jsonl
from ..retrieval import tokens,approved,_reference

class Engine:
    def __init__(self,root='data',load_models=True):
        from rank_bm25 import BM25Okapi
        self.root=Path(root);self.directory=self.root/'indexes/rag';self.directory.mkdir(parents=True,exist_ok=True)
        self.rows=[r for r in read_jsonl(self.root/'normalized/chunks.jsonl') if approved(r)]
        self.media=[r for r in read_jsonl(self.root/'normalized/media.jsonl') if approved(r)]
        self.segments=read_jsonl(self.root/'normalized/media_segments.jsonl')
        self.bm25=BM25Okapi([tokens(r['text']) for r in self.rows]);self.models={}
    def model(self,name):
        if name not in self.models:
            from sentence_transformers import SentenceTransformer
            self.models[name]=SentenceTransformer(name)
        return self.models[name]
    def encode(self,texts):
        return self.model('BAAI/bge-m3').encode(texts,batch_size=4,normalize_embeddings=True,show_progress_bar=True)
    def build(self):
        from PIL import Image
        vectors=self.encode([r['text'] for r in self.rows]);np.save(self.directory/'dense.npy',vectors)
        (self.directory/'manifest.json').write_text(json.dumps({'chunk_ids':[r['id'] for r in self.rows],'visual_ids':[],'text_model':'BAAI/bge-m3','text_shape':list(vectors.shape),'physical_batch':4,'visual_status':'building'},indent=2))
        visual=[m for m in self.media if m['modality']=='image' and Path(m['path']).exists()]
        images=[Image.open(m['path']).convert('RGB') for m in visual]
        v=self.model('sentence-transformers/clip-ViT-B-32').encode(images,batch_size=4,normalize_embeddings=True)
        np.save(self.directory/'visual.npy',v)
        manifest={'chunk_ids':[r['id'] for r in self.rows],'visual_ids':[m['id'] for m in visual],'text_model':'BAAI/bge-m3','visual_model':'sentence-transformers/clip-ViT-B-32','physical_batch':4,'text_shape':list(vectors.shape),'visual_shape':list(v.shape)}
        (self.directory/'manifest.json').write_text(json.dumps(manifest,indent=2));return manifest
    def search(self,question,filters=None,limit=5):
        started=time.perf_counter();filters=filters or {}
        unknown=set(filters)-{'city','domain','entity_id','source','license','language'}
        if unknown:raise ValueError('Unsupported filters: '+str(unknown))
        if filters.get('domain')=='entry_visa' or re.search(r'visa|签证|免签|today|tomorrow|tonight|current fare|实时|票价|明天|现在|今晚|allergen|过敏|baggage|行李|退票|护照|passport|entry rules|入境政策|allerg(?:y|ies)|peanuts|清真|全部配料|current train|live departure|列车时刻|ticket rules',question,re.I):
            from ..retrieval import _external_references
            return {'status':'verification_required','results':[],'references':_external_references(self.root,filters.get('domain')),'latency_ms':(time.perf_counter()-started)*1000}
        if re.search(r'这张|this (?:food )?(?:image|photo)|unlabelled photograph',question,re.I):return {'status':'image_input_required','results':[],'latency_ms':(time.perf_counter()-started)*1000}
        if re.search(r'英文(?:资料|来源)|English source',question,re.I):filters=dict(filters,language='en')
        manifest=json.loads((self.directory/'manifest.json').read_text())
        if manifest['chunk_ids']!=[r['id'] for r in self.rows]:raise ValueError('Stale index: rebuild after source changes')
        dense=np.load(self.directory/'dense.npy')@self.encode([question])[0];sparse=self.bm25.get_scores(tokens(question))
        ids=[i for i,r in enumerate(self.rows) if len(r['text'])>=100 and all(r.get('source_id' if k=='source' else k)==v for k,v in filters.items())]
        scores={i:0.0 for i in ids}
        for values in [dense,sparse]:
            for rank,i in enumerate(sorted(ids,key=lambda i:float(values[i]),reverse=True)):scores[i]+=1/(60+rank+1)
        result=[]
        for i in sorted(ids,key=lambda i:scores[i],reverse=True)[:limit]:
            row=self.rows[i];eid=row.get('entity_id');media=[m for m in self.media if eid and m.get('entity_id')==eid]
            result.append({'chunk_id':row['id'],'entity_id':eid,'text':row['text'],'citation':_reference(row),'score':scores[i],'dense_score':float(dense[i]),'media_ids':[m['id'] for m in media],'media':[{'asset_id':m['id'],'modality':m['modality'],'author':m.get('author'),'citation':_reference(m,m['modality'])} for m in media],'segments':[s for s in self.segments if eid and s.get('entity_id')==eid],'media_relation':'existing_entity_association_not_visual_search','freshness':{'retrieved_at':row.get('fetched_at'),'last_verified_at':row.get('last_verified_at'),'verification_required':bool(row.get('is_time_sensitive')),'live_verified':False}})
        return {'status':'candidate_evidence' if result else 'insufficient_evidence','answer':None,'results':result,'latency_ms':(time.perf_counter()-started)*1000,'note':'Retrieved excerpts are candidates, not a generated factual answer.'}
    def visual(self,image=None,text=None,limit=5,exclude_ids=()):
        from PIL import Image
        started=time.perf_counter();manifest=json.loads((self.directory/'manifest.json').read_text())
        if not manifest.get('visual_ids'):raise ValueError('Visual index not ready')
        if image is not None:q=self.model('sentence-transformers/clip-ViT-B-32').encode(Image.open(image).convert('RGB'),normalize_embeddings=True)
        else:q=self.model('sentence-transformers/clip-ViT-B-32-multilingual-v1').encode(text,normalize_embeddings=True)
        values=np.load(self.directory/'visual.npy')@q;live={m['id']:m for m in self.media};out=[]
        for i in np.argsort(-values):
            aid=manifest['visual_ids'][i]
            if aid not in live or aid in exclude_ids:continue
            m=live[aid];eid=m.get('entity_id')
            out.append({'asset_id':aid,'entity_id':eid,'similarity':float(values[i]),'citation':_reference(m,'image'),'text_evidence':[{'text':r['text'],'citation':_reference(r)} for r in self.rows if eid and r.get('entity_id')==eid][:2],'segments':[s for s in self.segments if aid in s.get('keyframe_asset_ids',[])],'identity_status':'visual_candidate_not_verified'})
            if len(out)>=limit:break
        return {'results':out,'latency_ms':(time.perf_counter()-started)*1000,'method':'CLIP_visual_similarity'}
