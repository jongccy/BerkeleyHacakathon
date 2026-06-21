import { scrapeAlerts } from "./browserbase.js";

// Real Maui-relevant official sources, scraped live via Browserbase.
// These are reached only in --live mode; scenario mode never touches them so the
// demo path stays fast and offline. Gov pages often have NO active alerts during
// the hackathon — that's expected; an empty result still proves the scrape ran
// (Browserbase session replay), and the pipeline falls back to scenario alerts.
const MAUI_SOURCES = [
  {
    url: "https://www.mauicounty.gov/983/MEMA-Alerts",
    what: "Maui County evacuations, flooding, wildfires, high surf, or other active emergencies"
  },
  {
    url: "https://dod.hawaii.gov/hiema/",
    what: "Hawaii statewide warnings, evacuations, tsunamis, severe weather, or hazards affecting Maui"
  }
];

// Demo source (handoff "scenario mode", option B): rather than fabricate alerts,
// Browserbase scrapes a REAL past Maui flood event — the March 2021 Hawaii floods
// (Kaupakalua Dam breach in Haiku, NWS flash flood warnings, statewide evacuation
// orders). This makes the armed demo show a genuine Browserbase session (replay for
// judges) pulling authentic historical emergency data. Override via env to swap the
// event. The instruction is tailored for a historical article (not a live alert page).
const DEMO_EVENT_URL = process.env.DEMO_EVENT_URL || "https://en.wikipedia.org/wiki/March_2021_Hawaii_floods";
const DEMO_EVENT_INSTRUCTION =
  "This article describes the March 2021 Hawaii floods. Extract the official emergency warnings and evacuation orders that were issued during this event (e.g. NWS Flash Flood Warnings, the Kaupakalua Dam evacuation in Haiku on Maui, state of emergency). For each, give the warning/event name, the area affected, and the instruction given to residents.";

export async function demoFloodAlerts() {
  return scrapeAlerts(DEMO_EVENT_URL, "the March 2021 Hawaii floods on Maui", DEMO_EVENT_INSTRUCTION);
}

export async function mauiScrapedAlerts() {
  // Sequential (not Promise.all) to stay within Browserbase single-session
  // concurrency limits. Each scrapeAlerts() isolates its own failure -> [].
  const out: any[] = [];
  for (const s of MAUI_SOURCES) {
    out.push(...(await scrapeAlerts(s.url, s.what)));
  }
  return out;
}
