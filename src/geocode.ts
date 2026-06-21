// Geocode a free-text home address -> { lat, lng }. Chosen for ease of use:
// no API key, no signup. Two keyless, server-friendly providers for resilience:
//   1. Photon (photon.komoot.io) — OpenStreetMap data; handles street addresses
//      AND place names globally (US + international).
//   2. Open-Meteo geocoding — place/town level only; a safety net for bare city
//      names if Photon is unavailable.
// To swap in a keyed provider (Google, Mapbox), change only the helpers below.

export type AddressSuggestion = {
  label: string;
  lat: number;
  lng: number;
  country?: string;
  countrycode?: string;
};

export async function geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
  const q = address.trim();
  if (!q) return null;

  let hit = await viaPhoton(q, 1);
  if (!hit) hit = await viaOpenMeteo(q);
  return hit;
}

/** US address search for autocomplete (OpenStreetMap via Photon). */
export async function suggestAddresses(query: string, limit = 6): Promise<AddressSuggestion[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  try {
    // US bounding box (continental US + Alaska + Hawaii + territories)
    const bbox = "-171.5,18.0,-65.0,71.5";
    const url = `https://photon.komoot.io/api?limit=${limit * 3}&q=${encodeURIComponent(q)}&bbox=${bbox}`;
    const res = await fetch(url, { headers: { "User-Agent": "maui-evac/1.0 (CalHacks demo)" } });
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    const features = data?.features;
    if (!Array.isArray(features)) return [];
    return features
      .map(photonToSuggestion)
      .filter((s): s is AddressSuggestion => s !== null && isUsSuggestion(s))
      .slice(0, limit);
  } catch {
    return [];
  }
}

function isUsSuggestion(s: AddressSuggestion): boolean {
  const code = s.countrycode?.toUpperCase();
  if (code === "US") return true;
  return /united states/i.test(s.country || "");
}

function photonToSuggestion(f: any): AddressSuggestion | null {
  const c = f?.geometry?.coordinates;
  if (!Array.isArray(c) || c.length < 2) return null;
  const lng = Number(c[0]);
  const lat = Number(c[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const p = f.properties || {};
  const line1 = [p.housenumber, p.street].filter(Boolean).join(" ");
  const line2 = [p.postcode, p.city, p.state, p.country].filter(Boolean).join(", ");
  const label = [line1, line2].filter(Boolean).join(", ") || p.name || p.city || p.country;
  if (!label) return null;
  return { label, lat, lng, country: p.country, countrycode: p.countrycode };
}

async function viaPhoton(query: string, limit = 1): Promise<{ lat: number; lng: number } | null> {
  try {
    const url = `https://photon.komoot.io/api?limit=${limit}&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { "User-Agent": "maui-evac/1.0 (CalHacks demo)" } });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const c = data?.features?.[0]?.geometry?.coordinates;
    if (Array.isArray(c) && c.length === 2) {
      const lng = Number(c[0]), lat = Number(c[1]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }
  } catch { /* fall through */ }
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
