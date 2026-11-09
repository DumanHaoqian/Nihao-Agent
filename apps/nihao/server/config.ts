import { resolve } from 'node:path'

/** Server configuration contains no credential value. Providers read their keys from the environment. */
export interface ServerConfig {
  port: number
  host: string
  model: string
  baseURL: string
  maxTokens: number
  timeoutMs: number
  maxConcurrent: number
  configured: boolean
  clientDirectory: string
  speechConfigured?: boolean
  speechSpeaker?: string
  speechTimeoutMs?: number
  speechMaxConcurrent?: number
  recognitionConfigured?: boolean
  recognitionTimeoutMs?: number
  recognitionMaxConcurrent?: number
  mapsConfigured?: boolean
}

function integer(name: string, raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer between 1 and ${max}.`)
  return value
}

/** Resolve validated deployment options without logging or returning provider credentials. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const baseURL = env.POE_BASE_URL || 'https://api.poe.com/v1'
  const endpoint = new URL(baseURL)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.protocol !== 'https:' && !(local && endpoint.protocol === 'http:'))) {
    throw new Error('POE_BASE_URL must be an HTTPS endpoint (HTTP is allowed only for a local test server).')
  }
  const host = env.HOST || '127.0.0.1'
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error('This local MVP must bind to localhost. Public hosting requires authentication first.')
  }
  const model = env.POE_MODEL || 'gpt-5.4-mini'
  if (!/^[\w./:-]{1,120}$/.test(model)) throw new Error('POE_MODEL is not a valid model identifier.')
  const speechSpeaker = env.DOUBAO_SPEAKER || 'zh_female_vv_uranus_bigtts'
  if (!/^[\w-]{1,160}$/.test(speechSpeaker)) throw new Error('DOUBAO_SPEAKER is not a valid voice identifier.')
  return {
    port: integer('PORT', env.PORT, 8787, 65_535),
    host,
    model,
    baseURL: baseURL.replace(/\/$/, ''),
    maxTokens: integer('POE_MAX_TOKENS', env.POE_MAX_TOKENS, 4096, 32_768),
    timeoutMs: integer('CHAT_TIMEOUT_MS', env.CHAT_TIMEOUT_MS, 120_000, 600_000),
    maxConcurrent: integer('CHAT_MAX_CONCURRENT', env.CHAT_MAX_CONCURRENT, 4, 32),
    configured: Boolean(env.POE_API_KEY?.trim()),
    clientDirectory: resolve(env.NIHAO_CLIENT_DIR || 'dist/client'),
    speechConfigured: Boolean(env.DOUBAO_API_KEY?.trim()),
    speechSpeaker,
    speechTimeoutMs: integer('SPEECH_TIMEOUT_MS', env.SPEECH_TIMEOUT_MS, 120_000, 600_000),
    speechMaxConcurrent: integer('SPEECH_MAX_CONCURRENT', env.SPEECH_MAX_CONCURRENT, 2, 16),
    recognitionConfigured: Boolean(env.DOUBAO_API_KEY?.trim()),
    recognitionTimeoutMs: integer('ASR_TIMEOUT_MS', env.ASR_TIMEOUT_MS, 140_000, 180_000),
    recognitionMaxConcurrent: integer('ASR_MAX_CONCURRENT', env.ASR_MAX_CONCURRENT, 2, 16),
    mapsConfigured: Boolean(env.BAIDU_MAP_API_KEY?.trim()),
  }
}
