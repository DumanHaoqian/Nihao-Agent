import type { ChatImage } from './chat.ts';

const MIB = 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_SOURCE_BYTES = 20 * MIB;
const MAX_IMAGE_BYTES = 5 * MIB;
const MAX_EDGE = 2048;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Stable codes keep file names and browser decode errors out of error notices. */
export class ImagePreparationError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ImagePreparationError'; }
}

/** Validate the full selection before accepting any files from it. */
export function validateImageSelection(files: File[], existingCount: number): void {
  if (files.length + existingCount > MAX_IMAGES_PER_MESSAGE) throw new ImagePreparationError('TOO_MANY_IMAGES');
  for (const file of files) {
    if (!ALLOWED_TYPES.has(file.type)) throw new ImagePreparationError('IMAGE_TYPE');
    if (file.size > MAX_SOURCE_BYTES) throw new ImagePreparationError('IMAGE_SOURCE_TOO_LARGE');
    if (file.size === 0) throw new ImagePreparationError('INVALID_IMAGE');
  }
}

/** Dimensions preserve aspect ratio and never upscale a small image. */
export function normalizedDimensions(width: number, height: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new ImagePreparationError('INVALID_IMAGE');
  const ratio = Math.min(1, MAX_EDGE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

/** MIME labels alone cannot turn a GIF, SVG, or arbitrary file into an image. */
export function validateImageSignature(bytes: Uint8Array, mimeType: string): void {
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  const isPng = png.every((byte, index) => bytes[index] === byte);
  const isJpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const isWebp = bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80;
  if (!(mimeType === 'image/png' && isPng || mimeType === 'image/jpeg' && isJpeg || mimeType === 'image/webp' && isWebp)) throw new ImagePreparationError('INVALID_IMAGE');
}

/** Count decoded bytes for browser-created base64 data URLs without decoding again. */
export function imageByteLength(dataUrl: string): number {
  const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return encoded.length * 3 / 4 - padding;
}

/** Check retained history and new attachments together before a request is sent. */
export function validateConversationImages(images: ChatImage[]): void {
  if (images.length > 12) throw new ImagePreparationError('IMAGE_HISTORY_LIMIT');
  if (images.reduce((bytes, image) => bytes + imageByteLength(image.dataUrl), 0) > 20 * MIB) throw new ImagePreparationError('IMAGES_TOO_LARGE');
}

async function decodeImage(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function jpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new ImagePreparationError('INVALID_IMAGE')), 'image/jpeg', quality);
  });
}

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new ImagePreparationError('INVALID_IMAGE'));
    reader.onerror = () => reject(new ImagePreparationError('INVALID_IMAGE'));
    reader.onabort = () => reject(new ImagePreparationError('INVALID_IMAGE'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Decode and re-encode locally to a readable JPEG. White fills transparent areas;
 * the output is at most 2048px on its long edge and contains no source metadata.
 */
export async function prepareImage(file: File): Promise<ChatImage> {
  validateImageSelection([file], 0);
  validateImageSignature(new Uint8Array(await file.slice(0, 16).arrayBuffer()), file.type);
  let decoded: Awaited<ReturnType<typeof decodeImage>>;
  try { decoded = await decodeImage(file); } catch { throw new ImagePreparationError('INVALID_IMAGE'); }
  const canvas = document.createElement('canvas');
  try {
    const dimensions = normalizedDimensions(decoded.width, decoded.height);
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext('2d');
    if (!context) throw new ImagePreparationError('INVALID_IMAGE');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
    let encoded = await jpegBlob(canvas, .92);
    for (const quality of [.84, .74, .64]) {
      if (encoded.size <= MAX_IMAGE_BYTES) break;
      encoded = await jpegBlob(canvas, quality);
    }
    if (encoded.size > MAX_IMAGE_BYTES) throw new ImagePreparationError('IMAGE_TOO_LARGE');
    const basename = file.name.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '') || 'image';
    const stem = basename.replace(/\.[^.]+$/, '').slice(0, 150) || 'image';
    return { name: `${stem}.jpg`, dataUrl: await readDataUrl(encoded) };
  } catch (error) {
    if (error instanceof ImagePreparationError) throw error;
    throw new ImagePreparationError('INVALID_IMAGE');
  } finally {
    decoded.release();
    canvas.width = 0;
    canvas.height = 0;
  }
}
