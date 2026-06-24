import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";
import { readDataFile } from "./data-path.js";

const zones = JSON.parse(readDataFile("zones.geojson"));

export function zoneForPoint(lng: number, lat: number): string | null {
  const p = point([lng, lat]);
  for (const f of zones.features) {
    if (booleanPointInPolygon(p, f)) return f.properties.zone_name;
  }
  return null;
}
