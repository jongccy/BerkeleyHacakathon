import "dotenv/config";
import express from "express";
import { reconcile } from "./reconcile.js";
import { zoneForPoint } from "./zones.js";
import { mockAlerts } from "./sources/mock.js";
import { nwsAlerts } from "./sources/nws.js";
import { mauiScrapedAlerts } from "./sources/maui.js";
import { geocodeAddress, suggestAddresses } from "./geocode.js";
import { readFileSync } from "fs";

const shelters = JSON.parse(readFileSync("data/shelters.json", "utf8"));
const app = express();
app.use(express.json());
app.use(express.static("public"));

app.post("/api/advise", async (req, res) => {
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

app.get("/api/updates", (_req, res) => {
  res.json(mockAlerts());
});

app.get("/api/shelters", (_req, res) => {
  res.json(shelters);
});

app.get("/api/address/suggest", async (req, res) => {
  const q = String(req.query.q || "");
  const suggestions = await suggestAddresses(q, 6);
  res.json(suggestions);
});

// Expose the client-side Google Maps key (if configured) to the browser.
// Null when unset -> the form falls back to a plain text box + server geocoding.
app.get("/api/config", (_req, res) => {
  res.json({ googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || null });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
