import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeTravelArtifact, parseTravelEvent, safeBaiduNavigationUrl } from './travel.ts';
import type { Place, TravelArtifact } from '../../shared/travel.ts';

function samplePlace(id = 'bund'): Place {
  return { id, name: '外滩', address: '上海市黄浦区中山东一路', city: '上海市', location: { lat: 31.24, lng: 121.49 }, navigationUrl: 'https://api.map.baidu.com/marker?location=31.24%2C121.49&title=%E5%A4%96%E6%BB%A9&output=html&src=Nihao' };
}

test('navigation links allow only known Baidu map endpoints without redirects or credentials', () => {
  assert.ok(safeBaiduNavigationUrl(samplePlace().navigationUrl));
  assert.ok(safeBaiduNavigationUrl('https://api.map.baidu.com/direction?origin=31,121&destination=32,122&mode=walking&output=html'));
  for (const value of [
    'javascript:alert(1)', 'https://api.map.baidu.com.evil.test/marker', 'https://evil.test/marker',
    'https://api.map.baidu.com@evil.test/marker', 'https://user:password@api.map.baidu.com/marker',
    'http://api.map.baidu.com/marker', 'https://api.map.baidu.com:9999/marker',
    'https://api.map.baidu.com/redirect?url=https://evil.test',
    'https://api.map.baidu.com/marker?redirect=https://evil.test', 'https://api.map.baidu.com/marker?ak=credential',
    'https://api.map.baidu.com/marker#script', 'https://api.map.baidu.com/%2Fmarker',
  ]) assert.equal(safeBaiduNavigationUrl(value), undefined);
});

test('travel validation keeps plain provider text but removes untrusted links and rejects malformed facts', () => {
  const parsed = parseTravelEvent({ type: 'artifact', artifact: { kind: 'places', places: [{ ...samplePlace(), name: '<script>untrusted text</script>', navigationUrl: 'javascript:alert(1)' }] } });
  assert.equal(parsed?.type, 'artifact');
  if (parsed?.type !== 'artifact' || parsed.artifact.kind !== 'places') throw new Error('Missing place artifact');
  assert.equal(parsed.artifact.places[0]!.name, '<script>untrusted text</script>');
  assert.equal(parsed.artifact.places[0]!.navigationUrl, '');
  assert.throws(() => parseTravelEvent({ type: 'artifact', artifact: { kind: 'places', places: [{ ...samplePlace(), location: { lat: 91, lng: 121 } }] } }));
  assert.throws(() => parseTravelEvent({ type: 'artifact', artifact: { kind: 'itinerary', itinerary: { id: 'i', title: 'Trip', city: '上海', days: [], notes: [] } } }));
  assert.throws(() => parseTravelEvent({ type: 'tool-status', tool: 'shell', status: 'running' }));
});

test('reply language is validated independently of the interface locale', () => {
  for (const language of ['en', 'zh']) assert.deepEqual(parseTravelEvent({ type: 'response-language', language }), { type: 'response-language', language });
  for (const language of [undefined, '', 'EN', 'zh-CN', 'fr', { value: 'en' }]) assert.throws(() => parseTravelEvent({ type: 'response-language', language }));
  assert.deepEqual(parseTravelEvent({ type: 'tool-status', tool: 'translate', status: 'running' }), { type: 'tool-status', tool: 'translate', status: 'running' });
});

test('repeated searches keep the latest facts with twelve-place limits instead of duplicate cards', () => {
  let artifacts: TravelArtifact[] = [{ kind: 'places', places: Array.from({ length: 12 }, (_, i) => samplePlace(String(i))) }];
  artifacts = mergeTravelArtifact(artifacts, { kind: 'places', places: [{ ...samplePlace('5'), address: 'Updated address' }, samplePlace('12')] });
  const places = artifacts.find(artifact => artifact.kind === 'places');
  assert.equal(places?.places.length, 12);
  assert.equal(places?.places.find(place => place.id === '5')?.address, 'Updated address');
  assert.equal(places?.places.filter(place => place.id === '5').length, 1);
  assert.equal(places?.places.some(place => place.id === '0'), false);
  const plan = { id: 'p1', title: 'One day', city: 'Shanghai', days: [], notes: [] };
  artifacts = mergeTravelArtifact(artifacts, { kind: 'itinerary', itinerary: plan });
  artifacts = mergeTravelArtifact(artifacts, { kind: 'itinerary', itinerary: { ...plan, id: 'p2', title: 'Revised day' } });
  assert.equal(artifacts.filter(artifact => artifact.kind === 'itinerary').length, 1);
  assert.equal(artifacts.find(artifact => artifact.kind === 'itinerary')?.itinerary.id, 'p2');
});
