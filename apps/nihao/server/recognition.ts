import { randomUUID } from 'node:crypto'
import { HttpsProxyAgent } from 'https-proxy-agent'
import WebSocket from 'ws'
import type { ServerConfig } from './config.ts'
import { ChatError } from './errors.ts'
import { speechProxy } from './speech.ts'
import { decodeRecognitionResponse, encodeRecognitionRequest } from './recognition-protocol.ts'

export const RECOGNITION_SAMPLE_RATE = 16_000
export const RECOGNITION_RESOURCE = 'volc.seedasr.sauc.duration'
export const MAX_RECOGNITION_AUDIO_BYTES = RECOGNITION_SAMPLE_RATE * 2 * 120
export const MAX_RECOGNITION_PACKET_BYTES = 32_000
export const MAX_RECOGNITION_TEXT = 12_000
const ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'

export interface RecognitionTranscript { type: 'transcript'; text: string; final: boolean }
export interface RecognitionSession {
  sendAudio(audio: Buffer): Promise<void>
  finish(): Promise<void>
  done: Promise<void>
}
export type RecognitionFactory = (onTranscript: (event: RecognitionTranscript) => void | Promise<void>, signal: AbortSignal) => Promise<RecognitionSession>

export function safeRecognitionError(error: unknown): ChatError {
  if (error instanceof ChatError && error.code.startsWith('ASR_')) return error
  return new ChatError('ASR_PROVIDER_ERROR', 'Voice input could not finish. Please try again.')
}

interface RecognitionOptions {
  /** Local test injection only. No browser parameter can change the provider or key. */
  endpoint?: string
  apiKey?: string
  environment?: NodeJS.ProcessEnv
  setupTimeoutMs?: number
  finishTimeoutMs?: number
}

export function createRecognitionFactory(config: ServerConfig, options: RecognitionOptions = {}): RecognitionFactory {
  return async (onTranscript, signal) => {
    signal.throwIfAborted()
    const env = options.environment ?? process.env
    const apiKey = options.apiKey ?? env.DOUBAO_API_KEY?.trim()
    if (!apiKey) throw new ChatError('ASR_NOT_CONFIGURED', 'Voice input is not connected yet.', 503)
    const endpoint = new URL(options.endpoint || ENDPOINT)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.protocol !== 'wss:' && !(local && endpoint.protocol === 'ws:'))) throw safeRecognitionError(undefined)
    const proxy = speechProxy(endpoint, env)
    const ready = Promise.withResolvers<RecognitionSession>()
    const complete = Promise.withResolvers<void>()
    // Completion can reject while the caller is still waiting for initialization.
    void complete.promise.catch(() => {})
    let socket: WebSocket
    try {
      socket = new WebSocket(endpoint, {
        headers: { 'X-Api-Key': apiKey, 'X-Api-Resource-Id': RECOGNITION_RESOURCE, 'X-Api-Request-Id': randomUUID() },
        ...(proxy ? { agent: new HttpsProxyAgent(proxy) } : {}),
        handshakeTimeout: options.setupTimeoutMs ?? 15_000, maxPayload: 1024 * 1024, perMessageDeflate: false,
      })
    } catch { throw safeRecognitionError(undefined) }
    let settled = false
    let initialized = false
    let ending = false
    let sequence = 1
    let totalBytes = 0
    let latestText = ''
    let tail: Buffer | undefined
    let endTimeout: NodeJS.Timeout | undefined
    let termination: NodeJS.Timeout | undefined
    let closed = false
    let forwarding = false
    const pendingFrames: Buffer[] = []
    let pendingBytes = 0
    const failTimeout = (): void => finish(new ChatError('ASR_TIMEOUT', 'Voice input took too long. Please try again.', 504))
    const setupTimeout = setTimeout(failTimeout, options.setupTimeoutMs ?? 15_000)
    const overallTimeout = setTimeout(failTimeout, config.recognitionTimeoutMs ?? 140_000)
    const finish = (error?: unknown): void => {
      if (settled) return
      settled = true
      tail = undefined
      pendingFrames.length = 0; pendingBytes = 0
      clearTimeout(setupTimeout); clearTimeout(overallTimeout); clearTimeout(endTimeout)
      signal.removeEventListener('abort', abort)
      if (socket.readyState === WebSocket.OPEN) {
        socket.close()
        termination = setTimeout(() => socket.terminate(), 500)
        termination.unref()
      } else if (socket.readyState !== WebSocket.CLOSED) socket.terminate()
      if (error) { ready.reject(error); complete.reject(error) }
      else complete.resolve()
    }
    const abort = (): void => finish(new DOMException('Voice input stopped.', 'AbortError'))
    const send = async (frame: Buffer): Promise<void> => {
      signal.throwIfAborted()
      if (settled || socket.readyState !== WebSocket.OPEN) throw safeRecognitionError(undefined)
      if (socket.bufferedAmount > 256 * 1024) throw new ChatError('ASR_CONNECTION_SLOW', 'Voice input could not keep up. Please try again.')
      await new Promise<void>((resolveSend, rejectSend) => {
        const stop = (): void => { cleanup(); rejectSend(new DOMException('Voice input stopped.', 'AbortError')) }
        const cleanup = (): void => signal.removeEventListener('abort', stop)
        signal.addEventListener('abort', stop, { once: true })
        socket.send(frame, error => { cleanup(); if (error) rejectSend(safeRecognitionError(undefined)); else resolveSend() })
        if (signal.aborted) stop()
      })
    }
    const session: RecognitionSession = {
      done: complete.promise,
      async sendAudio(audio) {
        if (!initialized || ending || settled) throw new ChatError('ASR_INVALID_REQUEST', 'Voice input is no longer accepting audio.', 400)
        if (!audio.length || audio.length % 2 || audio.length > MAX_RECOGNITION_PACKET_BYTES) throw new ChatError('ASR_INVALID_AUDIO', 'The microphone audio could not be read.', 400)
        totalBytes += audio.length
        if (totalBytes > MAX_RECOGNITION_AUDIO_BYTES) throw new ChatError('ASR_TOO_LONG', 'Recordings can be up to two minutes.', 413)
        const previous = tail
        tail = Buffer.from(audio)
        if (previous) await send(encodeRecognitionRequest(sequence++, previous))
      },
      async finish() {
        if (ending) return complete.promise
        ending = true
        if (!initialized || settled) return complete.promise
        if (!tail) { finish(new ChatError('ASR_NO_SPEECH', 'No speech was detected. Try speaking again.')); return complete.promise }
        const last = tail; tail = undefined
        endTimeout = setTimeout(failTimeout, options.finishTimeoutMs ?? 15_000)
        try { await send(encodeRecognitionRequest(sequence++, last, true)) }
        catch (error) { finish(safeRecognitionError(error)) }
        return complete.promise
      },
    }
    socket.on('open', () => {
      if (settled) return
      void send(encodeRecognitionRequest(sequence++, {
        user: { uid: randomUUID() },
        audio: { format: 'pcm', codec: 'raw', rate: RECOGNITION_SAMPLE_RATE, bits: 16, channel: 1 },
        request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true, enable_ddc: false, enable_nonstream: true, show_utterances: true, result_type: 'full' },
      })).catch(error => finish(safeRecognitionError(error)))
    })
    socket.on('unexpected-response', (_request, response) => {
      response.resume()
      finish(new ChatError(response.statusCode === 401 || response.statusCode === 403 ? 'ASR_AUTH_ERROR' : 'ASR_PROVIDER_ERROR', 'Voice input credentials or service availability need attention.'))
    })
    const processFrame = async (buffer: Buffer): Promise<void> => {
      const frame = decodeRecognitionResponse(buffer)
      const payloadCode = frame.payload.code
      const failureCode = frame.type === 15 ? frame.code : payloadCode
      if (failureCode === 45000002) throw new ChatError('ASR_NO_SPEECH', 'No speech was detected. Try speaking again.')
      if (failureCode === 45000081 || failureCode === 55001010) throw new ChatError('ASR_TIMEOUT', 'Voice input took too long. Please try again.', 504)
      if (frame.type === 15 || (typeof payloadCode === 'number' && ![0, 20000000].includes(payloadCode))) throw safeRecognitionError(undefined)
      if (!initialized) {
        if (frame.last) throw safeRecognitionError(undefined)
        initialized = true
        clearTimeout(setupTimeout)
        ready.resolve(session)
        // Initialization is an acknowledgement, not a transcript. Let the bridge send
        // ready before accepting audio or publishing any recognition text.
        return
      }
      const result = frame.payload.result
      const candidate = result && typeof result === 'object' && 'text' in result ? result.text : undefined
      if (candidate !== undefined && typeof candidate !== 'string') throw safeRecognitionError(undefined)
      if (typeof candidate === 'string') {
        if (candidate.length > MAX_RECOGNITION_TEXT) throw new ChatError('ASR_TOO_LONG', 'The recognized text is too long.', 413)
        latestText = candidate
      }
      if (frame.last && !ending) throw safeRecognitionError(undefined)
      if (frame.last && !latestText.trim()) throw new ChatError('ASR_NO_SPEECH', 'No speech was detected. Try speaking again.')
      if (candidate !== undefined || frame.last) await onTranscript({ type: 'transcript', text: latestText, final: frame.last })
      if (frame.last) finish()
    }
    const drainFrames = async (): Promise<void> => {
      if (forwarding || settled) return
      forwarding = true
      try {
        while (!settled && pendingFrames.length) {
          const next = pendingFrames.shift()!; pendingBytes -= next.length
          await processFrame(next)
        }
      } catch (error) { finish(safeRecognitionError(error)) }
      finally {
        forwarding = false
        if (!settled) {
          if (closed) finish(safeRecognitionError(undefined))
          else socket.resume()
        }
      }
    }
    socket.on('message', (data, binary) => {
      if (settled) return
      if (!binary) { finish(safeRecognitionError(undefined)); return }
      const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
      pendingBytes += buffer.length
      if (pendingBytes > 1024 * 1024) { finish(new ChatError('ASR_CONNECTION_SLOW', 'Voice input could not keep up. Please try again.')); return }
      pendingFrames.push(buffer)
      socket.pause()
      void drainFrames()
    })
    socket.on('error', () => finish(safeRecognitionError(undefined)))
    socket.on('close', () => {
      closed = true
      clearTimeout(termination)
      if (!settled && !forwarding) finish(safeRecognitionError(undefined))
    })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    return ready.promise
  }
}
