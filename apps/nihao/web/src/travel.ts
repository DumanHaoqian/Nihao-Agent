import type { Itinerary, ItineraryDay, ItineraryStop, Place, Route, TravelArtifact, TravelEvent } from '../../shared/travel.ts';

const markerParameters = new Set(['location', 'title', 'content', 'output', 'coord_type', 'src']);
const directionParameters = new Set(['origin', 'destination', 'mode', 'region', 'origin_region', 'destination_region', 'coord_type', 'src', 'output', 'sy']);

/** The UI never follows a provider-supplied redirect or an arbitrary map URL. */
export function safeBaiduNavigationUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'api.map.baidu.com' || url.username || url.password || url.port || url.hash) return undefined;
    const allowed = url.pathname === '/marker' ? markerParameters : url.pathname === '/direction' ? directionParameters : undefined;
    if (!allowed || [...url.searchParams.keys()].some(key => !allowed.has(key))) return undefined;
    return url.href;
  } catch { return undefined; }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid travel response');
  return value as Record<string, unknown>;
}

function string(value: unknown, max = 500, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max) throw new Error('Invalid travel response');
  return value;
}

function optionalString(value: unknown, max = 500): string | undefined {
  return value === undefined ? undefined : string(value, max, true);
}

function number(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error('Invalid travel response');
  return value;
}

function array<T>(value: unknown, maximum: number, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error('Invalid travel response');
  return value.map(parse);
}

function time(value: unknown): string {
  const result = string(value, 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(result)) throw new Error('Invalid travel response');
  return result;
}

function place(value: unknown): Place {
  const object = record(value);
  const location = record(object.location);
  return {
    id: string(object.id, 160), name: string(object.name, 300), address: string(object.address, 1000, true),
    city: optionalString(object.city, 100), openingHours: optionalString(object.openingHours, 1000),
    location: { lat: number(location.lat, -90, 90), lng: number(location.lng, -180, 180) },
    navigationUrl: safeBaiduNavigationUrl(object.navigationUrl) ?? '',
  };
}

function route(value: unknown): Route {
  const object = record(value);
  if (!['walking', 'transit', 'driving'].includes(String(object.mode))) throw new Error('Invalid travel response');
  return {
    id: string(object.id, 160), from: place(object.from), to: place(object.to), mode: object.mode as Route['mode'],
    minutes: number(object.minutes, 0, 10080), meters: number(object.meters, 0, 20_000_000),
    steps: array(object.steps, 80, value => string(value, 1000, true)),
    navigationUrl: safeBaiduNavigationUrl(object.navigationUrl) ?? '',
  };
}

function stop(value: unknown): ItineraryStop {
  const object = record(value);
  return {
    place: place(object.place), arrival: time(object.arrival), departure: time(object.departure),
    visitMinutes: number(object.visitMinutes, 0, 1440),
    ...(object.travel === undefined ? {} : { travel: route(object.travel) }),
    note: optionalString(object.note, 1500),
  };
}

function day(value: unknown): ItineraryDay {
  const object = record(value);
  const dayNumber = number(object.day, 1, 3);
  if (!Number.isInteger(dayNumber)) throw new Error('Invalid travel response');
  const date = optionalString(object.date, 10);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid travel response');
  return {
    day: dayNumber, date, startTime: time(object.startTime), endTime: time(object.endTime),
    stops: array(object.stops, 12, stop),
    ...(object.returnRoute === undefined ? {} : { returnRoute: route(object.returnRoute) }),
  };
}

function itinerary(value: unknown): Itinerary {
  const object = record(value);
  const days = array(object.days, 3, day);
  if (!days.length) throw new Error('Invalid travel response');
  return { id: string(object.id, 160), title: string(object.title, 300), city: string(object.city, 100), days, notes: array(object.notes, 20, value => string(value, 1500, true)) };
}

export function parseTravelEvent(value: unknown): TravelEvent | undefined {
  const object = record(value);
  if (object.type === 'travel-session') {
    const id = string(object.id, 160);
    if (!/^[A-Za-z0-9_-]{16,160}$/.test(id)) throw new Error('Invalid travel response');
    return { type: 'travel-session', id };
  }
  if (object.type === 'response-language') {
    if (object.language !== 'en' && object.language !== 'zh') throw new Error('Invalid travel response');
    return { type: 'response-language', language: object.language };
  }
  if (object.type === 'tool-status') {
    if (!['search', 'details', 'route', 'plan', 'translate'].includes(String(object.tool)) || !['running', 'complete', 'error'].includes(String(object.status))) throw new Error('Invalid travel response');
    return { type: 'tool-status', tool: object.tool as Extract<TravelEvent, { type: 'tool-status' }>['tool'], status: object.status as 'running' | 'complete' | 'error' };
  }
  if (object.type !== 'artifact') return undefined;
  const artifact = record(object.artifact);
  if (artifact.kind === 'places') return { type: 'artifact', artifact: { kind: 'places', places: array(artifact.places, 100, place) } };
  if (artifact.kind === 'routes') return { type: 'artifact', artifact: { kind: 'routes', routes: array(artifact.routes, 100, route) } };
  if (artifact.kind === 'itinerary') return { type: 'artifact', artifact: { kind: 'itinerary', itinerary: itinerary(artifact.itinerary) } };
  throw new Error('Invalid travel response');
}

/** Keep only the latest facts for each ID and the newest plan within one reply. */
export function mergeTravelArtifact(current: TravelArtifact[], incoming: TravelArtifact): TravelArtifact[] {
  const others = current.filter(artifact => artifact.kind !== incoming.kind);
  if (incoming.kind === 'itinerary') return [...others, incoming];
  const merge = <T extends { id: string }>(prior: T[], next: T[]): T[] => {
    const values = new Map(prior.map(item => [item.id, item]));
    for (const item of next) { values.delete(item.id); values.set(item.id, item); }
    return [...values.values()].slice(-12);
  };
  if (incoming.kind === 'places') {
    const previous = current.find(artifact => artifact.kind === 'places');
    return [...others, { kind: 'places', places: merge(previous?.kind === 'places' ? previous.places : [], incoming.places) }];
  }
  const previous = current.find(artifact => artifact.kind === 'routes');
  return [...others, { kind: 'routes', routes: merge(previous?.kind === 'routes' ? previous.routes : [], incoming.routes) }];
}
