import { gzipSync, gunzipSync } from 'node:zlib'

/** Byte framing from the supplied sauc_python/protocol.py; no audio is persisted. */
export function encodeRecognitionRequest(sequence: number, payload: object | Buffer, last = false): Buffer {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 0x7fffffff) throw new Error('Invalid ASR sequence.')
  const audio = Buffer.isBuffer(payload)
  if (last && !audio) throw new Error('Only an audio packet can end input.')
  const compressed = gzipSync(audio ? payload : Buffer.from(JSON.stringify(payload)))
  const frame = Buffer.allocUnsafe(12 + compressed.length)
  // The official client retains the JSON serialization nibble for audio packets.
  frame.set([0x11, (audio ? 0x20 : 0x10) | (last ? 3 : 1), 0x11, 0])
  frame.writeInt32BE(last ? -sequence : sequence, 4)
  frame.writeUInt32BE(compressed.length, 8)
  compressed.copy(frame, 12)
  return frame
}

export interface RecognitionFrame {
  type: 9 | 15
  last: boolean
  sequence?: number
  event?: number
  code: number
  payload: Record<string, unknown>
}

/** Reject truncated, oversized, or ambiguous envelopes before decoding JSON. */
export function decodeRecognitionResponse(frame: Buffer): RecognitionFrame {
  if (frame.length < 8 || frame.length > 1024 * 1024) throw new Error('Invalid ASR frame size.')
  const headerSize = (frame[0]! & 0x0f) * 4
  const type = frame[1]! >> 4
  const flags = frame[1]! & 0x0f
  const serialization = frame[2]! >> 4
  const compression = frame[2]! & 0x0f
  if (frame[0]! >> 4 !== 1 || headerSize < 4 || headerSize > frame.length || ![9, 15].includes(type) || flags > 7 || (type === 9 ? serialization !== 1 : ![0, 1].includes(serialization)) || ![0, 1].includes(compression)) throw new Error('Unsupported ASR envelope.')
  let offset = headerSize
  const readInt = (): number => {
    if (offset + 4 > frame.length) throw new Error('Truncated ASR envelope.')
    const value = frame.readInt32BE(offset); offset += 4; return value
  }
  const sequence = flags & 1 ? readInt() : undefined
  const event = flags & 4 ? readInt() : undefined
  const code = type === 15 ? readInt() : 0
  if (offset + 4 > frame.length) throw new Error('Missing ASR payload length.')
  const size = frame.readUInt32BE(offset); offset += 4
  if (size !== frame.length - offset || (!size && type !== 15)) throw new Error('Invalid ASR payload length.')
  // Error code is carried in the envelope; provider text may be plain, empty, or JSON.
  // It is never needed by the UI and must never be exposed or logged.
  if (type === 15) return { type, last: Boolean(flags & 2), sequence, event, code, payload: {} }
  const encoded = frame.subarray(offset)
  const bytes = compression === 1 ? gunzipSync(encoded, { maxOutputLength: 1024 * 1024 }) : encoded
  const payload: unknown = JSON.parse(bytes.toString('utf8'))
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid ASR payload.')
  return { type: type as 9 | 15, last: Boolean(flags & 2), sequence, event, code, payload: payload as Record<string, unknown> }
}
