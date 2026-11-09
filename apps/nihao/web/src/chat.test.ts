import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatError, streamChat } from './chat.ts';

const input = [{ role: 'user' as const, content: '你好' }];

function chunkedResponse(content: string, chunkSize: number): Response {
  const encoded = new TextEncoder().encode(content);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < encoded.length; offset += chunkSize) controller.enqueue(encoded.slice(offset, offset + chunkSize));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

test('UTF-8 text and CRLF event frames may span single-byte network chunks', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => chunkedResponse(': keepalive\r\n\r\ndata: {"type":"delta","text":"你好，"}\r\n\r\ndata: {"type":"delta","text":"Shanghai"}\r\n\r\ndata: {"type":"done"}\r\n\r\n', 1));
  const deltas: string[] = [];
  await streamChat(input, 'en', new AbortController().signal, (text) => deltas.push(text));
  assert.deepEqual(deltas, ['你好，', 'Shanghai']);
});

test('text arrives before the completion event, without whole-response buffering', async (context) => {
  let releaseDone: (() => void) | undefined;
  const doneGate = new Promise<void>((resolve) => { releaseDone = resolve; });
  const encoder = new TextEncoder();
  context.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"delta","text":"First"}\n\n'));
      await doneGate;
      controller.enqueue(encoder.encode('data: {"type":"done"}\n\n'));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  const deltas: string[] = [];
  await streamChat(input, 'en', new AbortController().signal, (text) => {
    deltas.push(text);
    releaseDone?.();
  });
  assert.deepEqual(deltas, ['First']);
});

test('a cut-off stream remains an error even after partial text', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => chunkedResponse('data: {"type":"delta","text":"Partial"}\n\n', 3));
  const deltas: string[] = [];
  await assert.rejects(streamChat(input, 'en', new AbortController().signal, (text) => deltas.push(text)), (error: unknown) => error instanceof ChatError && error.code === 'STREAM_INTERRUPTED');
  assert.deepEqual(deltas, ['Partial']);
});

test('both prestream and in-stream errors preserve stable codes', async (context) => {
  const mock = context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ code: 'NOT_CONFIGURED' }), { status: 503, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(streamChat(input, 'en', new AbortController().signal, () => {}), (error: unknown) => error instanceof ChatError && error.code === 'NOT_CONFIGURED');
  mock.mock.mockImplementation(async () => chunkedResponse('data: {"type":"error","code":"TIMEOUT","message":"Timed out"}\n\n', 4));
  await assert.rejects(streamChat(input, 'en', new AbortController().signal, () => {}), (error: unknown) => error instanceof ChatError && error.code === 'TIMEOUT');
});

test('an empty completion does not become a successful assistant message', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => chunkedResponse('data: {"type":"done"}\n\n', 2));
  await assert.rejects(streamChat(input, 'en', new AbortController().signal, () => {}), (error: unknown) => error instanceof ChatError && error.code === 'EMPTY_RESPONSE');
});

test('travel session and tool events stream alongside text while the opaque session travels on follow-up', async (context) => {
  let body: Record<string, unknown> | undefined;
  context.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    body = JSON.parse(String(options.body)) as Record<string, unknown>;
    return chunkedResponse('data: {"type":"travel-session","id":"c7a51f62-4d67-4250-9018-7f7b0e929fa7"}\n\ndata: {"type":"tool-status","tool":"route","status":"running"}\n\ndata: {"type":"delta","text":"Here is the route."}\n\ndata: {"type":"done"}\n\n', 2);
  });
  const events: unknown[] = [];
  await streamChat(input, 'en', new AbortController().signal, () => {}, { travelSession: 'previous-session', onTravelEvent: event => events.push(event) });
  assert.equal(body?.travelSession, 'previous-session');
  assert.deepEqual(events, [{ type: 'travel-session', id: 'c7a51f62-4d67-4250-9018-7f7b0e929fa7' }, { type: 'tool-status', tool: 'route', status: 'running' }]);
});

test('travel artifacts alone cannot turn an empty or failed reply into a successful response', async (context) => {
  const artifact = 'data: {"type":"artifact","artifact":{"kind":"places","places":[]}}\n\n';
  const mock = context.mock.method(globalThis, 'fetch', async () => chunkedResponse(`${artifact}data: {"type":"done"}\n\n`, 3));
  await assert.rejects(streamChat(input, 'en', new AbortController().signal, () => {}, { onTravelEvent() {} }), (error: unknown) => error instanceof ChatError && error.code === 'EMPTY_RESPONSE');
  mock.mock.mockImplementation(async () => chunkedResponse(`${artifact}data: {"type":"error","code":"TRAVEL_SESSION_EXPIRED"}\n\n`, 4));
  await assert.rejects(streamChat(input, 'en', new AbortController().signal, () => {}), (error: unknown) => error instanceof ChatError && error.code === 'TRAVEL_SESSION_EXPIRED');
});

test('reply language and translation status arrive after streamed text and before completed map facts', async (context) => {
  const frames = [
    { type: 'delta', text: '这是你的行程。' },
    { type: 'response-language', language: 'zh' },
    { type: 'tool-status', tool: 'translate', status: 'running' },
    { type: 'artifact', artifact: { kind: 'places', places: [] } },
    { type: 'done' },
  ];
  context.mock.method(globalThis, 'fetch', async () => chunkedResponse(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), 1));
  const received: unknown[] = [];
  await streamChat(input, 'en', new AbortController().signal, text => received.push(text), { onTravelEvent: event => received.push(event) });
  assert.deepEqual(received, ['这是你的行程。', ...frames.slice(1, 4)]);
});

test('translation failure preserves streamed answer text and never becomes successful', async (context) => {
  const frames = [
    { type: 'delta', text: 'Here is your trip.' },
    { type: 'response-language', language: 'en' },
    { type: 'tool-status', tool: 'translate', status: 'running' },
    { type: 'error', code: 'TRAVEL_TRANSLATION_FAILED' },
  ];
  context.mock.method(globalThis, 'fetch', async () => chunkedResponse(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), 2));
  const deltas: string[] = [];
  await assert.rejects(streamChat(input, 'zh', new AbortController().signal, text => deltas.push(text)), (error: unknown) => error instanceof ChatError && error.code === 'TRAVEL_TRANSLATION_FAILED');
  assert.deepEqual(deltas, ['Here is your trip.']);
});

test('invalid response language fails safely instead of silently mixing map languages', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => chunkedResponse('data: {"type":"delta","text":"Reply"}\n\ndata: {"type":"response-language","language":"es"}\n\ndata: {"type":"done"}\n\n', 2));
  await assert.rejects(streamChat(input, 'en', new AbortController().signal, () => {}), (error: unknown) => error instanceof ChatError && error.code === 'INVALID_TRAVEL_RESPONSE');
});

test('cancelling while waiting on a map tool releases a pending stream reader', async (context) => {
  let released = false;
  const encoder = new TextEncoder();
  context.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode('data: {"type":"tool-status","tool":"search","status":"running"}\n\n')); },
    cancel() { released = true; },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  const controller = new AbortController();
  await assert.rejects(streamChat(input, 'en', controller.signal, () => {}, { onTravelEvent() { controller.abort(); } }), { name: 'AbortError' });
  assert.equal(released, true);
});
