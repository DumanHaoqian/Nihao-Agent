import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import type { ServerConfig } from './config.ts'
import { ChatError } from './errors.ts'
import { MAX_RECOGNITION_PACKET_BYTES, RECOGNITION_SAMPLE_RATE, safeRecognitionError, type RecognitionFactory, type RecognitionSession } from './recognition.ts'

/** Same-origin, bounded local bridge: browser PCM in, provider transcript snapshots out. */
export function attachRecognitionWebSocket(server: Server, config: ServerConfig, recognize: RecognitionFactory, assertLocalRequest: (request: IncomingMessage) => void) {
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_RECOGNITION_PACKET_BYTES, perMessageDeflate: false })
  const sessions = new Map<WebSocket, AbortController>()
  let stopping = false
  const close = (socket: WebSocket): void => {
    if (socket.readyState === WebSocket.OPEN) socket.close(1000)
    else if (socket.readyState !== WebSocket.CLOSED) socket.terminate()
    const timer = setTimeout(() => socket.terminate(), 500)
    timer.unref()
    socket.once('close', () => clearTimeout(timer))
  }
  const rejectUpgrade = (socket: Duplex, status = 403): void => {
    socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  }
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    try {
      assertLocalRequest(request)
      // WebSocket requests bypass normal CORS; a browser origin is required explicitly.
      if (!request.headers.origin) throw new Error('Missing origin.')
      const url = new URL(request.url || '/', 'http://localhost')
      if (url.pathname !== '/api/transcribe' || url.search) { rejectUpgrade(socket, 404); return }
    } catch { rejectUpgrade(socket); return }
    websocketServer.handleUpgrade(request, socket, head, client => { websocketServer.emit('connection', client, request) })
  }
  server.on('upgrade', upgrade)
  websocketServer.on('connection', client => {
    // Even clients rejected immediately can have invalid frames buffered in upgrade head.
    client.on('error', () => client.terminate())
    if (stopping || !config.recognitionConfigured || sessions.size >= (config.recognitionMaxConcurrent ?? 2)) {
      const code = stopping ? 'ASR_PROVIDER_ERROR' : !config.recognitionConfigured ? 'ASR_NOT_CONFIGURED' : 'ASR_BUSY'
      client.send(JSON.stringify({ type: 'error', code }), () => close(client))
      return
    }
    const controller = new AbortController()
    sessions.set(client, controller)
    let session: RecognitionSession | undefined
    let ready = false
    let ending = false
    let settled = false
    let forwarding = false
    const pending: Array<{ buffer: Buffer; binary: boolean }> = []
    let pendingBytes = 0
    const finish = (): void => {
      if (settled) return
      settled = true
      controller.abort()
      pending.length = 0; pendingBytes = 0
      sessions.delete(client)
      close(client)
    }
    const send = async (event: object): Promise<void> => {
      controller.signal.throwIfAborted()
      if (client.readyState !== WebSocket.OPEN) throw new DOMException('Voice input stopped.', 'AbortError')
      if (client.bufferedAmount > 128 * 1024) throw new ChatError('ASR_CONNECTION_SLOW', 'Voice input could not keep up.')
      await new Promise<void>((resolveSend, rejectSend) => {
        const stop = (): void => { cleanup(); rejectSend(new DOMException('Voice input stopped.', 'AbortError')) }
        const cleanup = (): void => controller.signal.removeEventListener('abort', stop)
        controller.signal.addEventListener('abort', stop, { once: true })
        client.send(JSON.stringify(event), error => { cleanup(); if (error) rejectSend(safeRecognitionError(error)); else resolveSend() })
        if (controller.signal.aborted) stop()
      })
    }
    const fail = (error: unknown): void => {
      if (settled) return
      const failure = safeRecognitionError(error)
      // Bound error delivery too; close() enforces a deadline for an unresponsive peer.
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 256 * 1024) client.send(JSON.stringify({ type: 'error', code: failure.code }))
      finish()
    }
    const processFrame = async (buffer: Buffer, binary: boolean): Promise<void> => {
      if (binary) {
        if (!ready || ending || !session) throw new ChatError('ASR_INVALID_REQUEST', 'Start a new recording.', 400)
        await session.sendAudio(buffer)
        return
      }
      if (buffer.length > 256) throw new ChatError('ASR_INVALID_REQUEST', 'The recording request was invalid.', 400)
      let value: unknown
      try { value = JSON.parse(buffer.toString('utf8')) } catch { throw new ChatError('ASR_INVALID_REQUEST', 'The recording request was invalid.', 400) }
      if (!value || typeof value !== 'object' || !('type' in value) || !['finish', 'cancel'].includes(String(value.type))) throw new ChatError('ASR_INVALID_REQUEST', 'The recording request was invalid.', 400)
      if (value.type === 'cancel') { finish(); return }
      if (!ready || ending || !session) throw new ChatError('ASR_INVALID_REQUEST', 'Start a new recording.', 400)
      ending = true
      // Keep processing client cancellation while the provider finishes its final sentence.
      void session.finish().catch(fail)
    }
    const drain = async (): Promise<void> => {
      if (forwarding || settled) return
      forwarding = true
      try {
        while (!settled && pending.length) {
          const item = pending.shift()!; pendingBytes -= item.buffer.length
          await processFrame(item.buffer, item.binary)
        }
      } catch (error) { fail(error) }
      finally { forwarding = false }
    }
    client.on('message', (data, binary) => {
      if (settled) return
      const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
      // Keep the control channel responsive even while an upstream audio write is
      // blocked. Audio uses the bounded queue below rather than pausing this socket.
      if (!binary && buffer.length <= 256) {
        try {
          const control: unknown = JSON.parse(buffer.toString('utf8'))
          if (control && typeof control === 'object' && 'type' in control && control.type === 'cancel') { finish(); return }
        } catch { /* Invalid control is rejected by the ordered parser below. */ }
      }
      pendingBytes += buffer.length
      if (pendingBytes > 128 * 1024) { fail(new ChatError('ASR_CONNECTION_SLOW', 'Voice input could not keep up.')); return }
      pending.push({ buffer, binary })
      void drain()
    })
    client.on('error', () => finish())
    client.on('close', () => finish())
    void (async () => {
      try {
        session = await recognize(event => send(event), controller.signal)
        if (settled) return
        ready = true
        await send({ type: 'ready', sampleRate: RECOGNITION_SAMPLE_RATE, channels: 1 })
        await session.done
        if (!settled) { await send({ type: 'done' }); finish() }
      } catch (error) { if (!settled) fail(error) }
    })()
  })
  return {
    shutdown(): void {
      stopping = true
      server.off('upgrade', upgrade)
      for (const [client, controller] of sessions) {
        controller.abort()
        client.terminate()
      }
      sessions.clear()
      for (const client of websocketServer.clients) client.terminate()
      websocketServer.close()
    },
  }
}
