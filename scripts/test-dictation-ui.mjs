import assert from 'node:assert/strict';
import { createServer, request as proxyRequest } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';

// Actual browser microphone/AudioWorklet pipeline with a synthetic input device.
// Only the recognition provider is simulated; these checks use no API credits.
const upstream = new URL(process.env.NIHAO_TEST_URL || 'http://127.0.0.1:8787');
const temporary = await mkdtemp(join(tmpdir(), 'nihao-dictation-test-'));
const inputPath = join(temporary, 'input.wav');
const pcm = Buffer.alloc(48000 * 2 * 5);
for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 330 * Math.PI * 2 / 48000) * 3000), i * 2);
const wav = Buffer.alloc(44);
wav.write('RIFF'); wav.writeUInt32LE(pcm.length + 36, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40);
await writeFile(inputPath, Buffer.concat([wav, pcm]));
let mode = 'success';
const sessions = [], chats = [], speechRequests = [];
const fixture = createServer((request, response) => {
  if (request.url === '/api/speech') {
    request.resume();
    const entry = { closed: false };
    speechRequests.push(entry);
    response.once('close', () => { entry.closed = true; });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: {"type":"start","format":"pcm_s16le","sampleRate":24000,"channels":1}\n\n');
    response.write(`data: ${JSON.stringify({ type: 'audio', data: Buffer.alloc(24000 * 2 * 2).toString('base64') })}\n\n`);
    return;
  }
  if (request.url === '/api/chat') {
    const body = [];
    request.on('data', chunk => body.push(chunk));
    request.on('end', () => {
      chats.push(JSON.parse(Buffer.concat(body).toString()));
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: {"type":"delta","text":"Take the metro to the Bund."}\n\ndata: {"type":"done"}\n\n');
    });
    return;
  }
  const headers = { ...request.headers, host: upstream.host };
  if (headers.origin) headers.origin = upstream.origin;
  const proxy = proxyRequest(new URL(request.url, upstream), { method: request.method, headers }, result => {
    response.writeHead(result.statusCode, result.headers); result.pipe(response);
  });
  proxy.on('error', () => { response.writeHead(502); response.end(); });
  request.pipe(proxy);
});
const sockets = new WebSocketServer({ noServer: true });
fixture.on('upgrade', (request, socket, head) => {
  if (request.url !== '/api/transcribe') { socket.destroy(); return; }
  sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws));
});
sockets.on('connection', ws => {
  const entry = { mode, packets: [], finish: false, cancelled: false, closed: false };
  sessions.push(entry);
  const send = event => { if (ws.readyState === 1) ws.send(JSON.stringify(event)); };
  if (entry.mode !== 'connecting') send({ type: 'ready', sampleRate: 16000, channels: 1 });
  ws.on('message', (data, binary) => {
    if (binary) {
      entry.packets.push(Buffer.from(data));
      if (entry.mode === 'failure') {
        send({ type: 'error', code: 'ASR_AUTH_ERROR', message: 'raw-provider-debug-must-not-appear' }); ws.close(); return;
      }
      if (entry.mode === 'silence') return;
      if (entry.packets.length === 1) send({ type: 'transcript', text: 'How do I get to the bond', final: false });
      if (entry.packets.length === 3) send({ type: 'transcript', text: 'How do I get to the Bund', final: false });
    } else {
      const control = JSON.parse(data.toString());
      if (control.type === 'cancel') { entry.cancelled = true; ws.close(); }
      if (control.type === 'finish') {
        entry.finish = true;
        if (entry.mode === 'finishing') return;
        setTimeout(() => {
          if (entry.mode === 'silence') send({ type: 'error', code: 'ASR_NO_SPEECH' });
          else { send({ type: 'transcript', text: 'How do I get to the Bund?', final: true }); send({ type: 'done' }); }
          ws.close();
        }, 150);
      }
    }
  });
  ws.on('close', () => { entry.closed = true; });
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${fixture.address().port}`;
const browser = await chromium.launch({ headless: true, ...(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? { channel: 'chrome' } : {}), args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${inputPath}`] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text()); });
  await page.addInitScript(() => {
    window.__microphoneTracks = [];
    window.__microphoneMode = 'normal';
    const native = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (window.__microphoneMode === 'denied') throw new DOMException('Test denial', 'NotAllowedError');
      const stream = await native(constraints);
      window.__microphoneTracks.push(...stream.getTracks());
      if (window.__microphoneMode === 'delayed') await new Promise(resolve => setTimeout(resolve, 400));
      return stream;
    };
  });
  await page.goto(url);
  assert.match(await page.title(), /Nihao Agent/);
  await page.locator('textarea').waitFor();
  const input = page.locator('textarea');
  const start = () => page.getByRole('button', { name: 'Start voice input', exact: true }).click();
  const cancel = () => page.getByRole('button', { name: 'Cancel voice input', exact: true }).click();
  const finish = () => page.getByRole('button', { name: 'Finish voice input', exact: true }).click();
  const released = () => page.waitForFunction(() => window.__microphoneTracks.every(track => track.readyState === 'ended'));
  const hasTranscript = () => page.waitForFunction(() => document.querySelector('textarea').value.includes('Bund'));

  await input.fill('Please help:');
  await start();
  await hasTranscript();
  assert.equal(await input.evaluate(element => element.readOnly), true);
  assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).count(), 0);
  assert.match(await input.inputValue(), /^Please help:/);
  assert.equal(chats.length, 0, 'dictation never auto-sends to the chat model');
  assert.ok(sessions[0].packets.every(chunk => chunk.length === 6400), 'capture sends 200ms 16kHz PCM packets');
  assert.ok(sessions[0].packets.some(chunk => chunk.some(byte => byte !== 0)), 'actual microphone pipeline yields non-silent PCM');
  await page.screenshot({ path: '/tmp/nihao-dictation-desktop.png' });
  await finish();
  await page.getByRole('button', { name: 'Start voice input', exact: true }).waitFor();
  await released();
  assert.match(await input.inputValue(), /Bund\?$/);
  assert.equal(await input.evaluate(element => element.readOnly), false);
  assert.equal(sessions[0].finish, true);

  const original = await input.inputValue();
  await start();
  await page.waitForFunction(() => document.querySelector('textarea').value.includes('bond'));
  await cancel();
  await released();
  assert.equal(await input.inputValue(), original, 'cancel restores the original draft');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Copy response', exact: true }).waitFor();
  assert.equal(chats[0].messages.at(-1).content, original);

  // Read aloud and the microphone never remain active together.
  await page.getByRole('button', { name: 'Read aloud', exact: true }).click();
  await page.getByRole('button', { name: 'Stop reading', exact: true }).waitFor();
  await start();
  await hasTranscript();
  assert.equal(await page.getByRole('button', { name: 'Stop reading', exact: true }).count(), 0);
  assert.equal(speechRequests[0].closed, true, 'starting the microphone cancels synthesis');
  await page.getByRole('button', { name: 'Read aloud', exact: true }).click();
  await released();
  await page.getByRole('button', { name: 'Start voice input', exact: true }).waitFor();
  assert.equal(await input.inputValue(), '', 'read aloud cancels dictation and restores its original draft');
  await page.getByRole('button', { name: 'Stop reading', exact: true }).click();

  // New chat must stop a live microphone and ignore late provider data.
  await start();
  await hasTranscript();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await released();
  assert.equal(await input.inputValue(), '');
  assert.equal(await page.locator('.message').count(), 0);

  // A cancelled permission request can resolve later; every late track is stopped.
  await page.evaluate(() => { window.__microphoneMode = 'delayed'; });
  await start();
  await cancel();
  await page.waitForTimeout(500);
  await released();
  await page.evaluate(() => { window.__microphoneMode = 'denied'; });
  await start();
  await page.locator('.dictation-error').waitFor();
  assert.match(await page.locator('.dictation-error').innerText(), /microphone|permission/i);
  await page.evaluate(() => { window.__microphoneMode = 'normal'; });

  mode = 'connecting';
  await start();
  await page.locator('.dictation-status').filter({ hasText: 'Connecting' }).waitFor();
  await cancel();
  await released();

  mode = 'failure';
  await start();
  await page.locator('.dictation-error').waitFor();
  await released();
  assert.doesNotMatch(await page.locator('body').innerText(), /raw-provider-debug-must-not-appear/);

  mode = 'silence';
  await start();
  await page.locator('.dictation-status').filter({ hasText: 'Listening' }).waitFor();
  await page.waitForTimeout(300);
  await finish();
  await page.locator('.dictation-error').waitFor();
  await released();

  mode = 'finishing';
  await start();
  await hasTranscript();
  await finish();
  await page.locator('.dictation-status').filter({ hasText: 'Finishing' }).waitFor();
  await released();
  await cancel();

  // Mobile, localization, keyboard cancellation and provider recovery.
  mode = 'success';
  await page.getByRole('button', { name: '中文', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '开始语音输入', exact: true }).click();
  await hasTranscript();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: '/tmp/nihao-dictation-mobile.png' });
  await page.keyboard.press('Escape');
  await released();
  await page.getByRole('button', { name: '开始语音输入', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: actual microphone/AudioWorklet PCM, interim correction/final tail, editable draft/no autosend, cancel restore, send, TTS mutual exclusion, new-chat cleanup, late permission cleanup, denial, connecting/finishing cancel, safe provider error, silence, Chinese/mobile/Escape, console');
} finally {
  await browser.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise(resolve => sockets.close(resolve));
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
