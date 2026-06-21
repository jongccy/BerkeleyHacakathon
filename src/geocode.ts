// Geocode a free-text home address -> { lat, lng }. Chosen for ease of use:
// no API key, no signup. Two keyless, server-friendly providers for resilience:
//   1. Photon (photon.komoot.io) — OpenStreetMap data; handles street addresses
//      AND place names. (The main Nominatim instance 403s datacenter IPs; Photon
//      does not.) Biased toward Maui so generic street names resolve locally.
//   2. Open-Meteo geocoding — place/town level only; a safety net for bare city
//      names if Photon is unavailable.
// To swap in a keyed provider (Google, Mapbox), change only the helpers below.

const MAUI_BIAS = { lat: 20.8, lon: -156.33 }; // central Maui, to prioritize results

export async function geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
  const q = address.trim();
  if (!q) return null;

  let hit = await viaPhoton(q);
  // If nothing and the user didn't name a state, retry biased to Hawaii.
  if (!hit && !/hawaii|\bhi\b/i.test(q)) hit = await viaPhoton(`${q}, Hawaii`);
  // Last resort: place-level lookup (covers bare city/town names).
  if (!hit) hit = await viaOpenMeteo(q);
  return hit;
}

async function viaPhoton(query: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const url = `https://photon.komoot.io/api?limit=1&lat=${MAUI_BIAS.lat}&lon=${MAUI_BIAS.lon}&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { "User-Agent": "maui-evac/1.0 (CalHacks demo)" } });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const c = data?.features?.[0]?.geometry?.coordinates; // GeoJSON [lng, lat]
    if (Array.isArray(c) && c.length === 2) {
      const lng = Number(c[0]), lat = Number(c[1]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }
  } catch { /* fall through to next provider */ }
  return null;
}

async function viaOpenMeteo(query: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?count=1&format=json&name=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const r = data?.results?.[0];
    if (r && Number.isFinite(r.latitude) && Number.isFinite(r.longitude)) {
      return { lat: r.latitude, lng: r.longitude };
    }
  } catch { /* give up */ }
  return null;
}
