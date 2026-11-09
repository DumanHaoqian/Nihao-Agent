import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TravelStore, TRAVEL_LIMITS } from './maps/travel-store.ts'
import type { Place } from '../shared/travel.ts'

const place: Place = { id: 'verified-poi', name: 'Yu Garden', address: 'Shanghai', location: { lat: 31.2, lng: 121.4 }, navigationUrl: 'https://map.baidu.com/' }

test('travel sessions commit detached working copies and discard failed turn mutations', () => {
  const store = new TravelStore()
  const first = store.begin()
  assert.match(first.token, /^[0-9a-f-]{36}$/)
  first.state.places[place.id] = structuredClone(place)
  first.commit()
  first.state.places[place.id]!.name = 'uncommitted after snapshot'
  first.release()
  const failed = store.begin(first.token)
  assert.equal(failed.state.places[place.id]!.name, 'Yu Garden')
  failed.state.places[place.id]!.name = 'failed edit'
  failed.release()
  const next = store.begin(first.token)
  assert.equal(next.state.places[place.id]!.name, 'Yu Garden')
  next.release()
})

test('travel session lock prevents concurrent overwrites and release is idempotent', () => {
  const store = new TravelStore()
  const active = store.begin()
  assert.throws(() => store.begin(active.token), { code: 'TRAVEL_SESSION_BUSY' })
  active.release()
  active.release()
  assert.throws(() => active.commit(), /released/)
  const retry = store.begin(active.token)
  assert.deepEqual(retry.state, { places: {}, routes: [] })
  retry.release()
})

test('unknown and expired tokens fail explicitly; committing renews the two-hour TTL', () => {
  let now = 1000
  const store = new TravelStore(() => now)
  assert.throws(() => store.begin('invented-token'), { code: 'TRAVEL_SESSION_EXPIRED' })
  assert.throws(() => store.begin(''), { code: 'TRAVEL_SESSION_EXPIRED' })
  const first = store.begin()
  first.release()
  now += TRAVEL_LIMITS.ttlMs - 1
  const refreshed = store.begin(first.token)
  refreshed.commit()
  refreshed.release()
  now += TRAVEL_LIMITS.ttlMs - 1
  store.begin(first.token).release()
  now += 1
  assert.throws(() => store.begin(first.token), { code: 'TRAVEL_SESSION_EXPIRED' })
})

test('travel store caps sessions, avoids evicting busy work, and rejects oversized commits', () => {
  const store = new TravelStore()
  const transactions = Array.from({ length: TRAVEL_LIMITS.sessions }, () => store.begin())
  assert.throws(() => store.begin(), { code: 'TRAVEL_BUSY' })
  const oldest = transactions[0]!
  oldest.release()
  const replacement = store.begin()
  assert.throws(() => store.begin(oldest.token), { code: 'TRAVEL_SESSION_EXPIRED' })
  for (let index = 0; index <= TRAVEL_LIMITS.places; index++) replacement.state.places[`p${index}`] = { ...place, id: `p${index}` }
  assert.throws(() => replacement.commit(), { code: 'TRAVEL_STATE_LIMIT' })
  replacement.release()
  const unchanged = store.begin(replacement.token)
  assert.equal(Object.keys(unchanged.state.places).length, 0)
  unchanged.release()
  transactions.forEach(transaction => transaction.release())
})
