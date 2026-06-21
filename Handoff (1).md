# Build Handoff — Hawaii Evacuation Personalization (CalHacks)

This document is written to be handed to **Claude Code** on a fresh Mac. The team has **never used any of the sponsor tools before**, so every step is explicit. Build in the order given. Do **not** skip ahead to later phases until the current phase's checkpoint passes.

---

## 0. Decisions already made (do not re-litigate)

- Stack: **Node.js + TypeScript**, run directly with `tsx` (no build step).
- Profiles stored in **SQLite** (local file, zero setup). Not Redis.
- Zone matching is **point-in-polygon in code** (Turf.js). Not Redis geo.
- **No Band** (not used).
- Sponsor tools, core: **Browserbase** (scraping), **Anthropic/Claude** (reasoning), **Poke or Twilio** (delivery).
- Sponsor tools, later/optional: **Fetch AI** (orchestrator agent), **Redis** (pub/sub push), **Arize** (evals).
- Delivery: write code against a generic `sendMessage()` function. Primary target is **Poke**; if Poke has no programmatic send API, fall back to **Twilio SMS** (concrete code included).
- Demo geography: **Maui County only**. Do not try to cover all of Hawaii.

### One critical rule for a disaster demo
Real government alert pages will probably show **nothing** during the hackathon (no live disaster). So the project supports two modes:
- **Live mode**: actually scrapes real Maui sources. Proves the capability.
- **Scenario mode**: feeds a seeded set of conflicting alerts for a hypothetical flood. **This is what you demo on stage.** Build scenario mode first; it must always work offline.

### Safety framing (say this to judges, and enforce it in code)
We **never invent or override official orders**. We only (a) reconcile conflicting official channels into one picture, (b) pick among **official** shelters the one that fits the user, and (c) **fail safe** to "follow official guidance" when sources conflict or confidence is low.

---

## 1. What you're building (one paragraph)

When a disaster hits Maui, residents get hit with overlapping, sometimes contradictory alerts (sirens, wireless alerts, county pages, radio), all assuming everyone drives. This app ingests those alerts, uses Claude to reconcile them into one authoritative picture and personalize it to the resident's household profile (a family of five with one car gets different guidance than someone with no vehicle), and delivers one clear instruction to their phone over text.

Pipeline:

```
Sources (NWS API + scraped county pages)
   -> Browserbase (scrape the no-API pages)
   -> Claude (reconcile conflicts + personalize to profile + fail-safe)
   -> sendMessage (Poke or Twilio SMS)
   -> Resident's phone
Profiles + zone matching live alongside, in SQLite + Turf.
```

---

## 2. Accounts to create right now (10 minutes)

Create these before writing code. Each has a free tier. Keep every key in a password manager or scratch file; you'll paste them into `.env` later.

1. **Anthropic** (the reasoning model): go to `https://console.anthropic.com` → sign up → **Settings → API Keys → Create Key**. Copy it. Add a small amount of billing credit ($5 is plenty for a hackathon).
2. **Browserbase** (cloud browsers for scraping): go to `https://www.browserbase.com` → sign up → in the dashboard find **API Key** and **Project ID** (you need both).
3. **Twilio** (SMS fallback / likely primary): go to `https://www.twilio.com/try-twilio` → sign up → from the Console copy **Account SID** and **Auth Token**, then **get a trial phone number** (Console → Phone Numbers → Buy/Get a number). Note: a trial account can only text **verified** numbers, so verify each team member's phone (Console → Phone Numbers → Verified Caller IDs).
4. **Poke / The Interaction Company**: open the sponsor starter pack the hackathon gave you and find out **how to send a message programmatically** (API endpoint or MCP). If it only receives messages and can't send on demand, use Twilio for the demo and mention Poke as the intended consumer channel. **Confirm this at their table early.**

Later phases only (skip for now): Fetch AI (`https://asi1.ai` for the ASI1 key, `https://agentverse.ai` for agents), Redis (`https://redis.io/try-free`), Arize (`https://app.arize.com`).

---

## 3. Phase 0 — machine + repo setup

Run these in Terminal.

```bash
# Check Node is installed and is v20 or newer
node -v

# If missing or older than v20, install via Homebrew:
#   brew install node
# (If Homebrew itself is missing: https://brew.sh)

mkdir maui-evac && cd maui-evac
npm init -y
npm pkg set type="module"

# Core dependencies
npm install @anthropic-ai/sdk @browserbasehq/stagehand better-sqlite3 \
  @turf/boolean-point-in-polygon @turf/helpers twilio express dotenv zod

# Dev tooling (run TypeScript directly, no compile step)
npm install -D tsx typescript @types/node @types/better-sqlite3 @types/express
```

Create the folder layout:

```bash
mkdir -p src/sources data public
touch .env .gitignore
echo "node_modules
.env
*.db" > .gitignore
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": false,
    "skipLibCheck": true,
    "resolveJsonModule": true
  }
}
```

Create `.env` (fill in the keys you collected; leave later-phase ones blank for now):

```
ANTHROPIC_API_KEY=sk-ant-...
BROWSERBASE_API_KEY=bb_...
BROWSERBASE_PROJECT_ID=...
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+1...
# Delivery target for testing (a verified phone, with country code)
TEST_TO_NUMBER=+1...
# Phase 3+ (leave blank for now)
REDIS_URL=
ASI1_API_KEY=
```

Checkpoint 0: `npx tsx -e "console.log('env ok')"` prints `env ok`.

---

## 4. Phase 1 — the walking skeleton (must work before anything else)

Goal: run one command, and a personalized instruction for a test profile reacting to a seeded flood scenario is computed and printed (and optionally texted). No web UI yet, no live scraping required yet.

### 1a. Sample data files

`data/shelters.json` — the **official** shelter list (the only places Claude is allowed to send people):

```json
[
  { "name": "War Memorial Gym", "address": "Wailuku, HI", "lat": 20.8893, "lng": -156.5044, "accessible": true, "pet_friendly": false, "transit_accessible": true },
  { "name": "Lahaina Civic Center", "address": "Lahaina, HI", "lat": 20.8783, "lng": -156.6692, "accessible": true, "pet_friendly": true, "transit_accessible": false },
  { "name": "Kihei Community Center", "address": "Kihei, HI", "lat": 20.7644, "lng": -156.4450, "accessible": true, "pet_friendly": false, "transit_accessible": true }
]
```

`data/zones.geojson` — a few demo evacuation zones as polygons (approximate boxes around Lahaina and Kihei; good enough for a demo):

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": { "zone_name": "Lahaina-1" },
      "geometry": {
        "type": "Polygon",
        "coordinates": [[[-156.69,20.86],[-156.66,20.86],[-156.66,20.89],[-156.69,20.89],[-156.69,20.86]]]
      }
    },
    {
      "type": "Feature",
      "properties": { "zone_name": "Kihei-3" },
      "geometry": {
        "type": "Polygon",
        "coordinates": [[[-156.46,20.74],[-156.43,20.74],[-156.43,20.78],[-156.46,20.78],[-156.46,20.74]]]
      }
    }
  ]
}
```

### 1b. SQLite + profiles

`src/db.ts`:

```ts
import Database from "better-sqlite3";

const db = new Database("app.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    phone TEXT,
    lat REAL,
    lng REAL,
    household_size INTEGER,
    has_car INTEGER,
    mobility_needs TEXT,
    pets INTEGER,
    language TEXT
  );
`);

export function seedProfiles() {
  const count = db.prepare("SELECT COUNT(*) AS n FROM profiles").get() as { n: number };
  if (count.n > 0) return;
  const insert = db.prepare(`INSERT INTO profiles
    (name, phone, lat, lng, household_size, has_car, mobility_needs, pets, language)
    VALUES (@name,@phone,@lat,@lng,@household_size,@has_car,@mobility_needs,@pets,@language)`);
  insert.run({ name: "Family of five", phone: process.env.TEST_TO_NUMBER || "",
    lat: 20.875, lng: -156.675, household_size: 5, has_car: 1, mobility_needs: "none", pets: 1, language: "en" });
  insert.run({ name: "Solo, no car", phone: process.env.TEST_TO_NUMBER || "",
    lat: 20.876, lng: -156.672, household_size: 1, has_car: 0, mobility_needs: "limited", pets: 0, language: "en" });
}

export function getProfile(id: number) {
  return db.prepare("SELECT * FROM profiles WHERE id = ?").get(id);
}

export function allProfiles() {
  return db.prepare("SELECT * FROM profiles").all();
}

export default db;
```

### 1c. Sources — scenario mode (build this first) and NWS live feed

`src/sources/mock.ts` — the seeded conflicting flood scenario you'll demo:

```ts
export function mockAlerts() {
  return [
    { source: "County civil defense", event: "Flash Flood Warning",
      area: "West Maui, Lahaina", severity: "Severe",
      text: "Evacuate low-lying areas immediately. Proceed to higher ground." },
    { source: "Wireless Emergency Alert", event: "Flood Warning",
      area: "Lahaina", severity: "Extreme",
      text: "Move to designated shelters now. Avoid Honoapiilani Highway, flooding reported." },
    { source: "Local radio summary", event: "Advisory",
      area: "Lahaina town", severity: "Moderate",
      text: "Some residents advised to shelter in place; conditions changing." }
  ];
}
```

Note the deliberate **conflict**: one says evacuate, one says shelter in place, and one names a road to avoid. That conflict is what Claude resolves and what makes the demo land.

`src/sources/nws.ts` — a real source that has an API (no scraping needed):

```ts
export async function nwsAlerts() {
  const res = await fetch("https://api.weather.gov/alerts/active?area=HI", {
    headers: { "User-Agent": "calhacks-maui-evac (contact@example.com)" }
  });
  if (!res.ok) return [];
  const data = await res.json() as any;
  return (data.features || []).map((f: any) => ({
    source: "NWS",
    event: f.properties.event,
    area: f.properties.areaDesc,
    severity: f.properties.severity,
    text: f.properties.instruction || f.properties.headline || f.properties.description || ""
  }));
}
```

### 1d. Browserbase scraping (set up the service now)

**Set up Browserbase:** you already have `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` in `.env`. Browserbase runs a real cloud browser; we drive it with **Stagehand**, which lets Claude read a messy page and pull structured data without brittle CSS selectors.

`src/sources/browserbase.ts`:

```ts
import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";

export async function scrapeAlerts(url: string, what: string) {
  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    apiKey: process.env.BROWSERBASE_API_KEY,
    projectId: process.env.BROWSERBASE_PROJECT_ID,
    modelName: "claude-sonnet-4-6",
    modelClientOptions: { apiKey: process.env.ANTHROPIC_API_KEY }
  });

  await stagehand.init();
  try {
    const page = stagehand.page;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const result = await page.extract({
      instruction: `Extract any active emergency alerts about ${what}. For each, return its title/event, the area it affects, and the instruction to residents.`,
      schema: z.object({
        alerts: z.array(z.object({
          event: z.string(),
          area: z.string(),
          text: z.string()
        }))
      })
    });
    return (result.alerts || []).map(a => ({ source: url, severity: "unknown", ...a }));
  } catch (e) {
    console.error("scrape failed:", e);
    return [];
  } finally {
    await stagehand.close();
  }
}
```

Test scraping in isolation before wiring it in:

```bash
npx tsx -e "import('./src/sources/browserbase.ts').then(m => m.scrapeAlerts('https://www.weather.gov/hfo/','Hawaii weather alerts').then(r => console.log(JSON.stringify(r,null,2))))"
```

If this returns an array (even empty) without crashing, Browserbase works. You can watch the live session replay in the Browserbase dashboard, which is a great thing to show judges. (Note: Stagehand's exact API can shift between versions. If `page.extract` errors, run `npm ls @browserbasehq/stagehand`, open its README, and have Claude Code adjust the call to match the installed version.)

> Find the **real Maui source URLs** to scrape from the Maui Emergency Management Agency / County of Maui sites and the Genasys "Active Alerts" page. Put 1–2 of them in a config. These are your live-mode sources; scenario mode does not need them.

### 1e. Claude — reconcile + personalize (the core)

**Set up Anthropic:** `ANTHROPIC_API_KEY` is already in `.env`.

`src/reconcile.ts`:

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function reconcile(profile: any, alerts: any[], shelters: any[], zoneName: string | null) {
  const system = `You are an emergency guidance assistant for Maui County.
You receive (1) multiple, possibly conflicting alerts from official channels, (2) one resident's household profile, (3) the official list of shelters, and (4) the resident's evacuation zone if known.

Hard rules:
- NEVER invent a destination. Only choose from the official shelter list provided.
- NEVER contradict an official evacuation order. If an order says evacuate, do not tell them to stay.
- If the alerts conflict on the core action (evacuate vs shelter in place), or you are not confident, set fail_safe=true and tell the resident to follow official guidance and monitor official channels.
- Personalize: someone with no car needs transit-accessible or pickup options, not a driving route. A family with pets needs a pet-friendly shelter. Mobility needs require accessible shelters.
- Be concise and calm. Output STRICT JSON only, no markdown.`;

  const user = {
    profile, zone: zoneName, alerts, shelters,
    output_schema: {
      authoritative_summary: "string: what is actually being ordered, conflicts resolved",
      applies_to_user: "boolean",
      recommended_action: "string: one clear instruction for THIS resident",
      destination: "string|null: shelter name from the official list, or null",
      how_to_get_there: "string: tailored to their car/mobility situation",
      confidence: "number 0..1",
      fail_safe: "boolean",
      reasoning: "string: short"
    }
  };

  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    system,
    messages: [{ role: "user", content: JSON.stringify(user) }]
  });

  const textBlock = msg.content.find((c: any) => c.type === "text") as any;
  let raw = textBlock?.text?.trim() || "{}";
  raw = raw.replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  try { return JSON.parse(raw); }
  catch { return { fail_safe: true, recommended_action: "Follow official guidance and monitor local emergency channels.", confidence: 0, reasoning: "parse_error" }; }
}
```

### 1f. Zone matching (point-in-polygon, in code)

`src/zones.ts`:

```ts
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";
import { readFileSync } from "fs";

const zones = JSON.parse(readFileSync("data/zones.geojson", "utf8"));

export function zoneForPoint(lng: number, lat: number): string | null {
  const p = point([lng, lat]);
  for (const f of zones.features) {
    if (booleanPointInPolygon(p, f)) return f.properties.zone_name;
  }
  return null;
}
```

### 1g. Delivery (Twilio concrete, Poke adapter)

**Set up Twilio:** keys already in `.env`, and you've verified your test phone. (If your team's Poke starter pack documents a send API, write `sendViaPoke` to call it and switch `sendMessage` to use it; otherwise Twilio is the live demo channel.)

`src/deliver.ts`:

```ts
import twilio from "twilio";

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function sendViaTwilio(to: string, body: string) {
  return client.messages.create({ from: process.env.TWILIO_FROM_NUMBER, to, body });
}

async function sendViaPoke(to: string, body: string) {
  // TODO: fill in from the Poke starter pack if it exposes a send endpoint.
  throw new Error("Poke send not configured");
}

export async function sendMessage(to: string, body: string) {
  try { return await sendViaPoke(to, body); }
  catch { return await sendViaTwilio(to, body); }
}
```

### 1h. Wire the pipeline and run it

`src/pipeline.ts`:

```ts
import "dotenv/config";
import db, { seedProfiles, getProfile, allProfiles } from "./db.js";
import { mockAlerts } from "./sources/mock.js";
import { nwsAlerts } from "./sources/nws.js";
import { reconcile } from "./reconcile.js";
import { zoneForPoint } from "./zones.js";
import { sendMessage } from "./deliver.js";
import { readFileSync } from "fs";

const shelters = JSON.parse(readFileSync("data/shelters.json", "utf8"));

async function gatherAlerts(mode: string) {
  if (mode === "scenario") return mockAlerts();
  const live = await nwsAlerts();
  return live.length ? live : mockAlerts();
}

async function runForProfile(p: any, mode: string, doSend: boolean) {
  const alerts = await gatherAlerts(mode);
  const zone = zoneForPoint(p.lng, p.lat);
  const result = await reconcile(p, alerts, shelters, zone);

  console.log("\n=====", p.name, "(zone:", zone, ") =====");
  console.log(JSON.stringify(result, null, 2));

  if (doSend && p.phone) {
    const body = `${result.recommended_action}` +
      (result.destination ? `\nGo to: ${result.destination}.` : "") +
      (result.how_to_get_there ? `\n${result.how_to_get_there}` : "") +
      (result.fail_safe ? `\n(Follow official guidance; this is advisory.)` : "");
    await sendMessage(p.phone, body);
    console.log("[sent to", p.phone + "]");
  }
}

async function main() {
  seedProfiles();
  const mode = process.argv.includes("--live") ? "live" : "scenario";
  const doSend = process.argv.includes("--send");
  for (const p of allProfiles() as any[]) await runForProfile(p, mode, doSend);
}

main();
```

Run it:

```bash
# Compute only (safe, no texts) — scenario mode
npx tsx src/pipeline.ts

# Actually send texts to the verified phone
npx tsx src/pipeline.ts --send

# Try live mode (uses NWS; falls back to scenario if nothing active)
npx tsx src/pipeline.ts --live
```

### ✅ Checkpoint 1 (do not proceed until this passes)
Running `npx tsx src/pipeline.ts` prints **two different** recommendations for the two profiles from the **same** alerts: the family-with-car gets a driving instruction to a shelter; the solo-no-car person gets a transit/pickup-oriented instruction. That divergence is the entire pitch. If `--send` is set, a text actually arrives. If this works, you have a submittable project.

---

## 5. Phase 2 — make it real (only after Checkpoint 1)

### 2a. Profile web form
A minimal page so judges can create a profile live and watch the output change.

`public/index.html`:

```html
<!doctype html>
<meta charset="utf-8">
<title>Maui Evac</title>
<style>body{font-family:system-ui;max-width:560px;margin:40px auto;padding:0 16px}
label{display:block;margin:8px 0 2px}input,select{width:100%;padding:8px}
button{margin-top:16px;padding:10px 16px}pre{background:#f4f4f4;padding:12px;white-space:pre-wrap}</style>
<h1>Maui evacuation guidance</h1>
<label>Name</label><input id="name">
<label>Phone (+1...)</label><input id="phone">
<label>Latitude</label><input id="lat" value="20.875">
<label>Longitude</label><input id="lng" value="-156.675">
<label>Household size</label><input id="household_size" type="number" value="1">
<label>Has a car?</label><select id="has_car"><option value="1">Yes</option><option value="0">No</option></select>
<label>Mobility needs</label><input id="mobility_needs" value="none">
<label>Pets?</label><select id="pets"><option value="0">No</option><option value="1">Yes</option></select>
<button onclick="run()">Get my instruction</button>
<pre id="out"></pre>
<script>
async function run(){
  const get = id => document.getElementById(id).value;
  const body = { name:get('name'), phone:get('phone'), lat:+get('lat'), lng:+get('lng'),
    household_size:+get('household_size'), has_car:+get('has_car'),
    mobility_needs:get('mobility_needs'), pets:+get('pets'), language:'en' };
  const r = await fetch('/api/advise',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  document.getElementById('out').textContent = JSON.stringify(await r.json(), null, 2);
}
</script>
```

`src/server.ts`:

```ts
import "dotenv/config";
import express from "express";
import { reconcile } from "./reconcile.js";
import { zoneForPoint } from "./zones.js";
import { mockAlerts } from "./sources/mock.js";
import { nwsAlerts } from "./sources/nws.js";
import { readFileSync } from "fs";

const shelters = JSON.parse(readFileSync("data/shelters.json", "utf8"));
const app = express();
app.use(express.json());
app.use(express.static("public"));

app.post("/api/advise", async (req, res) => {
  const p = req.body;
  const alerts = req.query.live ? (await nwsAlerts()) : mockAlerts();
  const zone = zoneForPoint(p.lng, p.lat);
  const result = await reconcile(p, alerts.length ? alerts : mockAlerts(), shelters, zone);
  res.json({ zone, ...result });
});

app.listen(3000, () => console.log("http://localhost:3000"));
```

Run: `npx tsx src/server.ts`, open `http://localhost:3000`, flip "Has a car" between Yes/No and watch the instruction change. That is your live demo.

### 2b. More sources
Add your 1–2 real Maui scrape URLs via `scrapeAlerts()` and merge them into the alert list in both `pipeline.ts` and `server.ts`. Keep scenario mode as the default demo path.

### 2c. Fetch AI orchestrator (sponsor prize)
This is optional and exists mainly for the Fetch prize. Two ways, easiest first:
- **Light path (recommended under time pressure):** sign up at `https://asi1.ai`, get an ASI1 API key, and route the reconcile call through ASI1 instead of (or in addition to) Anthropic for one step, so you can legitimately say you used Fetch's model. Document it.
- **Full path (more impressive, more work, Python):** build a Fetch `uAgent` (their Python framework, see `https://agentverse.ai`) that receives a profile + location, calls your Node pipeline over HTTP, and returns the instruction. Only do this if Phase 2a–2b are solid and you have hours to spare. Talk to the Fetch table; they'll have a starter template.

### 2d. Fail-safe verification
Add a test where the alerts flatly contradict each other on evacuate-vs-stay and confirm Claude returns `fail_safe: true`. Show this to judges: it's your safety story.

### ✅ Checkpoint 2
Web form works, at least one real scraped source feeds the pipeline, and the fail-safe triggers on a contradictory scenario.

---

## 6. Phase 3 — optional add-ons (only if time remains)

Each is self-contained; adding it must not touch the core path.

**Redis (pub/sub push):** sign up at `https://redis.io/try-free`, create a database, copy the connection URL into `REDIS_URL`. `npm install redis`. On the publish side, after computing a new reconciled state, `PUBLISH alerts:<zone> <json>`. On the subscribe side, a small listener pushes to connected clients. Demo it as "the instant a new alert lands, subscribed residents get pinged." Keep it entirely separate from the request path.

**Arize (evals):** the most involved one. Use it to score the reconcile outputs (did it pick a valid official shelter, did it fail safe when it should). Check the Arize starter pack for the fastest path; their open-source **Phoenix** tracer is the quickest local option but is Python, so weigh that against your Node stack. If short on time, skip.

---

## 7. Demo script (90 seconds)

1. "Maui residents get five conflicting alerts at once, all assuming you drive." Show the three seeded alerts (evacuate / shelter-in-place / avoid-road).
2. Open the web form as **family of five, has car** → submit → read the driving instruction to a pet-friendly shelter.
3. Change to **solo, no car, limited mobility** → submit → the instruction changes to a transit/pickup option at an accessible shelter. **This side-by-side is the moment.**
4. Trigger `--send` so a real text lands on a judge's verified phone (or yours).
5. Show the Browserbase session replay (proves real scraping) and the fail-safe case (contradictory alerts → "follow official guidance").
6. One line: "We don't replace Genasys; we're the personalization-and-disambiguation layer on top of official feeds, and we fail safe."

---

## 8. Non-negotiable safety rules (enforce in code and say out loud)
- Destinations come **only** from `data/shelters.json`. Never free-text a location.
- Never output "shelter in place" when any official alert says evacuate.
- On conflict or low confidence: `fail_safe: true`, advise following official guidance.
- Always show the resident which official alert the advice is based on.1

---

## 9. Gotchas
- Twilio trial can only text **verified** numbers and prepends a trial notice. Verify phones early.
- US SMS may require A2P registration for non-trivial volume; for a demo, trial + verified numbers avoids this. Lean on voice/Twilio for the live send.
- Stagehand's API changes across versions; if `page.extract` fails, check the installed version's README and adjust.
- Live gov pages may have **no active alerts** during the hackathon — that's expected; demo in scenario mode.
- Keep `.env` out of git (already in `.gitignore`). Never paste keys into the Devpost writeup.

---

## Appendix — repo tree

```
maui-evac/
  .env
  tsconfig.json
  data/
    shelters.json
    zones.geojson
  public/
    index.html
  src/
    db.ts
    reconcile.ts
    zones.ts
    deliver.ts
    pipeline.ts
    server.ts
    sources/
      mock.ts
      nws.ts
      browserbase.ts
```

Build Phase 1 top to bottom, hit Checkpoint 1, then move on. A working scenario-mode demo with two diverging profiles beats a half-built app with every sponsor wired in.
