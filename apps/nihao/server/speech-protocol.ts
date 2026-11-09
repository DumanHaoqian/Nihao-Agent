import { gunzipSync } from 'node:zlib'

/** Binary framing follows the user's official TTS Websocket Bidirection protocols.py. */
export const SpeechEvent = {
  StartConnection: 1, FinishConnection: 2,
  ConnectionStarted: 50, ConnectionFailed: 51, ConnectionFinished: 52,
  StartSession: 100, CancelSession: 101, FinishSession: 102,
  SessionStarted: 150, SessionCanceled: 151, SessionFinished: 152, SessionFailed: 153,
  TaskRequest: 200, TTSResponse: 352,
} as const

const MAX_FRAME_BYTES = 4 * 1024 * 1024
const connectionEvents = new Set<number>([1, 2, 50, 51, 52])

export function encodeSpeechFrame(event: number, payload: unknown = {}, sessionId?: string): Buffer {
  const data = Buffer.from(JSON.stringify(payload))
  const eventBuffer = Buffer.alloc(4)
  eventBuffer.writeInt32BE(event)
  const parts = [Buffer.from([0x11, 0x14, 0x10, 0]), eventBuffer]
  if (!connectionEvents.has(event)) {
    if (!sessionId) throw new Error('A speech session ID is required.')
    const id = Buffer.from(sessionId)
    const length = Buffer.alloc(4)
    length.writeUInt32BE(id.length)
    parts.push(length, id)
  }
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  parts.push(length, data)
  return Buffer.concat(parts)
}

export interface SpeechFrame {
  type: number
  event: number
  sessionId?: string
  connectionId?: string
  errorCode?: number
  payload: Buffer
}

/** Reject malformed/truncated envelopes before interpreting or forwarding their payloads. */
export function decodeSpeechFrame(buffer: Buffer): SpeechFrame {
  if (buffer.length < 8 || buffer.length > MAX_FRAME_BYTES || buffer[0]! >> 4 !== 1) throw new Error('Invalid speech frame.')
  const headerBytes = (buffer[0]! & 15) * 4
  const type = buffer[1]! >> 4
  const flags = buffer[1]! & 15
  const serialization = buffer[2]! >> 4
  const compression = buffer[2]! & 15
  if (headerBytes < 4 || headerBytes > buffer.length || ![9, 11, 15].includes(type) || ![0, 1, 2, 3, 4].includes(flags) || ![0, 1].includes(serialization) || ![0, 1].includes(compression)) throw new Error('Unsupported speech frame.')
  let offset = headerBytes
  const readInt = (): number => {
    if (offset + 4 > buffer.length) throw new Error('Truncated speech frame.')
    const value = buffer.readUInt32BE(offset)
    offset += 4
    return value
  }
  const readBytes = (): Buffer => {
    const length = readInt()
    if (length > MAX_FRAME_BYTES || offset + length > buffer.length) throw new Error('Truncated speech payload.')
    const result = buffer.subarray(offset, offset + length)
    offset += length
    return result
  }
  let errorCode: number | undefined
  if (type === 15) errorCode = readInt()
  else if (flags === 1 || flags === 3) readInt() // Provider sequence number.
  let event = 0
  let sessionId: string | undefined
  let connectionId: string | undefined
  if (flags === 4) {
    event = readInt()
    if ([50, 51, 52].includes(event)) connectionId = readBytes().toString('utf8')
    else if (!connectionEvents.has(event)) sessionId = readBytes().toString('utf8')
  }
  let payload = readBytes()
  if (offset !== buffer.length) throw new Error('Unexpected trailing speech data.')
  if (compression === 1) payload = gunzipSync(payload, { maxOutputLength: MAX_FRAME_BYTES })
  return { type, event, ...(sessionId ? { sessionId } : {}), ...(connectionId ? { connectionId } : {}), ...(errorCode === undefined ? {} : { errorCode }), payload }
}
