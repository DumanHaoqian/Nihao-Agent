import { ArrowUpRight, BusFront, Car, Clock3, Footprints, MapPin, Route as RouteIcon } from 'lucide-react';
import type { Itinerary, Place, Route, TravelArtifact, TravelMode } from '../../../shared/travel.ts';
import { copy, type Locale } from '../copy.ts';
import { safeBaiduNavigationUrl } from '../travel.ts';

function duration(minutes: number, locale: Locale): string {
  const rounded = Math.max(1, Math.round(minutes));
  if (rounded < 60) return locale === 'zh' ? `${rounded} 分钟` : `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return locale === 'zh' ? `${hours} 小时${rest ? ` ${rest} 分钟` : ''}` : `${hours} hr${rest ? ` ${rest} min` : ''}`;
}

function distance(meters: number, locale: Locale): string {
  return meters < 1000 ? `${Math.round(meters)} ${locale === 'zh' ? '米' : 'm'}` : `${(meters / 1000).toFixed(1)} ${locale === 'zh' ? '公里' : 'km'}`;
}

function modeLabel(mode: TravelMode, locale: Locale): string {
  const text = copy[locale];
  return mode === 'walking' ? text.travelWalking : mode === 'transit' ? text.travelTransit : text.travelDriving;
}

function NavigationLink({ url, locale, label }: { url: string; locale: Locale; label?: string }) {
  const href = safeBaiduNavigationUrl(url);
  if (!href) return null;
  return <a className="travel-map-link" href={href} target="_blank" rel="noopener noreferrer" aria-label={label ? `${copy[locale].travelOpenMap}: ${label}` : copy[locale].travelOpenMap}>
    <span>{copy[locale].travelOpenMap}</span><ArrowUpRight size={14} strokeWidth={1.5} />
  </a>;
}

function PlaceInfo({ place, locale }: { place: Place; locale: Locale }) {
  return <div className="travel-place-row">
    <div className="travel-place-main">
      <h4>{place.name}</h4>
      {place.address && <p className="travel-address">{place.address}</p>}
      {place.openingHours && <p className="travel-hours"><Clock3 size={14} strokeWidth={1.5} /><span>{place.openingHours}</span></p>}
    </div>
    <NavigationLink url={place.navigationUrl} locale={locale} label={place.name} />
  </div>;
}

function RouteSummary({ route, locale, connection = false }: { route: Route; locale: Locale; connection?: boolean }) {
  const Icon = route.mode === 'walking' ? Footprints : route.mode === 'transit' ? BusFront : Car;
  return <div className={`travel-route${connection ? ' travel-route--connection' : ''}`}>
    {!connection && <p className="travel-route-endpoints">{route.from.name}<span aria-hidden="true"> → </span>{route.to.name}</p>}
    <div className="travel-route-summary">
      <span className="travel-route-mode"><Icon size={16} strokeWidth={1.5} />{modeLabel(route.mode, locale)}</span>
      <span>{duration(route.minutes, locale)}</span><span>{distance(route.meters, locale)}</span>
      <NavigationLink url={route.navigationUrl} locale={locale} label={`${route.from.name} → ${route.to.name}`} />
    </div>
    {!connection && route.steps.length > 0 && <details className="travel-directions">
      <summary>{copy[locale].travelDirections}</summary>
      <ol>{route.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
    </details>}
  </div>;
}

function ItineraryCard({ itinerary, locale }: { itinerary: Itinerary; locale: Locale }) {
  const text = copy[locale];
  return <section className="travel-itinerary" aria-label={text.travelItinerary}>
    <div className="travel-plan-heading">
      <p className="travel-eyebrow"><MapPin size={16} strokeWidth={1.5} />{itinerary.city}</p>
      <h3>{itinerary.title}</h3>
    </div>
    {itinerary.days.map(day => <section className="travel-day" key={day.day} aria-label={text.travelDay.replace('{day}', String(day.day))}>
      <div className="travel-day-heading">
        <h4>{text.travelDay.replace('{day}', String(day.day))}{day.date && <span> · {day.date}</span>}</h4>
        <span>{day.startTime}–{day.endTime}</span>
      </div>
      <ol className="travel-timeline">
        {day.stops.map((stop, index) => <li className="travel-stop" key={`${stop.place.id}-${index}`}>
          {stop.travel && <RouteSummary route={stop.travel} locale={locale} connection />}
          <div className="travel-stop-body">
            <div className="travel-stop-time"><time>{stop.arrival}</time><span>{stop.departure}</span></div>
            <div className="travel-stop-content">
              <PlaceInfo place={stop.place} locale={locale} />
              <p className="travel-visit-time">{text.travelVisit.replace('{duration}', duration(stop.visitMinutes, locale))}</p>
              {stop.note && <p className="travel-stop-note">{stop.note}</p>}
            </div>
          </div>
        </li>)}
      </ol>
      {day.returnRoute && <div className="travel-return">
        <p>{text.travelReturn.replace('{place}', day.returnRoute.to.name)}</p>
        <RouteSummary route={day.returnRoute} locale={locale} connection />
      </div>}
    </section>)}
    {itinerary.notes.length > 0 && <ul className="travel-notes">{itinerary.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
  </section>;
}

/** Only completed, validated server artifacts render here, separately from reply Markdown. */
export function TravelArtifacts({ artifacts, locale }: { artifacts: TravelArtifact[]; locale: Locale }) {
  const text = copy[locale];
  const plan = artifacts.find(artifact => artifact.kind === 'itinerary');
  const places = artifacts.find(artifact => artifact.kind === 'places');
  const routes = artifacts.find(artifact => artifact.kind === 'routes');
  return <div className="travel-artifacts" lang={locale === 'zh' ? 'zh-CN' : 'en'}>
    {plan?.kind === 'itinerary' && <ItineraryCard itinerary={plan.itinerary} locale={locale} />}
    {routes?.kind === 'routes' && routes.routes.length > 0 && <details className="travel-results" open={!plan && routes.routes.length <= 2}>
      <summary><RouteIcon size={16} strokeWidth={1.5} /><span>{text.travelRoutes}</span><span className="travel-count">{routes.routes.length}</span></summary>
      <div className="travel-results-content">{routes.routes.map(route => <RouteSummary key={route.id} route={route} locale={locale} />)}</div>
    </details>}
    {places?.kind === 'places' && places.places.length > 0 && <details className="travel-results" open>
      <summary><MapPin size={16} strokeWidth={1.5} /><span>{text.travelPlaces}</span><span className="travel-count">{places.places.length}</span></summary>
      <div className="travel-results-content">{places.places.map(place => <PlaceInfo key={place.id} place={place} locale={locale} />)}</div>
    </details>}
    <p className="travel-attribution">{text.travelAttribution}</p>
  </div>;
}
