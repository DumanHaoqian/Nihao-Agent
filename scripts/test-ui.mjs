import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

// Deterministic UI checks. No Poe credits are consumed; the running app serves its real assets.
const url = process.env.NIHAO_TEST_URL || 'http://127.0.0.1:8787';
const browser = await chromium.launch({
  headless: true,
  ...(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? { channel: 'chrome' } : {}),
});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const requests = [];
  let mode = 'success';
  let releasePending;
  await page.route('**/api/chat', async route => {
    requests.push(route.request().postDataJSON());
    if (mode === 'pending') {
      await new Promise(resolve => { releasePending = resolve; });
      await route.abort().catch(() => {});
    } else if (mode === 'error') {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"error","code":"PROVIDER_ERROR","message":"Try again"}\n\n' });
    } else {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"delta","text":"Nihao. Visit the Bund (外滩)."}\n\ndata: {"type":"done"}\n\n' });
    }
  });
  await page.goto(url);
  assert.match(await page.title(), /Nihao Agent/);
  assert.equal(await page.locator('h1').innerText(), 'China, a little closer');
  assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'A taste of Shanghai', exact: true }).click();
  assert.match(await page.locator('textarea').inputValue(), /Shanghai/);
  await page.locator('textarea').fill('First line');
  await page.locator('textarea').press('Shift+Enter');
  assert.equal(await page.locator('textarea').inputValue(), 'First line\n');
  await page.locator('textarea').fill('Visit Shanghai');
  await page.locator('textarea').press('Enter');
  await page.getByRole('button', { name: 'Copy response', exact: true }).waitFor();
  assert.equal(await page.locator('.message--assistant .message-text').innerText(), 'Nihao. Visit the Bund (外滩).');
  await page.getByRole('button', { name: 'Copy response', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Nihao. Visit the Bund (外滩).');
  await page.locator('textarea').fill('What is its Chinese name?');
  await page.locator('textarea').press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.copy-button').length === 2);
  assert.deepEqual(requests[1].messages.map(m => m.role), ['user', 'assistant', 'user']);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  assert.equal(await page.locator('.message').count(), 0);

  mode = 'error';
  await page.locator('textarea').fill('Check failure recovery');
  await page.locator('textarea').press('Enter');
  await page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
  mode = 'success';
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByRole('button', { name: 'Copy response', exact: true }).waitFor();
  assert.equal(await page.locator('.message--user').count(), 1);

  mode = 'pending';
  await page.locator('textarea').fill('A response to stop');
  await page.locator('textarea').press('Enter');
  await page.waitForFunction(() => Boolean(document.querySelector('[aria-label="Stop response"]')));
  await page.getByRole('button', { name: 'Stop response', exact: true }).click();
  await page.getByText('Response stopped', { exact: true }).waitFor();
  releasePending?.();
  assert.equal(await page.getByRole('button', { name: 'Stop response', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  mode = 'success';

  await page.getByRole('button', { name: '中文', exact: true }).click();
  assert.equal(await page.locator('h1').innerText(), '和中国，再近一点');
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('textarea').fill('你好');
  await page.locator('textarea').dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  assert.equal(await page.locator('.message').count(), 0);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByRole('button', { name: '复制回复', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.locator('textarea').isVisible(), true);
  assert.deepEqual(errors, []);
  console.log('PASS: landing, prompt starters, keyboard/IME, send, multi-turn history, copy, retry, stop, new chat, EN/中文, mobile, console');
} finally {
  await browser.close();
}
