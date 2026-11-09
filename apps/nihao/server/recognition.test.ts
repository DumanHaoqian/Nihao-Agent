import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { gzipSync, gunzipSync } from 'node:zlib'
import WebSocket, { WebSocketServer } from 'ws'
import { readConfig } from './config.ts'
import { createNihaoServer } from './http.ts'
import { decodeRecognitionResponse, encodeRecognitionRequest } from './recognition-protocol.ts'
import { createRecognitionFactory, MAX_RECOGNITION_AUDIO_BYTES, type RecognitionFactory, type RecognitionTranscript } from './recognition.ts'

const apiKey = 'local-test-credential'
const config = { ...readConfig({}), recognitionConfigured: true, recognitionTimeoutMs: 2000 }

// Provider-side bytes intentionally constructed independently of the production encoder.
function reply(payload: object, { last = false, code = 0, sequence = 42, event }: { last?: boolean; code?: number; sequence?: number; event?: number } = {}): Buffer {
  const compressed = gzipSync(Buffer.from(JSON.stringify(payload)))
  const frame = Buffer.alloc(12 + (code ? 4 : 0) + (event !== undefined ? 4 : 0) + compressed.length)
  frame.set([0x11, (code ? 0xf0 : 0x90) | 1 | (last ? 2 : 0) | (event !== undefined ? 4 : 0), 0x11, 0])
  let offset = 4
  frame.writeInt32BE(sequence, offset); offset += 4
  if (event !== undefined) { frame.writeInt32BE(event, offset); offset += 4 }
  if (code) { frame.writeInt32BE(code, offset); offset += 4 }
  frame.writeUInt32BE(compressed.length, offset); offset += 4
  compressed.copy(frame, offset)
  return frame
}

interface Packet { type: number; sequence: number; last: boolean; data: Buffer; socket: WebSocket }
async function provider(onPacket: (packet: Packet) => void, initialize = true) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  assert.ok(typeof address === 'object' && address)
  const packets: Packet[] = []
  const closed = Promise.withResolvers<void>()
  let initial: any
  server.on('connection', (socket, request) => {
    assert.equal(request.headers['x-api-key'], apiKey)
    assert.equal(request.headers['x-api-resource-id'], 'volc.seedasr.sauc.duration')
    assert.match(String(request.headers['x-api-request-id']), /^[\da-f-]{36}$/)
    socket.on('close', () => closed.resolve())
    socket.on('message', data => {
      const frame = Buffer.from(data as Buffer)
      assert.equal(frame[0], 0x11)
      assert.equal(frame[2], 0x11)
      assert.equal(frame[3], 0)
      const packet: Packet = { socket, type: frame[1]! >> 4, last: Boolean(frame[1]! & 2), sequence: frame.readInt32BE(4), data: gunzipSync(frame.subarray(12)) }
      assert.equal(frame.readUInt32BE(8), frame.length - 12)
      packets.push(packet)
      if (packet.type === 1) {
        initial = JSON.parse(packet.data.toString())
        if (initialize) socket.send(reply({ result: { text: '' } }))
      }
      onPacket(packet)
    })
  })
  return {
    endpoint: `ws://127.0.0.1:${address.port}`, packets, closed: closed.promise, initial: () => initial,
    close: async () => { for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}

test('ASR framing matches the supplied Python sequence, gzip and last-packet protocol', () => {
  const full = encodeRecognitionRequest(1, { user: { uid: 'test' } })
  assert.deepEqual([...full.subarray(0, 4)], [0x11, 0x11, 0x11, 0])
  assert.equal(full.readInt32BE(4), 1)
  assert.deepEqual(JSON.parse(gunzipSync(full.subarray(12)).toString()), { user: { uid: 'test' } })
  const last = encodeRecognitionRequest(3, Buffer.from([1, 0, 2, 0]), true)
  assert.deepEqual([...last.subarray(0, 4)], [0x11, 0x23, 0x11, 0])
  assert.equal(last.readInt32BE(4), -3)
  assert.deepEqual(gunzipSync(last.subarray(12)), Buffer.from([1, 0, 2, 0]))
  const frame = reply({ result: { text: '你好。' } }, { last: true, sequence: 42, event: 7 })
  const decoded = decodeRecognitionResponse(frame)
  assert.equal(decoded.last, true, 'positive provider sequence may still carry the last flag')
  assert.equal(decoded.sequence, 42)
  assert.equal(decoded.event, 7)
  assert.deepEqual(decoded.payload.result, { text: '你好。' })
  for (let size = 0; size < frame.length; size++) assert.throws(() => decodeRecognitionResponse(frame.subarray(0, size)))
  assert.throws(() => decodeRecognitionResponse(Buffer.concat([frame, Buffer.from([0])])))
  const unknown = Buffer.from(frame); unknown[1] = 0x98
  assert.throws(() => decodeRecognitionResponse(unknown))
  assert.throws(() => decodeRecognitionResponse(reply({ text: 'x'.repeat(1024 * 1024 + 1) })))
  const plainError = Buffer.alloc(12)
  plainError.set([0x11, 0xf0, 0, 0]); plainError.writeInt32BE(45000002, 4)
  assert.equal(decodeRecognitionResponse(plainError).code, 45000002)
})

test('ASR emits revised full transcripts while recording and retains actual tail audio until finish', async () => {
  const first = Promise.withResolvers<void>()
  const upstream = await provider(packet => {
    if (packet.type !== 2) return
    if (!packet.last) packet.socket.send(reply({ result: { text: 'Go to the band' } }))
    else packet.socket.send(reply({ result: { text: 'Go to the Bund.' } }, { last: true }))
  })
  const controller = new AbortController()
  const events: RecognitionTranscript[] = []
  try {
    const session = await createRecognitionFactory(config, { endpoint: upstream.endpoint, apiKey, environment: {} })(event => { events.push(event); if (event.text) first.resolve() }, controller.signal)
    assert.equal(upstream.initial().audio.format, 'pcm')
    assert.equal(upstream.initial().audio.rate, 16000)
    assert.equal(upstream.initial().request.enable_nonstream, true)
    assert.equal(upstream.initial().request.result_type, 'full')
    const one = Buffer.from([1, 0, 2, 0]); const two = Buffer.from([3, 0, 4, 0])
    await session.sendAudio(one)
    assert.equal(upstream.packets.filter(packet => packet.type === 2).length, 0)
    await session.sendAudio(two)
    await first.promise
    assert.equal(events.at(-1)?.final, false)
    await session.finish()
    assert.deepEqual(events.at(-1), { type: 'transcript', text: 'Go to the Bund.', final: true })
    const audio = upstream.packets.filter(packet => packet.type === 2)
    assert.deepEqual(audio.map(packet => packet.sequence), [2, -3])
    assert.deepEqual(Buffer.concat(audio.map(packet => packet.data)), Buffer.concat([one, two]))
    assert.deepEqual(audio.at(-1)?.data, two)
  } finally { controller.abort(); await upstream.close() }
})

test('ASR waits for final tail results and rejects silence without a successful completion', async () => {
  for (const mode of ['silence', 'missing', 'provider-no-audio'] as const) {
    const upstream = await provider(packet => {
      if (!packet.last) return
      if (mode === 'silence') packet.socket.send(reply({ result: { text: '' } }, { last: true }))
      else if (mode === 'provider-no-audio') packet.socket.send(reply({ message: 'raw-private-provider-detail' }, { code: 45000002 }))
      else packet.socket.close()
    })
    const controller = new AbortController()
    try {
      const session = await createRecognitionFactory(config, { endpoint: upstream.endpoint, apiKey, environment: {} })(() => {}, controller.signal)
      await session.sendAudio(Buffer.alloc(6400))
      await assert.rejects(session.finish(), error => {
        assert.ok(error instanceof Error)
        assert.equal(error.message.includes('raw-private'), false)
        assert.equal((error as { code?: string }).code, mode === 'missing' ? 'ASR_PROVIDER_ERROR' : 'ASR_NO_SPEECH')
        return true
      })
    } finally { controller.abort(); await upstream.close() }
  }
})

test('ASR abort closes the provider both before ready and during recording', async () => {
  for (const initialize of [false, true]) {
    const received = Promise.withResolvers<void>()
    const upstream = await provider(() => received.resolve(), initialize)
    const controller = new AbortController()
    try {
      const opening = createRecognitionFactory(config, { endpoint: upstream.endpoint, apiKey, environment: {} })(() => {}, controller.signal)
      await received.promise
      if (initialize) {
        const session = await opening
        controller.abort()
        await assert.rejects(session.done, { name: 'AbortError' })
      } else {
        controller.abort()
        await assert.rejects(opening, { name: 'AbortError' })
      }
      await upstream.closed
    } finally { controller.abort(); await upstream.close() }
  }
})

test('ASR bounds PCM shape and total duration, and times out initialization or finalization', async () => {
  for (const initialize of [false, true]) {
    const upstream = await provider(() => {}, initialize)
    const controller = new AbortController()
    try {
      const opening = createRecognitionFactory(config, { endpoint: upstream.endpoint, apiKey, environment: {}, setupTimeoutMs: 35, finishTimeoutMs: 35 })(() => {}, controller.signal)
      if (!initialize) await assert.rejects(opening, { code: 'ASR_TIMEOUT' })
      else {
        const session = await opening
        for (const buffer of [Buffer.alloc(0), Buffer.alloc(3), Buffer.alloc(32002)]) await assert.rejects(session.sendAudio(buffer), { code: 'ASR_INVALID_AUDIO' })
        for (let bytes = 0; bytes < MAX_RECOGNITION_AUDIO_BYTES; bytes += 32000) await session.sendAudio(Buffer.alloc(32000))
        await assert.rejects(session.sendAudio(Buffer.alloc(2)), { code: 'ASR_TOO_LONG' })
        await assert.rejects(session.finish(), { code: 'ASR_TIMEOUT' })
      }
    } finally { controller.abort(); await upstream.close() }
  }
})

test('ASR HTTP authentication failures are sanitized and config never retains keys', async () => {
  const loaded = readConfig({ DOUBAO_API_KEY: apiKey })
  assert.equal(loaded.recognitionConfigured, true)
  assert.equal(JSON.stringify(loaded).includes(apiKey), false)
  assert.throws(() => readConfig({ ASR_MAX_CONCURRENT: '0' }))
  const server = createServer()
  server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address === 'object')
  try {
    await assert.rejects(createRecognitionFactory(config, { endpoint: `ws://127.0.0.1:${address.port}`, apiKey, environment: {} })(() => {}, new AbortController().signal), { code: 'ASR_AUTH_ERROR' })
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

async function app(factory: RecognitionFactory, overrides: Partial<typeof config> = {}) {
  const application = createNihaoServer({ ...config, ...overrides }, async () => {}, async () => {}, factory)
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve))
  const address = application.server.address(); assert.ok(address && typeof address === 'object')
  return { ...application, url: `ws://127.0.0.1:${address.port}/api/transcribe`, origin: `http://127.0.0.1:${address.port}` }
}
function browser(url: string, origin: string) {
  const socket = new WebSocket(url, { origin })
  const events: any[] = []
  const waiters: Array<{ type: string; resolve: (value: any) => void }> = []
  const ended = Promise.withResolvers<void>()
  socket.on('message', data => {
    const event = JSON.parse(data.toString()); events.push(event)
    for (let index = waiters.length - 1; index >= 0; index--) if (waiters[index]!.type === event.type) waiters.splice(index, 1)[0]!.resolve(event)
  })
  socket.on('close', () => ended.resolve())
  socket.on('error', () => {})
  return { socket, events, closed: ended.promise, wait: (type: string) => {
    const existing = events.find(event => event.type === type)
    return existing ? Promise.resolve(existing) : new Promise<any>(resolve => waiters.push({ type, resolve }))
  } }
}

test('browser WS relays live transcript snapshots, final text, and done without exposing provider credentials', async () => {
  const upstream = await provider(packet => {
    if (packet.type === 2) packet.socket.send(reply({ result: { text: packet.last ? 'Final sentence.' : 'Final' } }, { last: packet.last }))
  })
  const application = await app(createRecognitionFactory(config, { endpoint: upstream.endpoint, apiKey, environment: {} }))
  const client = browser(application.url, application.origin)
  try {
    assert.deepEqual(await client.wait('ready'), { type: 'ready', sampleRate: 16000, channels: 1 })
    client.socket.send(Buffer.alloc(6400)); client.socket.send(Buffer.alloc(6400))
    assert.deepEqual(await client.wait('transcript'), { type: 'transcript', text: 'Final', final: false })
    assert.equal(client.events.some(event => event.type === 'done'), false)
    client.socket.send(JSON.stringify({ type: 'finish' }))
    await client.wait('done'); await client.closed
    assert.deepEqual(client.events.at(-2), { type: 'transcript', text: 'Final sentence.', final: true })
    assert.equal(JSON.stringify(client.events).includes(apiKey), false)
  } finally { client.socket.terminate(); await application.shutdown(); await upstream.close() }
})

test('browser WS rejects foreign or absent origins before any provider call', async () => {
  let calls = 0
  const application = await app(async () => { calls++; throw new Error('should not run') })
  try {
    for (const origin of [undefined, 'https://evil.example', 'null']) {
      const rejected = new WebSocket(application.url, origin ? { origin } : {})
      await new Promise<void>(resolve => {
        rejected.on('unexpected-response', (_request, response) => { assert.equal(response.statusCode, 403); response.resume(); rejected.terminate(); resolve() })
        rejected.on('error', () => {})
      })
    }
    assert.equal(calls, 0)
  } finally { await application.shutdown() }
})

test('browser WS cancellation, disconnect and shutdown abort recognition and release concurrency', async () => {
  for (const mode of ['cancel', 'disconnect', 'shutdown'] as const) {
    const aborted = Promise.withResolvers<void>()
    const application = await app(async (_onTranscript, signal) => {
      const done = Promise.withResolvers<void>()
      signal.addEventListener('abort', () => { aborted.resolve(); done.reject(new DOMException('Stopped', 'AbortError')) }, { once: true })
      return { sendAudio: async () => {}, finish: () => done.promise, done: done.promise }
    }, { recognitionMaxConcurrent: 1 })
    const client = browser(application.url, application.origin)
    try {
      await client.wait('ready')
      const extra = browser(application.url, application.origin)
      assert.equal((await extra.wait('error')).code, 'ASR_BUSY')
      await extra.closed
      if (mode === 'cancel') client.socket.send(JSON.stringify({ type: 'cancel' }))
      else if (mode === 'disconnect') client.socket.terminate()
      else await application.shutdown()
      await aborted.promise; await client.closed
    } finally { client.socket.terminate(); if (mode !== 'shutdown') await application.shutdown() }
  }
})

test('browser WS reports missing configuration and safe failures rather than raw provider details', async () => {
  for (const configured of [false, true]) {
    const application = await app(async () => { throw new Error(`private ${apiKey}`) }, { recognitionConfigured: configured })
    const client = browser(application.url, application.origin)
    try {
      assert.deepEqual(await client.wait('error'), { type: 'error', code: configured ? 'ASR_PROVIDER_ERROR' : 'ASR_NOT_CONFIGURED' })
      await client.closed
      assert.equal(JSON.stringify(client.events).includes(apiKey), false)
    } finally { client.socket.terminate(); await application.shutdown() }
  }
})

test('invalid frames bundled into a rejected WebSocket upgrade cannot crash the server', async () => {
  const application = await app(async () => { throw new Error('Not configured') }, { recognitionConfigured: false })
  try {
    const url = new URL(application.url)
    await new Promise<void>((resolve, reject) => {
      const raw = connect(Number(url.port), url.hostname, () => {
        const upgrade = `GET /api/transcribe HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${application.origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`
        // RSV1 is forbidden because per-message deflate is disabled.
        raw.write(Buffer.concat([Buffer.from(upgrade), Buffer.from([0xc1, 0x80, 0, 0, 0, 0])]))
      })
      raw.resume()
      raw.on('error', reject)
      raw.on('close', () => resolve())
    })
    const health = await fetch(`${application.origin}/api/health`)
    assert.equal(health.status, 200)
    await health.text()
  } finally { await application.shutdown() }
})

test('cancel interrupts an upstream audio write instead of waiting behind the audio queue', async () => {
  const writing = Promise.withResolvers<void>()
  const aborted = Promise.withResolvers<void>()
  const application = await app(async (_onTranscript, signal) => {
    const done = Promise.withResolvers<void>()
    signal.addEventListener('abort', () => { aborted.resolve(); done.reject(new DOMException('Stopped', 'AbortError')) }, { once: true })
    return { done: done.promise, finish: () => done.promise, sendAudio: () => { writing.resolve(); return done.promise } }
  })
  const client = browser(application.url, application.origin)
  try {
    await client.wait('ready')
    client.socket.send(Buffer.alloc(6400))
    await writing.promise
    client.socket.send(JSON.stringify({ type: 'cancel' }))
    await Promise.race([aborted.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Cancel was blocked by audio.')), 500).unref())])
    await client.closed
  } finally { client.socket.terminate(); await application.shutdown() }
})
