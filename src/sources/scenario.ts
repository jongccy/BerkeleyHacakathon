import {
  loadSituationFeed, loadLocationFeed, loadProfile,
  feedAlerts, feedShelters, positionAt,
} from "./feed.js";

// Bridges the hard-coded East Maui (Kaupakalua Dam) scenario into the MCP tools,
// ENTIRELY within the pull/MCP channel — this never POSTs to Poke, so it can't hit
// the inbound-webhook delivery problem. Poke calls check_active_threats /
// get_evacuation_guidance; we answer from the situation feed.
//
// A scenario "clock" walks the timestamped feed so guidance EVOLVES across polls
// (advisory -> flash flood warning -> imminent dam failure -> evacuate -> all clear),
// and the family's GPS position is read at the same clock for position-aware advice.

let active = false;
let sit: any = null, loc: any = null, prof: any = null;
let clockMs = 0;

// The household persona used to personalize the scenario. Set from the app's
// onboarding answers (POST /profile). When present, it overrides the demo file's
// personalization fields (car / pets / mobility / household size / name) — but the
// scenario's location + GPS track stay fixed (this is the Haiku event, "imagine it
// happened to a household like yours"). Null -> fall back to kaupakalua-profile.json.
let activeProfile: any = null;
export function setActiveProfile(p: any) { activeProfile = p || null; }
export function getActiveProfile() { return activeProfile; }
// Scenario-minutes advanced on each check_active_threats poll (auto-play). The full
// event spans ~14h; ~180 min/poll reaches the key beats in a handful of polls.
const STEP_MIN = Number(process.env.SCENARIO_STEP_MIN) || 180;

function baseDate(): string {
  const t = sit?.updates?.[0]?.t || "2021-03-08T10:00:00-10:00";
  return t.slice(0, 10); // YYYY-MM-DD
}

// "HH:MM" -> ms, anchored to the scenario's date in HST (UTC-10).
function hhmmToMs(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm || "").trim());
  if (!m) return null;
  const iso = `${baseDate()}T${m[1].padStart(2, "0")}:${m[2]}:00-10:00`;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function startScenario(atHHMM?: string) {
  sit = loadSituationFeed();
  loc = loadLocationFeed();
  prof = loadProfile();
  const at = atHHMM ? hhmmToMs(atHHMM) : null;
  clockMs = at ?? new Date(sit.updates[0].t).getTime();
  active = true;
}

export function stopScenario() { active = false; }
export function isScenarioActive() { return active; }

export function setScenarioTime(atHHMM: string): boolean {
  if (!sit) startScenario(atHHMM);
  const ms = hhmmToMs(atHHMM);
  if (ms == null) return false;
  clockMs = ms;
  return true;
}

export function advanceScenario(stepMin = STEP_MIN) {
  // Don't run past the last known update — clamp so the final poll holds the all-clear.
  const lastMs = new Date(sit.updates[sit.updates.length - 1].t).getTime();
  clockMs = Math.min(clockMs + stepMin * 60_000, lastMs);
}

// The situation + family state at the current clock, in reconcile()'s shapes.
export function scenarioSnapshot() {
  const alerts = feedAlerts(sit, clockMs);   // everything known up to "now"
  const shelters = feedShelters(sit);         // East Maui shelters (Paia, Hana, Eddie Tam)
  const ping = positionAt(loc, clockMs);      // family's GPS at "now" (null before they leave)
  const lat = ping?.lat ?? prof.home.lat;
  const lng = ping?.lng ?? prof.home.lng;
  // Personalization: prefer the onboarded profile; fall back to the demo file.
  // buildApiProfile() (the app) already emits has_car/pets as 0/1 and a string
  // mobility_needs, so we can use those fields directly.
  const ap = activeProfile;
  const profile = {
    lat, lng,
    name: ap?.name ?? prof.name,
    household_size: ap?.household_size ?? prof.household_size,
    has_car: ap ? (ap.has_car ? 1 : 0) : (prof.has_car ? 1 : 0),
    mobility_needs: ap?.mobility_needs ?? prof.mobility_needs,
    pets: ap ? (ap.pets ? 1 : 0) : (prof.pets ? 1 : 0),
    language: ap?.language || prof.language || "en",
  };
  return {
    clockIso: new Date(clockMs).toISOString(),
    homeLabel: prof.home?.label || "Haiku, HI",
    persona: ap ? (ap.name || "onboarded household") : "demo family of five",
    alerts, shelters, profile, position: ping,
  };
}
