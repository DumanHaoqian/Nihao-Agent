import assert from 'node:assert/strict';
import { createServer, request as proxyRequest } from 'node:http';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

// Controlled SSE/provider fixtures with the production browser UI. No paid APIs.
const upstream=new URL(process.env.NIHAO_TEST_URL||'http://127.0.0.1:8787');
let reply, speechText='',speechCalls=0;
const send=event=>reply.write(`data: ${JSON.stringify(event)}\n\n`);
const fixture=createServer(async(request,response)=>{
 if(request.url==='/api/chat'){request.resume();reply=response;response.writeHead(200,{'Content-Type':'text/event-stream'});response.flushHeaders();return;}
 if(request.url==='/api/speech'){
  const chunks=[];for await(const c of request)chunks.push(c);speechText=JSON.parse(Buffer.concat(chunks)).text;speechCalls++;
  response.writeHead(200,{'Content-Type':'text/event-stream'});
  response.end([{type:'start',format:'pcm_s16le',sampleRate:24000,channels:1},{type:'audio',data:Buffer.alloc(4800).toString('base64')},{type:'done'}].map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''));return;
 }
 const headers={...request.headers,host:upstream.host};if(headers.origin)headers.origin=upstream.origin;
 const proxy=proxyRequest(new URL(request.url,upstream),{method:request.method,headers},r=>{response.writeHead(r.statusCode,r.headers);r.pipe(response);});proxy.on('error',()=>{response.writeHead(502);response.end();});request.pipe(proxy);
});
await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${fixture.address().port}`;
const browser=await chromium.launch({headless:true,...(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?{channel:'chrome'}:{})});
try{
 const context=await browser.newContext({viewport:{width:1440,height:900},permissions:['clipboard-read','clipboard-write']});const page=await context.newPage();page.setDefaultTimeout(10000);
 const errors=[],missing=[],external=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(['error','warning'].includes(m.type()))errors.push(m.text());});page.on('response',r=>{if(r.status()===404)missing.push(r.url());});page.on('request',r=>{if(r.url().includes('tracker.example'))external.push(r.url());});
 await page.goto(url);assert.match(await page.title(),/Nihao Agent/);
 await page.locator('textarea').fill('请演示 **格式** 和公式');await page.locator('textarea').press('Enter');
 for(let i=0;!reply&&i<100;i++)await page.waitForTimeout(20);assert.ok(reply);
 const first='## 上海一日游\n\n**上午**：漫步外滩，*慢慢走*。\n\n- 地铁出行\n- 随身带水\n\n行内公式：\\(E=mc';
 send({type:'delta',text:first});
 await page.locator('.markdown-reply strong').waitFor();assert.equal(await page.locator('.markdown-reply strong').innerText(),'上午');
 assert.equal(await page.getByRole('button',{name:'Stop response',exact:true}).isVisible(),true);
 assert.equal(await page.locator('.message--user strong').count(),0,'user text remains literal');
 const rest='^2\\)。\n\n独立公式：\n\n$$\nC=\\frac{120+80}{2}=100\\text{ CNY}\n$$\n\n| 地点 | 时间 | 预算 |\n| --- | --- | --- |\n| 外滩 | 09:00 | 免费 |\n| 豫园 | 11:00 | 40 CNY |\n\n> 请核实当天开放时间。\n\n1. 先看路线\n2. 再安排午餐\n\n```python\ncost = 120 + 80\nprint(cost)\n# \\(literal\\) <script>window.injected=1</script>\n```\n\n[查看示例链接](https://example.com/info)\n\n<script>window.injected=1</script>\n\n![not loaded](https://tracker.example/pixel)\n\n[unsafe](javascript:alert)';
 send({type:'delta',text:rest});await page.locator('.markdown-reply table').waitFor();await page.locator('.katex-display').waitFor();
 assert.equal(await page.locator('.markdown-reply .katex').count(),2);assert.equal(await page.getByRole('button',{name:'Read aloud',exact:true}).count(),0,'rich reply renders before the stream completes');
 send({type:'done'});reply.end();await page.getByRole('button',{name:'Read aloud',exact:true}).waitFor();await page.evaluate(()=>document.fonts.ready);
 assert.equal(await page.locator('.markdown-reply em').innerText(),'慢慢走');assert.match(await page.locator('.markdown-reply pre').innerText(),/\\\(literal\\\)/);
 assert.equal(await page.evaluate(()=>window.injected),undefined);assert.equal(await page.locator('.markdown-reply script,.markdown-reply img').count(),0);assert.deepEqual(external,[]);
 const link=page.locator('.markdown-reply a');assert.equal(await link.count(),1);assert.equal(await link.getAttribute('rel'),'noopener noreferrer');
 await page.getByRole('button',{name:'Copy response',exact:true}).click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),first+rest);
 await page.getByRole('button',{name:'Read aloud',exact:true}).click();await page.getByRole('button',{name:'Replay',exact:true}).waitFor();
 assert.match(speechText,/上午：漫步外滩/);assert.doesNotMatch(speechText,/\*\*上午\*\*|## 上海|```/);assert.equal(speechText.split('E=mc^2').length-1,1,'math is read once, not MathML plus visual HTML');
 await page.getByRole('button',{name:'Replay',exact:true}).click();await page.getByRole('button',{name:'Replay',exact:true}).waitFor();assert.equal(speechCalls,1);
 await page.locator('.conversation-scroll').evaluate(e=>{e.scrollTop=0;});await page.waitForTimeout(100);await page.screenshot({path:'/tmp/nihao-markdown-desktop.png'});
 for(const width of [390,320]){await page.setViewportSize({width,height:844});await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.locator('.conversation-scroll').evaluate(e=>{e.scrollTop=0;});await page.screenshot({path:`/tmp/nihao-markdown-${width}.png`});}
 // Long expressions and wide tables scroll inside the reply instead of widening the page.
 reply=undefined;await page.locator('textarea').fill('Long examples');await page.locator('textarea').press('Enter');for(let i=0;!reply&&i<100;i++)await page.waitForTimeout(20);
 const long=Array.from({length:30},(_,i)=>`x_{${i}}`).join('+');
 send({type:'delta',text:`Inline $${long}$\n\n$$\n${long}\n$$\n\n| A | B | C | D | E | F |\n| - | - | - | - | - | - |\n| one | two | three | four | five | six |\n\n\`\`\`text\n${'a'.repeat(250)}\n\`\`\``});send({type:'done'});reply.end();
 await page.locator('.message--assistant').last().locator('.markdown-reply pre').waitFor();await page.waitForTimeout(150);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.ok(await page.locator('.markdown-table').last().evaluate(e=>e.scrollWidth>e.clientWidth));
 assert.ok(await page.locator('.markdown-reply pre').last().evaluate(e=>e.scrollWidth>e.clientWidth));
 // Stop an incomplete formula, then create a fresh conversation.
 reply=undefined;await page.locator('textarea').fill('Partial');await page.locator('textarea').press('Enter');for(let i=0;!reply&&i<100;i++)await page.waitForTimeout(20);
 send({type:'delta',text:'**Partial**\n\n$$\n\\frac{1}{'});await page.locator('.message--assistant').last().locator('strong').waitFor();await page.getByRole('button',{name:'Stop response',exact:true}).click();await page.getByText('Response stopped',{exact:true}).waitFor();
 await page.getByRole('button',{name:'New chat',exact:true}).click();assert.equal(await page.locator('.message').count(),0);
 assert.deepEqual(errors,[]);assert.deepEqual(missing,[]);
 console.log('PASS: incremental Markdown/math, 1440/390/320 layouts, contained wide content, original copy, readable TTS/replay, untrusted-content handling, cancellation/new chat, no console errors or missing fonts/assets (mock providers).');
}finally{await browser.close();fixture.closeAllConnections();await new Promise(r=>fixture.close(r));}
