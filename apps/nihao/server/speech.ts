import { randomUUID } from 'node:crypto'
import { HttpsProxyAgent } from 'https-proxy-agent'
import WebSocket from 'ws'
import type { ServerConfig } from './config.ts'
import { ChatError } from './errors.ts'
import { decodeSpeechFrame, encodeSpeechFrame, SpeechEvent } from './speech-protocol.ts'

export const SPEECH_SAMPLE_RATE = 24_000
export const MAX_SPEECH_CHARACTERS = 20_000
export const MAX_SPEECH_BODY_BYTES = 128 * 1024
const MAX_AUDIO_BYTES = SPEECH_SAMPLE_RATE * 2 * 600
const DEFAULT_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection'
export const DEFAULT_SPEAKER = 'zh_female_vv_uranus_bigtts'

export type SpeechStreamEvent =
  | { type: 'start'; format: 'pcm_s16le'; sampleRate: number; channels: 1 }
  | { type: 'audio'; data: string }
  | { type: 'done' }
  | { type: 'error'; code: string; message: string }

export type SpeechRunner = (text: string, onAudio: (audio: Buffer) => void | Promise<void>, signal: AbortSignal) => Promise<void>

export function parseSpeechRequest(value: unknown): string {
  if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string' || !value.text.trim()) throw new ChatError('INVALID_SPEECH_REQUEST', 'Choose a reply containing text to read aloud.', 400)
  if (value.text.length > MAX_SPEECH_CHARACTERS) throw new ChatError('SPEECH_TOO_LONG', 'This reply is too long to read aloud.', 413)
  return value.text.trim()
}

export function safeSpeechError(error: unknown): ChatError {
  if (error instanceof ChatError) return error
  return new ChatError('SPEECH_PROVIDER_ERROR', 'The voice service could not finish. Please try again.')
}

/** Respect standard proxy variables without including their values in diagnostics. */
export function speechProxy(endpoint: URL, env: NodeJS.ProcessEnv): string | undefined {
  const host = endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const port = endpoint.port || (endpoint.protocol === 'wss:' ? '443' : '80')
  const bypass = (env.NO_PROXY || env.no_proxy || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
  if (bypass.some(entry => {
    if (entry === '*') return true
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry)
    if (!match || (match[2] && match[2] !== port)) return false
    let domain = match[1]!.replace(/^\[|\]$/g, '')
    if (domain.startsWith('*.')) domain = domain.slice(1)
    return domain.startsWith('.') ? host === domain.slice(1) || host.endsWith(domain) : host === domain
  })) return undefined
  return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || undefined
}

interface SpeechRunnerOptions {
  /** Dependency injection for local protocol tests; browser requests never set these. */
  endpoint?: string
  apiKey?: string
  environment?: NodeJS.ProcessEnv
}

export function createSpeechRunner(config: ServerConfig, options: SpeechRunnerOptions = {}): SpeechRunner {
  return async (text, onAudio, signal) => {
    signal.throwIfAborted()
    const env = options.environment ?? process.env
    const apiKey = options.apiKey ?? env.DOUBAO_API_KEY?.trim()
    if (!apiKey) throw new ChatError('SPEECH_NOT_CONFIGURED', 'Read aloud is not connected yet.', 503)
    const endpoint = new URL(options.endpoint || DEFAULT_ENDPOINT)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    if (endpoint.username || endpoint.password || endpoint.hash || (endpoint.protocol !== 'wss:' && !(local && endpoint.protocol === 'ws:'))) throw new ChatError('SPEECH_PROVIDER_ERROR', 'The voice service is not configured correctly.')
    const proxy = speechProxy(endpoint, env)
    const sessionId = randomUUID()
    const request = {
      req_params: {
        speaker: config.speechSpeaker || DEFAULT_SPEAKER,
        audio_params: { format: 'pcm', sample_rate: SPEECH_SAMPLE_RATE },
        additions: JSON.stringify({ enable_auto_language_recognition: true }),
      },
    }
    await new Promise<void>((resolve, reject) => {
      let socket: WebSocket
      try {
        socket = new WebSocket(endpoint, {
          headers: { 'X-Api-Key': apiKey, 'X-Api-Resource-Id': 'seed-tts-2.0', 'X-Api-Connect-Id': randomUUID() },
          ...(proxy ? { agent: new HttpsProxyAgent(proxy) } : {}),
          handshakeTimeout: 15_000,
          maxPayload: 4 * 1024 * 1024,
          perMessageDeflate: false,
        })
      } catch { reject(safeSpeechError(undefined)); return }
      let settled = false
      let phase: 'connection' | 'session' | 'audio' | 'finished' = 'connection'
      let receivedBytes = 0
      const pendingFrames: Buffer[] = []
      let pendingBytes = 0
      let forwarding = false
      let termination: NodeJS.Timeout | undefined
      const send = (event: number, payload: unknown = {}): void => {
        socket.send(encodeSpeechFrame(event, payload, sessionId))
      }
      const finish = (error?: unknown): void => {
        if (settled) return
        settled = true
        pendingFrames.length = 0
        pendingBytes = 0
        clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
        if (socket.readyState === WebSocket.OPEN) {
          try {
            if (phase === 'audio' || phase === 'session') send(SpeechEvent.CancelSession)
            else if (phase === 'finished') send(SpeechEvent.FinishConnection)
            socket.close()
          } catch { socket.terminate() }
          termination = setTimeout(() => socket.terminate(), 500)
          termination.unref()
        } else if (socket.readyState !== WebSocket.CLOSED) socket.terminate()
        if (error) reject(error)
        else resolve()
      }
      const abort = (): void => finish(new DOMException('Speech stopped.', 'AbortError'))
      const timeout = setTimeout(() => finish(new ChatError('SPEECH_TIMEOUT', 'The voice service took too long. Please try again.', 504)), config.speechTimeoutMs ?? 120_000)
      socket.on('open', () => {
        if (settled) return
        try { send(SpeechEvent.StartConnection) } catch { finish(safeSpeechError(undefined)) }
      })
      socket.on('unexpected-response', (_request, response) => {
        response.resume()
        const denied = response.statusCode === 401 || response.statusCode === 403
        finish(new ChatError(denied ? 'SPEECH_AUTH_ERROR' : 'SPEECH_PROVIDER_ERROR', denied ? 'The voice service credentials or permissions need attention.' : 'The voice service is unavailable. Please try again.'))
      })
      const forwardFrame = async (buffer: Buffer): Promise<void> => {
          const frame = decodeSpeechFrame(buffer)
          if (frame.type === 15 || [SpeechEvent.ConnectionFailed, SpeechEvent.SessionFailed].includes(frame.event as 51 | 153)) throw safeSpeechError(undefined)
          if (frame.sessionId && frame.sessionId !== sessionId) throw new Error('Unexpected speech session.')
          if (frame.event === SpeechEvent.ConnectionStarted && phase === 'connection') {
            phase = 'session'
            send(SpeechEvent.StartSession, { ...request, event: SpeechEvent.StartSession })
          } else if (frame.event === SpeechEvent.SessionStarted && phase === 'session') {
            phase = 'audio'
            // Bounded chunks preserve surrogate pairs; output audio remains fully streaming.
            const characters = Array.from(text)
            for (let offset = 0; offset < characters.length; offset += 500) {
              send(SpeechEvent.TaskRequest, { req_params: { text: characters.slice(offset, offset + 500).join('') }, event: SpeechEvent.TaskRequest })
            }
            send(SpeechEvent.FinishSession)
          } else if (frame.type === 11 && phase === 'audio') {
            receivedBytes += frame.payload.length
            if (receivedBytes > MAX_AUDIO_BYTES) throw new ChatError('SPEECH_TOO_LONG', 'This reply is too long to read aloud.', 413)
            if (frame.payload.length) await onAudio(frame.payload)
          } else if (frame.event === SpeechEvent.SessionFinished && phase === 'audio') {
            if (!receivedBytes || receivedBytes % 2 !== 0) throw new ChatError('SPEECH_EMPTY_AUDIO', 'The voice service returned no playable audio. Please try again.')
            phase = 'finished'
            finish()
          }
      }
      const forwardPending = async (): Promise<void> => {
        if (forwarding || settled) return
        forwarding = true
        try {
          while (!settled && pendingFrames.length) {
            const frame = pendingFrames.shift()!
            pendingBytes -= frame.length
            await forwardFrame(frame)
          }
        } catch (error) { finish(safeSpeechError(error)) }
        finally {
          forwarding = false
          if (!settled) socket.resume()
        }
      }
      socket.on('message', (data, isBinary) => {
        if (settled) return
        if (!isBinary) { finish(safeSpeechError(undefined)); return }
        const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
        pendingBytes += buffer.length
        // pause() propagates HTTP backpressure to the provider. Already-parsed frames
        // can still arrive from the receiver, so also bound that small delivery queue.
        if (pendingBytes > 8 * 1024 * 1024) {
          finish(new ChatError('SPEECH_CONNECTION_SLOW', 'Audio playback could not keep up. Please try again.'))
          return
        }
        pendingFrames.push(buffer)
        socket.pause()
        void forwardPending()
      })
      socket.on('error', () => finish(safeSpeechError(undefined)))
      socket.on('close', () => {
        if (termination) clearTimeout(termination)
        if (!settled) finish(safeSpeechError(undefined))
      })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
}
