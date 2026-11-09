from fastapi import FastAPI,UploadFile,File,HTTPException
from pydantic import BaseModel,Field
from io import BytesIO
from . import Engine
app=FastAPI(title='Nihao evidence retrieval');engine=Engine()
class Query(BaseModel):
    question:str=Field(min_length=1,max_length=2000)
    filters:dict={}
    limit:int=Field(default=5,ge=1,le=20)
@app.get('/health')
def health():return {'chunks':len(engine.rows),'index_exists':(engine.directory/'manifest.json').exists()}
def ready():
    if not (engine.directory/'manifest.json').exists():raise HTTPException(503,'Real model indexes are not ready; run build and inspect its exit status')
@app.post('/search')
def search(q:Query):
    ready()
    try:return engine.search(q.question,q.filters,q.limit)
    except ValueError as error:raise HTTPException(400,str(error))
@app.post('/visual/text')
def visual_text(q:Query):
    ready()
    return engine.visual(text=q.question,limit=q.limit)
@app.post('/visual/image')
async def visual_image(file:UploadFile=File(...)):
    ready()
    data=await file.read(12*1024*1024+1)
    if len(data)>12*1024*1024:raise HTTPException(413,'Image exceeds 12 MiB')
    return engine.visual(image=BytesIO(data))
@app.get('/verification/{source_id}')
def verification(source_id:str):
    from .verification import verify
    try:return verify(source_id)
    except ValueError as error:raise HTTPException(404,str(error))
