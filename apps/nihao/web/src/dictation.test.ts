import assert from 'node:assert/strict';
import test from 'node:test';
import { PcmPacketizer } from '../public/audio/pcm-capture.js';
import { appendDictation, DictationCapture, DictationError, parseDictationEvent } from './dictation.ts';

function resample(rate: number, input: Float32Array, block: number): Buffer {
  const packets: Buffer[] = [];
  const encoder = new PcmPacketizer(rate, packet => packets.push(Buffer.from(packet)));
  for (let offset = 0; offset < input.length; offset += block) encoder.push(input.subarray(offset, offset + block));
  encoder.flush();
  return Buffer.concat(packets);
}

test('48 kHz microphone audio emits exact 200 ms PCM16LE packets before completion', () => {
  const packets: ArrayBuffer[] = [];
  const encoder = new PcmPacketizer(48000, packet => packets.push(packet));
  encoder.push(new Float32Array(9599).fill(-.5));
  assert.equal(packets.length, 0);
  encoder.push(new Float32Array([-.5]));
  assert.equal(packets.length, 1);
  assert.equal(packets[0]!.byteLength, 6400);
  assert.equal(new DataView(packets[0]!).getInt16(0, true), -16384);
  encoder.flush();
  assert.equal(packets.length, 1, 'an empty tail does not create an audio packet');
});

test('44.1 kHz resampling keeps fractional positions across AudioWorklet blocks and flushes the tail', () => {
  const input = Float32Array.from({ length: 44107 }, (_, index) => Math.sin(index * 2 * Math.PI * 440 / 44100) * .8);
  const contiguous = resample(44100, input, input.length);
  const workletBlocks = resample(44100, input, 128);
  assert.deepEqual(workletBlocks, contiguous);
  assert.equal(workletBlocks.length, Math.ceil(input.length * 16000 / 44100) * 2);
  assert.deepEqual(resample(48000, new Float32Array([.25, .25]), 1), Buffer.from([0, 32]));
});

test('PCM clamps clipping and invalid samples instead of overflowing', () => {
  const bytes = resample(16000, new Float32Array([-2, -1, 0, 1, 2, NaN, Infinity]), 2);
  assert.deepEqual(Array.from({ length: bytes.length / 2 }, (_, i) => bytes.readInt16LE(i * 2)), [-32768, -32768, 0, 32767, 32767, 0, 0]);
});

test('dictation protocol accepts complete replacements and discards raw provider messages', () => {
  assert.deepEqual(parseDictationEvent('{"type":"ready","sampleRate":16000,"channels":1}'), { type: 'ready', sampleRate: 16000, channels: 1 });
  assert.deepEqual(parseDictationEvent('{"type":"transcript","text":"你好，上海。","final":true}'), { type: 'transcript', text: '你好，上海。', final: true });
  assert.deepEqual(parseDictationEvent('{"type":"error","code":"ASR_AUTH_ERROR","message":"secret-debug"}'), { type: 'error', code: 'ASR_AUTH_ERROR' });
  assert.deepEqual(parseDictationEvent('{"type":"error","code":"private-message"}'), { type: 'error', code: 'ASR_PROVIDER_ERROR' });
  for (const raw of ['null', '[]', '{"type":"ready","sampleRate":24000,"channels":1}', '{"type":"transcript","text":"hello"}', 'x'.repeat(65537), new ArrayBuffer(4)]) {
    assert.throws(() => parseDictationEvent(raw), DictationError);
  }
  assert.equal(appendDictation('A typed question:', '上海'), 'A typed question: 上海');
  assert.equal(appendDictation('A typed question:\n', 'Shanghai'), 'A typed question:\nShanghai');
  assert.equal(appendDictation('original ', ''), 'original ');
});

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function browserFixture(permission?: Promise<MediaStream>) {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const tracks = { stopped: 0, stop() { this.stopped++; }, addEventListener() {} };
  const stream = { getTracks: () => [tracks], getAudioTracks: () => [tracks] } as unknown as MediaStream;
  const contexts: AudioContextMock[] = [];
  const sockets: SocketMock[] = [];
  const worklets: WorkletMock[] = [];
  class AudioContextMock {
    state = 'running';
    destination = {};
    closed = 0;
    audioWorklet = { addModule: async () => undefined };
    constructor() { contexts.push(this); }
    resume() { return Promise.resolve(); }
    close() { this.closed++; return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  }
  class WorkletMock {
    port = { onmessage: undefined as ((event: { data: unknown }) => void) | null | undefined, messages: [] as unknown[], postMessage: (message: unknown) => { this.port.messages.push(message); }, close() {} };
    constructor() { worklets.push(this); }
    emit(data: unknown) { this.port.onmessage?.({ data }); }
    connect() {}
    disconnect() {}
  }
  class SocketMock {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    sent: (ArrayBuffer | string)[] = [];
    closed = false;
    onmessage?: (event: { data: unknown }) => void;
    onclose?: () => void;
    onerror?: () => void;
    constructor() { sockets.push(this); }
    send(value: ArrayBuffer | string) { this.sent.push(value); }
    close() { this.closed = true; }
    receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  const replace = (key: string, value: unknown) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  replace('isSecureContext', true);
  replace('navigator', { mediaDevices: { getUserMedia: () => permission ?? Promise.resolve(stream) } });
  replace('window', { AudioContext: AudioContextMock, AudioWorkletNode: WorkletMock, location: { href: 'http://127.0.0.1:8787/' } });
  replace('AudioContext', AudioContextMock);
  replace('AudioWorkletNode', WorkletMock);
  replace('WebSocket', SocketMock);
  const restore = () => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } };
  return { stream, tracks, sockets, worklets, contexts, restore };
}

test('cancelling while microphone permission is pending closes late-granted tracks without opening a socket', async () => {
  let grant!: (stream: MediaStream) => void;
  const fixture = browserFixture(new Promise(resolve => { grant = resolve; }));
  let errors = 0;
  const capture = new DictationCapture({ onStatus() {}, onMeter() {}, onTranscript() {}, onComplete() {}, onError() { errors++; } });
  try {
    capture.start();
    capture.cancel();
    grant(fixture.stream);
    await tick();
    assert.equal(fixture.tracks.stopped, 1);
    assert.equal(fixture.contexts[0]!.closed, 1);
    assert.equal(fixture.sockets.length, 0);
    assert.equal(errors, 0);
  } finally { capture.cancel(); fixture.restore(); }
});

test('finish flushes partial audio before the finish marker and waits for the final result', async () => {
  const fixture = browserFixture();
  const texts: string[] = [];
  const errors: string[] = [];
  let completed = false;
  const capture = new DictationCapture({ onStatus() {}, onMeter() {}, onTranscript(text) { texts.push(text); }, onComplete() { completed = true; }, onError(code) { errors.push(code); } });
  try {
    capture.start();
    await tick();
    const socket = fixture.sockets[0]!;
    assert.equal(fixture.worklets.length, 0, 'no audio graph sends data before provider readiness');
    socket.receive({ type: 'ready', sampleRate: 16000, channels: 1 });
    const worklet = fixture.worklets[0]!;
    worklet.emit({ type: 'pcm', pcm: new ArrayBuffer(6400) });
    socket.receive({ type: 'transcript', text: 'Shang', final: false });
    capture.finish();
    assert.ok(fixture.tracks.stopped > 0, 'microphone stops immediately, before transcription completes');
    assert.deepEqual(worklet.port.messages, [{ type: 'flush' }]);
    assert.equal(socket.sent.length, 1, 'finish marker waits for the processor tail');
    worklet.emit({ type: 'pcm', pcm: new ArrayBuffer(100) });
    worklet.emit({ type: 'flushed' });
    assert.deepEqual(socket.sent.map(item => typeof item === 'string' ? item : item.byteLength), [6400, 100, '{"type":"finish"}']);
    assert.equal(fixture.contexts[0]!.closed, 1);
    assert.equal(socket.closed, false, 'the service can still return final text after microphone shutdown');
    socket.receive({ type: 'transcript', text: 'Shanghai.', final: true });
    socket.receive({ type: 'done' });
    assert.deepEqual(texts, ['Shang', 'Shanghai.']);
    assert.equal(completed, true);
    assert.equal(socket.closed, true);
    assert.deepEqual(errors, []);
  } finally { capture.cancel(); fixture.restore(); }
});

test('premature completion preserves delivered text and reports an interrupted stream', async () => {
  const fixture = browserFixture();
  const texts: string[] = [];
  const errors: string[] = [];
  let completed = false;
  const capture = new DictationCapture({ onStatus() {}, onMeter() {}, onTranscript(text) { texts.push(text); }, onComplete() { completed = true; }, onError(code) { errors.push(code); } });
  try {
    capture.start();
    await tick();
    const socket = fixture.sockets[0]!;
    socket.receive({ type: 'ready', sampleRate: 16000, channels: 1 });
    socket.receive({ type: 'transcript', text: 'A useful partial reply', final: false });
    socket.receive({ type: 'done' });
    assert.deepEqual(texts, ['A useful partial reply']);
    assert.deepEqual(errors, ['ASR_INTERRUPTED']);
    assert.equal(completed, false);
    assert.ok(fixture.tracks.stopped > 0);
    assert.equal(socket.closed, true);
  } finally { capture.cancel(); fixture.restore(); }
});
