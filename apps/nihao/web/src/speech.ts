/** Browser-only speech transport. Provider credentials never reach this module. */
export class SpeechError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SpeechError';
  }
}

export const SPEECH_SAMPLE_RATE = 24_000;
export const MAX_SPEECH_BYTES = 32 * 1024 * 1024;
const MAX_FRAME_CHARACTERS = 2 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Playback stopped', 'AbortError');
}

/** Decode and deliver each PCM block before the provider finishes synthesis. */
export async function streamSpeech(text: string, signal: AbortSignal, onAudio: (bytes: Uint8Array) => void): Promise<void> {
  checkAbort(signal);
  let response: Response;
  try {
    response = await fetch('/api/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ text }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new SpeechError('SPEECH_NETWORK_ERROR');
  }
  if (!response.ok) {
    let code = response.status === 429 ? 'SPEECH_BUSY' : 'SPEECH_UNAVAILABLE';
    try {
      const body: unknown = await response.json();
      if (isRecord(body) && typeof body.code === 'string') code = body.code;
    } catch { checkAbort(signal); }
    throw new SpeechError(code);
  }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new SpeechError('SPEECH_INVALID_RESPONSE');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let started = false;
  let complete = false;
  let bytesReceived = 0;
  const abortReader = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abortReader, { once: true });

  function parseFrame(frame: string): void {
    checkAbort(signal);
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    let event: unknown;
    try { event = JSON.parse(data); } catch { throw new SpeechError('SPEECH_INVALID_RESPONSE'); }
    if (!isRecord(event)) throw new SpeechError('SPEECH_INVALID_RESPONSE');
    if (event.type === 'error') throw new SpeechError(typeof event.code === 'string' ? event.code : 'SPEECH_UNAVAILABLE');
    if (event.type === 'start') {
      if (started || event.format !== 'pcm_s16le' || event.sampleRate !== SPEECH_SAMPLE_RATE || event.channels !== 1) throw new SpeechError('SPEECH_INVALID_RESPONSE');
      started = true;
    } else if (event.type === 'audio') {
      if (!started || typeof event.data !== 'string' || !event.data.length || event.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(event.data)) throw new SpeechError('SPEECH_INVALID_RESPONSE');
      let binary: string;
      try { binary = atob(event.data); } catch { throw new SpeechError('SPEECH_INVALID_RESPONSE'); }
      if (btoa(binary) !== event.data) throw new SpeechError('SPEECH_INVALID_RESPONSE');
      bytesReceived += binary.length;
      if (bytesReceived > MAX_SPEECH_BYTES) throw new SpeechError('SPEECH_TOO_LONG');
      onAudio(Uint8Array.from(binary, character => character.charCodeAt(0)));
    } else if (event.type === 'done') {
      if (!started || !bytesReceived) throw new SpeechError('SPEECH_EMPTY');
      complete = true;
    } else {
      throw new SpeechError('SPEECH_INVALID_RESPONSE');
    }
  }

  try {
    while (!complete) {
      checkAbort(signal);
      const { value, done } = await reader.read();
      checkAbort(signal);
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      pending = pending.replace(/\r\n/g, '\n');
      if (pending.length > MAX_FRAME_CHARACTERS) throw new SpeechError('SPEECH_INVALID_RESPONSE');
      let boundary = pending.indexOf('\n\n');
      while (boundary !== -1) {
        parseFrame(pending.slice(0, boundary));
        pending = pending.slice(boundary + 2);
        if (complete) break;
        boundary = pending.indexOf('\n\n');
      }
      if (done) {
        if (pending.trim() && !complete) parseFrame(pending);
        break;
      }
    }
    if (!complete) throw new SpeechError('SPEECH_INTERRUPTED');
  } catch (error) {
    checkAbort(signal);
    if (error instanceof SpeechError) throw error;
    throw new SpeechError('SPEECH_NETWORK_ERROR');
  } finally {
    signal.removeEventListener('abort', abortReader);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** PCM samples may be split between any pair of network blocks. */
export class Pcm16Decoder {
  private lowByte: number | undefined;

  push(bytes: Uint8Array): Float32Array {
    const samples = new Float32Array(Math.floor((bytes.length + (this.lowByte === undefined ? 0 : 1)) / 2));
    let input = 0;
    let output = 0;
    if (this.lowByte !== undefined && bytes.length) {
      const value = this.lowByte | (bytes[input++]! << 8);
      samples[output++] = (value >= 0x8000 ? value - 0x10000 : value) / 32768;
      this.lowByte = undefined;
    }
    while (input + 1 < bytes.length) {
      const value = bytes[input]! | (bytes[input + 1]! << 8);
      samples[output++] = (value >= 0x8000 ? value - 0x10000 : value) / 32768;
      input += 2;
    }
    if (input < bytes.length) this.lowByte = bytes[input];
    return samples;
  }

  finish(): void {
    if (this.lowByte !== undefined) throw new SpeechError('SPEECH_INVALID_RESPONSE');
  }
}

/** Schedule PCM while it arrives, preserving order across gaps in delivery. */
export class StreamingPcmPlayer {
  private readonly decoder = new Pcm16Decoder();
  private readonly sources = new Set<AudioBufferSourceNode>();
  private readonly scheduled = new Map<AudioBufferSourceNode, { start: number; end: number }>();
  private readonly analyser: AnalyserNode;
  private readonly samples = new Float32Array(512);
  private disconnected = false;
  private nextStart = 0;
  private stopped = false;
  private finished = false;
  private resolveFinished: (() => void) | undefined;
  private rejectFinished: ((reason: unknown) => void) | undefined;

  constructor(private readonly context: AudioContext) {
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = this.samples.length;
    this.analyser.smoothingTimeConstant = 0;
    this.analyser.connect(context.destination);
  }

  /** Read actual output samples, with explicit silence outside scheduled playback. */
  readLevel(): number {
    if (this.stopped || this.disconnected || this.context.state !== 'running') return 0;
    const now = this.context.currentTime;
    let audible = false;
    for (const range of this.scheduled.values()) {
      if (now >= range.start && now < range.end) { audible = true; break; }
    }
    if (!audible) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const value of this.samples) sum += value * value;
    return Math.sqrt(sum / this.samples.length);
  }

  private disconnectAnalyser(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.samples.fill(0);
    this.analyser.disconnect();
  }

  enqueue(bytes: Uint8Array): boolean {
    if (this.stopped || this.finished) throw new DOMException('Playback stopped', 'AbortError');
    const samples = this.decoder.push(bytes);
    if (!samples.length) return false;
    const audio = this.context.createBuffer(1, samples.length, SPEECH_SAMPLE_RATE);
    audio.getChannelData(0).set(samples);
    const source = this.context.createBufferSource();
    source.buffer = audio;
    source.connect(this.analyser);
    source.onended = () => {
      this.sources.delete(source);
      this.scheduled.delete(source);
      source.disconnect();
      if (this.finished && !this.sources.size) { this.disconnectAnalyser(); this.resolveFinished?.(); }
    };
    this.sources.add(source);
    const when = Math.max(this.context.currentTime + .04, this.nextStart);
    this.nextStart = when + audio.duration;
    this.scheduled.set(source, { start: when, end: this.nextStart });
    source.start(when);
    return true;
  }

  finish(): Promise<void> {
    if (this.stopped) return Promise.reject(new DOMException('Playback stopped', 'AbortError'));
    this.decoder.finish();
    this.finished = true;
    if (!this.sources.size) { this.disconnectAnalyser(); return Promise.resolve(); }
    return new Promise((resolve, reject) => { this.resolveFinished = resolve; this.rejectFinished = reject; });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const source of this.sources) {
      source.onended = null;
      try { source.stop(); } catch { /* A source may have just completed. */ }
      source.disconnect();
    }
    this.sources.clear();
    this.scheduled.clear();
    this.disconnectAnalyser();
    this.rejectFinished?.(new DOMException('Playback stopped', 'AbortError'));
  }
}
