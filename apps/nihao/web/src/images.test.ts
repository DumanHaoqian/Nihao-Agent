import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ImagePreparationError, imageByteLength, normalizedDimensions, validateConversationImages, validateImageSelection, validateImageSignature } from './images.ts';

const image = { name: 'menu.jpg', dataUrl: 'data:image/jpeg;base64,/9j/' };

test('a mixed or excessive file selection is rejected without choosing a subset', () => {
  const photo = new File(['photo'], 'photo.png', { type: 'image/png' });
  const video = new File(['video'], 'clip.mp4', { type: 'video/mp4' });
  assert.throws(() => validateImageSelection([photo, video], 0), (error: unknown) => error instanceof ImagePreparationError && error.code === 'IMAGE_TYPE');
  assert.throws(() => validateImageSelection([photo, photo], 3), (error: unknown) => error instanceof ImagePreparationError && error.code === 'TOO_MANY_IMAGES');
  assert.doesNotThrow(() => validateImageSelection([photo, photo], 2));
});

test('large source files and empty images are rejected before decoding', () => {
  const empty = new File([], 'empty.png', { type: 'image/png' });
  const oversized = new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'large.jpg', { type: 'image/jpeg' });
  assert.throws(() => validateImageSelection([empty], 0), (error: unknown) => error instanceof ImagePreparationError && error.code === 'INVALID_IMAGE');
  assert.throws(() => validateImageSelection([oversized], 0), (error: unknown) => error instanceof ImagePreparationError && error.code === 'IMAGE_SOURCE_TOO_LARGE');
});

test('normalization preserves portrait and landscape proportions without upscaling', () => {
  assert.deepEqual(normalizedDimensions(6000, 4000), { width: 2048, height: 1365 });
  assert.deepEqual(normalizedDimensions(4000, 6000), { width: 1365, height: 2048 });
  assert.deepEqual(normalizedDimensions(640, 480), { width: 640, height: 480 });
  assert.throws(() => normalizedDimensions(0, 500), ImagePreparationError);
});

test('a MIME label cannot admit GIF or SVG bytes', () => {
  assert.throws(() => validateImageSignature(new TextEncoder().encode('GIF89a'), 'image/png'), ImagePreparationError);
  assert.throws(() => validateImageSignature(new TextEncoder().encode('<svg></svg>'), 'image/jpeg'), ImagePreparationError);
  assert.doesNotThrow(() => validateImageSignature(new Uint8Array([255, 216, 255, 224]), 'image/jpeg'));
  assert.doesNotThrow(() => validateImageSignature(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), 'image/png'));
});

test('conversation limits count retained images and base64 padding correctly', () => {
  assert.equal(imageByteLength('data:image/png;base64,YQ=='), 1);
  assert.equal(imageByteLength('data:image/png;base64,YWI='), 2);
  assert.equal(imageByteLength('data:image/png;base64,YWJj'), 3);
  assert.doesNotThrow(() => validateConversationImages(Array.from({ length: 12 }, () => image)));
  assert.throws(() => validateConversationImages(Array.from({ length: 13 }, () => image)), (error: unknown) => error instanceof ImagePreparationError && error.code === 'IMAGE_HISTORY_LIMIT');
  const largeImage = { ...image, dataUrl: `data:image/jpeg;base64,${'A'.repeat(4 * (7 * 1024 * 1024 / 3 | 0))}` };
  assert.throws(() => validateConversationImages([largeImage, largeImage, largeImage]), (error: unknown) => error instanceof ImagePreparationError && error.code === 'IMAGES_TOO_LARGE');
});
