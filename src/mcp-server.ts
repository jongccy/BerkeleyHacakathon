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
import { mauiScrapedAlerts } from "./sources/maui.js";

// Poke (and any MCP client) connects to this server's /sse endpoint and can call
// the tool below. This is the two-way, adaptive path: a resident texts their Poke
// "flood warning, no car, I have a dog — what do I do?", Poke calls
// get_evacuation_guidance, and replies with the personalized, fail-safe instruction.
const shelters = JSON.parse(readFileSync("data/shelters.json", "utf8"));

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
