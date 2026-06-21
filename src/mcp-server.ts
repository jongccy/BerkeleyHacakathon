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
      console.log(`[tool call] get_evacuation_guidance`, JSON.stringify({ address, household_size, has_car, mobility_needs, pets, live }));
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
      console.log(`[tool call] check_active_threats`, JSON.stringify({ address, demoArmed }));
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

  return server;
}

const app = express();

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
