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

export async function mauiScrapedAlerts() {
  // Sequential (not Promise.all) to stay within Browserbase single-session
  // concurrency limits. Each scrapeAlerts() isolates its own failure -> [].
  const out: any[] = [];
  for (const s of MAUI_SOURCES) {
    out.push(...(await scrapeAlerts(s.url, s.what)));
  }
  return out;
}
