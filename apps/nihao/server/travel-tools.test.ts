import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Place, Route, TravelEvent, TravelMode } from '../shared/travel.ts'
import type { BaiduClient } from './maps/baidu.ts'
import { registerTravelTools } from './maps/travel-tools.ts'
import { TRAVEL_LIMITS, type TravelState } from './maps/travel-store.ts'

const hotel: Place = { id: 'hotel', name: 'Hotel', address: 'Shanghai', location: { lat: 31.21, lng: 121.42 }, navigationUrl: 'https://map.baidu.com/' }
const garden: Place = { ...hotel, id: 'garden', name: 'Yu Garden', location: { lat: 31.22, lng: 121.49 }, openingHours: '09:00–16:30' }
const museum: Place = { ...hotel, id: 'museum', name: 'Shanghai Museum', location: { lat: 31.23, lng: 121.47 } }

async function fixture(overrides: Partial<BaiduClient> = {}, locale: 'en' | 'zh' = 'en') {
  const controller = new AbortController()
  const calls: { from: string; to: string; mode: TravelMode }[] = []
  const events: TravelEvent[] = []
  const state: TravelState = { places: {}, routes: [] }
  const provider: BaiduClient = {
    search: async () => [hotel, garden, museum],
    details: async place => place,
    route: async (from, to, mode) => {
      calls.push({ from: from.id, to: to.id, mode })
      return { id: `${from.id}-${to.id}`, from, to, mode, minutes: 20, meters: 1000, steps: ['Take the verified route'], navigationUrl: 'https://map.baidu.com/' }
    },
    matrix: async () => [],
    close: async () => {},
    ...overrides,
  }
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
  await ctx.plugin(ToolRuntime)
  registerTravelTools(ctx, state, provider, event => events.push(event), controller.signal, locale)
  return {
    state, calls, events, controller, ctx,
    call: async (name: string, args: unknown) => {
      const tool = ctx.tools.get(name)
      assert.ok(tool)
      const value = await tool.execute(args, { signal: controller.signal } as ToolRunContext)
      return value as { ok: boolean; error?: { code: string; message: string }; itinerary?: { days: { endTime: string }[] } }
    },
    close: () => ctx.fiber.dispose(),
  }
}

const plan = {
  title: 'Shanghai day', city: 'Shanghai', mode: 'transit', bufferMinutes: 10,
  days: [{ startTime: '09:00', endTime: '18:00', startPlaceId: 'hotel', endPlaceId: 'hotel', stops: [{ placeId: 'garden', visitMinutes: 60 }, { placeId: 'museum', visitMinutes: 90 }] }],
}

test('map tools use only session-verified IDs and never call a provider for invented IDs', async () => {
  const f = await fixture()
  try {
    const result = await f.call('route', { fromPlaceId: 'hotel', toPlaceId: 'garden', mode: 'transit' })
    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'PLACE_NOT_IN_SESSION')
    assert.equal(f.calls.length, 0)
    await f.call('search_places', { query: 'Shanghai landmarks', city: 'Shanghai' })
    assert.equal((await f.call('route', { fromPlaceId: 'hotel', toPlaceId: 'garden', mode: 'transit' })).ok, true)
    assert.deepEqual(f.calls, [{ from: 'hotel', to: 'garden', mode: 'transit' }])
    assert.ok(f.events.some(event => event.type === 'artifact' && event.artifact.kind === 'routes'))
  } finally { await f.close() }
})

test('trip scheduling uses real per-leg duration, chosen mode, hotel return, visits, and buffers', async () => {
  const f = await fixture()
  try {
    await f.call('search_places', { query: 'Shanghai', city: 'Shanghai' })
    const result = await f.call('plan_trip', plan)
    assert.equal(result.ok, true)
    assert.deepEqual(f.calls, [
      { from: 'hotel', to: 'garden', mode: 'transit' },
      { from: 'garden', to: 'museum', mode: 'transit' },
      { from: 'museum', to: 'hotel', mode: 'transit' },
    ])
    const itinerary = f.state.itinerary!
    assert.equal(itinerary.days[0]!.stops[0]!.arrival, '09:30')
    assert.equal(itinerary.days[0]!.stops[1]!.departure, '12:30')
    assert.equal(itinerary.days[0]!.endTime, '13:00')
    assert.equal(itinerary.days[0]!.returnRoute!.to.id, 'hotel')
    assert.ok(itinerary.notes.some(note => note.includes('have not been verified')))
    assert.ok(f.events.some(event => event.type === 'artifact' && event.artifact.kind === 'itinerary'))
  } finally { await f.close() }
})

test('an infeasible plan publishes no itinerary and preserves the previous successful plan', async () => {
  const f = await fixture()
  try {
    await f.call('search_places', { query: 'Shanghai', city: 'Shanghai' })
    await f.call('plan_trip', plan)
    const previous = structuredClone(f.state.itinerary)
    const routeCount = f.state.routes.length
    f.events.length = 0
    const result = await f.call('plan_trip', { ...plan, days: [{ ...plan.days[0], endTime: '12:45' }] })
    assert.equal(result.error?.code, 'TRIP_DOES_NOT_FIT')
    assert.deepEqual(f.state.itinerary, previous)
    assert.equal(f.state.routes.length, routeCount)
    assert.equal(f.events.some(event => event.type === 'artifact'), false)
  } finally { await f.close() }
})

test('invalid day inputs and a forged stop reject before spending on route requests', async () => {
  const f = await fixture()
  try {
    await f.call('search_places', { query: 'Shanghai', city: 'Shanghai' })
    for (const day of [
      { ...plan.days[0], startTime: '25:30' },
      { ...plan.days[0], date: '2027-02-30' },
      { ...plan.days[0], stops: [{ placeId: 'garden', visitMinutes: -5 }] },
      { ...plan.days[0], stops: [{ placeId: 'invented', visitMinutes: 30 }] },
    ]) assert.equal((await f.call('plan_trip', { ...plan, days: [day] })).ok, false)
    assert.equal(f.calls.length, 0)
  } finally { await f.close() }
})

test('lookup failures are sanitized and cancellation cannot publish a completed route', async () => {
  const failed = await fixture({ search: async () => { throw new Error('https://private/?ak=secret-key') } })
  try {
    const result = await failed.call('search_places', { query: 'Shanghai', city: 'Shanghai' })
    assert.equal(result.error?.code, 'MAP_LOOKUP_FAILED')
    assert.doesNotMatch(JSON.stringify(result), /secret-key|private/)
  } finally { await failed.close() }
  const f = await fixture()
  try {
    f.controller.abort()
    await assert.rejects(f.call('search_places', { query: 'Shanghai', city: 'Shanghai' }), { name: 'AbortError' })
    assert.equal(f.events.length, 0)
  } finally { await f.close() }
})

test('per-turn map tool budget stops additional paid work', async () => {
  let queries = 0
  const f = await fixture({ search: async () => { queries++; return [] } })
  try {
    for (let index = 0; index < TRAVEL_LIMITS.toolCalls; index++) assert.equal((await f.call('search_places', { query: 'Shanghai', city: 'Shanghai' })).ok, true)
    const over = await f.call('search_places', { query: 'Shanghai', city: 'Shanghai' })
    assert.equal(over.error?.code, 'TRAVEL_CALL_LIMIT')
    assert.equal(queries, TRAVEL_LIMITS.toolCalls)
  } finally { await f.close() }
})

test('wrong-mode provider data is rejected instead of appearing as verified transit', async () => {
  const f = await fixture({ route: async (from, to) => ({ id: 'wrong', from, to, mode: 'walking', minutes: 3, meters: 200, steps: [], navigationUrl: 'https://map.baidu.com/' } satisfies Route) })
  try {
    await f.call('search_places', { query: 'Shanghai', city: 'Shanghai' })
    assert.equal((await f.call('route', { fromPlaceId: 'hotel', toPlaceId: 'garden', mode: 'transit' })).error?.code, 'INVALID_MAP_RESULT')
    assert.equal(f.state.routes.length, 0)
  } finally { await f.close() }
})

test('route budget includes every leg inside multi-day planning and keeps a failed revision unpublished', async () => {
  const f = await fixture()
  try {
    await f.call('search_places', { query: 'Shanghai', city: 'Shanghai' })
    const threeDays = { ...plan, days: [plan.days[0], plan.days[0], plan.days[0]] }
    assert.equal((await f.call('plan_trip', threeDays)).ok, true)
    assert.equal((await f.call('plan_trip', threeDays)).ok, true)
    const previous = structuredClone(f.state.itinerary)
    f.events.length = 0
    const result = await f.call('plan_trip', threeDays)
    assert.equal(result.error?.code, 'TRAVEL_ROUTE_LIMIT')
    assert.equal(f.calls.length, TRAVEL_LIMITS.routeCalls)
    assert.deepEqual(f.state.itinerary, previous)
    assert.equal(f.events.some(event => event.type === 'artifact'), false)
  } finally { await f.close() }
})

test('Chinese itinerary notes disclose unverified hours and excluded accommodation journeys', async () => {
  const f = await fixture({}, 'zh')
  try {
    await f.call('search_places', { query: '上海', city: '上海' })
    await f.call('plan_trip', { ...plan, days: [{ startTime: '09:00', endTime: '18:00', stops: plan.days[0]!.stops }] })
    assert.ok(f.state.itinerary!.notes.some(note => note.includes('尚未核验营业时间')))
    assert.ok(f.state.itinerary!.notes.some(note => note.includes('不包含相应的住宿往返交通')))
  } finally { await f.close() }
})

test('cancellation during route lookup leaves no route or itinerary artifact', async () => {
  const started = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<Route>()
  const f = await fixture({ route: async () => { started.resolve(); return gate.promise } })
  try {
    await f.call('search_places', { query: 'Shanghai', city: 'Shanghai' })
    f.events.length = 0
    const running = f.call('route', { fromPlaceId: 'hotel', toPlaceId: 'garden', mode: 'transit' })
    await started.promise
    f.controller.abort()
    gate.resolve({ id: 'cancelled', from: hotel, to: garden, mode: 'transit', minutes: 20, meters: 100, steps: [], navigationUrl: 'https://map.baidu.com/' })
    await assert.rejects(running, { name: 'AbortError' })
    assert.equal(f.state.routes.length, 0)
    assert.equal(f.events.some(event => event.type === 'artifact'), false)
  } finally { await f.close() }
})
