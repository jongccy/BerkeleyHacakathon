import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Adapter for the hard-coded demo feeds (the family being portrayed). It turns the
// timestamped situation feed into the SAME alert shape reconcile()/isThreat() use for
// live Browserbase/NWS sources — so the scenario flows through the existing pipeline
// unchanged — and exposes the family's GPS track for position-aware guidance.
//
// Defaults target the East Maui / Kaupakalua Dam scenario (the event the live
// Browserbase discovery path already searches for). Override paths per call.

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO_DIR = join(HERE, "..", "..", "demo-data");
export const SITUATION_FEED = join(DEMO_DIR, "kaupakalua-situation-feed.json");
export const LOCATION_FEED = join(DEMO_DIR, "kaupakalua-location-feed.json");
export const PROFILE_FILE = join(DEMO_DIR, "kaupakalua-profile.json");

export interface FeedAlert {
  source: string;
  event: string;
  area: string;
  text: string;
  severity: string; // Moderate | Severe | Extreme | unknown
  issued_at: string; // ISO timestamp the update was issued
  type: string; // flood_extent | alert | evac_order | road_closure | dam_status | resource | report
  raw: any; // full original update, so no field is lost
}

export const loadSituationFeed = (path = SITUATION_FEED) => JSON.parse(readFileSync(path, "utf8"));
export const loadLocationFeed = (path = LOCATION_FEED) => JSON.parse(readFileSync(path, "utf8"));
export const loadProfile = (path = PROFILE_FILE) => JSON.parse(readFileSync(path, "utf8"));

// A readable event name per update type, so reconcile sees a meaningful "event"
// string (the live scrape supplies one; the structured feed needs us to synthesize it).
function eventLabel(u: any): string {
  switch (u.type) {
    case "flood_extent":
      return `${u.severity || ""} flood warning`.trim();
    case "evac_order":
      return "Evacuation order";
    case "road_closure":
      return u.status === "reopened" ? "Road reopened" : "Road closure";
    case "dam_status":
      return `Dam status: ${u.state || "update"}`;
    case "resource":
      return `Shelter status: ${u.shelter || ""}`.trim();
    case "report":
      return "Situation report";
    case "alert":
      return "Public safety alert";
    default:
      return u.type || "update";
  }
}

// The affected area, pulled from whichever field this update type carries.
function areaOf(u: any): string {
  if (Array.isArray(u.zones) && u.zones.length) return u.zones.join(", ");
  if (u.evac_area) return u.evac_area;
  if (Array.isArray(u.roads) && u.roads.length) return u.roads.join("; ");
  if (u.shelter) return u.shelter;
  return "";
}

/** Map one situation update to the alert shape reconcile()/isThreat() consume. */
export function toAlert(u: any): FeedAlert {
  return {
    source: u.source || "official",
    event: eventLabel(u),
    area: areaOf(u),
    text: u.text || "",
    severity: u.severity || "unknown",
    issued_at: u.t,
    type: u.type,
    raw: u,
  };
}

/** Alerts known AT OR BEFORE asOfMs (omit asOfMs for the full set). */
export function feedAlerts(feed: any, asOfMs?: number): FeedAlert[] {
  const updates = (feed.updates || []).filter((u: any) =>
    asOfMs == null ? true : new Date(u.t).getTime() <= asOfMs
  );
  return updates.map(toAlert);
}

/** Shelters from the situation feed in reconcile's shape (fallback to data/shelters.json). */
export function feedShelters(feed: any): any[] {
  return (feed.shelters || []).map((s: any) => ({
    name: s.name,
    address: s.area ? `${s.area}, HI` : "",
    lat: s.lat,
    lng: s.lng,
    accessible: s.accessible ?? null,
    pet_friendly: s.pet_friendly ?? null,
    transit_accessible: s.transit_accessible ?? null,
  }));
}

/** The family's latest GPS ping at or before asOfMs (their position at that moment). */
export function positionAt(feed: any, asOfMs: number): any | null {
  let last: any = null;
  for (const p of feed.pings || []) {
    if (new Date(p.t).getTime() <= asOfMs) last = p;
    else break;
  }
  return last;
}
