"""Local metadata, thumbnails and sparse video keyframes; never synthetic captions."""
from __future__ import annotations
import json
import shutil
import subprocess
from pathlib import Path
from nihao_ingest.core import read_jsonl, write_jsonl, stable_id
from .normalize import common
from .integrity import file_sha256,verify_file

PROCESSING_VERSION='nihao-media-2.0'

def probe_video(path):
    if not shutil.which('ffprobe'): raise RuntimeError('ffprobe unavailable; video metadata pending')
    result=subprocess.run(['ffprobe','-v','error','-show_format','-show_streams','-of','json',str(path)],
                          capture_output=True,text=True,check=True,timeout=45)
    data=json.loads(result.stdout); video=next((s for s in data.get('streams',[]) if s.get('codec_type')=='video'),None)
    if not video: raise ValueError('No video stream')
    duration=float(data.get('format',{}).get('duration') or video.get('duration') or 0)
    if duration<=0: raise ValueError('Video has no valid positive duration')
    return {'duration_seconds':duration,'width':video.get('width'),'height':video.get('height')}

def process_media(root):
    root=Path(root); norm=root/'normalized'; assets=read_jsonl(norm/'media.jsonl')
    assets=[a for a in assets if not a.get('derived_from')]; segments=[]; derived=[]; errors=[]; thumbnails=0
    for asset in assets:
        if asset['rights_status']!='approved': continue
        try:
            path=Path(asset['path'])
            asset['sha256']=verify_file(path,asset.get('sha256'))
            if asset['modality']=='image':
                from PIL import Image,ImageOps
                with Image.open(path) as im:
                    asset['width'],asset['height']=im.size
                    im=ImageOps.exif_transpose(im).convert('RGB'); im.thumbnail((512,512))
                    target=root/'derived/thumbnails'/asset['source_id']/(asset['asset_id'].split(':')[-1]+'.jpg')
                    target.parent.mkdir(parents=True,exist_ok=True); im.save(target,quality=85)
                    asset['thumbnail_path']=str(target.resolve()); asset['thumbnail_sha256']=file_sha256(target); thumbnails+=1
            elif asset['modality']=='video':
                asset.update(probe_video(path)); duration=asset['duration_seconds']
                if not shutil.which('ffmpeg'): raise RuntimeError('ffmpeg unavailable; keyframes pending')
                count=min(3,max(1,int(duration//15)+1)); width=duration/count
                for i in range(count):
                    start=i*width; end=min(duration,(i+1)*width); timestamp=(start+end)/2
                    segment_id='segment:'+stable_id(asset['asset_id'],PROCESSING_VERSION,i)
                    frame_id='keyframe:'+stable_id(segment_id,timestamp)
                    target=root/'derived/keyframes'/asset['source_id']/(frame_id.split(':')[-1]+'.jpg')
                    target.parent.mkdir(parents=True,exist_ok=True)
                    subprocess.run(['ffmpeg','-nostdin','-y','-v','error','-ss',str(timestamp),'-i',str(path),
                                    '-frames:v','1','-vf','scale=640:-2',str(target)],
                                   capture_output=True,check=True,timeout=90)
                    if not target.is_file() or target.stat().st_size==0: raise ValueError('No keyframe generated')
                    frame=dict(asset,id=frame_id,asset_id=frame_id,modality='image',path=str(target.resolve()),
                               mime='image/jpeg',duration_seconds=None,derived_from=asset['asset_id'],
                               processing_version=PROCESSING_VERSION,timestamp_seconds=timestamp,
                               derivation_evidence='Sparse frame extracted from licensed parent video; no visual place inference.',
                               transformation='Sparse keyframe resized to width 640',bytes=target.stat().st_size,
                               sha256=file_sha256(target),parent_sha256=asset['sha256'])
                    frame['content_id']='sha256:'+frame['sha256']
                    frame.pop('thumbnail_path',None);frame.pop('thumbnail_sha256',None)
                    from PIL import Image
                    with Image.open(target) as im: frame['width'],frame['height']=im.size
                    derived.append(frame)
                    segments.append(dict(common(asset),id=segment_id,segment_id=segment_id,asset_id=asset['asset_id'],
                                         entity_id=asset.get('entity_id'),start_seconds=start,end_seconds=end,
                                         transcript=None,transcript_language=None,keyframe_asset_ids=[frame_id],
                                         keyframe_timestamps=[timestamp],visual_summary=None,
                                         annotation_status='pending',processing_version=PROCESSING_VERSION,
                                         source_url=asset['file_page_url']+'#t='+str(round(start,3)),
                                         original_video_url=asset['original_url'],parent_sha256=asset['sha256'],
                                         transcript_status='pending_no_licensed_subtitles_or_configured_asr'))
            asset['processing_status']='processed'
        except Exception as exc:
            asset['processing_status']='pending'; asset['processing_reason']=str(exc)
            if 'SHA256 mismatch' in str(exc):
                asset['rights_status']='needs_review';asset['content_status']='quarantined'
            errors.append({'source_id':asset['source_id'],'asset_id':asset['asset_id'],'stage':'media_process','reason':str(exc)})
    write_jsonl(norm/'media.jsonl',assets+derived); write_jsonl(norm/'media_segments.jsonl',segments)
    write_jsonl(root/'manifests/media_processing_errors.jsonl',errors)
    return {'thumbnails':thumbnails,'video_segments':len(segments),'keyframes':len(derived),'errors':errors,
            'captions':'pending: no VLM configured','ocr':'pending: no OCR configured','transcripts':'pending: no ASR or licensed subtitles supplied'}
