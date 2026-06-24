import "dotenv/config";
import express from "express";
import { reconcile } from "./reconcile.js";
import { zoneForPoint } from "./zones.js";
import { mockAlerts } from "./sources/mock.js";
import { nwsAlerts } from "./sources/nws.js";
import { mauiScrapedAlerts } from "./sources/maui.js";
import { geocodeAddress, suggestAddresses } from "./geocode.js";
import { readDataFile } from "./data-path.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const shelters = JSON.parse(readDataFile("shelters.json"));
const app = express();
app.use(express.json());

if (process.env.VERCEL) {
  app.use(express.static(PUBLIC_DIR));
} else {
  app.use(express.static("public"));
}

/** Register API route for local (/api/…) and Vercel (prefix stripped to /…). */
function onApi(method: "get" | "post", path: string, ...handlers: express.RequestHandler[]) {
  app[method](path, ...handlers);
  if (process.env.VERCEL && path.startsWith("/api")) {
    app[method](path.slice(4) || "/", ...handlers);
  }
}

onApi("post", "/api/advise", async (req, res) => {
  try {
    const p = req.body;

    // Resolve a typed home address to coordinates. Explicit numeric lat/lng (e.g.
    // from the CLI) still work and skip geocoding.
    if (p.address && (typeof p.lat !== "number" || typeof p.lng !== "number")) {
      const geo = await geocodeAddress(p.address);
      if (!geo) {
        return res.status(422).json({
          error: `Could not locate "${p.address}". Try selecting an address from the suggestions.`,
        });
      }
      p.lat = geo.lat;
      p.lng = geo.lng;
    }
    if (typeof p.lat !== "number" || typeof p.lng !== "number") {
      return res.status(400).json({ error: "Provide a home address." });
    }

    // Default (no ?live) is scenario mode — the fast, offline demo path.
    // ?live merges the NWS API with real Maui pages scraped via Browserbase.
    let alerts;
    if (req.query.live) {
      const [live, scraped] = [await nwsAlerts(), await mauiScrapedAlerts()];
      alerts = [...live, ...scraped];
    } else {
      alerts = mockAlerts();
    }
    const zone = zoneForPoint(p.lng, p.lat);
    const result = await reconcile(p, alerts.length ? alerts : mockAlerts(), shelters, zone);
    res.json({ resolved: { address: p.address, lat: p.lat, lng: p.lng }, zone, ...result });
  } catch (err) {
    console.error("[api/advise]", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Could not generate guidance. Please try again.",
    });
  }
});

onApi("get", "/api/updates", (_req, res) => {
  res.json(mockAlerts());
});

onApi("get", "/api/shelters", (_req, res) => {
  res.json(shelters);
});

onApi("get", "/api/address/suggest", async (req, res) => {
  const q = String(req.query.q || "");
  const suggestions = await suggestAddresses(q, 6);
  res.json(suggestions);
});

onApi("get", "/api/config", (_req, res) => {
  res.json({ googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || null });
});

onApi("get", "/api/health", (_req, res) => {
  res.json({ ok: true });
});

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

if (!process.env.VERCEL) {
  app.listen(PORT, HOST, () => console.log(`http://${HOST}:${PORT}`));
}

export default app;
