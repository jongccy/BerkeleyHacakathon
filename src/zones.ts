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
