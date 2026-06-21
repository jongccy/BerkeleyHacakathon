import { scrapeAlerts } from "./browserbase.js";
import { discoverAlerts } from "./discover.js";

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

// Demo sources (handoff "scenario mode", option B — multi-source): rather than
// fabricate alerts, Browserbase scrapes SEVERAL real pages about a past Maui flood
// (the March 2021 Hawaii floods / Kaupakalua Dam breach in Haiku) — Wikipedia plus
// two news outlets that covered it — then we merge + dedup. This shows multiple real
// Browserbase sessions ingesting messy, independent, sometimes conflicting sources
// (e.g. an evacuation order alongside a shelter-in-place-for-visitors notice), which
// is exactly the reconcile story. Override the list via DEMO_EVENT_URLS (comma-sep).
const DEMO_INSTRUCTION =
  "This page covers the March 2021 Maui flooding and the Kaupakalua Dam emergency in Haiku. Extract the official emergency warnings, evacuation orders, shelter-in-place notices, and road closures described. For each, give the warning/event name, the area affected, and the instruction given to residents.";

const DEMO_SOURCES = process.env.DEMO_EVENT_URLS
  ? process.env.DEMO_EVENT_URLS.split(",").map((s) => s.trim()).filter(Boolean)
  : [
      "https://en.wikipedia.org/wiki/March_2021_Hawaii_floods",
      "https://www.civilbeat.org/2021/03/maui-area-evacuated-after-heavy-rains-cause-dam-to-overflow/",
      "https://www.khon2.com/local-news/evacuations-ordered-on-maui/"
    ];

// Event the demo discovers. Browserbase searches Google News for this query within
// the date window and reads the top N articles itself. Defaults target the March 8,
// 2021 Kaupakalua Dam evacuation in Haiku, Maui. All overridable via env.
const DEMO_QUERY = process.env.DEMO_EVENT_QUERY || "Maui Kaupakalua Dam evacuation flood";
const DEMO_AFTER = process.env.DEMO_EVENT_AFTER || "2021-03-07";
const DEMO_BEFORE = process.env.DEMO_EVENT_BEFORE || "2021-03-11";
// 5 keeps pre-warm under ~3 min and avoids the Browserbase single-session timeout
// that truncates ~8+ article runs. The top Maui outlets carry most of the data.
const DEMO_MAX_ARTICLES = Number(process.env.DISCOVERY_MAX_ARTICLES) || 5;

export async function demoFloodAlerts() {
  // Primary: Browserbase discovers its own articles for the event (Google News ->
  // top N -> read each). This is the "find the real coverage" path.
  const discovered = await discoverAlerts({
    query: DEMO_QUERY, after: DEMO_AFTER, before: DEMO_BEFORE, maxArticles: DEMO_MAX_ARTICLES
  });
  if (discovered.length) return discovered;

  // Fallback: a fixed curated source list, so the demo never comes up empty if a
  // discovery run is sparse or Google News hiccups.
  console.warn("[demo] discovery returned nothing — falling back to curated sources.");
  const out: any[] = [];
  for (const url of DEMO_SOURCES) {
    out.push(...(await scrapeAlerts(url, "the March 2021 Maui flood", DEMO_INSTRUCTION)));
  }
  const seen = new Set<string>();
  return out.filter((a) => {
    const key = `${String(a.event || "").toLowerCase().trim()}|${String(a.area || "").toLowerCase().trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
