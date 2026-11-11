import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pcm16Decoder, SpeechError, StreamingPcmPlayer, streamSpeech } from './speech.ts';

function streamResponse(data: string, chunkSize = 1): Response {
  const encoded = new TextEncoder().encode(data);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < encoded.length; offset += chunkSize) controller.enqueue(encoded.slice(offset, offset + chunkSize));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

const start = 'data: {"type":"start","format":"pcm_s16le","sampleRate":24000,"channels":1}\r\n\r\n';
const audio = 'data: {"type":"audio","data":"AID/f///AAA="}\r\n\r\n';
const done = 'data: {"type":"done"}\r\n\r\n';

test('speech streams audio before done across byte-split CRLF frames', async context => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const encoder = new TextEncoder();
  context.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { text: 'Hello, Nihao' });
    return new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const byte of encoder.encode(start + audio)) controller.enqueue(Uint8Array.of(byte));
        await gate;
        controller.enqueue(encoder.encode(done));
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const blocks: Uint8Array[] = [];
  await streamSpeech('Hello, Nihao', new AbortController().signal, bytes => { blocks.push(bytes); release(); });
  assert.deepEqual([...blocks[0]!], [0, 128, 255, 127, 255, 255, 0, 0]);
});

test('PCM decoder preserves signed little-endian samples across odd block boundaries', () => {
  const decoder = new Pcm16Decoder();
  const outputs = [decoder.push(Uint8Array.of(0)), decoder.push(new Uint8Array()), decoder.push(Uint8Array.of(128, 255, 127, 255)), decoder.push(Uint8Array.of(255, 0, 0))];
  decoder.finish();
  assert.deepEqual(outputs.flatMap(values => [...values]), [-1, 32767 / 32768, -1 / 32768, 0]);
  const truncated = new Pcm16Decoder();
  truncated.push(Uint8Array.of(1));
  assert.throws(() => truncated.finish(), (error: unknown) => error instanceof SpeechError && error.code === 'SPEECH_INVALID_RESPONSE');
});

test('missing start, empty audio, malformed audio and premature EOF never count as successful playback', async context => {
  const fetchMock = context.mock.method(globalThis, 'fetch', async () => streamResponse(''));
  for (const [body, code] of [
    [audio + done, 'SPEECH_INVALID_RESPONSE'],
    [start + done, 'SPEECH_EMPTY'],
    [start + 'data: {"type":"audio","data":"not base64"}\n\n' + done, 'SPEECH_INVALID_RESPONSE'],
    [start + audio, 'SPEECH_INTERRUPTED'],
    [start.replace('24000', '48000') + audio + done, 'SPEECH_INVALID_RESPONSE'],
  ]) {
    fetchMock.mock.mockImplementation(async () => streamResponse(body!));
    await assert.rejects(streamSpeech('Hello', new AbortController().signal, () => {}), (error: unknown) => error instanceof SpeechError && error.code === code);
  }
});

test('speech errors retain only the stable error code from prestream and midstream failures', async context => {
  const fetchMock = context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ code: 'SPEECH_NOT_CONFIGURED', message: 'Do not show raw provider data' }), { status: 503 }));
  await assert.rejects(streamSpeech('Hello', new AbortController().signal, () => {}), (error: unknown) => error instanceof SpeechError && error.message === 'SPEECH_NOT_CONFIGURED');
  fetchMock.mock.mockImplementation(async () => streamResponse(start + 'data: {"type":"error","code":"SPEECH_AUTH_ERROR","message":"private"}\n\n'));
  await assert.rejects(streamSpeech('Hello', new AbortController().signal, () => {}), (error: unknown) => error instanceof SpeechError && error.message === 'SPEECH_AUTH_ERROR');
});

test('aborting speech cancels a reader waiting for the next audio packet', async context => {
  const abort = new AbortController();
  let cancelled = false;
  context.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(start + audio));
    },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  await assert.rejects(streamSpeech('Hello', abort.signal, () => { abort.abort(); }), (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(cancelled, true);
});

function mockAudioContext() {
  const analyser = { fftSize: 0, smoothingTimeConstant: 0, disconnected: false, level: .1, connect() {}, disconnect() { this.disconnected = true; }, getFloatTimeDomainData(array: Float32Array) { array.fill(this.level); } };
  const sources: { buffer: { duration: number } | null; onended: (() => void) | null; when: number; stopped: boolean; disconnected: boolean; connect(): void; disconnect(): void; start(when: number): void; stop(): void }[] = [];
  const context = {
    currentTime: 10,
    state: 'running',
    createAnalyser: () => analyser,
    destination: {},
    createBuffer(_channels: number, frames: number, rate: number) {
      const data = new Float32Array(frames);
      return { duration: frames / rate, getChannelData: () => data };
    },
    createBufferSource() {
      const source = { buffer: null as { duration: number } | null, onended: null as (() => void) | null, when: 0, stopped: false, disconnected: false,
        connect() {}, disconnect() { this.disconnected = true; }, start(when: number) { this.when = when; }, stop() { this.stopped = true; },
      };
      sources.push(source);
      return source;
    },
  };
  return { context, sources, analyser };
}

test('one shared analyser reads output only during actual scheduled sound, including silence and replay', async () => {
  const { context, sources, analyser } = mockAudioContext();
  const player = new StreamingPcmPlayer(context as unknown as AudioContext);
  player.enqueue(new Uint8Array(4800));
  assert.equal(player.readLevel(), 0, 'enqueued does not mean audible');
  context.currentTime = 10.08;
  assert.ok(Math.abs(player.readLevel() - .1) < .00001);
  analyser.level = 0;
  assert.equal(player.readLevel(), 0, 'silent PCM closes mouth even while playing');
  analyser.level = .3;
  context.currentTime = 10.2;
  assert.equal(player.readLevel(), 0, 'network gap must not read stale analyser data');
  sources[0]!.onended?.();
  player.enqueue(new Uint8Array(4800));
  assert.equal(player.readLevel(), 0, 'new scheduled block still waits for its start');
  context.currentTime = 10.28;
  assert.ok(player.readLevel() > .29);
  const done = player.finish();
  sources[1]!.onended?.();
  await done;
  assert.equal(player.readLevel(), 0);
  assert.equal(analyser.disconnected, true);
  const replay = mockAudioContext();
  const replayPlayer = new StreamingPcmPlayer(replay.context as unknown as AudioContext);
  replayPlayer.enqueue(new Uint8Array(4800));
  replay.context.currentTime = 10.08;
  assert.ok(replayPlayer.readLevel() > 0);
  replayPlayer.stop();
  assert.equal(replayPlayer.readLevel(), 0);
  assert.equal(replay.analyser.disconnected, true);
});

test('audio completion waits for scheduled sound, and cancellation stops every outstanding source', async () => {
  const { context, sources } = mockAudioContext();
  const player = new StreamingPcmPlayer(context as unknown as AudioContext);
  player.enqueue(new Uint8Array(4800));
  player.enqueue(new Uint8Array(4800));
  assert.equal(sources[0]!.when, 10.04);
  assert.ok(Math.abs(sources[1]!.when - 10.14) < .00001);
  let finished = false;
  const completion = player.finish().then(() => { finished = true; });
  sources[0]!.onended?.();
  await Promise.resolve();
  assert.equal(finished, false);
  sources[1]!.onended?.();
  await completion;
  assert.equal(finished, true);

  const other = mockAudioContext();
  const cancellable = new StreamingPcmPlayer(other.context as unknown as AudioContext);
  cancellable.enqueue(new Uint8Array(4800));
  cancellable.enqueue(new Uint8Array(4800));
  const stopped = assert.rejects(cancellable.finish(), (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  cancellable.stop();
  await stopped;
  assert.ok(other.sources.every(source => source.stopped && source.disconnected));
});
