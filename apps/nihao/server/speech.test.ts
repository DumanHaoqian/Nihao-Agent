import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { readConfig } from './config.ts'
import { createNihaoServer } from './http.ts'
import { decodeSpeechFrame, encodeSpeechFrame, SpeechEvent } from './speech-protocol.ts'
import { createSpeechRunner, MAX_SPEECH_BODY_BYTES, parseSpeechRequest, speechProxy, type SpeechRunner } from './speech.ts'

const config = { ...readConfig({}), speechConfigured: true, speechTimeoutMs: 2000 }
const apiKey = 'test-only-not-a-real-credential'
const headers = { 'Content-Type': 'application/json' }

// Independent provider-side framing: mirrors the published Python protocol, not the client encoder.
function serverFrame(event: number, payload: Buffer | object, id: string, type = 9): Buffer {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload))
  const identifier = Buffer.from(id)
  const frame = Buffer.alloc(4 + 4 + 4 + identifier.length + 4 + data.length)
  frame.set([0x11, (type << 4) | 4, type === 11 ? 0 : 0x10, 0])
  frame.writeUInt32BE(event, 4)
  frame.writeUInt32BE(identifier.length, 8)
  identifier.copy(frame, 12)
  frame.writeUInt32BE(data.length, 12 + identifier.length)
  data.copy(frame, 16 + identifier.length)
  return frame
}

async function provider(onPacket: (socket: WebSocket, event: number, payload: Record<string, any>, session: string) => void) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  assert.ok(typeof address === 'object' && address)
  let receivedKey: string | undefined
  const events: number[] = []
  server.on('connection', (socket, request) => {
    receivedKey = request.headers['x-api-key'] as string
    assert.equal(request.headers['x-api-resource-id'], 'seed-tts-2.0')
    socket.on('message', data => {
      const buffer = Buffer.from(data as Buffer)
      assert.deepEqual([...buffer.subarray(0, 4)], [0x11, 0x14, 0x10, 0])
      const event = buffer.readUInt32BE(4)
      events.push(event)
      let offset = 8
      let session = ''
      if (![1, 2].includes(event)) {
        const size = buffer.readUInt32BE(offset); offset += 4
        session = buffer.subarray(offset, offset + size).toString(); offset += size
      }
      const size = buffer.readUInt32BE(offset); offset += 4
      const payload = JSON.parse(buffer.subarray(offset, offset + size).toString())
      if (event === 1) socket.send(serverFrame(50, {}, 'test-connection'))
      else if (event === 100) socket.send(serverFrame(150, {}, session))
      onPacket(socket, event, payload, session)
    })
  })
  return {
    endpoint: `ws://127.0.0.1:${address.port}`,
    events,
    key: () => receivedKey,
    close: async () => {
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

test('speech protocol validates binary envelopes and matches official client framing', () => {
  const encoded = encodeSpeechFrame(SpeechEvent.StartConnection)
  assert.equal(encoded.toString('hex'), '1114100000000001000000027b7d')
  const pcm = Buffer.from([1, 0, 2, 0])
  const parsed = decodeSpeechFrame(serverFrame(352, pcm, 'voice-session', 11))
  assert.equal(parsed.sessionId, 'voice-session')
  assert.equal(parsed.type, 11)
  assert.deepEqual(parsed.payload, pcm)
  const complete = serverFrame(50, {}, 'connection')
  assert.equal(decodeSpeechFrame(complete).connectionId, 'connection')
  for (let cut = 0; cut < complete.length; cut++) assert.throws(() => decodeSpeechFrame(complete.subarray(0, cut)))
  assert.throws(() => decodeSpeechFrame(Buffer.concat([complete, Buffer.from([0])])))
  const invalid = Buffer.from(complete); invalid[1] = 0x94 | 8
  assert.throws(() => decodeSpeechFrame(invalid))
})

test('speech input, config and proxy selection enforce public limits without retaining keys', () => {
  assert.equal(parseSpeechRequest({ text: '  Welcome to China.  ' }), 'Welcome to China.')
  for (const value of [null, {}, { text: 4 }, { text: ' ' }]) assert.throws(() => parseSpeechRequest(value))
  assert.throws(() => parseSpeechRequest({ text: 'a'.repeat(20_001) }), { code: 'SPEECH_TOO_LONG' })
  const loaded = readConfig({ DOUBAO_API_KEY: apiKey, DOUBAO_SPEAKER: 'a_test_voice' })
  assert.equal(loaded.speechConfigured, true)
  assert.equal(JSON.stringify(loaded).includes(apiKey), false)
  assert.throws(() => readConfig({ DOUBAO_SPEAKER: 'unsafe voice\n' }))
  const url = new URL('wss://openspeech.bytedance.com/api/v3/tts/bidirection')
  assert.equal(speechProxy(url, { HTTPS_PROXY: 'http://proxy.invalid:8080' }), 'http://proxy.invalid:8080')
  assert.equal(speechProxy(url, { HTTPS_PROXY: 'http://proxy.invalid:8080', NO_PROXY: '.bytedance.com' }), undefined)
  assert.equal(speechProxy(url, { HTTPS_PROXY: 'http://proxy.invalid:8080', NO_PROXY: 'openspeech.bytedance.com:444' }), 'http://proxy.invalid:8080')
  assert.equal(speechProxy(url, { HTTPS_PROXY: 'http://proxy.invalid:8080', NO_PROXY: '*' }), undefined)
})

test('Doubao runner sends text/session/auth frames and emits PCM before session finishes', async () => {
  const firstAudio = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const texts: string[] = []
  let setup: Record<string, any> | undefined
  const upstream = await provider((socket, event, payload, session) => {
    if (event === 100) setup = payload.req_params
    if (event === 200) texts.push(payload.req_params.text)
    if (event === 102) {
      socket.send(serverFrame(352, Buffer.from([3, 0]), session, 11))
      void gate.promise.then(() => {
        socket.send(serverFrame(352, Buffer.from([4, 0]), session, 11))
        socket.send(serverFrame(152, { usage: { text_words: 10 } }, session))
      })
    }
  })
  try {
    const chunks: Buffer[] = []
    let finished = false
    const pending = createSpeechRunner(config, { endpoint: upstream.endpoint, apiKey, environment: {} })(
      'Nihao! 你好。', chunk => { chunks.push(chunk); firstAudio.resolve() }, new AbortController().signal,
    ).then(() => { finished = true })
    await firstAudio.promise
    assert.equal(finished, false)
    assert.equal(upstream.key(), apiKey)
    assert.equal(texts.join(''), 'Nihao! 你好。')
    assert.equal(setup?.speaker, 'zh_female_vv_uranus_bigtts')
    assert.deepEqual(setup?.audio_params, { format: 'pcm', sample_rate: 24_000 })
    gate.resolve()
    await pending
    assert.deepEqual(Buffer.concat(chunks), Buffer.from([3, 0, 4, 0]))
  } finally { gate.resolve(); await upstream.close() }
})

test('Doubao runner cancels upstream and closes the socket when playback is stopped', async () => {
  const canceled = Promise.withResolvers<void>()
  const controller = new AbortController()
  const upstream = await provider((socket, event, _payload, session) => {
    if (event === 102) socket.send(serverFrame(352, Buffer.from([0, 0]), session, 11))
    if (event === 101) canceled.resolve()
  })
  try {
    await assert.rejects(createSpeechRunner(config, { endpoint: upstream.endpoint, apiKey, environment: {} })(
      'Hello', () => controller.abort(), controller.signal,
    ), { name: 'AbortError' })
    await canceled.promise
    assert.ok(upstream.events.includes(101))
  } finally { await upstream.close() }
})

test('Doubao runner rejects empty audio and redacts protocol/provider failures', async () => {
  for (const mode of ['empty', 'failure', 'malformed', 'disconnect'] as const) {
    const upstream = await provider((socket, event, _payload, session) => {
      if (event !== 102) return
      if (mode === 'empty') socket.send(serverFrame(152, {}, session))
      else if (mode === 'failure') socket.send(serverFrame(153, { message: `private ${apiKey}` }, session))
      else if (mode === 'malformed') socket.send(Buffer.from([0x11, 0x94, 0x10, 0]))
      else socket.close()
    })
    try {
      await assert.rejects(createSpeechRunner(config, { endpoint: upstream.endpoint, apiKey, environment: {} })(
        'Hello', () => assert.fail('No valid audio expected'), new AbortController().signal,
      ), error => {
        assert.ok(error instanceof Error)
        assert.equal(error.message.includes(apiKey), false)
        assert.equal(error.message.includes('private'), false)
        return true
      })
    } finally { await upstream.close() }
  }
})

test('Doubao runner maps a 401 handshake to a safe authentication error', async () => {
  const server = createServer()
  server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    await assert.rejects(createSpeechRunner(config, { endpoint: `ws://127.0.0.1:${address.port}`, apiKey, environment: {} })(
      'Hello', () => {}, new AbortController().signal,
    ), { code: 'SPEECH_AUTH_ERROR' })
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('Doubao runner times out a stalled stream and cancels its session', async () => {
  const canceled = Promise.withResolvers<void>()
  const upstream = await provider((_socket, event) => { if (event === 101) canceled.resolve() })
  try {
    await assert.rejects(createSpeechRunner({ ...config, speechTimeoutMs: 30 }, { endpoint: upstream.endpoint, apiKey, environment: {} })(
      'Hello', () => {}, new AbortController().signal,
    ), { code: 'SPEECH_TIMEOUT' })
    await canceled.promise
  } finally { await upstream.close() }
})

async function app(speak: SpeechRunner, overrides: Partial<typeof config> = {}) {
  const application = createNihaoServer({ ...config, ...overrides }, async () => {}, speak)
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve))
  const address = application.server.address()
  assert.ok(address && typeof address === 'object')
  return { ...application, url: `http://127.0.0.1:${address.port}` }
}

test('speech HTTP streams audio before completion and returns done', async () => {
  const gate = Promise.withResolvers<void>()
  const application = await app(async (_text, onAudio) => {
    await onAudio(Buffer.from([2, 0])); await gate.promise; await onAudio(Buffer.from([4, 0]))
  })
  try {
    const response = await fetch(`${application.url}/api/speech`, { method: 'POST', headers, body: JSON.stringify({ text: 'Read me' }) })
    assert.equal(response.status, 200)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let output = ''
    while (!output.includes('audio')) output += decoder.decode((await reader.read()).value)
    assert.equal(output.includes('"done"'), false)
    gate.resolve()
    while (true) { const next = await reader.read(); if (next.done) break; output += decoder.decode(next.value) }
    const events = output.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
    assert.deepEqual(events, [
      { type: 'start', format: 'pcm_s16le', sampleRate: 24_000, channels: 1 },
      { type: 'audio', data: 'AgA=' }, { type: 'audio', data: 'BAA=' }, { type: 'done' },
    ])
  } finally { gate.resolve(); await application.shutdown() }
})

test('speech HTTP validates origin, configuration, text and body size without calling a provider', async () => {
  let calls = 0
  const application = await app(async () => { calls += 1 })
  try {
    for (const [body, status] of [[{}, 400], [{ text: 'a'.repeat(20_001) }, 413], [{ text: 'a'.repeat(MAX_SPEECH_BODY_BYTES) }, 413]] as const) {
      const response = await fetch(`${application.url}/api/speech`, { method: 'POST', headers, body: JSON.stringify(body) })
      assert.equal(response.status, status)
      await response.text()
    }
    const foreign = await fetch(`${application.url}/api/speech`, { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: '{"text":"Hello"}' })
    assert.equal(foreign.status, 403)
    assert.equal((await fetch(`${application.url}/api/speech`)).status, 405)
    assert.equal(calls, 0)
  } finally { await application.shutdown() }
  const disabled = await app(async () => { calls += 1 }, { speechConfigured: false })
  try {
    const response = await fetch(`${disabled.url}/api/speech`, { method: 'POST', headers, body: '{"text":"Hello"}' })
    assert.equal(response.status, 503)
    assert.equal((await response.json()).code, 'SPEECH_NOT_CONFIGURED')
  } finally { await disabled.shutdown() }
})

test('speech HTTP disconnect and server shutdown abort pending synthesis', async () => {
  for (const mode of ['disconnect', 'shutdown'] as const) {
    const aborted = Promise.withResolvers<void>()
    const application = await app(async (_text, onAudio, signal) => {
      await onAudio(Buffer.from([0, 0]))
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted.resolve(); resolve() }, { once: true }))
    })
    try {
      const controller = new AbortController()
      const response = await fetch(`${application.url}/api/speech`, { method: 'POST', headers, body: '{"text":"Hello"}', signal: controller.signal })
      await response.body!.getReader().read()
      if (mode === 'disconnect') controller.abort()
      else await application.shutdown()
      await aborted.promise
    } finally { if (mode === 'disconnect') await application.shutdown() }
  }
})

test('a coalesced 512 KiB upstream PCM frame streams completely without false slow-client errors', async () => {
  const pcm = Buffer.alloc(512 * 1024, 3)
  const upstream = await provider((socket, event, _payload, session) => {
    if (event !== 102) return
    socket.send(serverFrame(352, pcm, session, 11))
    socket.send(serverFrame(152, {}, session))
  })
  const application = await app(createSpeechRunner(config, { endpoint: upstream.endpoint, apiKey, environment: {} }))
  try {
    const response = await fetch(`${application.url}/api/speech`, { method: 'POST', headers, body: '{"text":"Hello"}' })
    const output = await response.text()
    const events = output.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
    assert.equal(events.filter(event => event.type === 'error').length, 0)
    assert.equal(events.at(-1).type, 'done')
    const audio = Buffer.concat(events.filter(event => event.type === 'audio').map(event => Buffer.from(event.data, 'base64')))
    assert.deepEqual(audio, pcm)
  } finally { await application.shutdown(); await upstream.close() }
})

test('a genuinely stalled HTTP reader applies bounded backpressure and shutdown cancels the wait', async () => {
  const started = Promise.withResolvers<void>()
  const aborted = Promise.withResolvers<void>()
  let sentChunks = 0
  let peakWritableBytes = 0
  const pcm = Buffer.alloc(32_768)
  const application = await app(async (_text, onAudio, signal) => {
    signal.addEventListener('abort', () => aborted.resolve(), { once: true })
    started.resolve()
    for (; sentChunks < 4096; sentChunks++) await onAudio(pcm)
  }, { speechTimeoutMs: 5000 })
  application.server.prependListener('request', (_request, response) => {
    const write = response.write.bind(response)
    response.write = ((chunk: any, encoding?: any, callback?: any) => {
      const result = write(chunk, encoding, callback)
      peakWritableBytes = Math.max(peakWritableBytes, response.writableLength)
      return result
    }) as typeof response.write
  })
  const url = new URL(application.url)
  const client = connect({ host: '127.0.0.1', port: Number(url.port) })
  client.on('error', () => {})
  await new Promise<void>(resolve => client.once('connect', resolve))
  client.pause()
  const body = '{"text":"Hello"}'
  client.write(`POST /api/speech HTTP/1.1\r\nHost: ${url.host}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  try {
    await started.promise
    await new Promise<void>(resolve => setTimeout(resolve, 40))
    assert.ok(sentChunks > 0 && sentChunks < 4096, 'The producer must pause instead of queueing all audio.')
    assert.ok(peakWritableBytes < 128 * 1024, `HTTP queued ${peakWritableBytes} bytes instead of respecting drain.`)
    await application.shutdown()
    await aborted.promise
  } finally { client.destroy() }
})

test('speech HTTP limits simultaneous synthesis independently and sanitizes stream errors', async () => {
  const release = Promise.withResolvers<void>()
  const application = await app(async () => {
    await release.promise
    throw new Error(`private provider error ${apiKey}`)
  }, { speechMaxConcurrent: 1 })
  try {
    const first = await fetch(`${application.url}/api/speech`, { method: 'POST', headers, body: '{"text":"Hello"}' })
    const second = await fetch(`${application.url}/api/speech`, { method: 'POST', headers, body: '{"text":"Hello"}' })
    assert.equal(second.status, 429)
    assert.equal((await second.json()).code, 'SPEECH_BUSY')
    release.resolve()
    const output = await first.text()
    assert.match(output, /SPEECH_PROVIDER_ERROR/)
    assert.equal(output.includes(apiKey), false)
    assert.equal(output.includes('"done"'), false)
  } finally { release.resolve(); await application.shutdown() }
})
