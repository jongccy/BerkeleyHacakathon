import "dotenv/config";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { readFileSync } from "fs";
import { reconcile } from "./reconcile.js";
import { zoneForPoint } from "./zones.js";
import { geocodeAddress } from "./geocode.js";
import { mockAlerts } from "./sources/mock.js";
import { nwsAlerts } from "./sources/nws.js";
import { mauiScrapedAlerts, demoFloodAlerts } from "./sources/maui.js";
import { startScenario, stopScenario, isScenarioActive, setScenarioTime, advanceScenario, scenarioSnapshot, setActiveProfile, getActiveProfile } from "./sources/scenario.js";

// Poke (and any MCP client) connects to this server's /sse endpoint and can call
// the tool below. This is the two-way, adaptive path: a resident texts their Poke
// "flood warning, no car, I have a dog — what do I do?", Poke calls
// get_evacuation_guidance, and replies with the personalized, fail-safe instruction.
const shelters = JSON.parse(readFileSync("data/shelters.json", "utf8"));

// Demo arming: an MCP tool can't push to Poke on its own (MCP is pull-only). The
// proactive "Poke texts you first" flow is a Poke automation that polls
// check_active_threats on a timer and messages you when it reports an active
// threat. To prove that on stage without waiting for a real tsunami, set_demo_disaster
// arms a simulated Lahaina flood; the next poll then trips and Poke alerts you.
let demoArmed = false;

// When armed, Browserbase discovers + reads the top news articles for the event
// (demoFloodAlerts -> discoverAlerts). That takes minutes, so we run it in the
// BACKGROUND on arming and cache the result — the tool calls (which Poke awaits)
// never block on the scrape. Polls before discovery finishes report quiet; the
// first poll after it completes surfaces the threat. Falls back to mockAlerts so
// the demo can never come up empty.
let demoAlertsCache: any[] | null = null;
let demoDiscoveryInFlight = false;

function startDemoDiscovery() {
  if (demoDiscoveryInFlight || demoAlertsCache) return;
  demoDiscoveryInFlight = true;
  console.log("[demo] background discovery started — Browserbase searching Google News and reading the top articles...");
  demoFloodAlerts()
    .then((alerts) => {
      if (!alerts.length) {
        console.warn("[demo] discovery empty — falling back to seeded mockAlerts.");
        alerts = mockAlerts();
      }
      demoAlertsCache = alerts;
      console.log(`[demo] discovery complete: ${alerts.length} alerts cached.`);
    })
    .catch((e) => {
      console.error("[demo] discovery failed:", (e as Error).message);
      demoAlertsCache = mockAlerts();
    })
    .finally(() => { demoDiscoveryInFlight = false; });
}

// What counts as an evacuation-relevant threat. Deliberately trips on warning/
// emergency-grade events, not routine advisories, so the watcher doesn't cry wolf.
const THREAT_RE = /tsunami warning|flash flood|flood warning|flood emergency|hurricane warning|high surf warning|red flag|wildfire|evacuat|coastal flood warning/i;
function isThreat(a: any): boolean {
  const sev = String(a.severity || "").toLowerCase();
  const text = `${a.event || ""} ${a.text || ""}`;
  // Scraped pages report severity "unknown"; trust the event/text match there.
  // For NWS (which has severity), require Severe/Extreme to avoid minor warnings.
  const severeEnough = sev === "unknown" || sev === "severe" || sev === "extreme";
  return THREAT_RE.test(text) && severeEnough;
}

// Latest reconciled scenario guidance, cached so GET /demo-state (which the web app
// polls) is cheap — no LLM call per poll. Updated whenever a scenario tool runs.
let lastGuidance: any = null;

// Derive a short, checkable task list from the guidance + feed road closures, for the
// app's "tasks" panel.
function deriveTasks(result: any, snap: any): string[] {
  const tasks: string[] = [];
  if (result?.recommended_action) tasks.push(result.recommended_action);
  if (result?.destination) tasks.push(`Head to ${result.destination}`);
  const closures = (snap?.alerts || []).filter((a: any) => a.type === "road_closure" && a.raw?.status !== "reopened");
  const roads = [...new Set(closures.flatMap((a: any) => a.raw?.roads || []))];
  if (roads.length) tasks.push(`Avoid closed roads: ${roads.slice(0, 4).join(", ")}`);
  return tasks;
}

function buildServer() {
  const server = new McpServer({ name: "maui-evac", version: "1.0.0" });

  server.registerTool(
    "get_evacuation_guidance",
    {
      title: "Get Maui evacuation guidance",
      description:
        "Given a Maui resident's home address and household situation, reconcile the current official emergency alerts and return ONE personalized, fail-safe evacuation instruction. Destinations come only from the official shelter list; never invents a location. Use this whenever a resident on Maui asks what to do during a flood, wildfire, high surf, or other emergency.",
      inputSchema: {
        address: z.string().describe("Home address on Maui, e.g. 'Lahaina, HI'"),
        household_size: z.number().int().min(1).default(1).describe("Number of people in the household"),
        has_car: z.boolean().default(true).describe("Whether the household has access to a vehicle"),
        mobility_needs: z.string().default("none").describe("Mobility needs, e.g. 'none', 'limited', 'wheelchair'"),
        pets: z.boolean().default(false).describe("Whether the household has pets"),
        live: z.boolean().default(false).describe("If true, pull live NWS + scraped Maui alerts; otherwise use the seeded demo scenario")
      }
    },
    async ({ address, household_size, has_car, mobility_needs, pets, live }) => {
      console.log(`[tool call] get_evacuation_guidance`, JSON.stringify({ address, household_size, has_car, mobility_needs, pets, live, scenario: isScenarioActive() }));

      // If the East Maui scenario is playing, answer reactive questions from it too
      // (current moment, no clock advance) so Poke is consistent across both tools.
      if (isScenarioActive()) {
        const snap = scenarioSnapshot();
        const news = demoAlertsCache || [];
        const merged = [...snap.alerts, ...news];
        const zoneLabel = "Haiku (Kaupakalua Dam downstream corridor)";
        const result = await reconcile(snap.profile, merged, snap.shelters, zoneLabel);
        lastGuidance = result;   // cache for GET /demo-state (web app polls it)
        return { content: [{ type: "text", text: JSON.stringify({
          scenario_time: snap.clockIso,
          family_position: snap.position ? { lat: snap.position.lat, lng: snap.position.lng } : "at home",
          sources: { official_feed: snap.alerts.length, web_articles_browserbase: news.length },
          zone: zoneLabel, ...result
        }, null, 2) }] };
      }

      const geo = await geocodeAddress(address);
      if (!geo) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `Could not locate "${address}". Include city and state, e.g. "Lahaina, HI".` }) }],
          isError: true
        };
      }

      const zone = zoneForPoint(geo.lng, geo.lat);

      let alerts: any[];
      if (live) {
        const [nws, scraped] = [await nwsAlerts(), await mauiScrapedAlerts()];
        alerts = [...nws, ...scraped];
        if (!alerts.length) alerts = mockAlerts();
      } else {
        alerts = mockAlerts();
      }

      const profile = {
        lat: geo.lat, lng: geo.lng,
        household_size, has_car: has_car ? 1 : 0,
        mobility_needs, pets: pets ? 1 : 0, language: "en"
      };

      const result = await reconcile(profile, alerts, shelters, zone);
      return {
        content: [{ type: "text", text: JSON.stringify({ resolved: { address, ...geo }, zone, ...result }, null, 2) }]
      };
    }
  );

  // PROACTIVE PATH. A Poke automation polls this on a timer; it returns an honest
  // "no_active_threat" when nothing real is happening, and only when a genuine
  // (or armed-demo) threat trips does it return active_threat + personalized
  // guidance for Poke to text the resident. This is what turns the app from
  // "ask and you shall receive" into "we warn you first".
  server.registerTool(
    "check_active_threats",
    {
      title: "Check for active Maui disasters",
      description:
        "Poll this on a schedule to proactively watch for emergencies near a Maui resident. Returns status 'no_active_threat' when there is nothing serious, or 'active_threat' with a personalized, fail-safe evacuation instruction when a real (warning/emergency-grade) flood, tsunami, hurricane, wildfire, or evacuation order affects their area. When status is 'active_threat', immediately text the resident the recommended_action. When 'no_active_threat', do nothing.",
      inputSchema: {
        address: z.string().describe("Home address on Maui, e.g. 'Lahaina, HI'"),
        household_size: z.number().int().min(1).default(1).describe("Number of people in the household"),
        has_car: z.boolean().default(true).describe("Whether the household has access to a vehicle"),
        mobility_needs: z.string().default("none").describe("Mobility needs, e.g. 'none', 'limited', 'wheelchair'"),
        pets: z.boolean().default(false).describe("Whether the household has pets")
      }
    },
    async ({ address, household_size, has_car, mobility_needs, pets }) => {
      console.log(`[tool call] check_active_threats`, JSON.stringify({ address, demoArmed, scenario: isScenarioActive() }));

      // SCENARIO MODE (East Maui / Kaupakalua feed) takes precedence. Advance the
      // clock each poll so guidance evolves; reconcile over the situation feed +
      // the feed's shelters, personalized to the family's CURRENT GPS position.
      if (isScenarioActive()) {
        advanceScenario();
        const snap = scenarioSnapshot();
        // Merge the OFFICIAL situation feed (evolving by clock) with what BROWSERBASE
        // found on the web for this same event (cached once discovery completes).
        // reconcile sees both — official timeline + real news — and personalizes to GPS.
        const news = demoAlertsCache || [];
        const merged = [...snap.alerts, ...news];
        const threats = merged.filter(isThreat);
        if (!threats.length) {
          return { content: [{ type: "text", text: JSON.stringify({ status: "no_active_threat", scenario_time: snap.clockIso, news_ready: !!demoAlertsCache, checked: merged.length }) }] };
        }
        const zoneLabel = "Haiku (Kaupakalua Dam downstream corridor)";
        const result = await reconcile(snap.profile, merged, snap.shelters, zoneLabel);
        lastGuidance = result;   // cache for GET /demo-state (web app polls it)
        return { content: [{ type: "text", text: JSON.stringify({
          status: "active_threat",
          scenario_time: snap.clockIso,
          family_position: snap.position ? { lat: snap.position.lat, lng: snap.position.lng, speed_mph: snap.position.speed_mph } : "at home",
          sources: { official_feed: snap.alerts.length, web_articles_browserbase: news.length, news_ready: !!demoAlertsCache },
          threats: threats.slice(0, 8).map((t: any) => `[${t.source}] ${t.event}${t.issued_at ? " @ " + t.issued_at : ""}`),
          ...result
        }, null, 2) }] };
      }

      const geo = await geocodeAddress(address);
      if (!geo) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: `Could not locate "${address}".` }) }], isError: true };
      }
      const zone = zoneForPoint(geo.lng, geo.lat);

      // Live sources only — NO scenario fallback, so "quiet" reads as quiet.
      // When armed, use the background-discovered alerts (Browserbase reads the top
      // news articles for the event). While discovery is still running, report quiet.
      let alerts: any[];
      if (demoArmed) {
        if (!demoAlertsCache) {
          startDemoDiscovery();   // idempotent; begins gathering if not already
          return { content: [{ type: "text", text: JSON.stringify({ status: "no_active_threat", zone, demo_armed: true, note: "Demo armed — Browserbase is searching Google News and reading the top reports. The next check will surface the threat." }) }] };
        }
        alerts = demoAlertsCache;
      } else {
        const [nws, scraped] = [await nwsAlerts(), await mauiScrapedAlerts()];
        alerts = [...nws, ...scraped];
      }

      // isThreat decides IF there's an active emergency. But once one is detected we
      // reconcile over the FULL scraped set — so conflicting notices (evacuate vs
      // shelter-in-place), road closures, and shelter locations all inform the
      // personalized guidance. That conflict-resolution is the core of the pitch.
      const threats = alerts.filter(isThreat);
      if (!threats.length) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "no_active_threat", zone, checked: alerts.length, demo_armed: demoArmed }) }] };
      }

      const profile = {
        lat: geo.lat, lng: geo.lng,
        household_size, has_car: has_car ? 1 : 0,
        mobility_needs, pets: pets ? 1 : 0, language: "en"
      };
      const result = await reconcile(profile, alerts, shelters, zone);
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "active_threat", zone, threats: threats.map(t => `[${t.source}] ${t.event}${t.issued_at ? " @ " + t.issued_at : ""}`), ...result }, null, 2) }]
      };
    }
  );

  // Demo control: arm/disarm a simulated Lahaina flood so the proactive push can
  // be shown live. Real detection is unaffected when disarmed.
  server.registerTool(
    "set_demo_disaster",
    {
      title: "Arm or disarm a simulated Maui disaster (demo only)",
      description:
        "Demo control. Call with armed=true to simulate an active Lahaina flood emergency, so the next check_active_threats poll trips and the proactive alert fires. Call with armed=false to return to real live monitoring.",
      inputSchema: {
        armed: z.boolean().describe("true = simulate an active disaster; false = real monitoring")
      }
    },
    async ({ armed }) => {
      demoArmed = armed;
      demoAlertsCache = null;   // drop any prior discovery so a fresh arming re-gathers
      if (armed) startDemoDiscovery();   // begin Browserbase discovery now, in the background
      console.log(`[tool call] set_demo_disaster armed=${armed}`);
      return { content: [{ type: "text", text: JSON.stringify({ demo_armed: demoArmed, note: armed ? "ARMED — Browserbase is now searching Google News and reading the top reports in the background (~a few minutes). Once done, the next check_active_threats poll will report active_threat." : "Disarmed — back to real live monitoring." }) }] };
    }
  );

  // Scenario control: play the real East Maui (Kaupakalua Dam, Mar 2021) situation
  // feed through the tools. Each subsequent check_active_threats poll advances the
  // scenario clock, so the guidance evolves (warning -> evacuate -> all clear) and
  // tracks the family's GPS position. Optionally jump to a specific time with `at`.
  server.registerTool(
    "set_demo_scenario",
    {
      title: "Play/stop the East Maui (Kaupakalua Dam) scenario",
      description:
        "Demo control for the East Maui Kaupakalua Dam flood scenario. Call with active=true to start playing the real situation feed; each later check_active_threats poll advances the timeline so guidance evolves and follows the family's GPS position. Pass at='HH:MM' (HST, e.g. '14:42') to jump to a specific moment. Call active=false to stop.",
      inputSchema: {
        active: z.boolean().describe("true = play the East Maui scenario; false = stop"),
        at: z.string().optional().describe("Optional scenario time to jump to, 'HH:MM' HST (e.g. '14:42' = imminent dam failure)")
      }
    },
    async ({ active, at }) => {
      if (!active) {
        stopScenario();
        console.log(`[tool call] set_demo_scenario active=false`);
        return { content: [{ type: "text", text: JSON.stringify({ scenario_active: false, note: "East Maui scenario stopped." }) }] };
      }
      startScenario(at);
      if (at) setScenarioTime(at);
      startDemoDiscovery();   // ALSO kick off Browserbase in the background — its web
                              // findings for this same event merge into the guidance.
      console.log(`[tool call] set_demo_scenario active=true at=${at || "start"}`);
      return { content: [{ type: "text", text: JSON.stringify({ scenario_active: true, at: at || "start", note: "East Maui (Kaupakalua Dam) demo started. The official situation feed + family GPS are live now; Browserbase is reading the real news articles in the background (~3 min) and will merge into the guidance. Each check_active_threats poll advances the timeline." }) }] };
    }
  );

  return server;
}

const app = express();

// Permissive CORS so the web app (served from :3000) can call the bridge endpoints
// (/profile, /demo-state) on this server (:3333). Harmless for the SSE/MCP routes.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

// BRIDGE: the web app POSTs the onboarded household here; the scenario personalizes
// to it (express.json only on this route — /messages must read its raw body).
app.post("/profile", express.json(), (req, res) => {
  setActiveProfile(req.body || null);
  const p = req.body || {};
  console.log(`[profile] active profile set: ${JSON.stringify({ name: p.name, has_car: p.has_car, pets: p.pets, mobility_needs: p.mobility_needs, household_size: p.household_size })}`);
  res.json({ ok: true, persona: p.name || "household" });
});

// BRIDGE: the web app polls this to mirror what Poke sees — map position, news feed,
// and tasks — all driven by the same scenario clock Poke advances. Cheap (no LLM).
app.get("/demo-state", (_req, res) => {
  if (!isScenarioActive()) { res.json({ active: false }); return; }
  const snap = scenarioSnapshot();
  const news = demoAlertsCache || [];
  res.json({
    active: true,
    scenario_time: snap.clockIso,
    persona: snap.persona,
    position: snap.position
      ? { lat: snap.position.lat, lng: snap.position.lng, speed_mph: snap.position.speed_mph, heading_deg: snap.position.heading_deg }
      : null,
    shelters: snap.shelters,
    news: [...snap.alerts].reverse().slice(0, 12).map((a: any) => ({ source: a.source, event: a.event, area: a.area, text: a.text, severity: a.severity, issued_at: a.issued_at })),
    web_articles: news.slice(0, 8).map((a: any) => ({ source: a.source, event: a.event, text: a.text })),
    guidance: lastGuidance,
    tasks: lastGuidance ? deriveTasks(lastGuidance, snap) : [],
  });
});

// One SSE transport per client connection, keyed by the transport's sessionId.
// Note: we deliberately do NOT mount express.json() — SSEServerTransport reads the
// raw POST body itself on /messages.
const transports: Record<string, SSEServerTransport> = {};

app.get("/sse", async (_req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => { delete transports[transport.sessionId]; });
  await buildServer().connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = String(req.query.sessionId || "");
  const transport = transports[sessionId];
  if (!transport) { res.status(400).send("No active SSE session for that sessionId"); return; }
  await transport.handlePostMessage(req, res);
});

app.get("/", (_req, res) => res.type("text").send("Maui Evac MCP server. Connect an MCP client to /sse"));

const PORT = Number(process.env.MCP_PORT) || 3333;
app.listen(PORT, () => console.log(`Maui Evac MCP server: http://localhost:${PORT}/sse`));
