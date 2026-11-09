import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import AttachmentStore, { AttachmentId, ImageVariantId, type ImageAttachmentRef, type ImageRequestTarget, type RequestImageAttachment, type SaveImageAttachment, type StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import sharp from 'sharp'
import { ChatError } from './errors.ts'
import { IMAGE_LIMITS, parseImages, prepareImage, type ChatImage, type PreparedImage } from './images.ts'

/** Request-scoped raster storage. IDs are random; bytes never reach disk and are never hashed. */
export default class NihaoAttachments extends AttachmentStore {
  readonly imageLimits = {
    maxImageBytes: IMAGE_LIMITS.maxImageBytes,
    maxImagesPerMessage: IMAGE_LIMITS.maxMessageImages,
    maxMessageImageBytes: IMAGE_LIMITS.maxHistoryBytes,
    maxImagePixels: IMAGE_LIMITS.maxPixels,
    maxImageDimension: IMAGE_LIMITS.maxDimension,
    mediaTypes: ['image/jpeg', 'image/png', 'image/webp'] as const,
  }

  private readonly images = new Map<AttachmentId, { ref: ImageAttachmentRef; image: PreparedImage }>()

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => () => { this.images.clear() })
  }

  /** Store an already validated browser upload in this request's private map. */
  async saveUpload(upload: ChatImage): Promise<ImageAttachmentRef> {
    const image = await prepareImage(upload)
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(`nihao-image:${randomUUID()}`),
      mediaType: image.mediaType,
      bytes: image.data.byteLength,
      width: image.width,
      height: image.height,
      name: upload.name,
      ...(image.originalDimensions ? { originalDimensions: image.originalDimensions } : {}),
    }
    this.images.set(ref.attachmentId, { ref, image })
    return ref
  }

  private uploadOf(input: SaveImageAttachment): ChatImage {
    return parseImages([{ name: input.name || 'Image', dataUrl: `data:${input.mediaType};base64,${Buffer.from(input.data).toString('base64')}` }])[0]!
  }

  override async validateImage(input: SaveImageAttachment): Promise<void> {
    await prepareImage(this.uploadOf(input))
  }

  override async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return this.saveUpload(this.uploadOf(input))
  }

  private stored(ref: ImageAttachmentRef): { ref: ImageAttachmentRef; image: PreparedImage } {
    const stored = this.images.get(ref.attachmentId)
    if (!stored || stored.ref.bytes !== ref.bytes || stored.ref.width !== ref.width || stored.ref.height !== ref.height || stored.ref.mediaType !== ref.mediaType) {
      throw new ChatError('INVALID_IMAGE', 'This image is no longer available. Please attach it again.', 400)
    }
    return stored
  }

  override async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    signal?.throwIfAborted()
    const stored = this.stored(ref)
    return { ref, data: stored.image.data }
  }

  override async readImageRequest(ref: ImageAttachmentRef, target: ImageRequestTarget, signal?: AbortSignal): Promise<RequestImageAttachment> {
    signal?.throwIfAborted()
    const stored = this.stored(ref)
    let image = stored.image
    if (image.width > target.width || image.height > target.height || image.data.byteLength > target.maxBytes) {
      let smallest: PreparedImage | undefined
      for (const quality of [95, 85, 75, 60]) {
        signal?.throwIfAborted()
        const result = await sharp(image.data, { limitInputPixels: IMAGE_LIMITS.maxPixels, failOn: 'warning' })
          .resize({ width: target.width, height: target.height, fit: 'inside', withoutEnlargement: true })
          .toColourspace('srgb').webp({ quality, alphaQuality: 100 }).toBuffer({ resolveWithObject: true })
        const candidate: PreparedImage = { data: result.data, mediaType: 'image/webp', width: result.info.width, height: result.info.height, hasAlpha: image.hasAlpha }
        if (!smallest || candidate.data.byteLength < smallest.data.byteLength) smallest = candidate
        if (candidate.data.byteLength <= target.maxBytes) break
      }
      image = smallest!
    }
    signal?.throwIfAborted()
    return {
      variantId: ImageVariantId(`${ref.attachmentId}:${target.width}:${target.height}:${target.maxBytes}`),
      attachment: ref,
      data: image.data,
      mediaType: image.mediaType,
      bytes: image.data.byteLength,
      width: image.width,
      height: image.height,
      depth: 'uchar', space: 'srgb', hasAlpha: image.hasAlpha,
    }
  }
}
