import assert from 'node:assert/strict';
import { createServer, request as proxyRequest } from 'node:http';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

// A streaming test provider in front of the real built UI; no provider credits are used.
const upstream = new URL(process.env.NIHAO_TEST_URL || 'http://127.0.0.1:8787');
let mode = 'success';
const requests = [];
function tone(seconds) {
  const bytes = Buffer.alloc(Math.floor(24000 * seconds) * 2);
  for (let i = 0; i < bytes.length / 2; i++) bytes.writeInt16LE(Math.round(Math.sin(i * 440 * 2 * Math.PI / 24000) * 120), i * 2);
  return bytes;
}
const fixture = createServer(async (request, response) => {
  if (request.url === '/api/chat') {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('data: {"type":"delta","text":"Nihao. We can explore Shanghai together."}\n\ndata: {"type":"done"}\n\n');
    return;
  }
  if (request.url === '/api/speech') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const entry = { body: JSON.parse(Buffer.concat(chunks).toString()), mode, closed: false, done: false };
    requests.push(entry);
    response.on('close', () => { entry.closed = true; });
    if (mode === 'auth') {
      response.writeHead(502, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ code: 'SPEECH_AUTH_ERROR', message: 'provider-debug-must-not-appear' }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = event => { if (!response.destroyed) response.write(`data: ${JSON.stringify(event)}\n\n`); };
    send({ type: 'start', format: 'pcm_s16le', sampleRate: 24000, channels: 1 });
    if (mode === 'loading') return;
    const bytes = tone(mode === 'pending' ? 3 : .7);
    // An odd byte split exercises real browser PCM carry handling.
    send({ type: 'audio', data: bytes.subarray(0, 7001).toString('base64') });
    const more = setTimeout(() => send({ type: 'audio', data: bytes.subarray(7001).toString('base64') }), 140);
    const finish = mode === 'success' ? setTimeout(() => {
      entry.done = true;
      send({ type: 'done' });
      response.end();
    }, 350) : undefined;
    response.once('close', () => { clearTimeout(more); clearTimeout(finish); });
    return;
  }
  // Static assets are forwarded to another local origin; keep its origin checks intact.
  const headers = { ...request.headers, host: upstream.host };
  if (headers.origin) headers.origin = upstream.origin;
  const proxy = proxyRequest(new URL(request.url, upstream), { method: request.method, headers }, result => {
    response.writeHead(result.statusCode, result.headers);
    result.pipe(response);
  });
  proxy.on('error', () => { response.writeHead(502); response.end(); });
  request.pipe(proxy);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${fixture.address().port}`;
const browser = await chromium.launch({ headless: true, ...(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? { channel: 'chrome' } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const NativeContext = window.AudioContext;
    window.__nihaoAudio = { starts: 0, stops: 0, closes: 0 };
    window.AudioContext = class extends NativeContext {
      createBufferSource() {
        const source = super.createBufferSource();
        const start = source.start.bind(source);
        const stop = source.stop.bind(source);
        source.start = (...args) => { window.__nihaoAudio.starts++; return start(...args); };
        source.stop = (...args) => { window.__nihaoAudio.stops++; return stop(...args); };
        return source;
      }
      close() { window.__nihaoAudio.closes++; return super.close(); }
    };
  });
  await page.goto(url);
  async function reply() {
    const previous = await page.locator('.message--assistant').count();
    await page.locator('textarea').fill('Say hello');
    await page.locator('textarea').press('Enter');
    await page.waitForFunction(count => document.querySelectorAll('.message--assistant').length > count, previous);
    await page.getByRole('button', { name: 'Read aloud', exact: true }).last().waitFor();
  }
  async function freshReply() {
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await reply();
  }
  await reply();
  await page.getByRole('button', { name: 'Read aloud', exact: true }).click();
  await page.waitForFunction(() => window.__nihaoAudio.starts > 0);
  assert.equal(requests[0].done, false, 'playback starts before the streaming provider finishes');
  assert.match(requests[0].body.text, /Shanghai/);
  await page.screenshot({ path: '/tmp/nihao-speech-desktop.png' });
  await page.getByRole('button', { name: 'Replay', exact: true }).waitFor();
  const count = requests.length;
  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  await page.getByRole('button', { name: 'Stop reading', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Replay', exact: true }).waitFor();
  assert.equal(requests.length, count, 'replay reuses completed cached audio');

  await freshReply();
  mode = 'loading';
  await page.getByRole('button', { name: 'Read aloud', exact: true }).click();
  await page.getByRole('button', { name: 'Stop reading', exact: true }).click();
  await page.getByRole('button', { name: 'Read aloud', exact: true }).waitFor();

  mode = 'pending';
  const before = await page.evaluate(() => window.__nihaoAudio.starts);
  await page.getByRole('button', { name: 'Read aloud', exact: true }).click();
  await page.waitForFunction(previous => window.__nihaoAudio.starts > previous, before);
  const activeRequest = requests.at(-1);
  await page.getByRole('button', { name: 'Stop reading', exact: true }).click();
  await page.waitForFunction(() => window.__nihaoAudio.stops > 0);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(activeRequest.closed, true, 'stop closes the streaming request');

  await reply();
  await page.getByRole('button', { name: 'Read aloud', exact: true }).first().click();
  await page.getByRole('button', { name: 'Stop reading', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Read aloud', exact: true }).last().click();
  assert.equal(await page.getByRole('button', { name: 'Stop reading', exact: true }).count(), 1);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Stop reading', exact: true }).count(), 0);

  mode = 'auth';
  await reply();
  await page.getByRole('button', { name: 'Read aloud', exact: true }).click();
  await page.locator('.speech-error').waitFor();
  assert.doesNotMatch(await page.locator('body').innerText(), /provider-debug-must-not-appear/);
  await page.getByRole('button', { name: '中文', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  mode = 'success';
  await page.getByRole('button', { name: '朗读', exact: true }).click();
  await page.getByRole('button', { name: '重播', exact: true }).waitFor();
  await page.screenshot({ path: '/tmp/nihao-speech-mobile.png' });
  assert.equal(await page.locator('.speech-error').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: actual Web Audio streaming before done, cached replay, cancel loading/playback, one active reply, new-chat cleanup, safe auth error/retry, Chinese/mobile, console');
} finally {
  await browser.close();
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
}
