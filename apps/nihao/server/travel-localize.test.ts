import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Place, Route, TravelArtifact } from '../shared/travel.ts'
import { detectReplyLanguage, localizeTravelArtifacts } from './maps/localize.ts'

interface InputSlot { id: string; text: string; maxLength: number }
interface Batch { language: string; strings: InputSlot[] }
function batch(options: GenerateOptions): Batch {
  const message = options.messages[0]!
  const block = message.content.find(block => block.type === 'text')
  assert.ok(block?.type === 'text')
  return JSON.parse(block.text) as Batch
}

class TranslationAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  readonly started = Promise.withResolvers<void>()
  constructor(private reply: (input: Batch) => string, private mode: 'normal' | 'truncated' | 'missing-finish' | 'wait' | 'throw' = 'normal') { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, defaultMaxTokens: 4096 })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.started.resolve()
    if (this.mode === 'throw') throw new Error('private provider error https://secret?key=do-not-leak')
    if (this.mode === 'wait') {
      await new Promise<void>(resolve => {
        if (options.signal?.aborted) resolve()
        else options.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      options.signal?.throwIfAborted()
    }
    const text = this.reply(batch(options))
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (let offset = 0; offset < text.length; offset += 17) yield { type: 'text-delta', index: 0, text: text.slice(offset, offset + 17) }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    if (this.mode !== 'missing-finish') yield { type: 'finish', reason: { kind: this.mode === 'truncated' ? 'max-tokens' : 'stop' } }
  }
}

async function setup(adapter: TranslationAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.effect(() => ctx.llm.registerAdapter(['poe'], adapter))
  return ctx
}

const garden: Place = {
  id: 'verified-garden-id', name: '豫园', address: '上海市黄浦区安仁街218号', city: '上海',
  location: { lat: 31.2271, lng: 121.4921 }, openingHours: 'Tue–Sun 09:00–16:30',
  navigationUrl: 'https://api.map.baidu.com/marker?location=31.2271%2C121.4921&title=%E8%B1%AB%E5%9B%AD',
}
const bund: Place = { ...garden, id: 'verified-bund-id', name: '外滩' }
const route: Route = {
  id: 'verified-route-id', from: garden, to: bund, mode: 'transit', minutes: 23, meters: 3100,
  steps: ['步行300米，乘坐10号线。'], navigationUrl: 'https://api.map.baidu.com/direction?mode=transit',
}
function artifacts(): TravelArtifact[] {
  return structuredClone([
    { kind: 'places', places: [garden, bund] },
    { kind: 'routes', routes: [route] },
    { kind: 'itinerary', itinerary: {
      id: 'verified-itinerary-id', title: '上海一日游', city: '上海', notes: ['营业时间尚未核验。'],
      days: [{ day: 1, date: '2027-05-10', startTime: '09:00', endTime: '11:00', stops: [{ place: bund, arrival: '09:23', departure: '10:23', visitMinutes: 60, travel: route, note: '游览60分钟。' }], returnRoute: route }],
    } },
  ])
}
const english: Record<string, string> = {
  '豫园': 'Yu Garden', '外滩': 'The Bund', '上海': 'Shanghai',
  '上海市黄浦区安仁街__NIHAO_NUM_0__号': 'No. __NIHAO_NUM_0__, Anren Street, Huangpu District, Shanghai',
  '步行__NIHAO_NUM_0__米，乘坐__NIHAO_NUM_1__号线。': 'Walk __NIHAO_NUM_0__ meters and take Metro Line __NIHAO_NUM_1__.',
  '上海一日游': 'A day in Shanghai', '营业时间尚未核验。': 'Opening hours have not been verified.',
  '游览__NIHAO_NUM_0__分钟。': 'Visit for __NIHAO_NUM_0__ minutes.',
}
const validEnglish = (input: Batch): string => JSON.stringify({ translations: input.strings.map(slot => ({ id: slot.id, text: english[slot.text] ?? slot.text })) })
const config = { model: 'gpt-5.4-mini' }
const signal = () => new AbortController().signal

test('reply language follows prose rather than UI language or bracketed destination names', () => {
  assert.equal(detectReplyLanguage('Visit Yu Garden (豫园) and the Bund (外滩). Take the metro between them.', 'zh'), 'en')
  assert.equal(detectReplyLanguage('推荐上午去豫园（Yu Garden），下午漫步外滩（The Bund），这样时间更充裕。', 'en'), 'zh')
  assert.equal(detectReplyLanguage('Visit 豫园 and 外滩.', 'zh'), 'en')
  assert.equal(detectReplyLanguage('明天去 Shanghai Disneyland 玩一天。', 'en'), 'zh')
  assert.equal(detectReplyLanguage('外滩 The Bund', 'zh'), 'zh')
  assert.equal(detectReplyLanguage('外滩 The Bund', 'en'), 'en')
  assert.equal(detectReplyLanguage('09:00–16:30', 'zh'), 'zh')
  assert.equal(detectReplyLanguage('你好', 'en'), 'zh')
  assert.equal(detectReplyLanguage('Sure!', 'zh'), 'en')
})

test('one streamed translation deduplicates display strings and preserves every raw fact', async () => {
  const adapter = new TranslationAdapter(validEnglish)
  const ctx = await setup(adapter)
  const raw = artifacts()
  const original = structuredClone(raw)
  try {
    const translated = await localizeTravelArtifacts(ctx, raw, 'en', config, signal())
    assert.deepEqual(raw, original)
    assert.equal(adapter.requests.length, 1)
    const request = adapter.requests[0]!
    assert.deepEqual(request.tools, [])
    assert.equal(request.provider, 'poe')
    assert.equal(request.model, 'gpt-5.4-mini')
    assert.ok(request.maxTokens! <= 12_000)
    const strings = batch(request).strings
    assert.equal(strings.filter(slot => slot.text === '豫园').length, 1)
    assert.doesNotMatch(JSON.stringify(strings), /verified-|navigationUrl|31\.2271|2027-05-10/)
    assert.ok(translated[0]?.kind === 'places')
    assert.equal(translated[0].places[0]!.name, 'Yu Garden')
    assert.equal(translated[0].places[0]!.address, 'No. 218, Anren Street, Huangpu District, Shanghai')
    assert.deepEqual(translated[0].places[0]!.location, garden.location)
    assert.equal(translated[0].places[0]!.navigationUrl, garden.navigationUrl)
    assert.equal(translated[0].places[0]!.openingHours, garden.openingHours)
    assert.ok(translated[1]?.kind === 'routes')
    assert.equal(translated[1].routes[0]!.steps[0], 'Walk 300 meters and take Metro Line 10.')
    assert.equal(translated[1].routes[0]!.meters, route.meters)
    assert.equal(translated[1].routes[0]!.minutes, route.minutes)
    assert.equal(translated[1].routes[0]!.mode, route.mode)
    assert.equal(translated[1].routes[0]!.id, route.id)
    assert.ok(translated[2]?.kind === 'itinerary')
    const day = translated[2].itinerary.days[0]!
    assert.equal(day.date, '2027-05-10')
    assert.equal(day.startTime, '09:00')
    assert.equal(day.stops[0]!.arrival, '09:23')
    assert.equal(day.stops[0]!.departure, '10:23')
    assert.equal(day.stops[0]!.visitMinutes, 60)
    assert.equal(day.stops[0]!.note, 'Visit for 60 minutes.')
    translated[0].places[0]!.name = 'display-only mutation'
    assert.deepEqual(raw, original)
  } finally { await ctx.fiber.dispose() }
})

test('Chinese localizes weekdays and English notes while allowing established Latin brands', async () => {
  const input: TravelArtifact[] = [{ kind: 'places', places: [{ ...garden, name: 'IKEA', address: '上海市', openingHours: 'Tue–Sun 09:00–16:30' }] }]
  const adapter = new TranslationAdapter(input => JSON.stringify({ translations: input.strings.map(slot => ({ id: slot.id, text: slot.text === 'IKEA' ? 'IKEA' : '周二至周日 __NIHAO_NUM_0__–__NIHAO_NUM_1__' })) }))
  const ctx = await setup(adapter)
  try {
    const result = await localizeTravelArtifacts(ctx, input, 'zh', config, signal())
    assert.ok(result[0]?.kind === 'places')
    assert.equal(result[0].places[0]!.name, 'IKEA')
    assert.equal(result[0].places[0]!.openingHours, '周二至周日 09:00–16:30')
    assert.equal(result[0].places[0]!.address, '上海市')
    assert.equal(batch(adapter.requests[0]!).strings.length, 2)
  } finally { await ctx.fiber.dispose() }
})

test('already localized cards skip an extra model call but still return detached copies', async () => {
  const adapter = new TranslationAdapter(() => { throw new Error('Unexpected translation request') })
  const ctx = await setup(adapter)
  try {
    const input: TravelArtifact[] = [{ kind: 'places', places: [{ ...garden, name: 'Yu Garden', address: '218 Anren Street', city: 'Shanghai' }] }]
    const output = await localizeTravelArtifacts(ctx, input, 'en', config, signal())
    assert.deepEqual(output, input)
    assert.notEqual(output, input)
    assert.equal(adapter.requests.length, 0)
  } finally { await ctx.fiber.dispose() }
})

test('Chinese translations reject untranslated English sentences and weekday labels', async () => {
  const adapter = new TranslationAdapter(input => JSON.stringify({ translations: input.strings.map(slot => ({ id: slot.id, text: slot.text })) }))
  const ctx = await setup(adapter)
  try {
    await assert.rejects(localizeTravelArtifacts(ctx, [{ kind: 'places', places: [garden] }], 'zh', config, signal()), { code: 'TRAVEL_TRANSLATION_FAILED' })
    const input = artifacts()
    assert.ok(input[2]?.kind === 'itinerary')
    input[2].itinerary.notes = ['Opening hours have not been verified.']
    for (const artifact of input) {
      if (artifact.kind === 'places') artifact.places.forEach(place => { place.openingHours = '09:00–16:30' })
    }
    await assert.rejects(localizeTravelArtifacts(ctx, input, 'zh', config, signal()), { code: 'TRAVEL_TRANSLATION_FAILED' })
  } finally { await ctx.fiber.dispose() }
})

test('invalid JSON, missing/unknown/duplicate slots and hidden extra fields fail closed', async () => {
  const cases: ((input: Batch) => string)[] = [
    () => 'Here is the translation: nope',
    input => `\`\`\`json\n${validEnglish(input)}\n\`\`\``,
    input => JSON.stringify({ translations: JSON.parse(validEnglish(input)).translations.slice(1) }),
    input => JSON.stringify({ translations: JSON.parse(validEnglish(input)).translations.map((row: { id: string; text: string }, index: number) => index ? row : { ...row, id: 'unknown' }) }),
    input => JSON.stringify({ translations: JSON.parse(validEnglish(input)).translations.map((row: { id: string; text: string }, index: number) => index ? row : { ...row, id: 's1' }) }),
    input => JSON.stringify({ ...JSON.parse(validEnglish(input)), route: { minutes: 1 } }),
    input => JSON.stringify({ translations: JSON.parse(validEnglish(input)).translations.map((row: object) => ({ ...row, location: [0, 0] })) }),
  ]
  for (const reply of cases) {
    const ctx = await setup(new TranslationAdapter(reply))
    try { await assert.rejects(localizeTravelArtifacts(ctx, artifacts(), 'en', config, signal()), { code: 'TRAVEL_TRANSLATION_FAILED' }) }
    finally { await ctx.fiber.dispose() }
  }
})

test('numeric tokens cannot be dropped, duplicated, changed, or supplemented with invented digits', async () => {
  for (const alteration of ['218', '__NIHAO_NUM_99__', '__NIHAO_NUM_0____NIHAO_NUM_0__', '__NIHAO_NUM_0__ and 999']) {
    const adapter = new TranslationAdapter(input => validEnglish(input).replace('__NIHAO_NUM_0__', alteration))
    const ctx = await setup(adapter)
    try { await assert.rejects(localizeTravelArtifacts(ctx, artifacts(), 'en', config, signal()), { code: 'TRAVEL_TRANSLATION_FAILED' }) }
    finally { await ctx.fiber.dispose() }
  }
})

test('one bounded repair recovers bad JSON, missing slots, or rewritten numbers without changing source facts', async () => {
  const invalidReplies: ((input: Batch) => string)[] = [
    () => 'Not valid JSON',
    input => JSON.stringify({ translations: JSON.parse(validEnglish(input)).translations.slice(1) }),
    input => validEnglish(input).replace('__NIHAO_NUM_0__', '218'),
  ]
  for (const invalid of invalidReplies) {
    let attempts = 0
    const adapter = new TranslationAdapter(input => ++attempts === 1 ? invalid(input) : validEnglish(input))
    const ctx = await setup(adapter)
    const input = artifacts(), original = structuredClone(input)
    try {
      const translated = await localizeTravelArtifacts(ctx, input, 'en', config, signal())
      assert.ok(translated[0]?.kind === 'places')
      assert.equal(translated[0].places[0]!.name, 'Yu Garden')
      assert.deepEqual(input, original)
      assert.equal(adapter.requests.length, 2)
      assert.deepEqual(batch(adapter.requests[0]!), batch(adapter.requests[1]!))
      assert.ok(adapter.requests[1]!.maxTokens! > adapter.requests[0]!.maxTokens!)
      assert.ok(adapter.requests[1]!.maxTokens! <= 12_000)
      assert.match(adapter.requests[1]!.system!, /A prior translation failed validation/)
      assert.deepEqual(adapter.requests[1]!.tools, [])
    } finally { await ctx.fiber.dispose() }
  }
})

test('two invalid translations fail with the original safe error and never attempt a third call', async () => {
  const adapter = new TranslationAdapter(() => 'not JSON')
  const ctx = await setup(adapter)
  const input = artifacts(), original = structuredClone(input)
  try {
    await assert.rejects(localizeTravelArtifacts(ctx, input, 'en', config, signal()), { code: 'TRAVEL_TRANSLATION_FAILED' })
    assert.equal(adapter.requests.length, 2)
    assert.deepEqual(input, original)
  } finally { await ctx.fiber.dispose() }
})

test('English translations reject Han leftovers, overlong fields, and provider failure details', async () => {
  for (const replacement of ['Yu Garden（豫园）', 'x'.repeat(301)]) {
    const adapter = new TranslationAdapter(input => validEnglish(input).replace('Yu Garden', replacement))
    const ctx = await setup(adapter)
    try { await assert.rejects(localizeTravelArtifacts(ctx, artifacts(), 'en', config, signal()), { code: 'TRAVEL_TRANSLATION_FAILED' }) }
    finally { await ctx.fiber.dispose() }
  }
  const failedAdapter = new TranslationAdapter(validEnglish, 'throw')
  const ctx = await setup(failedAdapter)
  try {
    await assert.rejects(localizeTravelArtifacts(ctx, artifacts(), 'en', config, signal()), error => {
      assert.equal((error as { code: string }).code, 'TRAVEL_TRANSLATION_FAILED')
      assert.doesNotMatch(String(error), /private|secret|do-not-leak/)
      return true
    })
    assert.equal(failedAdapter.requests.length, 1)
  } finally { await ctx.fiber.dispose() }
})

test('truncated or unterminated streams cannot produce successful map cards', async () => {
  for (const mode of ['truncated', 'missing-finish'] as const) {
    const adapter = new TranslationAdapter(validEnglish, mode)
    const ctx = await setup(adapter)
    try {
      await assert.rejects(localizeTravelArtifacts(ctx, artifacts(), 'en', config, signal()), { code: 'TRAVEL_TRANSLATION_FAILED' })
      assert.equal(adapter.requests.length, 1)
    }
    finally { await ctx.fiber.dispose() }
  }
})

test('cancellation propagates into the translation stream and preserves the original artifacts', async () => {
  const adapter = new TranslationAdapter(validEnglish, 'wait')
  const ctx = await setup(adapter)
  const controller = new AbortController()
  const input = artifacts(), original = structuredClone(input)
  try {
    const running = localizeTravelArtifacts(ctx, input, 'en', config, controller.signal)
    await adapter.started.promise
    controller.abort()
    await assert.rejects(running, { name: 'AbortError' })
    assert.equal(adapter.requests[0]!.signal?.aborted, true)
    assert.deepEqual(input, original)
    await assert.rejects(localizeTravelArtifacts(ctx, input, 'en', config, controller.signal), { name: 'AbortError' })
    assert.equal(adapter.requests.length, 1)
  } finally { await ctx.fiber.dispose() }
})

test('single-call source/token budgets reject oversized work before issuing a model request', async () => {
  const adapter = new TranslationAdapter(validEnglish)
  const ctx = await setup(adapter)
  try {
    const input: TravelArtifact[] = [{ kind: 'places', places: Array.from({ length: 40 }, (_, index) => ({ ...garden, id: `place-${index}`, name: `景点${index}`, address: `${'长'.repeat(500)}${index}` })) }]
    await assert.rejects(localizeTravelArtifacts(ctx, input, 'en', config, signal()), { code: 'TRAVEL_TRANSLATION_FAILED' })
    assert.equal(adapter.requests.length, 0)
  } finally { await ctx.fiber.dispose() }
})
