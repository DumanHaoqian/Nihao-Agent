import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Message, type DisplayMessage } from './components/Message.tsx';
import type { Locale } from './copy.ts';

function renderMessage(message: Partial<DisplayMessage>, locale: Locale): string {
  return renderToStaticMarkup(createElement(Message, {
    message: { id: 'reply', role: 'assistant', content: 'A useful streamed answer.', status: 'complete', ...message },
    locale, canRetry: true, canReplay: false,
    onRetry() {}, onSpeak() {}, onStopSpeech() {},
  }));
}

const place = {
  id: 'bund', name: 'The Bund', address: 'Zhongshan East 1st Road, Shanghai',
  location: { lat: 31.24, lng: 121.49 },
  navigationUrl: 'https://api.map.baidu.com/marker?location=31.24,121.49&output=html',
};

test('completed map labels keep the reply language when interface language changes', () => {
  const message: Partial<DisplayMessage> = {
    responseLanguage: 'en',
    travel: [{ kind: 'routes', routes: [{ id: 'walk', from: place, to: { ...place, id: 'garden', name: 'Yu Garden' }, mode: 'walking', minutes: 15, meters: 1000, steps: ['Walk along the river.'], navigationUrl: '' }] }],
  };
  for (const locale of ['en', 'zh'] as const) {
    const html = renderMessage(message, locale);
    assert.match(html, /class="travel-artifacts" lang="en"/);
    for (const text of ['Route options', 'Walking', '15 min', '1.0 km', 'Directions', 'Walk along the river.']) assert.ok(html.includes(text));
    for (const text of ['路线方案', '步行', '分钟', '公里', '路线详情']) assert.equal(html.includes(text), false);
  }
});

test('Chinese map links and headings stay Chinese on the English interface', () => {
  const html = renderMessage({ responseLanguage: 'zh', travel: [{ kind: 'places', places: [{ ...place, name: '外滩', address: '上海市黄浦区中山东一路' }] }] }, 'en');
  assert.match(html, /class="travel-artifacts" lang="zh-CN"/);
  for (const text of ['找到的地点', '在百度地图打开', '地点及预计交通耗时来自百度地图']) assert.ok(html.includes(text));
  assert.equal(html.includes('Open in Baidu Maps'), false);
});

test('translation progress and failure use the reply language while preserving answer text', () => {
  const message: Partial<DisplayMessage> = { responseLanguage: 'en', travel: [{ kind: 'places', places: [place] }] };
  const waiting = renderMessage({ ...message, status: 'streaming', toolStatus: { type: 'tool-status', tool: 'translate', status: 'running' } }, 'zh');
  assert.ok(waiting.includes('Preparing English directions…'));
  assert.equal(waiting.includes('class="travel-artifacts"'), false);
  const failed = renderMessage({ ...message, status: 'error', errorCode: 'TRAVEL_TRANSLATION_FAILED' }, 'zh');
  assert.ok(failed.includes('A useful streamed answer.'));
  assert.ok(failed.includes('The map details could not be prepared in English. Please try again'));
  assert.ok(failed.includes('Try again'));
  assert.equal(failed.includes('class="travel-artifacts"'), false);
  assert.equal(failed.includes('travel-tool-status'), false);
});
