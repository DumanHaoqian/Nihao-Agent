/** Map facts cross the wire only after server-side validation. All coordinates are BD-09. */
export interface Place {
  id: string
  name: string
  address: string
  city?: string
  location: { lat: number; lng: number }
  openingHours?: string
  navigationUrl: string
}

export type TravelMode = 'walking' | 'transit' | 'driving'

export interface Route {
  id: string
  from: Place
  to: Place
  mode: TravelMode
  minutes: number
  meters: number
  steps: string[]
  navigationUrl: string
}

export interface ItineraryStop {
  place: Place
  arrival: string
  departure: string
  visitMinutes: number
  travel?: Route
  note?: string
}

export interface ItineraryDay {
  day: number
  date?: string
  startTime: string
  endTime: string
  stops: ItineraryStop[]
  returnRoute?: Route
}

export interface Itinerary {
  id: string
  title: string
  city: string
  days: ItineraryDay[]
  notes: string[]
}

export type TravelArtifact =
  | { kind: 'places'; places: Place[] }
  | { kind: 'routes'; routes: Route[] }
  | { kind: 'itinerary'; itinerary: Itinerary }

export type TravelEvent =
  | { type: 'travel-session'; id: string }
  | { type: 'response-language'; language: 'en' | 'zh' }
  | { type: 'tool-status'; tool: 'search' | 'details' | 'route' | 'plan' | 'translate'; status: 'running' | 'complete' | 'error' }
  | { type: 'artifact'; artifact: TravelArtifact }
