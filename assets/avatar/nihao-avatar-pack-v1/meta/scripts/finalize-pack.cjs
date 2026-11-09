const fs=require('fs'),path=require('path'),sharp=require('sharp');
const root=path.resolve(__dirname,'../..');
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const save=(p,o)=>fs.writeFileSync(path.join(root,p),JSON.stringify(o,null,2));
const transparent={r:0,g:0,b:0,alpha:0};
async function main(){
const m=read('meta/manifest.json');
for(const layer of m.layers)if(layer.id==='torso')layer.parent='root';
const anchors=read('meta/anchors.json');for(const layer of anchors.layers)if(layer.id==='torso')layer.parent='root';save('meta/anchors.json',anchors);
for(const [name,clip]of Object.entries(m.animations)){
 const fw=256,fh=384,cols=Math.min(8,clip.frames.length),rows=Math.ceil(clip.frames.length/cols),layers=[];
 const rects=[];for(let i=0;i<clip.frames.length;i++){const f=clip.frames[i],x=i%cols*fw,y=Math.floor(i/cols)*fh;layers.push({input:await sharp(path.join(root,f.file)).resize(fw,fh,{kernel:'nearest'}).png().toBuffer(),left:x,top:y});rects.push({x,y,w:fw,h:fh,durationMs:f.durationMs});}
 const file='animations/'+name+'/atlas.png';await sharp({create:{width:cols*fw,height:rows*fh,channels:4,background:transparent}}).composite(layers).png().toFile(path.join(root,file));clip.atlas={file,width:cols*fw,height:rows*fh,frameWidth:fw,frameHeight:fh,scaleFromMaster:.25,frames:rects};
}
m.deliverables={concept:4,layers:m.layers.length,expressions:Object.keys(m.expressions).length,poses:Object.keys(m.poses).length,animationClips:Object.keys(m.animations).length,animationFrames:Object.values(m.animations).reduce((n,x)=>n+x.frames.length,0),atlases:Object.keys(m.animations).length,mouths:m.layers.filter(x=>x.group==='mouth').length};
save('meta/manifest.json',m);
// Transparent expression overview, for reviewing rather than runtime playback.
const thumbs=[];for(let i=0;i<6;i++){const name=Object.keys(m.expressions)[i];const image=await sharp(path.join(root,m.expressions[name].file)).extract({left:160,top:24,width:680,height:1000}).resize(272,400,{kernel:'nearest'}).png().toBuffer();thumbs.push({input:image,left:(i%3)*320+24,top:Math.floor(i/3)*432+16});}
await sharp({create:{width:960,height:864,channels:4,background:transparent}}).composite(thumbs).png().toFile(path.join(root,'meta/expression-overview.png'));
if(fs.existsSync(path.join(root,'meta/qa_contact.png')))fs.unlinkSync(path.join(root,'meta/qa_contact.png'));
// Asset checks: decode, dimensional registration, real alpha, palette, reference paths, bounds. No hashes.
const runtime=[...m.layers.map(x=>x.file),...Object.values(m.expressions).map(x=>x.file),...Object.values(m.poses).map(x=>x.file),...Object.values(m.animations).flatMap(x=>x.frames.map(f=>f.file)),...m.animations.talking.mouthSet.map(x=>x.file)];
const failures=[],summary=[];const palette=new Set(m.palette.map(h=>h.toLowerCase()));
for(const file of runtime){const {data,info}=await sharp(path.join(root,file)).ensureAlpha().raw().toBuffer({resolveWithObject:true});let zero=0,opaque=0,partial=0,other=0;for(let i=0;i<data.length;i+=4){if(data[i+3]===0)zero++;else if(data[i+3]===255){opaque++;const c='#'+[0,1,2].map(k=>data[i+k].toString(16).padStart(2,'0')).join('');if(!palette.has(c))other++;}else partial++;}if(info.width!==1024||info.height!==1536||!zero||!opaque||partial||other)failures.push({file,dimensions:[info.width,info.height],zero,opaque,partial,other});summary.push({file,width:info.width,height:info.height,alpha:'binary',nonempty:opaque>0});}
for(const l of m.layers){if(!fs.existsSync(path.join(root,l.source)))failures.push({missingSource:l.source});if(l.pivot[0]<0||l.pivot[0]>1024||l.pivot[1]<0||l.pivot[1]>1536)failures.push({badPivot:l.id});}
const must=['face_base','hair_back','hair_front','side_hair_left','side_hair_right','bun','ribbon','torso','arm_upper_left','arm_upper_right','forearm_left','forearm_right','hand_left','hand_right'];for(const name of must)if(!m.layers.some(l=>l.id===name))failures.push({missingRequired:name});
for(const [group,states]of Object.entries({eyes:['open','half_closed','closed','smiling'],eyebrows:['neutral','happy','concerned','surprised'],mouth:['closed','slight_open','medium_open','wide_open','smile','o_shape']}))for(const state of states)if(!m.layers.some(l=>l.group===group&&l.state===state))failures.push({missingState:group+'_'+state});
const concept=[];for(const f of fs.readdirSync(path.join(root,'concept')).filter(f=>f.endsWith('.png'))){const file='concept/'+f;const meta=await sharp(path.join(root,file)).metadata();const stat=await sharp(path.join(root,file)).stats();if(!meta.hasAlpha||stat.channels[3].min!==0)failures.push({conceptNotTransparent:file});concept.push({file,width:meta.width,height:meta.height,transparent:meta.hasAlpha&&stat.channels[3].min===0});}
const neutral=[...m.layers].filter(l=>l.visible!==false&&l.default!==false&&(!l.group||l.state===m.expressions.neutral[l.group])).sort((a,b)=>a.z-b.z);
const assembled=await sharp({create:{width:1024,height:1536,channels:4,background:transparent}}).composite(neutral.map(l=>({input:path.join(root,l.file)}))).raw().toBuffer();const mother=await sharp(path.join(root,'concept/nihao_full_front_neutral.png')).ensureAlpha().raw().toBuffer();if(!assembled.equals(mother))failures.push({neutralLayerAssembly:'does not match master'});
const animationChecks=[];for(const [name,clip]of Object.entries(m.animations)){const all=await Promise.all(clip.frames.map(f=>sharp(path.join(root,f.file)).raw().toBuffer()));const unique=[];for(const b of all)if(!unique.some(a=>a.equals(b)))unique.push(b);animationChecks.push({name,frames:all.length,distinctFrames:unique.length,durationMs:clip.frames.reduce((n,f)=>n+f.durationMs,0),loop:clip.loop});if(unique.length<2)failures.push({animationStatic:name});}
const report={passed:failures.length===0,checks:['PNG decodes','1024x1536 runtime registration','nonempty RGBA with transparent pixels','binary alpha','shared palette','required parts/states','source and anchor references','transparent concepts','neutral layers match master byte-for-byte','animation has actual changing frames'],deliverables:m.deliverables,checkedRuntimePngs:runtime.length,concept,animationChecks,failures};save('meta/validation-assets.json',report);console.log(JSON.stringify(report,null,2));if(failures.length)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1});
