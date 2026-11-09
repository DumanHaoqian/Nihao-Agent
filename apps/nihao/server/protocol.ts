import { ChatError } from './errors.ts'
import { parseImages, IMAGE_LIMITS, imageByteLength, type ChatImage } from './images.ts'
import type { TravelEvent } from '../shared/travel.ts'
export { ChatError } from './errors.ts'

/** Validated chat input shared by the HTTP and Harness adapters. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  images?: ChatImage[]
}

export interface ChatRequest {
  messages: ChatMessage[]
  locale: 'en' | 'zh'
  travelSession?: string
}

export type ChatEvent =
  | TravelEvent
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; code: string; message: string }

/** Decode untrusted browser JSON; user input may contain text, raster images, or both. */
export function parseChatRequest(value: unknown): ChatRequest {
  if (typeof value !== 'object' || value === null || !('messages' in value) || !Array.isArray(value.messages)) {
    throw new ChatError('INVALID_REQUEST', 'Send a conversation containing text messages.', 400)
  }
  const locale = 'locale' in value ? value.locale : 'en'
  if (locale !== 'en' && locale !== 'zh') {
    throw new ChatError('INVALID_REQUEST', 'Choose English or Chinese.', 400)
  }
  const travelSession = 'travelSession' in value ? value.travelSession : undefined
  if (travelSession !== undefined && (typeof travelSession !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(travelSession))) {
    throw new ChatError('INVALID_REQUEST', 'The travel session could not be read. Start a new chat.', 400)
  }
  if (value.messages.length > 41) {
    throw new ChatError('CONVERSATION_TOO_LONG', 'This conversation is full. Start a new chat to continue.', 413)
  }
  if (value.messages.length === 0 || value.messages.length % 2 !== 1) {
    throw new ChatError('INVALID_REQUEST', 'Send completed conversation pairs followed by a new question.', 400)
  }
  let total = 0
  let imageCount = 0
  let imageBytes = 0
  const messages: ChatMessage[] = value.messages.map((message: unknown, index): ChatMessage => {
    if (typeof message !== 'object' || message === null || !('role' in message) || !('content' in message)) {
      throw new ChatError('INVALID_REQUEST', 'Each message needs a role and text.', 400)
    }
    const role = index % 2 === 0 ? 'user' : 'assistant'
    if (role === 'assistant' && 'images' in message) throw new ChatError('INVALID_IMAGE', 'Only user messages can contain images.', 400)
    const images = role === 'user' && 'images' in message ? parseImages(message.images) : []
    const limit = role === 'user' ? 16_000 : 64_000
    if (message.role !== role || typeof message.content !== 'string' || (!message.content.trim() && images.length === 0) || message.content.length > limit) {
      throw new ChatError('INVALID_REQUEST', 'Use alternating user and assistant messages. Keep each question under 16,000 characters.', 400)
    }
    total += message.content.length
    imageCount += images.length
    imageBytes += images.reduce((sum, image) => sum + imageByteLength(image), 0)
    if (imageCount > IMAGE_LIMITS.maxHistoryImages) throw new ChatError('TOO_MANY_IMAGES', 'A conversation can contain up to 12 images. Start a new chat to add more.', 413)
    if (imageBytes > IMAGE_LIMITS.maxHistoryBytes) throw new ChatError('IMAGES_TOO_LARGE', 'Images in one conversation must total no more than 20 MB.', 413)
    return { role, content: message.content, ...(images.length ? { images } : {}) }
  })
  if (total > 80_000) {
    throw new ChatError('CONVERSATION_TOO_LONG', 'This conversation is full. Start a new chat to continue.', 413)
  }
  return { messages, locale, ...(travelSession === undefined ? {} : { travelSession }) }
}

/** Never forward provider errors or request bodies: they may contain credentials or private input. */
export function safeChatError(error: unknown): ChatError {
  if (error instanceof ChatError) return error
  return new ChatError('PROVIDER_ERROR', 'Nihao could not finish this reply. Please try again.')
}
