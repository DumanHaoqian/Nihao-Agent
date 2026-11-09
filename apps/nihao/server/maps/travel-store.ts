import { randomUUID } from 'node:crypto'
import type { Itinerary, Place, Route } from '../../shared/travel.ts'
import { ChatError } from '../errors.ts'

/** Only normalized map facts and the latest published itinerary belong in a session. */
export interface TravelState {
  places: Record<string, Place>
  routes: Route[]
  itinerary?: Itinerary
}

export const TRAVEL_LIMITS = {
  sessions: 100,
  ttlMs: 2 * 60 * 60 * 1000,
  places: 80,
  routes: 60,
  stateBytes: 768 * 1024,
  toolCalls: 16,
  routeCalls: 24,
} as const

interface Entry {
  state: TravelState
  expiresAt: number
  touchedAt: number
  busy: boolean
}

export interface TravelTransaction {
  token: string
  /** Detached working copy: failed/cancelled turns cannot alter committed facts. */
  state: TravelState
  /** Commit only after the entire model turn succeeds. The lock remains until release. */
  commit(): void
  /** Idempotent. Any working changes not committed are discarded. */
  release(): void
}

function emptyState(): TravelState { return { places: {}, routes: [] } }

function validateBoundedState(state: TravelState): void {
  if (Object.keys(state.places).length > TRAVEL_LIMITS.places
    || state.routes.length > TRAVEL_LIMITS.routes
    || (state.itinerary?.days.length ?? 0) > 3
    || state.itinerary?.days.some(day => day.stops.length > 6)
    || Buffer.byteLength(JSON.stringify(state), 'utf8') > TRAVEL_LIMITS.stateBytes) {
    throw new ChatError('TRAVEL_STATE_LIMIT', 'This trip contains too much map data. Start a new chat.', 413)
  }
}

/** Short-lived server-owned state with per-session transaction locks; no disk writes. */
export class TravelStore {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly now: () => number = Date.now) {}

  begin(token?: string): TravelTransaction {
    const now = this.now()
    for (const [id, entry] of this.entries) {
      if (!entry.busy && entry.expiresAt <= now) this.entries.delete(id)
    }
    let id = token
    let entry: Entry
    if (id !== undefined) {
      const existing = this.entries.get(id)
      if (!existing || existing.expiresAt <= now) {
        throw new ChatError('TRAVEL_SESSION_EXPIRED', 'This trip session has expired. Start a new chat.', 409)
      }
      if (existing.busy) throw new ChatError('TRAVEL_SESSION_BUSY', 'A reply is already updating this trip. Wait for it to finish.', 409)
      entry = existing
    } else {
      if (this.entries.size >= TRAVEL_LIMITS.sessions) {
        const oldest = [...this.entries].filter(([, value]) => !value.busy).sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0]
        if (!oldest) throw new ChatError('TRAVEL_BUSY', 'Travel planning is busy. Try again shortly.', 429)
        this.entries.delete(oldest[0])
      }
      id = randomUUID()
      entry = { state: emptyState(), expiresAt: now + TRAVEL_LIMITS.ttlMs, touchedAt: now, busy: false }
      this.entries.set(id, entry)
    }
    entry.busy = true
    const state = structuredClone(entry.state)
    let released = false
    let committed = false
    return {
      token: id,
      state,
      commit: () => {
        if (released) throw new Error('Travel transaction is already released')
        if (committed) return
        validateBoundedState(state)
        entry.state = structuredClone(state)
        entry.touchedAt = this.now()
        entry.expiresAt = entry.touchedAt + TRAVEL_LIMITS.ttlMs
        committed = true
      },
      release: () => {
        if (released) return
        released = true
        entry.busy = false
      },
    }
  }
}

export function createTravelStore(): TravelStore { return new TravelStore() }
