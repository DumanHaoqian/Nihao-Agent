import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { ServerConfig } from './config.ts'
import { createHarnessRunner, type ChatRunner } from './harness.ts'
import { ChatError, parseChatRequest, safeChatError, type ChatEvent } from './protocol.ts'
import { prepareChatImages } from './images.ts'
import { createSpeechRunner, DEFAULT_SPEAKER, MAX_SPEECH_BODY_BYTES, parseSpeechRequest, safeSpeechError, SPEECH_SAMPLE_RATE, type SpeechRunner, type SpeechStreamEvent } from './speech.ts'
import { createRecognitionFactory, RECOGNITION_RESOURCE, type RecognitionFactory } from './recognition.ts'
import { attachRecognitionWebSocket } from './recognition-websocket.ts'

const MAX_BODY_BYTES = 30 * 1024 * 1024
const MAX_STREAM_BUFFER_BYTES = 256 * 1024
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webp': 'image/webp',
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(value))
}

function assertLocalRequest(request: IncomingMessage): void {
  let host: URL
  try { host = new URL(`http://${request.headers.host || ''}`) } catch {
    throw new ChatError('INVALID_HOST', 'Open Nihao using its localhost address.', 403)
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) {
    throw new ChatError('INVALID_HOST', 'Open Nihao using its localhost address.', 403)
  }
  if (!request.headers.origin) return
  let origin: URL
  try { origin = new URL(request.headers.origin) } catch {
    throw new ChatError('INVALID_ORIGIN', 'Open Nihao using its localhost address.', 403)
  }
  const sameHost = origin.host === host.host
  const viteDev = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && origin.port === '5173'
  if (origin.protocol !== 'http:' || (!sameHost && !viteDev)) {
    throw new ChatError('INVALID_ORIGIN', 'Open Nihao using its localhost address.', 403)
  }
}

async function readJSON(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
    throw new ChatError('INVALID_CONTENT_TYPE', 'Send messages as JSON.', 415)
  }
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) throw new ChatError('REQUEST_TOO_LARGE', 'This message is too long.', 413)
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > maxBytes) throw new ChatError('REQUEST_TOO_LARGE', 'This message is too long.', 413)
    chunks.push(buffer)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
    throw new ChatError('INVALID_JSON', 'The message could not be read. Please try again.', 400)
  }
}

async function serveClient(pathname: string, request: IncomingMessage, response: ServerResponse, directory: string): Promise<void> {
  let decoded: string
  try { decoded = decodeURIComponent(pathname) } catch {
    throw new ChatError('NOT_FOUND', 'Page not found.', 404)
  }
  if (decoded.includes('\0') || decoded.split('/').some(part => part.startsWith('.'))) throw new ChatError('NOT_FOUND', 'Page not found.', 404)
  const filename = resolve(directory, decoded === '/' ? 'index.html' : `.${decoded}`)
  if (!filename.startsWith(`${directory}${sep}`) || !MIME[extname(filename)]) throw new ChatError('NOT_FOUND', 'Page not found.', 404)
  let content: Buffer
  try {
    const entry = await stat(filename)
    if (!entry.isFile()) throw new Error('not a file')
    content = await readFile(filename)
  } catch {
    throw new ChatError('NOT_FOUND', 'Page not found. Run npm run build first, or use the development server.', 404)
  }
  response.writeHead(200, {
    'Content-Type': MIME[extname(filename)]!,
    'Content-Length': content.length,
    'Cache-Control': extname(filename) === '.html' ? 'no-cache' : 'public, max-age=3600',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  })
  response.end(request.method === 'HEAD' ? undefined : content)
}

export interface NihaoServer {
  server: Server
  /** Abort all active replies, await model cleanup, and close the HTTP listener. */
  shutdown(): Promise<void>
}

/** Create the local chat server. Each HTTP stream owns and cancels exactly one Harness request. */
export function createNihaoServer(config: ServerConfig, run: ChatRunner = createHarnessRunner(config), speak: SpeechRunner = createSpeechRunner(config), recognize: RecognitionFactory = createRecognitionFactory(config)): NihaoServer {
  const active = new Set<AbortController>()
  const tasks = new Set<Promise<void>>()
  let stopping = false
  const preparations = new Set<AbortController>()
  const speeches = new Set<AbortController>()

  async function handleSpeech(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST')
      throw new ChatError('METHOD_NOT_ALLOWED', 'Request read aloud using POST.', 405)
    }
    if (stopping) throw new ChatError('SERVER_STOPPING', 'Nihao is restarting. Try again in a moment.', 503)
    if (!config.speechConfigured) throw new ChatError('SPEECH_NOT_CONFIGURED', 'Read aloud is not connected yet.', 503)
    if (speeches.size >= (config.speechMaxConcurrent ?? 2)) throw new ChatError('SPEECH_BUSY', 'The voice service is busy. Please try again in a moment.', 429)
    const controller = new AbortController()
    speeches.add(controller)
    let uploading = true
    let timedOut = false
    const disconnect = (): void => { if (!response.writableEnded) controller.abort() }
    const stopUpload = (): void => {
      if (uploading) request.destroy()
      else if (stopping) response.destroy()
    }
    controller.signal.addEventListener('abort', stopUpload)
    response.on('close', disconnect)
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, config.speechTimeoutMs ?? 120_000)
    let heartbeat: NodeJS.Timeout | undefined
    const send = async (event: SpeechStreamEvent): Promise<void> => {
      controller.signal.throwIfAborted()
      if (response.destroyed || response.writableEnded) throw new DOMException('Speech stopped.', 'AbortError')
      if (response.write(`data: ${JSON.stringify(event)}\n\n`)) return
      await new Promise<void>((resolveDrain, rejectDrain) => {
        const cleanup = (): void => {
          response.off('drain', drained)
          response.off('close', stopped)
          response.off('error', stopped)
          controller.signal.removeEventListener('abort', stopped)
        }
        const drained = (): void => { cleanup(); resolveDrain() }
        const stopped = (): void => { cleanup(); rejectDrain(new DOMException('Speech stopped.', 'AbortError')) }
        response.once('drain', drained)
        response.once('close', stopped)
        response.once('error', stopped)
        controller.signal.addEventListener('abort', stopped, { once: true })
        if (controller.signal.aborted || response.destroyed) stopped()
      })
    }
    try {
      const text = parseSpeechRequest(await readJSON(request, MAX_SPEECH_BODY_BYTES))
      uploading = false
      if (response.destroyed || controller.signal.aborted) return
      if (stopping) throw new ChatError('SERVER_STOPPING', 'Nihao is restarting. Try again in a moment.', 503)
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
        'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
      })
      response.flushHeaders()
      await send({ type: 'start', format: 'pcm_s16le', sampleRate: SPEECH_SAMPLE_RATE, channels: 1 })
      heartbeat = setInterval(() => { if (!response.destroyed && !response.writableNeedDrain) response.write(': keepalive\n\n') }, 15_000)
      await speak(text, async audio => {
        // Bound the SSE frame size even if an upstream provider coalesces large frames.
        for (let offset = 0; offset < audio.length; offset += 32_768) {
          await send({ type: 'audio', data: audio.subarray(offset, offset + 32_768).toString('base64') })
        }
      }, controller.signal)
      if (timedOut) throw new ChatError('SPEECH_TIMEOUT', 'The voice service took too long. Please try again.', 504)
      if (!controller.signal.aborted) await send({ type: 'done' })
    } catch (error) {
      if (!response.headersSent) throw error
      if (!response.destroyed) {
        const failure = timedOut ? new ChatError('SPEECH_TIMEOUT', 'The voice service took too long. Please try again.', 504) : safeSpeechError(error)
        if (timedOut || !controller.signal.aborted) response.write(`data: ${JSON.stringify({ type: 'error', code: failure.code, message: failure.message })}\n\n`)
      }
    } finally {
      clearTimeout(timeout)
      if (heartbeat) clearInterval(heartbeat)
      response.off('close', disconnect)
      controller.signal.removeEventListener('abort', stopUpload)
      speeches.delete(controller)
      if (response.headersSent) response.end()
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    try {
      assertLocalRequest(request)
      const url = new URL(request.url || '/', 'http://localhost')
      if (url.pathname === '/api/health' && request.method === 'GET') {
        json(response, 200, { ok: true, configured: config.configured, model: config.model, maps: { configured: Boolean(config.mapsConfigured), provider: 'baidu' }, speech: { configured: Boolean(config.speechConfigured), provider: 'doubao', speaker: config.speechSpeaker || DEFAULT_SPEAKER }, recognition: { configured: Boolean(config.recognitionConfigured), provider: 'doubao', resource: RECOGNITION_RESOURCE } })
        return
      }
      if (url.pathname === '/api/speech') {
        await handleSpeech(request, response)
        return
      }
      if (url.pathname !== '/api/chat') {
        if (url.pathname.startsWith('/api/') || !['GET', 'HEAD'].includes(request.method || '')) throw new ChatError('NOT_FOUND', 'Page not found.', 404)
        await serveClient(url.pathname, request, response, config.clientDirectory)
        return
      }
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST')
        throw new ChatError('METHOD_NOT_ALLOWED', 'Send a chat message using POST.', 405)
      }
      if (stopping) throw new ChatError('SERVER_STOPPING', 'Nihao is restarting. Try again in a moment.', 503)
      if (!config.configured) throw new ChatError('NOT_CONFIGURED', 'Nihao is not connected yet. Start the server from a terminal with POE_API_KEY loaded.', 503)
      if (active.size + preparations.size >= config.maxConcurrent) throw new ChatError('BUSY', 'Nihao is answering other messages. Try again in a moment.', 429)
      let payload: ReturnType<typeof parseChatRequest>
      const preparation = new AbortController()
      preparations.add(preparation)
      const abortPreparation = (): void => { preparation.abort() }
      const stopUpload = (): void => { request.destroy() }
      preparation.signal.addEventListener('abort', stopUpload, { once: true })
      response.once('close', abortPreparation)
      try {
        payload = parseChatRequest(await readJSON(request))
        await prepareChatImages(payload, preparation.signal)
      } finally {
        preparations.delete(preparation)
        preparation.signal.removeEventListener('abort', stopUpload)
        response.off('close', abortPreparation)
      }
      if (response.destroyed) return
      if (stopping) throw new ChatError('SERVER_STOPPING', 'Nihao is restarting. Try again in a moment.', 503)
      if (active.size >= config.maxConcurrent) throw new ChatError('BUSY', 'Nihao is answering other messages. Try again in a moment.', 429)
      const controller = new AbortController()
      active.add(controller)
      const disconnect = (): void => { if (!response.writableEnded) controller.abort() }
      response.on('close', disconnect)
      let timedOut = false
      let flowFailure: ChatError | undefined
      const timeout = setTimeout(() => { timedOut = true; controller.abort() }, config.timeoutMs)
      const send = (event: ChatEvent): void => {
        if (response.destroyed || response.writableEnded) return
        if (response.writableLength > MAX_STREAM_BUFFER_BYTES) {
          flowFailure = new ChatError('CONNECTION_SLOW', 'The connection is too slow. Please try again.')
          controller.abort()
          throw flowFailure
        }
        response.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      response.flushHeaders()
      response.write(': connected\n\n')
      const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': keepalive\n\n') }, 15_000)
      try {
        await run(payload, text => send({ type: 'delta', text }), controller.signal, send)
        if (timedOut) throw new ChatError('TIMEOUT', 'This reply took too long. Please try again.', 504)
        if (!controller.signal.aborted) send({ type: 'done' })
      } catch (error) {
        if (timedOut) send({ type: 'error', code: 'TIMEOUT', message: 'This reply took too long. Please try again.' })
        else if (flowFailure && !response.destroyed) response.write(`data: ${JSON.stringify({ type: 'error', code: flowFailure.code, message: flowFailure.message })}\n\n`)
        else if (!response.destroyed && !controller.signal.aborted) {
          const failure = safeChatError(error)
          send({ type: 'error', code: failure.code, message: failure.message })
        }
      } finally {
        clearTimeout(timeout)
        clearInterval(heartbeat)
        response.off('close', disconnect)
        active.delete(controller)
        response.end()
      }
    } catch (error) {
      if (response.destroyed || response.writableEnded) return
      const failure = safeChatError(error)
      if (!request.complete) {
        response.setHeader('Connection', 'close')
        response.once('finish', () => { request.destroy() })
      }
      json(response, failure.status, { error: failure.message, code: failure.code, message: failure.message })
    }
  }

  const server = createServer((request, response) => {
    const task = handle(request, response)
    tasks.add(task)
    void task.finally(() => { tasks.delete(task) })
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  const recognition = attachRecognitionWebSocket(server, config, recognize, assertLocalRequest)
  return {
    server,
    async shutdown() {
      stopping = true
      for (const controller of preparations) controller.abort()
      for (const controller of active) controller.abort()
      for (const controller of speeches) controller.abort()
      recognition.shutdown()
      const closed = new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
      await Promise.allSettled([...tasks])
      server.closeIdleConnections()
      await closed
    },
  }
}
