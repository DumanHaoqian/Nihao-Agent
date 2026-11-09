import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Place, Route, TravelMode } from '../../shared/travel.ts'

export interface MatrixLeg { fromId: string; toId: string; minutes: number; meters: number }
export interface BaiduClient {
  search(query: string, city: string): Promise<Place[]>
  details(place: Place): Promise<Place>
  route(from: Place, to: Place, mode: TravelMode): Promise<Route>
  matrix?(places: Place[], mode: 'walking' | 'driving'): Promise<MatrixLeg[]>
  close(): Promise<void>
}

/** Deliberately never carries the provider exception, URL, or response body. */
export class MapsError extends Error {
  constructor(readonly code: 'MAPS_NOT_CONFIGURED' | 'MAPS_UNAVAILABLE' | 'MAPS_INVALID_RESULT' | 'MAPS_TIMEOUT' | 'MAPS_NO_ROUTE' | 'MAPS_INVALID_INPUT') {
    super({ MAPS_NOT_CONFIGURED: 'Map search is not configured.', MAPS_UNAVAILABLE: 'Baidu Maps is unavailable. Please try again.', MAPS_INVALID_RESULT: 'Baidu Maps returned incomplete data.', MAPS_TIMEOUT: 'Baidu Maps took too long to respond.', MAPS_NO_ROUTE: 'No route is available for this transport mode.', MAPS_INVALID_INPUT: 'The map request is invalid.' }[code])
    this.name = 'MapsError'
  }
}

const allowedTools = ['map_search_places', 'map_place_details', 'map_directions', 'map_directions_matrix'] as const
type AllowedTool = typeof allowedTools[number]
type RecordValue = Record<string, unknown>
const invalid = (): never => { throw new MapsError('MAPS_INVALID_RESULT') }
const object = (value: unknown): RecordValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined
const cleanText = (value: unknown, max = 400): string => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : ''
const finite = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const uid = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{6,128}$/.test(value)

function coordinate(value: unknown): Place['location'] | undefined {
  const point = object(value)
  return point && finite(point.lat, -90, 90) && finite(point.lng, -180, 180)
    ? { lat: point.lat, lng: point.lng } : undefined
}

function mapUrl(path: 'marker' | 'direction', parameters: Record<string, string>): string {
  const url = new URL(`https://api.map.baidu.com/${path}`)
  for (const [name, value] of Object.entries({ ...parameters, coord_type: 'bd09ll', output: 'html', src: 'webapp.nihao.agent' })) url.searchParams.set(name, value)
  return url.href
}

function openingHours(detail: RecordValue | undefined): string | undefined {
  const regular = object(detail?.regular_open_hour)
  if (Array.isArray(regular?.periods) && regular.periods.length <= 28) {
    const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const pieces: string[] = []
    const sameDay: { day: number; start: string; end: string }[] = []
    for (const item of regular.periods) {
      const period = object(item)
      const open = object(period?.open)
      const close = object(period?.close)
      const time = (point: RecordValue | undefined): string | undefined => point && Number.isInteger(point.day) && finite(point.day, 0, 6) && Number.isInteger(point.hour) && finite(point.hour, 0, 24) && Number.isInteger(point.minute) && finite(point.minute, 0, 59)
        ? `${labels[point.day]} ${String(point.hour).padStart(2, '0')}:${String(point.minute).padStart(2, '0')}` : undefined
      const start = time(open), end = time(close)
      if (start && end) {
        pieces.push(`${start}–${end}`)
        // Only uncomplicated, forward, same-day intervals can be shortened safely.
        if (open!.day === close!.day && Number(open!.hour) < 24 && (Number(close!.hour) < 24 || close!.minute === 0)
          && Number(open!.hour) * 60 + Number(open!.minute) < Number(close!.hour) * 60 + Number(close!.minute)) {
          sameDay.push({ day: Number(open!.day) || 7, start: start.slice(4), end: end.slice(4) })
        }
      }
    }
    if (pieces.length === regular.periods.length && pieces.length) {
      // Preserve overnight and split-shift schedules verbatim. Missing weekdays stay missing.
      if (sameDay.length !== pieces.length || new Set(sameDay.map(period => period.day)).size !== sameDay.length) return pieces.join('; ')
      sameDay.sort((a, b) => a.day - b.day)
      const groups: { first: number; last: number; start: string; end: string }[] = []
      for (const period of sameDay) {
        const previous = groups.at(-1)
        if (previous && period.day === previous.last + 1 && period.start === previous.start && period.end === previous.end) previous.last = period.day
        else groups.push({ first: period.day, last: period.day, start: period.start, end: period.end })
      }
      return groups.map(group => `${labels[group.first % 7]}${group.first === group.last ? '' : `–${labels[group.last % 7]}`} ${group.start}–${group.end}`).join('; ')
    }
  }
  return cleanText(detail?.shop_hours, 800) || undefined
}

function place(value: unknown): Place | undefined {
  const row = object(value)
  const location = coordinate(row?.location)
  const name = cleanText(row?.name, 160)
  if (!row || !uid(row.uid) || !location || !name) return undefined
  const address = cleanText(row.address)
  return { id: row.uid, name, address, location, ...(cleanText(row.city, 80) ? { city: cleanText(row.city, 80) } : {}),
    ...(openingHours(object(row.detail_info)) ? { openingHours: openingHours(object(row.detail_info)) } : {}),
    navigationUrl: mapUrl('marker', { location: `${location.lat},${location.lng}`, title: name, content: address }),
  }
}

/** Extract only JSON data. Server instructions, arbitrary links, and unknown fields never become app configuration. */
function payload(value: unknown): RecordValue {
  const result = object(value)
  if (!result || result.isError === true) throw new MapsError('MAPS_UNAVAILABLE')
  let data = object(result.structuredContent)
  if (!data) {
    if (!Array.isArray(result.content)) return invalid()
    const blocks = result.content.filter(item => object(item)?.type === 'text')
    if (blocks.length !== 1) return invalid()
    const text = object(blocks[0])?.text
    if (typeof text !== 'string' || text.length > 2_000_000) return invalid()
    try { data = object(JSON.parse(text)) } catch { return invalid() }
  }
  if (!data) return invalid()
  if (data.status !== 0) throw new MapsError(data.status === 1001 || data.status === 7 ? 'MAPS_NO_ROUTE' : 'MAPS_UNAVAILABLE')
  return data
}

function assertPlace(value: Place): void {
  if (!uid(value.id) || !coordinate(value.location) || !cleanText(value.name)) throw new MapsError('MAPS_INVALID_INPUT')
}

function durationDistance(value: unknown): { minutes: number; meters: number } | undefined {
  const row = object(value)
  const duration = object(row?.duration)?.value ?? row?.duration
  const distance = object(row?.distance)?.value ?? row?.distance
  if (!finite(duration, 0, 2_592_000) || !finite(distance, 0, 30_000_000)) return undefined
  return { minutes: Math.ceil(duration / 60), meters: Math.round(distance) }
}

function routeSteps(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 40).flatMap(step => {
    // Transit arrays contain alternative vehicles for one leg, not consecutive legs.
    const selected = Array.isArray(step) ? object(step[0]) : object(step)
    const text = cleanText(selected?.instruction ?? selected?.instructions, 500)
    if (text) return [text]
    if (Array.isArray(selected?.schemes)) return routeSteps([selected.schemes[0]])
    return []
  })
}

export interface BaiduClientOptions {
  /** Test injection only; production always obtains the key from the server environment. */
  apiKey?: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

/** One client per chat request; callers may initialize lazily on first tool execution. */
export async function createBaiduClient(signal: AbortSignal, options: BaiduClientOptions = {}): Promise<BaiduClient> {
  signal.throwIfAborted()
  const apiKey = (options.apiKey ?? process.env.BAIDU_MAP_API_KEY)?.trim()
  if (!apiKey) throw new MapsError('MAPS_NOT_CONFIGURED')
  const timeoutMs = options.timeoutMs ?? 20_000
  const lifetime = new AbortController()
  const requestSignal = AbortSignal.any([signal, lifetime.signal])
  const operation = new AsyncLocalStorage<AbortSignal>()
  const endpoint = new URL('https://mcp.map.baidu.com/mcp')
  endpoint.searchParams.set('ak', apiKey)
  const fetcher = options.fetch ?? globalThis.fetch
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { redirect: 'error' },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    fetch: (url, init) => fetcher(url, { ...init, signal: AbortSignal.any([requestSignal, ...(operation.getStore() ? [operation.getStore()!] : []), ...(init?.signal ? [init.signal] : [])]) }),
  })
  const client = new Client({ name: 'nihao-agent', version: '0.1.0' })
  client.onerror = () => {} // SDK exceptions may include the AK-bearing URL; never log them.
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    signal.removeEventListener('abort', abort)
    lifetime.abort()
    await client.close().catch(() => {})
  }
  const abort = (): void => { void close() }
  signal.addEventListener('abort', abort, { once: true })
  async function bounded<T>(work: (callSignal: AbortSignal) => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    if (closed) throw new MapsError('MAPS_UNAVAILABLE')
    const timerController = new AbortController()
    const callSignal = AbortSignal.any([requestSignal, timerController.signal])
    const timer = setTimeout(() => timerController.abort(), timeoutMs)
    try {
      return await operation.run(callSignal, () => work(callSignal))
    } catch (error) {
      if (signal.aborted) throw new DOMException('Map request cancelled.', 'AbortError')
      if (timerController.signal.aborted) throw new MapsError('MAPS_TIMEOUT')
      if (error instanceof MapsError) throw error
      throw new MapsError('MAPS_UNAVAILABLE')
    } finally { clearTimeout(timer) }
  }
  async function call(name: AllowedTool, args: RecordValue): Promise<RecordValue> {
    if (!allowedTools.includes(name)) throw new MapsError('MAPS_INVALID_INPUT')
    return bounded(async callSignal => payload(await client.callTool({ name, arguments: args }, undefined, { signal: callSignal, timeout: timeoutMs })))
  }
  try {
    await bounded(callSignal => client.connect(transport, { signal: callSignal, timeout: timeoutMs }))
    const listed = await bounded(callSignal => client.listTools({}, { signal: callSignal, timeout: timeoutMs }))
    if (allowedTools.some(name => !listed.tools.some(tool => tool.name === name))) throw new MapsError('MAPS_UNAVAILABLE')
  } catch (error) { await close(); throw error }
  return {
    close,
    async search(query, city) {
      if (typeof query !== 'string' || !query.trim() || query.length > 160 || typeof city !== 'string' || !city.trim() || city.length > 80) throw new MapsError('MAPS_INVALID_INPUT')
      const data = await call('map_search_places', { query: query.trim(), region: city.trim(), is_chinese_mainland: 'true' })
      if (!Array.isArray(data.results)) return invalid()
      const rows = data.results.slice(0, 12).map(place).filter((row): row is Place => row !== undefined)
      if (data.results.length && !rows.length) return invalid()
      return [...new Map(rows.map(row => [row.id, row])).values()]
    },
    async details(input) {
      assertPlace(input)
      const data = await call('map_place_details', { uid: input.id, is_chinese_mainland: 'true' })
      const result = place(data.result)
      if (!result || result.id !== input.id) return invalid()
      return result
    },
    async route(from, to, mode) {
      assertPlace(from); assertPlace(to)
      if (!['walking', 'transit', 'driving'].includes(mode)) throw new MapsError('MAPS_INVALID_INPUT')
      const data = await call('map_directions', { model: mode, origin: `${from.location.lat.toFixed(6)},${from.location.lng.toFixed(6)}`, destination: `${to.location.lat.toFixed(6)},${to.location.lng.toFixed(6)}`, is_chinese_mainland: 'true' })
      const routes = object(data.result)?.routes
      if (!Array.isArray(routes)) return invalid()
      if (!routes.length) throw new MapsError('MAPS_NO_ROUTE')
      const result = object(routes[0])
      const metrics = durationDistance(result)
      if (!result || !metrics) return invalid()
      return { id: randomUUID(), from, to, mode, ...metrics, steps: routeSteps(result.steps), navigationUrl: mapUrl('direction', {
        origin: `latlng:${from.location.lat},${from.location.lng}|name:${from.name}`,
        destination: `latlng:${to.location.lat},${to.location.lng}|name:${to.name}`, mode,
        ...(from.city && from.city === to.city ? { region: from.city } : {}),
      }) }
    },
    async matrix(places, mode) {
      if (!['walking', 'driving'].includes(mode) || places.length < 2 || places.length > 10) throw new MapsError('MAPS_INVALID_INPUT')
      places.forEach(assertPlace)
      const batchRows = Math.floor((mode === 'walking' ? 50 : 100) / places.length)
      const legs: MatrixLeg[] = []
      const points = (values: Place[]): string => values.map(item => `${item.location.lat.toFixed(6)},${item.location.lng.toFixed(6)}`).join('|')
      for (let start = 0; start < places.length; start += batchRows) {
        const origins = places.slice(start, start + batchRows)
        const data = await call('map_directions_matrix', { model: mode, origins: points(origins), destinations: points(places) })
        if (!Array.isArray(data.result) || data.result.length !== origins.length * places.length) return invalid()
        for (let index = 0; index < data.result.length; index++) {
          const metrics = durationDistance(data.result[index])
          if (!metrics) return invalid()
          legs.push({ fromId: origins[Math.floor(index / places.length)]!.id, toId: places[index % places.length]!.id, ...metrics })
        }
      }
      return legs
    },
  }
}
