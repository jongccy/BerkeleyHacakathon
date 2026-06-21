# Maui Evac — personalized evacuation guidance

Maui County residents get a flood of **conflicting** official alerts at once (evacuate / shelter-in-place / avoid-this-road), almost all assuming you drive. Maui Evac ingests those alerts, uses Claude to **reconcile the conflicts**, **personalizes** the result to one household (car, mobility needs, pets, location), and delivers a single clear instruction.

The pitch: from the **same** alerts, a family-with-a-car and a solo resident-with-no-car get **different** instructions — and the system **fails safe** when alerts genuinely contradict.

> We don't replace official systems (e.g. Genasys). We're the personalization-and-disambiguation layer on top of official feeds, and we fail safe.

## Setup

1. `npm install`
2. Create `.env` (already gitignored) with these keys:
   - `ANTHROPIC_API_KEY` — reconcile + personalization (required)
   - `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` — live scraping (live mode only)
   - `POKE_API_KEY` — SMS-style delivery (only needed for `--send`)
   - `TEST_TO_NUMBER` — delivery target for testing
   - `ASI1_API_KEY` — optional; enables the Fetch ASI:One provider (see below)
   - `GOOGLE_MAPS_API_KEY` — optional; enables Google address autocomplete in the web form (see below)

## Run

```bash
# Scenario mode (default) — seeded conflicting flood alerts. Offline, fast, the demo path.
npx tsx src/pipeline.ts

# Live mode — National Weather Service API + real Maui pages scraped via Browserbase,
# falling back to scenario alerts if nothing is active (common; that's expected).
npx tsx src/pipeline.ts --live

# Also deliver each instruction via Poke (SMS-style):
npx tsx src/pipeline.ts --send

# Web form — enter a home ADDRESS and watch the instruction change.
npx tsx src/server.ts   # http://localhost:3000
# POST /api/advise (scenario by default; add ?live=1 for live sources)
```

The form takes a **home address**, resolves it to coordinates, matches the evacuation zone, and personalizes from there. The response echoes the `resolved` coordinates and matched `zone`.

**Address entry has two modes:**
- **Google autocomplete (recommended):** set `GOOGLE_MAPS_API_KEY` and the form shows Google Places suggestions as you type. The submit button stays disabled until you pick a real, validated address, and the exact Google coordinates are sent — so only valid addresses are ever submitted.
- **Fallback (no key):** a plain text box; the server geocodes whatever you type (Photon/Open-Meteo). A bad address returns `422` with a friendly message.

### Enabling Google address autocomplete
1. In the [Google Cloud Console](https://console.cloud.google.com/): create/select a project and **enable billing** (required by Google Maps Platform; there's a generous free monthly credit).
2. Enable two APIs: **Maps JavaScript API** and **Places API (New)**.
3. **APIs & Services → Credentials → Create credentials → API key.** Restrict it: *Application restrictions → HTTP referrers* → add `http://localhost:3000/*` (and your demo domain); *API restrictions* → Maps JavaScript API + Places API.
4. Put it in `.env` as `GOOGLE_MAPS_API_KEY=...` and restart the server. The form auto-detects it via `GET /api/config`.

Uses the current `PlaceAutocompleteElement` API (the legacy `Autocomplete` widget is blocked for keys created after March 2025).

## Modes & sources

- **scenario** (default): `src/sources/mock.ts` — three seeded, conflicting alerts. Always works offline; use it for the demo.
- **live**: `src/sources/nws.ts` (NWS active alerts for HI) + `src/sources/maui.ts` (real Maui County MEMA + Hawai‘i EMA pages, scraped with Browserbase/Stagehand). Government pages often have no active alerts during a demo — that's expected, and the pipeline falls back to scenario alerts.
- **geocoding**: `src/geocode.ts` turns a typed address into coordinates using **keyless** providers — Photon (OpenStreetMap; handles street addresses) with an Open-Meteo fallback for place names. No API key or signup. (The main Nominatim instance blocks datacenter IPs, so it is intentionally not used.)

## LLM provider (Fetch ASI:One — sponsor path)

The reconcile step runs on Anthropic (`claude-sonnet-4-6`) by default. To route it through **Fetch's ASI:One** model instead (OpenAI-compatible API), set the key and opt in:

```bash
LLM_PROVIDER=asi1 npx tsx src/pipeline.ts          # uses ASI1_API_KEY, model asi1-mini
LLM_PROVIDER=asi1 ASI1_MODEL=asi1-mini npx tsx ...  # override model if needed
```

If `LLM_PROVIDER=asi1` is set but `ASI1_API_KEY` is empty, reconcile logs a warning and falls back to Anthropic so the demo never hard-fails.

## Non-negotiable safety rules (enforced in `src/reconcile.ts`)

- Destinations come **only** from `data/shelters.json` — never a free-texted location.
- Never output "shelter in place" when any official alert orders evacuate.
- On conflict or low confidence: `fail_safe: true`, advise following official guidance.
- Always surface which official alert the advice is based on (`authoritative_summary`).

## Architecture

```
src/
  pipeline.ts          CLI runner (--live, --send)
  server.ts            Express web form + POST /api/advise (?live)
  reconcile.ts         Claude/ASI:One call -> strict JSON, safety rules
  geocode.ts           home address -> lat/lng (Photon + Open-Meteo, keyless)
  zones.ts             point-in-polygon zone match (Turf.js)
  deliver.ts           Poke webhook (SMS-style delivery)
  db.ts                SQLite profiles (two seeded demo households)
  sources/
    mock.ts            seeded conflicting scenario (demo default)
    nws.ts             National Weather Service active alerts (live)
    maui.ts            real Maui/HI emergency pages via Browserbase (live)
    browserbase.ts     Stagehand scraper (model: claude-haiku-4-5)
data/
  shelters.json        official shelter list (only valid destinations)
  zones.geojson        evacuation zone polygons
public/index.html      profile web form
```
