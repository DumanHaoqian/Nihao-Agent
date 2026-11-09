import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBaiduClient, MapsError } from './maps/baidu.ts'
import { readConfig } from './config.ts'

const key = 'test-key-never-public'
const names = ['map_search_places', 'map_place_details', 'map_directions', 'map_directions_matrix']
const poi = { uid: '606289fda2cbca54a2046453', name: '豫园', address: '上海市黄浦区福佑路168号', city: '上海市', location: { lat: 31.232745, lng: 121.498966 }, detail_info: { shop_hours: '09:00-16:30', regular_open_hour: { periods: [{ open: { day: 2, hour: 9, minute: 0 }, close: { day: 2, hour: 16, minute: 30 } }] } } }
type Call = { name: string; arguments: Record<string, unknown> }
function mockProvider(handler: (call: Call, signal: AbortSignal) => unknown | Promise<unknown>) {
  const calls: Call[] = []
  const fetcher: typeof fetch = async (_input, options) => {
    if (options?.method === 'GET') return new Response('', { status: 405 })
    const request = JSON.parse(String(options?.body))
    if (request.id === undefined) return new Response(null, { status: 202 })
    let result: unknown
    if (request.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test-baidu', version: '1' } }
    else if (request.method === 'tools/list') result = { tools: names.map(name => ({ name, inputSchema: { type: 'object' } })) }
    else {
      const call = request.params as Call
      calls.push(call)
      const value = await handler(call, options!.signal!)
      result = { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'Content-Type': 'application/json' } })
  }
  return { fetcher, calls }
}

test('Baidu normalizes real POI shapes, preserves weekday hours, and creates credential-free navigation links', async () => {
  const provider = mockProvider(call => call.name === 'map_search_places'
    ? { status: 0, results: [poi, { ...poi, uid: 'invalid-coordinate', location: { lat: 91, lng: 121 } }] }
    : { status: 0, result: { ...poi, detail_url: `https://example.test/?ak=${key}` } })
  const client = await createBaiduClient(new AbortController().signal, { apiKey: key, fetch: provider.fetcher })
  try {
    const places = await client.search('豫园', '上海市')
    assert.equal(places.length, 1)
    assert.equal(places[0]!.id, poi.uid)
    assert.equal(places[0]!.openingHours, 'Tue 09:00–16:30')
    assert.equal(new URL(places[0]!.navigationUrl).searchParams.get('coord_type'), 'bd09ll')
    assert.equal(new URL(places[0]!.navigationUrl).origin, 'https://api.map.baidu.com')
    const detail = await client.details(places[0]!)
    assert.equal(detail.id, poi.uid)
    assert.ok(!JSON.stringify(detail).includes(key))
    assert.deepEqual(provider.calls[0]!.arguments, { query: '豫园', region: '上海市', is_chinese_mainland: 'true' })
  } finally { await client.close() }
})

test('opening hours compact only consecutive days with identical same-day times', async () => {
  const period = (day: number, start = 9, end = 16, closeDay = day) => ({ open: { day, hour: start, minute: 0 }, close: { day: closeDay, hour: end, minute: 30 } })
  const cases = [
    { periods: [2, 3, 4, 5, 6, 0].map(day => period(day)), expected: 'Tue–Sun 09:00–16:30' },
    { periods: [period(2), period(3), period(5), period(0)], expected: 'Tue–Wed 09:00–16:30; Fri 09:00–16:30; Sun 09:00–16:30' },
    { periods: [period(2), period(3, 10), period(4, 10)], expected: 'Tue 09:00–16:30; Wed–Thu 10:00–16:30' },
    { periods: [period(2, 22, 6, 3), period(3, 22, 6, 4)], expected: 'Tue 22:00–Wed 06:30; Wed 22:00–Thu 06:30' },
    { periods: [period(2, 22, 6), period(3, 22, 6)], expected: 'Tue 22:00–Tue 06:30; Wed 22:00–Wed 06:30' },
    { periods: [period(2, 9, 11), period(2, 13, 16), period(3)], expected: 'Tue 09:00–Tue 11:30; Tue 13:00–Tue 16:30; Wed 09:00–Wed 16:30' },
  ]
  const provider = mockProvider(() => ({ status: 0, results: cases.map((item, index) => ({ ...poi, uid: `${poi.uid}-${index}`, detail_info: { regular_open_hour: { periods: item.periods } } })) }))
  const client = await createBaiduClient(new AbortController().signal, { apiKey: key, fetch: provider.fetcher })
  try {
    const places = await client.search('豫园', '上海市')
    assert.deepEqual(places.map(place => place.openingHours), cases.map(item => item.expected))
    assert.ok(!places[0]!.openingHours!.includes('Mon'))
  } finally { await client.close() }
})

test('Baidu distinguishes transit alternatives from consecutive steps and retains route units', async () => {
  const provider = mockProvider(call => call.name === 'map_search_places' ? { status: 0, results: [poi] } : { status: 0, result: { routes: [{ distance: 3177, duration: 1896, steps: [[{ instruction: '<b>步行</b>233米' }], [{ instruction: '乘旅游2线' }, { instruction: '另一个可选公交' }], [{ instruction: '步行276米' }]] }] } })
  const client = await createBaiduClient(new AbortController().signal, { apiKey: key, fetch: provider.fetcher })
  try {
    const [origin] = await client.search('豫园', '上海市')
    const route = await client.route(origin!, { ...origin!, id: '5c2dc21dd3dcd2056ec02cab', location: { lat: 31.238549, lng: 121.499318 } }, 'transit')
    assert.equal(route.meters, 3177)
    assert.equal(route.minutes, 32)
    assert.deepEqual(route.steps, ['步行233米', '乘旅游2线', '步行276米'])
    assert.equal(provider.calls[1]!.arguments.origin, '31.232745,121.498966')
    assert.ok(!route.navigationUrl.includes(key))
  } finally { await client.close() }
})

test('invalid provider data and provider exceptions fail closed without leaking secrets', async () => {
  for (const value of [{ status: 0, results: [{ ...poi, uid: 'bad uid' }] }, { status: 302, message: `https://mcp.map.baidu.com/mcp?ak=${key}` }, new Error(`private error ${key}`)]) {
    const provider = mockProvider(() => { if (value instanceof Error) throw value; return value })
    const client = await createBaiduClient(new AbortController().signal, { apiKey: key, fetch: provider.fetcher })
    try {
      await assert.rejects(client.search('豫园', '上海市'), error => error instanceof MapsError && !String(error).includes(key))
    } finally { await client.close() }
  }
})

test('empty route results never become zero-minute fake routes', async () => {
  const provider = mockProvider(call => call.name === 'map_search_places' ? { status: 0, results: [poi] } : { status: 0, result: { routes: [] } })
  const client = await createBaiduClient(new AbortController().signal, { apiKey: key, fetch: provider.fetcher })
  try {
    const [place] = await client.search('豫园', '上海市')
    await assert.rejects(client.route(place!, place!, 'walking'), error => error instanceof MapsError && error.code === 'MAPS_NO_ROUTE')
  } finally { await client.close() }
})

test('cancelling and timing out a tool call aborts the real fetch signal', async () => {
  for (const cancel of [true, false]) {
    let abortObserved = false
    let started!: () => void
    const waiting = new Promise<void>(resolve => { started = resolve })
    const provider = mockProvider((_call, signal) => new Promise((_resolve, reject) => {
      started()
      signal.addEventListener('abort', () => { abortObserved = true; reject(new Error(`upstream ${key}`)) }, { once: true })
    }))
    const controller = new AbortController()
    const client = await createBaiduClient(controller.signal, { apiKey: key, fetch: provider.fetcher, timeoutMs: 40 })
    try {
      const pending = client.search('豫园', '上海市')
      await waiting
      if (cancel) controller.abort()
      await assert.rejects(pending, error => cancel ? error instanceof DOMException && error.name === 'AbortError' : error instanceof MapsError && error.code === 'MAPS_TIMEOUT')
      assert.equal(abortObserved, true)
    } finally { await client.close() }
  }
})

test('walking matrices split actual requests at the 50-pair provider limit and map each result to its IDs', async () => {
  const provider = mockProvider(call => {
    if (call.name === 'map_search_places') return { status: 0, results: [poi] }
    const origins = String(call.arguments.origins).split('|'), destinations = String(call.arguments.destinations).split('|')
    return { status: 0, result: origins.flatMap(() => destinations.map(() => ({ distance: { value: 100 }, duration: { value: 120 } }))) }
  })
  const client = await createBaiduClient(new AbortController().signal, { apiKey: key, fetch: provider.fetcher })
  try {
    const [base] = await client.search('豫园', '上海市')
    const places = Array.from({ length: 8 }, (_, index) => ({ ...base!, id: `provider-id-${index}` }))
    const legs = await client.matrix!(places, 'walking')
    assert.equal(legs.length, 64)
    assert.equal(legs[8]!.fromId, places[1]!.id)
    assert.equal(legs[8]!.toId, places[0]!.id)
    assert.equal(provider.calls.filter(call => call.name === 'map_directions_matrix').length, 2)
    assert.equal(String(provider.calls[1]!.arguments.origins).split('|').length * 8, 48)
    assert.equal(String(provider.calls[2]!.arguments.origins).split('|').length * 8, 16)
  } finally { await client.close() }
})

test('map configuration exposes only availability and ignores blank keys', () => {
  assert.equal(readConfig({ BAIDU_MAP_API_KEY: '  ' }).mapsConfigured, false)
  const config = readConfig({ BAIDU_MAP_API_KEY: key })
  assert.equal(config.mapsConfigured, true)
  assert.ok(!JSON.stringify(config).includes(key))
})
