import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmAdapter, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { createHarnessRunner } from './harness.ts'
import { readConfig } from './config.ts'
import { parseChatRequest } from './protocol.ts'
import { createNihaoServer } from './http.ts'
import { ChatError } from './errors.ts'
import type { BaiduClient } from './maps/baidu.ts'
import type { Place, TravelEvent } from '../shared/travel.ts'

const place: Place = { id: 'verified-test-place', name: '测试地点', address: '上海市测试地址', location: { lat: 31.24, lng: 121.49 }, navigationUrl: 'https://api.map.baidu.com/marker?output=html' }
const config = { ...readConfig({}), configured: true, mapsConfigured: true }

class MapAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  constructor(private readonly callTool = true) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { return Promise.resolve({ provider, id: model, name: model }) }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.callTool && this.requests.length === 1) {
      const id = ToolCallId('map-test-call')
      const args = JSON.stringify({ query: '测试地点', city: '上海' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'search_places', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'search_places', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Found ' }
    yield { type: 'text-delta', index: 0, text: 'the place.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Found the place.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function fakeClient(search: BaiduClient['search'] = async () => [place]): BaiduClient {
  return { search, details: async p => p, route: async () => { throw new Error('unused') }, matrix: async () => [], close: async () => {} }
}

test('Harness executes a map tool, replays the result to the model, and retains verified facts for edits', async () => {
  const adapter = new MapAdapter()
  let opens = 0
  let closes = 0
  let translated = false
  const run = createHarnessRunner(config, adapter, {
    createClient: async () => { opens++; return { ...fakeClient(), close: async () => { closes++ } } },
    localize: async (_ctx, artifacts, language) => {
      assert.equal(language, 'en', 'map language follows the English reply, even with a Chinese interface')
      translated = true
      return artifacts.map(artifact => artifact.kind === 'places' ? { ...artifact, places: artifact.places.map(p => ({ ...p, name: 'Test place', address: 'Shanghai test address' })) } : artifact)
    },
  })
  const events: TravelEvent[] = []
  const chunks: string[] = []
  await run(parseChatRequest({ locale: 'zh', messages: [{ role: 'user', content: 'Find a place in Shanghai' }] }), text => chunks.push(text), new AbortController().signal, event => events.push(event))
  assert.deepEqual(chunks, ['Found ', 'the place.'])
  assert.equal(opens, 1)
  assert.equal(closes, 1)
  assert.match(JSON.stringify(adapter.requests[1]!.messages), /verified-test-place/)
  assert.ok(events.some(event => event.type === 'artifact' && event.artifact.kind === 'places'))
  assert.equal(translated, true)
  assert.ok(events.some(event => event.type === 'response-language' && event.language === 'en'))
  const published = events.find(event => event.type === 'artifact')
  assert.ok(published?.type === 'artifact' && published.artifact.kind === 'places')
  assert.equal(published.artifact.places[0]!.name, 'Test place')
  const session = events.find(event => event.type === 'travel-session')!
  assert.equal(session.type, 'travel-session')
  await run(parseChatRequest({ travelSession: session.id, messages: [{ role: 'user', content: 'Use that place for my next trip' }] }), () => {}, new AbortController().signal)
  assert.match(JSON.stringify(adapter.requests[2]!.messages[0]), /verified-test-place/)
  assert.match(JSON.stringify(adapter.requests[2]!.messages[0]), /测试地点/, 'stored facts retain their original provider names')
  assert.equal(opens, 1, 'a follow-up without map tool calls must not create an MCP connection')
})

test('translation failure publishes no mixed-language cards and does not commit the new map facts', async () => {
  const adapter = new MapAdapter()
  const run = createHarnessRunner(config, adapter, {
    createClient: async () => fakeClient(),
    localize: async () => { throw new ChatError('TRAVEL_TRANSLATION_FAILED', 'Map translation could not finish.') },
  })
  const events: TravelEvent[] = []
  await assert.rejects(run(parseChatRequest({ messages: [{ role: 'user', content: 'Find a place' }] }), () => {}, new AbortController().signal, event => events.push(event)), (error: unknown) => error instanceof ChatError && error.code === 'TRAVEL_TRANSLATION_FAILED')
  assert.equal(events.some(event => event.type === 'artifact'), false)
  const session = events.find(event => event.type === 'travel-session')!
  assert.equal(session.type, 'travel-session')
  await run(parseChatRequest({ travelSession: session.id, messages: [{ role: 'user', content: 'Hello' }] }), () => {}, new AbortController().signal)
  assert.doesNotMatch(JSON.stringify(adapter.requests.at(-1)!.messages[0]), /verified-test-place/)
})

test('cancelling during a map lookup aborts upstream and leaves no new stored map facts', async () => {
  const adapter = new MapAdapter()
  const controller = new AbortController()
  let upstreamAborted = false
  const run = createHarnessRunner(config, adapter, { createClient: async signal => fakeClient(async () => {
    controller.abort()
    upstreamAborted = signal.aborted
    signal.throwIfAborted()
    return [place]
  }) })
  const events: TravelEvent[] = []
  await assert.rejects(run(parseChatRequest({ messages: [{ role: 'user', content: 'Look up a place' }] }), () => {}, controller.signal, event => events.push(event)), { name: 'AbortError' })
  assert.equal(upstreamAborted, true)
  const session = events.find(event => event.type === 'travel-session')!
  assert.equal(session.type, 'travel-session')
  await run(parseChatRequest({ travelSession: session.id, messages: [{ role: 'user', content: 'Hello again' }] }), () => {}, new AbortController().signal)
  assert.doesNotMatch(JSON.stringify(adapter.requests.at(-1)!.messages[0]), /verified-test-place/)
})

test('HTTP carries map progress and artifacts over the same text stream without provider credentials', async () => {
  const app = createNihaoServer(config, async (_request, onText, _signal, onTravelEvent) => {
    onTravelEvent?.({ type: 'tool-status', tool: 'search', status: 'running' })
    onTravelEvent?.({ type: 'artifact', artifact: { kind: 'places', places: [place] } })
    onText('Verified place')
  })
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Find a place' }] }) })
    const output = await response.text()
    assert.match(output, /"type":"tool-status"/)
    assert.match(output, /"type":"artifact"/)
    assert.match(output, /"type":"delta"/)
    assert.match(output, /"type":"done"/)
    assert.doesNotMatch(output, /API_KEY|mcp\.map\.baidu/)
  } finally { await app.shutdown() }
})

test('chat rejects malformed travel capability tokens before model work', () => {
  for (const travelSession of [null, {}, 'guessable', '<script>']) {
    assert.throws(() => parseChatRequest({ travelSession, messages: [{ role: 'user', content: 'Hello' }] }), /travel session/)
  }
})
