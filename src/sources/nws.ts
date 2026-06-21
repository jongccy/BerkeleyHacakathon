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
