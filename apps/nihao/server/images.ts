import sharp from 'sharp'
import { requestImageDimensions, type ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { ChatError } from './errors.ts'
import type { ChatRequest } from './protocol.ts'

const preparation = Symbol('nihao.image.preparation')

/** Browser transport for one uploaded image; remote URLs are never accepted. */
export interface ChatImage {
  name: string
  dataUrl: string
  [preparation]?: Promise<PreparedImage>
}

export const IMAGE_LIMITS = {
  maxImageBytes: 5 * 1024 * 1024,
  maxMessageImages: 4,
  maxHistoryImages: 12,
  maxHistoryBytes: 20 * 1024 * 1024,
  maxPixels: 25_000_000,
  maxDimension: 8192,
  requestPixels: 2048 * 2048,
} as const

type AcceptedMediaType = Exclude<ImageMediaType, 'image/gif'>

/** Fully decoded image, ready to be registered with the request's in-memory attachment store. */
export interface PreparedImage {
  data: Uint8Array
  mediaType: AcceptedMediaType
  width: number
  height: number
  hasAlpha: boolean
  originalDimensions?: { width: number; height: number }
}

function encodedParts(dataUrl: string): { mediaType: AcceptedMediaType; encoded: string } {
  const prefix = /^data:(image\/(?:jpeg|png|webp));base64,/.exec(dataUrl)
  if (!prefix) throw new ChatError('IMAGE_TYPE', 'Upload a JPEG, PNG or WebP image. Video and other file types are not supported.', 400)
  const encoded = dataUrl.slice(prefix[0].length)
  const mediaType = prefix[1] as AcceptedMediaType
  return { mediaType, encoded }
}

/** Exact decoded size without allocating another copy of the upload. */
export function imageByteLength(image: ChatImage): number {
  const { encoded } = encodedParts(image.dataUrl)
  return encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0)
}

function signatureMatches(bytes: Buffer, mediaType: AcceptedMediaType): boolean {
  switch (mediaType) {
    case 'image/png': return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    case 'image/jpeg': return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    case 'image/webp': return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  }
}

/** Validate encoding, byte budget and declared format before allocating model work. */
export function parseImages(value: unknown): ChatImage[] {
  if (!Array.isArray(value)) throw new ChatError('INVALID_IMAGE', 'Images must be a list of uploaded files.', 400)
  if (value.length > IMAGE_LIMITS.maxMessageImages) throw new ChatError('TOO_MANY_IMAGES', 'Add up to four images to one message.', 413)
  return value.map((item: unknown) => {
    if (typeof item !== 'object' || item === null || !('name' in item) || typeof item.name !== 'string' || !('dataUrl' in item) || typeof item.dataUrl !== 'string') {
      throw new ChatError('INVALID_IMAGE', 'Each image needs a filename and encoded image data.', 400)
    }
    const { encoded, mediaType } = encodedParts(item.dataUrl)
    if (encoded.length > Math.ceil(IMAGE_LIMITS.maxImageBytes / 3) * 4) throw new ChatError('IMAGE_TOO_LARGE', 'Each image must be no larger than 5 MB.', 413)
    if (!encoded.length || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new ChatError('INVALID_IMAGE', 'This image could not be read. Please upload it again.', 400)
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.length > IMAGE_LIMITS.maxImageBytes) throw new ChatError('IMAGE_TOO_LARGE', 'Each image must be no larger than 5 MB.', 413)
    if (bytes.toString('base64') !== encoded || !signatureMatches(bytes, mediaType)) throw new ChatError('INVALID_IMAGE', 'The file content does not match its image format.', 400)
    const name = item.name.split(/[\\/]/).at(-1)!.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160).trim() || 'Image'
    return { name, dataUrl: item.dataUrl }
  })
}

async function decodeImage(image: ChatImage): Promise<PreparedImage> {
  const { encoded, mediaType } = encodedParts(image.dataUrl)
  const bytes = Buffer.from(encoded, 'base64')
  const input = sharp(bytes, { failOn: 'warning', limitInputPixels: IMAGE_LIMITS.maxPixels, sequentialRead: true })
  try {
    // Header reads do not decode pixels. Check dimensions before requesting raster output.
    const metadata = await input.metadata()
    const expected = mediaType.slice('image/'.length)
    if (metadata.format !== expected || (metadata.pages ?? 1) > 1) throw new ChatError('INVALID_IMAGE', 'Upload a still JPEG, PNG or WebP image.', 400)
    if (!metadata.width || !metadata.height || metadata.width > IMAGE_LIMITS.maxDimension || metadata.height > IMAGE_LIMITS.maxDimension || metadata.width * metadata.height > IMAGE_LIMITS.maxPixels) {
      throw new ChatError('IMAGE_DIMENSIONS', 'Images must be at most 8192 pixels per side and 25 megapixels.', 400)
    }
    const rotated = metadata.orientation !== undefined && metadata.orientation >= 5
    const width = rotated ? metadata.height : metadata.width
    const height = rotated ? metadata.width : metadata.height
    const target = requestImageDimensions(width, height, IMAGE_LIMITS.requestPixels)
    const needsNormalization = width !== target.width || height !== target.height || metadata.depth !== 'uchar' || metadata.space !== 'srgb' || (metadata.orientation ?? 1) !== 1
    if (!needsNormalization) {
      // Decode every pixel so a valid header cannot conceal a truncated or corrupt raster.
      await input.clone().raw().toBuffer()
      return { data: bytes, mediaType, width, height, hasAlpha: metadata.hasAlpha }
    }
    const result = await input.clone().rotate().resize({ width: target.width, height: target.height, fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb').webp({ quality: 95, alphaQuality: 100 }).toBuffer({ resolveWithObject: true })
    if (result.data.byteLength > IMAGE_LIMITS.maxImageBytes) throw new ChatError('IMAGE_TOO_LARGE', 'This image is too large after preparation. Upload a smaller copy.', 413)
    const verified = await sharp(result.data).metadata()
    if (verified.depth !== 'uchar' || verified.space !== 'srgb') throw new ChatError('INVALID_IMAGE', 'This image could not be prepared. Try a JPEG or PNG copy.', 400)
    return {
      data: result.data, mediaType: 'image/webp', width: result.info.width, height: result.info.height, hasAlpha: verified.hasAlpha,
      ...(width !== result.info.width || height !== result.info.height ? { originalDimensions: { width, height } } : {}),
    }
  } catch (error) {
    if (error instanceof ChatError) throw error
    throw new ChatError('INVALID_IMAGE', 'This image could not be decoded. It may be damaged or exceed the image dimensions limit.', 400)
  } finally { input.destroy() }
}

/** Decode an upload once; the parsed request owns the cached result and its lifetime. */
export function prepareImage(image: ChatImage): Promise<PreparedImage> {
  image[preparation] ??= decodeImage(image)
  return image[preparation]
}

/** Validate all images before opening SSE; retain all accepted history images without offloading. */
export async function prepareChatImages(request: ChatRequest, signal?: AbortSignal): Promise<void> {
  let preparedBytes = 0
  for (const message of request.messages) {
    for (const image of message.images ?? []) {
      signal?.throwIfAborted()
      preparedBytes += (await prepareImage(image)).data.byteLength
      if (preparedBytes > IMAGE_LIMITS.maxHistoryBytes) throw new ChatError('IMAGES_TOO_LARGE', 'Prepared images exceed the 20 MB conversation limit. Upload smaller copies.', 413)
    }
  }
  signal?.throwIfAborted()
}
