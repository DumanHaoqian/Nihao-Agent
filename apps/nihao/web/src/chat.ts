import type { Locale } from './copy.ts';
import type { TravelEvent } from '../../shared/travel.ts';
import { parseTravelEvent } from './travel.ts';

export interface StreamChatOptions {
  travelSession?: string;
  onTravelEvent?: (event: TravelEvent) => void;
}

/** A browser-normalized image, sent only with a user turn. */
export interface ChatImage {
  name: string;
  dataUrl: string;
}

/** User turns may include images; assistant replies remain plain text. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  images?: ChatImage[];
}

/** An API failure with a stable code for localized rendering. */
export class ChatError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ChatError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Read streamed text without buffering the entire reply. UTF-8 and SSE frames may
 * be split across arbitrary network chunks. A done event is required for success.
 */
export async function streamChat(
  messages: ChatMessage[],
  locale: Locale,
  signal: AbortSignal,
  onText: (text: string) => void,
  options: StreamChatOptions = {},
): Promise<void> {
  let response: Response;
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ messages, locale, ...(options.travelSession ? { travelSession: options.travelSession } : {}) }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ChatError('NETWORK_ERROR');
  }

  if (!response.ok) {
    let code = response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_UNAVAILABLE';
    try {
      const body: unknown = await response.json();
      if (isRecord(body) && typeof body.code === 'string') code = body.code;
      if (isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string') code = body.error.code;
    } catch (error) {
      // HTML proxy failures still use the status-derived message.
      if (signal.aborted) throw error;
    }
    throw new ChatError(code);
  }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new ChatError('INVALID_RESPONSE');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let receivedText = false;
  let complete = false;
  const cancelRead = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancelRead, { once: true });

  const parseFrame = (frame: string): void => {
    if (frame.length > 1_048_576) throw new ChatError('INVALID_RESPONSE');
    const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    let value: unknown;
    try { value = JSON.parse(data); } catch { throw new ChatError('INVALID_RESPONSE'); }
    if (!isRecord(value)) throw new ChatError('INVALID_RESPONSE');
    if (value.type === 'delta' && typeof value.text === 'string') {
      receivedText ||= value.text.length > 0;
      onText(value.text);
    } else if (value.type === 'done') {
      complete = true;
    } else if (value.type === 'error') {
      throw new ChatError(typeof value.code === 'string' ? value.code : 'PROVIDER_ERROR');
    } else if (['travel-session', 'response-language', 'tool-status', 'artifact'].includes(String(value.type))) {
      let travel: TravelEvent | undefined;
      try { travel = parseTravelEvent(value); } catch { throw new ChatError('INVALID_TRAVEL_RESPONSE'); }
      if (travel) options.onTravelEvent?.(travel);
    }
  };

  try {
    while (!complete) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        parseFrame(frame);
        if (complete) break;
        boundary = buffer.indexOf('\n\n');
      }
      if (!complete && buffer.length > 1_048_576) throw new ChatError('INVALID_RESPONSE');
      if (done) {
        if (buffer.trim() && !complete) parseFrame(buffer);
        break;
      }
    }
    if (!complete) throw new ChatError('STREAM_INTERRUPTED');
    if (!receivedText) throw new ChatError('EMPTY_RESPONSE');
  } finally {
    signal.removeEventListener('abort', cancelRead);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
