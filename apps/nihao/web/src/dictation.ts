export type DictationStatus = 'idle' | 'permission' | 'connecting' | 'recording' | 'finishing';
export const MAX_DICTATION_SECONDS = 120;
const MAX_AUDIO_BYTES = MAX_DICTATION_SECONDS * 16000 * 2;
const MAX_BUFFER_BYTES = 256 * 1024;

export class DictationError extends Error {
  constructor(readonly code: string) { super(code); }
}

const SAFE_CODES = new Set([
  'ASR_NOT_CONFIGURED', 'ASR_AUTH_ERROR', 'ASR_PROVIDER_ERROR', 'ASR_TIMEOUT', 'ASR_BUSY',
  'ASR_INVALID_AUDIO', 'ASR_TOO_LONG', 'ASR_NO_SPEECH', 'ASR_CONNECTION_SLOW', 'ASR_INVALID_REQUEST',
]);

export type DictationEvent =
  | { type: 'ready'; sampleRate: 16000; channels: 1 }
  | { type: 'transcript'; text: string; final: boolean }
  | { type: 'done' }
  | { type: 'error'; code: string };

/** Only a bounded, known protocol reaches the UI; raw service error text is discarded. */
export function parseDictationEvent(raw: unknown): DictationEvent {
  if (typeof raw !== 'string' || raw.length > 65_536) throw new DictationError('ASR_INVALID_RESPONSE');
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw); } catch { throw new DictationError('ASR_INVALID_RESPONSE'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DictationError('ASR_INVALID_RESPONSE');
  if (value.type === 'ready' && value.sampleRate === 16000 && value.channels === 1) return { type: 'ready', sampleRate: 16000, channels: 1 };
  if (value.type === 'transcript' && typeof value.text === 'string' && value.text.length <= 12000 && typeof value.final === 'boolean') {
    return { type: 'transcript', text: value.text, final: value.final };
  }
  if (value.type === 'done') return { type: 'done' };
  if (value.type === 'error') return { type: 'error', code: typeof value.code === 'string' && SAFE_CODES.has(value.code) ? value.code : 'ASR_PROVIDER_ERROR' };
  throw new DictationError('ASR_INVALID_RESPONSE');
}

export function appendDictation(original: string, transcript: string): string {
  if (!transcript) return original;
  return `${original}${original && !/\s$/.test(original) ? ' ' : ''}${transcript}`;
}

interface CaptureCallbacks {
  onStatus: (status: Exclude<DictationStatus, 'idle'>) => void;
  onMeter: (level: number, seconds: number) => void;
  onTranscript: (text: string) => void;
  onComplete: () => void;
  onError: (code: string) => void;
}

/** Owns the microphone, audio graph and WebSocket for exactly one user gesture. */
export class DictationCapture {
  private context?: AudioContext;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private worklet?: AudioWorkletNode;
  private socket?: WebSocket;
  private deadline?: ReturnType<typeof setTimeout>;
  private clock?: ReturnType<typeof setInterval>;
  private flushDeadline?: ReturnType<typeof setTimeout>;
  private closed = false;
  private status: DictationStatus = 'permission';
  private startedAt = 0;
  private level = 0;
  private bytes = 0;
  private finalReceived = false;
  private finalText = '';

  constructor(private readonly callbacks: CaptureCallbacks) {}

  start(): void {
    if (this.closed) return;
    if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.AudioContext || !window.AudioWorkletNode) {
      this.fail('ASR_UNSUPPORTED');
      return;
    }
    this.callbacks.onStatus('permission');
    this.deadline = setTimeout(() => this.fail(this.status === 'permission' ? 'ASR_PERMISSION_TIMEOUT' : 'ASR_TIMEOUT'), 25_000);
    try {
      // Resume within the click event so Safari/Chrome can unlock the audio graph.
      const context = this.context = new AudioContext();
      if (!context.audioWorklet) { this.fail('ASR_UNSUPPORTED'); return; }
      const resumed = context.resume();
      const microphone = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      // Permission prompts can outlive cancellation. Dispose a late granted stream immediately.
      const admitted = microphone.then(stream => {
        if (this.closed) { stream.getTracks().forEach(track => track.stop()); return undefined; }
        this.stream = stream;
        stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => {
          if (this.status === 'recording') this.fail('ASR_MICROPHONE_LOST');
        }, { once: true }));
        return stream;
      });
      void (async () => {
        try {
          const [, stream] = await Promise.all([resumed, admitted]);
          if (this.closed || !stream) return;
          if (context.state !== 'running') throw new DictationError('ASR_UNSUPPORTED');
          this.setStatus('connecting');
          await context.audioWorklet.addModule('/audio/pcm-capture.js');
          if (this.closed) return;
          this.connect();
        } catch (error) { this.fail(this.microphoneError(error)); }
      })();
    } catch (error) { this.fail(this.microphoneError(error)); }
  }

  private microphoneError(error: unknown): string {
    if (error instanceof DictationError) return error.code;
    if (error instanceof DOMException) {
      if (['NotAllowedError', 'SecurityError'].includes(error.name)) return 'ASR_PERMISSION_DENIED';
      if (['NotFoundError', 'DevicesNotFoundError'].includes(error.name)) return 'ASR_NO_MICROPHONE';
      if (['NotReadableError', 'TrackStartError'].includes(error.name)) return 'ASR_MICROPHONE_BUSY';
    }
    return 'ASR_UNSUPPORTED';
  }

  private setStatus(status: Exclude<DictationStatus, 'idle'>): void {
    this.status = status;
    this.callbacks.onStatus(status);
  }

  private connect(): void {
    try {
      const url = new URL('/api/transcribe', window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = this.socket = new WebSocket(url);
      socket.onmessage = event => {
        if (this.closed) return;
        try {
          const message = parseDictationEvent(event.data);
          if (message.type === 'error') { this.fail(message.code); return; }
          if (message.type === 'ready') {
            if (this.status !== 'connecting') throw new DictationError('ASR_INVALID_RESPONSE');
            this.record();
          } else if (message.type === 'transcript') {
            if (!['recording', 'finishing'].includes(this.status) || this.finalReceived) throw new DictationError('ASR_INVALID_RESPONSE');
            this.finalReceived = message.final;
            this.finalText = message.text;
            this.callbacks.onTranscript(message.text);
          } else if (message.type === 'done') {
            if (!this.finalReceived || this.status !== 'finishing') throw new DictationError('ASR_INTERRUPTED');
            if (!this.finalText.trim()) { this.fail('ASR_NO_SPEECH'); return; }
            this.dispose();
            this.callbacks.onComplete();
          }
        } catch (error) { this.fail(error instanceof DictationError ? error.code : 'ASR_INVALID_RESPONSE'); }
      };
      socket.onerror = () => this.fail('ASR_NETWORK_ERROR');
      socket.onclose = () => { if (!this.closed) this.fail('ASR_INTERRUPTED'); };
    } catch { this.fail('ASR_NETWORK_ERROR'); }
  }

  private record(): void {
    if (this.closed || !this.context || !this.stream) return;
    try {
      clearTimeout(this.deadline);
      const worklet = this.worklet = new AudioWorkletNode(this.context, 'nihao-pcm-capture');
      this.source = this.context.createMediaStreamSource(this.stream);
      worklet.port.onmessage = event => {
        if (this.closed) return;
        if (event.data?.type === 'pcm' && event.data.pcm instanceof ArrayBuffer) {
          if (!['recording', 'finishing'].includes(this.status)) return;
          this.sendAudio(event.data.pcm);
        } else if (event.data?.type === 'level' && this.status === 'recording') {
          this.level = Math.max(0, Math.min(1, Number(event.data.level) || 0));
        } else if (event.data?.type === 'flushed' && this.status === 'finishing') {
          clearTimeout(this.flushDeadline);
          this.stopAudio();
          if (this.socket?.readyState !== WebSocket.OPEN) { this.fail('ASR_INTERRUPTED'); return; }
          this.socket.send(JSON.stringify({ type: 'finish' }));
          this.deadline = setTimeout(() => this.fail('ASR_TIMEOUT'), 20_000);
        }
      };
      worklet.onprocessorerror = () => this.fail('ASR_MICROPHONE_LOST');
      this.startedAt = performance.now();
      this.setStatus('recording');
      this.source.connect(worklet);
      worklet.connect(this.context.destination);
      this.clock = setInterval(() => {
        const seconds = Math.min(MAX_DICTATION_SECONDS, (performance.now() - this.startedAt) / 1000);
        this.callbacks.onMeter(this.level, seconds);
        if (seconds >= MAX_DICTATION_SECONDS) this.finish();
      }, 100);
    } catch { this.fail('ASR_UNSUPPORTED'); }
  }

  private sendAudio(packet: ArrayBuffer): void {
    if (this.socket?.readyState !== WebSocket.OPEN) { this.fail('ASR_INTERRUPTED'); return; }
    if (this.socket.bufferedAmount > MAX_BUFFER_BYTES) { this.fail('ASR_CONNECTION_SLOW'); return; }
    if (!packet.byteLength || packet.byteLength % 2 || packet.byteLength > 6400) { this.fail('ASR_INVALID_AUDIO'); return; }
    const allowed = Math.min(packet.byteLength, MAX_AUDIO_BYTES - this.bytes);
    if (allowed > 0) {
      this.socket.send(allowed === packet.byteLength ? packet : packet.slice(0, allowed));
      this.bytes += allowed;
    }
    if (this.bytes >= MAX_AUDIO_BYTES && this.status === 'recording') this.finish();
  }

  finish(): void {
    if (this.closed || this.status !== 'recording') return;
    this.setStatus('finishing');
    clearInterval(this.clock);
    this.stream?.getTracks().forEach(track => track.stop());
    // The processor sends its remaining PCM before its flush acknowledgement.
    this.worklet?.port.postMessage({ type: 'flush' });
    this.flushDeadline = setTimeout(() => this.fail('ASR_INTERRUPTED'), 2000);
  }

  cancel(): void {
    if (this.closed) return;
    try { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'cancel' })); } catch { /* release still runs */ }
    this.dispose();
  }

  fail(code: string): void {
    if (this.closed) return;
    this.cancel();
    this.callbacks.onError(code);
  }

  private stopAudio(): void {
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = undefined;
    this.source?.disconnect();
    this.source = undefined;
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.port.close();
      this.worklet.disconnect();
      this.worklet = undefined;
    }
    if (this.context) {
      void this.context.close().catch(() => undefined);
      this.context = undefined;
    }
  }

  private dispose(): void {
    this.closed = true;
    clearTimeout(this.deadline);
    clearTimeout(this.flushDeadline);
    clearInterval(this.clock);
    this.stopAudio();
    if (this.socket) {
      this.socket.onmessage = this.socket.onclose = this.socket.onerror = null;
      this.socket.close();
      this.socket = undefined;
    }
  }
}
