import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import sharp from 'sharp';

// All model replies in this test are mocked. Uploads exercise the real browser image pipeline.
const url = process.env.NIHAO_TEST_URL || 'http://127.0.0.1:8787';
const png = await sharp({ create: { width: 96, height: 64, channels: 3, background: '#2875d8' } }).png().toBuffer();
const upload = { name: 'photo.png', mimeType: 'image/png', buffer: png };
const browser = await chromium.launch({ headless: true, ...(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? { channel: 'chrome' } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/chat', async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"delta","text":"The uploaded picture is blue."}\n\ndata: {"type":"done"}\n\n' });
  });
  await page.goto(url);
  const input = page.locator('input[type="file"]');
  await input.setInputFiles(upload);
  await page.getByRole('button', { name: 'Remove image: photo.png', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Send message"]').disabled);
  assert.equal(await page.locator('textarea').inputValue(), '');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Copy response', exact: true }).waitFor();
  assert.equal(requests[0].messages[0].content, '');
  assert.equal(requests[0].messages[0].images.length, 1);
  assert.match(requests[0].messages[0].images[0].dataUrl, /^data:image\/(jpeg|png|webp);base64,/);
  await page.getByRole('button', { name: 'View image: photo.jpg', exact: true }).click();
  assert.equal(await page.getByRole('dialog', { name: 'Image preview' }).isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog', { name: 'Image preview' }).isVisible(), false);
  await page.locator('textarea').fill('What color was the same picture?');
  await page.locator('textarea').press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.copy-button').length === 2);
  assert.equal(requests[1].messages[0].images[0].dataUrl, requests[0].messages[0].images[0].dataUrl);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();

  await input.setInputFiles(upload);
  await page.getByRole('button', { name: 'Remove image: photo.png', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Remove image: photo.png', exact: true }).click();
  assert.equal(await page.locator('.draft-image').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);

  await input.setInputFiles({ name: 'video.mp4', mimeType: 'video/mp4', buffer: Buffer.from('not supported') });
  await page.getByRole('alert').first().waitFor();
  assert.equal(await page.locator('.draft-image').count(), 0);

  await page.getByRole('button', { name: 'Nihao Agent — New chat', exact: true }).click();
  await input.setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
  await page.getByRole('alert').first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Remove image: broken.png', exact: true }).click();

  // Clipboard upload uses the same validation and normalization as the picker.
  await page.locator('textarea').evaluate((element, bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], 'pasted.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, [...png]);
  await page.getByRole('button', { name: 'Remove image: pasted.png', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Send message"]').disabled);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Copy response', exact: true }).waitFor();
  await page.getByRole('button', { name: 'View image: pasted.jpg', exact: true }).click();
  assert.equal(await page.getByRole('dialog', { name: 'Image preview' }).isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('button', { name: 'Close image', exact: true }).click();
  assert.deepEqual(errors, []);
  console.log('PASS: image picker, image-only send, preview/remove, enlarged view/Escape, image history, invalid/corrupt file, clipboard paste, mobile');
} finally {
  await browser.close();
}
