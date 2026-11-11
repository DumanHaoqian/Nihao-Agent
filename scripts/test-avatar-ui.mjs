import assert from 'node:assert/strict';
import { createServer, request as proxyRequest } from 'node:http';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

// Mock chat/maps/TTS providers, real production assets + browser AudioContext/analyser.
// This does NOT verify any online provider. Screenshots are outside the repository.
const upstream = new URL(process.env.NIHAO_TEST_URL || 'http://127.0.0.1:8787');
let chatMode = 'normal', speechMode = 'pattern', heldChat, speechCalls = 0;
const send = (response, event) => { if (!response.destroyed) response.write(`data: ${JSON.stringify(event)}\n\n`); };
function pcm(seconds, amplitude) {
  const bytes = Buffer.alloc(Math.round(24000 * seconds) * 2);
  for (let i = 0; i < bytes.length / 2; i++) {
    const t = i / 24000;
    const volume = amplitude ?? (t < .35 || t >= .85 && t < 1.3 ? 0 : t < .85 ? .3 : t < 1.85 ? .04 : .12);
    bytes.writeInt16LE(Math.round(Math.sin(i * 330 * 2 * Math.PI / 24000) * volume * 32767), i * 2);
  }
  return bytes;
}
const fixture = createServer((request, response) => {
  if (request.url === '/api/chat') {
    request.resume(); response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders();
    if (chatMode === 'hold') { heldChat = response; return; }
    if (chatMode === 'error') send(response, {type:'error', code:'PROVIDER_ERROR'});
    else { send(response, {type:'delta',text:'Nihao. We can explore Shanghai together.'}); send(response, {type:'done'}); }
    response.end(); return;
  }
  if (request.url === '/api/speech') {
    speechCalls++; request.resume(); response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    send(response, {type:'start',format:'pcm_s16le',sampleRate:24000,channels:1});
    if (speechMode === 'loading') return;
    if (speechMode === 'gap') {
      send(response,{type:'audio',data:pcm(.25,.2).toString('base64')});
      const timer=setTimeout(()=>{send(response,{type:'audio',data:pcm(.4,.2).toString('base64')});send(response,{type:'done'});response.end();},1300);
      response.on('close',()=>clearTimeout(timer)); return;
    }
    send(response,{type:'audio',data:(speechMode === 'long' ? pcm(6,.2) : pcm(2.4)).toString('base64')});
    send(response,{type:'done'}); response.end(); return;
  }
  const headers = {...request.headers,host:upstream.host};
  if (headers.origin) headers.origin=upstream.origin;
  const proxy=proxyRequest(new URL(request.url,upstream),{method:request.method,headers},result=>{response.writeHead(result.statusCode,result.headers);result.pipe(response);});
  proxy.on('error',()=>{response.writeHead(502);response.end();}); request.pipe(proxy);
});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${fixture.address().port}`;
const browser=await chromium.launch({headless:true,...(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?{channel:'chrome'}:{})});
const errors=[], missing=[];
const watch = page => {
  page.setDefaultTimeout(7000);
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(['error','warning'].includes(m.type()))errors.push(m.text());});
  page.on('response',r=>{if(r.status()===404)missing.push(r.url());});
};
const poll = async predicate => { for(let i=0;i<100;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,30));}throw new Error('Fixture did not receive request'); };
try {
  const page=await browser.newPage({viewport:{width:1440,height:900}}); watch(page);
  await page.addInitScript(()=>{
    const Native=window.AudioContext;
    window.__avatarAudio={analysers:0,contexts:[],starts:[]};
    window.AudioContext=class extends Native {
      constructor(...args){super(...args);window.__avatarAudio.contexts.push(this);}
      createAnalyser(){window.__avatarAudio.analysers++;return super.createAnalyser();}
      createBufferSource(){const s=super.createBufferSource();const start=s.start.bind(s);s.start=(when,...rest)=>{window.__avatarAudio.starts.push({when,context:this});return start(when,...rest);};return s;}
    };
  });
  await page.goto(url); assert.match(await page.title(),/Nihao Agent/); assert.equal(new URL(page.url()).origin,url);
  await page.locator('.welcome-avatar [data-ready="true"]').waitFor();
  await page.waitForFunction(()=>document.querySelector('.welcome-avatar canvas')?.dataset.clip==='waving');
  const firstAction=await page.locator('.welcome-avatar .nihao-avatar').getAttribute('data-action');
  await page.locator('textarea').fill('A draft');
  assert.equal(await page.locator('.welcome-avatar .nihao-avatar').getAttribute('data-action'),firstAction);
  await page.waitForFunction(()=>document.querySelector('.welcome-avatar .nihao-avatar')?.dataset.action==='');
  await page.getByRole('button',{name:'中文',exact:true}).click();
  await page.getByRole('button',{name:'English',exact:true}).click();
  assert.equal(await page.locator('.welcome-avatar .nihao-avatar').getAttribute('data-action'),'');
  await page.locator('textarea').fill('');
  await page.screenshot({path:'/tmp/nihao-avatar-desktop.png'});
  for(const width of [390,320]) {
    await page.setViewportSize({width,height:844}); await page.waitForTimeout(200);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    const box=await page.getByRole('button',{name:'Send message',exact:true}).boundingBox();assert.ok(box.y+box.height<844);
    await page.screenshot({path:`/tmp/nihao-avatar-mobile-${width}.png`});
  }
  await page.setViewportSize({width:1440,height:900});
  const reply = async text => { const n=await page.locator('.message--assistant').count();await page.locator('textarea').fill(text);await page.locator('textarea').press('Enter');await page.waitForFunction(n=>document.querySelectorAll('.message--assistant').length>n,n); };
  const av = index => page.locator('.message--assistant .nihao-avatar').nth(index);
  await reply('Say hello'); await page.getByRole('button',{name:'Read aloud',exact:true}).waitFor();
  assert.equal(await page.locator('.message--assistant canvas').count(),0,'history does not animate');
  await page.getByRole('button',{name:'Read aloud',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-activity="speaking"] canvas')?.dataset.mouth==='closed');
  await page.waitForFunction(()=>document.querySelector('[data-activity="speaking"] canvas')?.dataset.mouth==='wide_open');
  await page.screenshot({path:'/tmp/nihao-avatar-speaking.png'});
  await page.waitForFunction(()=>document.querySelector('[data-activity="speaking"] canvas')?.dataset.mouth==='closed');
  assert.equal(await page.getByRole('button',{name:'Stop reading',exact:true}).count(),1,'silence closes mouth before playback ends');
  await page.getByRole('button',{name:'Replay',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.__avatarAudio.analysers),1);
  const calls=speechCalls;
  await page.getByRole('button',{name:'Replay',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-activity="speaking"] canvas')?.dataset.mouth==='wide_open');
  assert.equal(speechCalls,calls,'cached replay uses the same volume route without a request');
  await page.getByRole('button',{name:'Stop reading',exact:true}).click();
  assert.equal(await page.locator('canvas:not([data-mouth="closed"])').count(),0);

  // A new reply is pending while the user explicitly reads an older one.
  chatMode='hold'; heldChat=undefined;await reply('Plan a walk');await poll(()=>heldChat);
  await page.waitForFunction(()=>document.querySelectorAll('.message--assistant .nihao-avatar')[1]?.dataset.activity==='thinking');
  send(heldChat,{type:'delta',text:'Let me check the route. '});
  await page.waitForFunction(()=>document.querySelectorAll('.message--assistant .nihao-avatar')[1]?.dataset.activity==='idle');
  assert.equal(await av(1).locator('canvas').getAttribute('data-mouth'),'closed');
  await page.getByRole('button',{name:'Replay',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.message--assistant .nihao-avatar')[0]?.dataset.activity==='speaking');
  assert.equal(await av(1).locator('canvas').count(),0,'the latest text reply must not speak');
  await page.getByRole('button',{name:'Stop reading',exact:true}).click();
  send(heldChat,{type:'tool-status',tool:'route',status:'running'});
  await page.waitForFunction(()=>document.querySelectorAll('.message--assistant .nihao-avatar')[1]?.dataset.activity==='thinking');
  send(heldChat,{type:'tool-status',tool:'route',status:'complete'});
  await page.waitForFunction(()=>document.querySelectorAll('.message--assistant .nihao-avatar')[1]?.dataset.activity==='idle');
  assert.equal(await av(1).getAttribute('data-action'),'');
  const from={id:'bund',name:'The Bund',address:'Zhongshan East Road, Shanghai',location:{lat:31.24,lng:121.49},navigationUrl:'https://api.map.baidu.com/marker?location=31.24,121.49&output=html'};
  const to={...from,id:'garden',name:'Yu Garden',address:'Huangpu, Shanghai'};
  send(heldChat,{type:'artifact',artifact:{kind:'routes',routes:[{id:'walk',from,to,mode:'walking',minutes:24,meters:1700,steps:['Walk south along the river.'],navigationUrl:'https://api.map.baidu.com/direction?origin=31.24,121.49&destination=31.23,121.49&mode=walking&output=html'}]}});
  await page.waitForTimeout(80);assert.equal(await av(1).getAttribute('data-action'),'','artifacts wait for successful turn completion');
  send(heldChat,{type:'done'});heldChat.end();
  await page.waitForFunction(()=>document.querySelectorAll('.message--assistant .nihao-avatar')[1]?.dataset.action.startsWith('travel:'));
  await page.locator('.travel-map-link').first().waitFor();
  await page.screenshot({path:'/tmp/nihao-avatar-route-desktop.png'});
  for(const width of [390,320]) {
    await page.setViewportSize({width,height:844});await page.waitForTimeout(200);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.locator('.travel-map-link').first().scrollIntoViewIfNeeded();
    await page.locator('.travel-map-link').first().click({trial:true});
    await page.getByRole('button',{name:'Start voice input',exact:true}).click({trial:true});
    await page.screenshot({path:`/tmp/nihao-avatar-route-${width}.png`});
  }
  await page.setViewportSize({width:1440,height:900});
  // Force a large real scroll range, then verify offscreen visual suspension.
  chatMode='hold';heldChat=undefined;await reply('More details');await poll(()=>heldChat);
  send(heldChat,{type:'delta',text:('A short walk beside the river.\n').repeat(70)});send(heldChat,{type:'done'});heldChat.end();
  await page.getByRole('button',{name:'Read aloud',exact:true}).last().waitFor();
  speechMode='long'; await page.getByRole('button',{name:'Read aloud',exact:true}).nth(0).click();
  await av(1).scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>document.querySelector('[data-activity="speaking"] canvas')?.dataset.animating==='true');
  await page.locator('.conversation-scroll').evaluate(e=>{e.scrollTop=e.scrollHeight;});
  await page.waitForFunction(()=>document.querySelector('[data-activity="speaking"] canvas')?.dataset.animating==='false');
  const count=await page.locator('[data-activity="speaking"] canvas').getAttribute('data-draws');
  await page.waitForTimeout(150);assert.equal(await page.locator('[data-activity="speaking"] canvas').getAttribute('data-draws'),count);
  await av(1).scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>document.querySelector('[data-activity="speaking"] canvas')?.dataset.animating==='true');
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
  assert.equal(await page.locator('[data-activity="speaking"] canvas').getAttribute('data-mouth'),'closed');
  assert.equal(await page.evaluate(()=>window.__avatarAudio.contexts.at(-1).state),'running','background visibility must not stop audio');
  await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
  await page.getByRole('button',{name:'Stop reading',exact:true}).click();

  // Fresh message avoids replay cache: audio network gaps leave the mouth closed.
  speechMode='gap';await page.getByRole('button',{name:'Read aloud',exact:true}).last().click();
  await page.locator('[data-activity="speaking"]').scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>['slight_open','medium_open','wide_open'].includes(document.querySelector('[data-activity="speaking"] canvas')?.dataset.mouth));
  await page.waitForTimeout(450);
  assert.equal(await page.locator('[data-activity="speaking"] canvas').getAttribute('data-mouth'),'closed');
  await page.getByRole('button',{name:'Stop reading',exact:true}).click();

  chatMode='error';await reply('Failure example');await page.locator('.reply-error').waitFor();
  assert.equal(await page.locator('.message--assistant .nihao-avatar').last().getAttribute('data-expression'),'concerned');
  chatMode='hold';heldChat=undefined;await page.getByRole('button',{name:'Try again',exact:true}).click();await poll(()=>heldChat);
  await page.getByRole('button',{name:'Stop response',exact:true}).click();
  assert.equal(await page.locator('.message--assistant .nihao-avatar').last().getAttribute('data-expression'),'neutral');
  await page.getByRole('button',{name:'New chat',exact:true}).click();
  send(heldChat,{type:'delta',text:'Late output must be ignored'});send(heldChat,{type:'done'});heldChat.end();
  await page.waitForTimeout(150);assert.equal(await page.locator('.message').count(),0);
  assert.equal(await page.locator('[data-activity="speaking"]').count(),0);

  // Reduced motion disables JS loops, not just CSS transitions.
  const reduced=await browser.newPage({reducedMotion:'reduce'});watch(reduced);await reduced.goto(url);
  await reduced.locator('.nihao-avatar[data-ready="true"]').waitFor();
  const draws=await reduced.locator('canvas').getAttribute('data-draws');await reduced.waitForTimeout(300);
  assert.equal(await reduced.locator('canvas').getAttribute('data-draws'),draws);
  assert.equal(await reduced.locator('canvas').getAttribute('data-animating'),'false');
  assert.equal(await reduced.locator('canvas').getAttribute('data-mouth'),'closed');
  await reduced.close();
  // A corrupt asset is deliberate fault injection, not a real missing resource.
  const broken=await browser.newPage();watch(broken);
  await broken.route('**/avatar/nihao-v1/bust/front.png',r=>r.fulfill({status:200,contentType:'image/png',body:'broken PNG fixture'}));
  await broken.goto(url);await broken.locator('[data-fallback="true"]').waitFor();
  assert.equal(await broken.locator('.nihao-avatar img').getAttribute('src'),'/brand/chat-head.png');
  assert.equal(await broken.locator('.nihao-avatar canvas').count(),0);
  await broken.locator('textarea').fill('Still usable');assert.equal(await broken.getByRole('button',{name:'Send message',exact:true}).isEnabled(),true);
  await broken.close();
  assert.deepEqual(missing,[]);assert.deepEqual(errors,[]);
  console.log('PASS: welcome once, fixed portrait/bust, 320/390/desktop, actual analyser volume and silence, cache replay, old-message ownership, text/tools, validated route completion, stop/error/reset, offscreen/background, reduced motion, asset fallback, no console errors or 404s');
} finally { await browser.close(); fixture.closeAllConnections(); await new Promise(resolve=>fixture.close(resolve)); }
