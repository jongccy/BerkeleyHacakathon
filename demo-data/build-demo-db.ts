/**
 * build-demo-db.ts — ingest the hard-coded demo feeds into a SQLite database,
 * stored chronologically, for the live-evacuation demo.
 *
 * Inputs (all in this folder):
 *   - user-profile.json                  resident household profile
 *   - mock-user-location-feed.json       GPS fixes, 1/min
 *   - mock-disaster-situation-feed.json  evolving alerts / road closures / resources
 *
 * Output:
 *   - demo.db  with tables: meta, user_profile, location_pings,
 *     shelters, situation_updates  + a `timeline` view that merges the
 *     location and situation streams into one time-ordered feed.
 *
 * Run:  npm run demo:build   (or: npx tsx demo-data/build-demo-db.ts)
 */
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => JSON.parse(readFileSync(join(HERE, f), "utf8"));
const epoch = (t: string) => new Date(t).getTime();
const bool = (v: unknown) => (v ? 1 : 0);

// Minutes elapsed since scenario start — enables simple WHERE elapsed_min <= N queries.
let START_EPOCH = 0; // set after feeds are loaded
const elapsed = (t: string) => Math.floor((epoch(t) - START_EPOCH) / 60_000);

const profile = read("user-profile.json");
const loc = read("mock-user-location-feed.json");
const sit = read("mock-disaster-situation-feed.json");
START_EPOCH = epoch(sit.start_time ?? loc.start_time);

const DB_PATH = join(HERE, "demo.db");
const db = new Database(DB_PATH);
// Default rollback journal → demo.db stays a single, portable file.

// Rebuild cleanly each run so the demo DB is deterministic.
db.exec(`
  DROP VIEW  IF EXISTS timeline;
  DROP TABLE IF EXISTS situation_updates;
  DROP TABLE IF EXISTS shelters;
  DROP TABLE IF EXISTS location_pings;
  DROP TABLE IF EXISTS user_profile;
  DROP TABLE IF EXISTS meta;

  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE user_profile (
    id             INTEGER PRIMARY KEY,
    name           TEXT,
    phone          TEXT,
    home_lat       REAL,
    home_lng       REAL,
    home_zip       TEXT,
    home_label     TEXT,
    household_size INTEGER,
    has_car        INTEGER,   -- 0/1
    mobility_needs TEXT,
    pets           INTEGER,   -- 0/1
    language       TEXT
  );

  -- One row per GPS fix, in feed order. elapsed_min enables simple WHERE elapsed_min <= N queries.
  CREATE TABLE location_pings (
    seq           INTEGER PRIMARY KEY,
    t             TEXT NOT NULL,
    epoch_ms      INTEGER NOT NULL,
    elapsed_min   INTEGER NOT NULL,  -- minutes since scenario start (14:00 HST)
    lat           REAL,
    lng           REAL,
    accuracy_m    REAL,
    speed_mph     REAL,
    heading_deg   REAL,       -- nullable when stationary
    altitude_m    REAL,
    coast_dist_km REAL
  );
  CREATE INDEX idx_pings_epoch   ON location_pings(epoch_ms);
  CREATE INDEX idx_pings_elapsed ON location_pings(elapsed_min);

  -- Shelter reference data (snapshot from the situation feed header).
  CREATE TABLE shelters (
    name               TEXT PRIMARY KEY,
    area               TEXT,
    lat                REAL,
    lng                REAL,
    accessible         INTEGER,
    pet_friendly       INTEGER,
    transit_accessible INTEGER,
    water_bottles      INTEGER,
    canned_meals       INTEGER,
    cots               INTEGER,
    status             TEXT
  );

  -- Heterogeneous situation updates flattened to common columns; the full
  -- original object is kept in the raw column so no field is ever lost.
  CREATE TABLE situation_updates (
    seq            INTEGER PRIMARY KEY,  -- feed order (stable for equal timestamps)
    t              TEXT NOT NULL,
    epoch_ms       INTEGER NOT NULL,
    elapsed_min    INTEGER NOT NULL,     -- minutes since scenario start (14:00 HST)
    type           TEXT,                 -- flood_extent | alert | road_closure | evac_target | resource
    source         TEXT,
    tier           INTEGER,
    severity       TEXT,
    text           TEXT,
    zones          TEXT,                 -- JSON array string, nullable
    target_shelter TEXT,                 -- evac_target
    previous_target TEXT,                -- evac_target
    route_note     TEXT,                 -- evac_target
    reason         TEXT,                 -- evac_target
    road           TEXT,                 -- road_closure
    segment        TEXT,                 -- road_closure
    shelter        TEXT,                 -- resource
    level          TEXT,                 -- resource
    status         TEXT,                 -- road_closure / resource
    at_risk_metric TEXT,                 -- flood_extent / alert predicate
    at_risk_op     TEXT,
    at_risk_value  REAL,
    raw            TEXT NOT NULL         -- full original JSON for this update
  );
  CREATE INDEX idx_updates_epoch   ON situation_updates(epoch_ms);
  CREATE INDEX idx_updates_elapsed ON situation_updates(elapsed_min);
  CREATE INDEX idx_updates_type    ON situation_updates(type);

  -- Merged chronological stream: replay the whole demo minute-by-minute.
  -- Sort by elapsed_min then kind so location pings always precede same-minute alerts.
  CREATE VIEW timeline AS
    SELECT elapsed_min, epoch_ms, t,
           'location'      AS category,
           'gps_ping'      AS type,
           'ping#' || seq  AS ref,
           printf('moved to (%.5f, %.5f) | %.0f mph | %.2f km from coast | alt %.0f m',
                  lat, lng, speed_mph, coast_dist_km, altitude_m) AS summary
      FROM location_pings
    UNION ALL
    SELECT elapsed_min, epoch_ms, t,
           'situation'                          AS category,
           type,
           type || '#' || seq                   AS ref,
           '[' || source || '] ' || COALESCE(text, type) AS summary
      FROM situation_updates
    ORDER BY elapsed_min, epoch_ms, category;
`);

// ---- meta ----------------------------------------------------------------
const setMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
const meta: Record<string, unknown> = {
  scenario: sit.scenario ?? loc.scenario,
  timezone: sit.timezone ?? loc.timezone,
  start_time: sit.start_time ?? loc.start_time,
  interval_seconds: loc.interval_seconds,
  initial_evac_target: sit.initial_evac_target,
  final_destination_shelter: loc.destination_shelter,
  location_fix_count: loc.pings.length,
  situation_update_count: sit.updates.length,
  generated_at: new Date().toISOString(),
};
const setMetaTx = db.transaction(() => {
  for (const [k, v] of Object.entries(meta)) setMeta.run(k, String(v));
});
setMetaTx();

// ---- user_profile --------------------------------------------------------
db.prepare(
  `INSERT INTO user_profile
     (id, name, phone, home_lat, home_lng, home_zip, home_label,
      household_size, has_car, mobility_needs, pets, language)
   VALUES (@id,@name,@phone,@home_lat,@home_lng,@home_zip,@home_label,
           @household_size,@has_car,@mobility_needs,@pets,@language)`
).run({
  id: profile.id ?? 1,
  name: profile.name,
  phone: profile.phone,
  home_lat: profile.home?.lat ?? null,
  home_lng: profile.home?.lng ?? null,
  home_zip: profile.home?.zip ?? null,
  home_label: profile.home?.label ?? null,
  household_size: profile.household_size ?? null,
  has_car: bool(profile.has_car),
  mobility_needs: profile.mobility_needs ?? null,
  pets: bool(profile.pets),
  language: profile.language ?? null,
});

// ---- location_pings (chronological, feed order) --------------------------
const insPing = db.prepare(
  `INSERT INTO location_pings
     (seq, t, epoch_ms, elapsed_min, lat, lng, accuracy_m, speed_mph, heading_deg, altitude_m, coast_dist_km)
   VALUES (@seq,@t,@epoch_ms,@elapsed_min,@lat,@lng,@accuracy_m,@speed_mph,@heading_deg,@altitude_m,@coast_dist_km)`
);
const insPingsTx = db.transaction((pings: any[]) => {
  pings.forEach((p, seq) =>
    insPing.run({
      seq,
      t: p.t,
      epoch_ms: epoch(p.t),
      elapsed_min: elapsed(p.t),
      lat: p.lat,
      lng: p.lng,
      accuracy_m: p.accuracy_m ?? null,
      speed_mph: p.speed_mph ?? null,
      heading_deg: p.heading_deg ?? null,
      altitude_m: p.altitude_m ?? null,
      coast_dist_km: p.coast_dist_km ?? null,
    })
  );
});
insPingsTx(loc.pings);

// ---- shelters ------------------------------------------------------------
const insShelter = db.prepare(
  `INSERT INTO shelters
     (name, area, lat, lng, accessible, pet_friendly, transit_accessible,
      water_bottles, canned_meals, cots, status)
   VALUES (@name,@area,@lat,@lng,@accessible,@pet_friendly,@transit_accessible,
           @water_bottles,@canned_meals,@cots,@status)`
);
const insSheltersTx = db.transaction((shelters: any[]) => {
  for (const s of shelters)
    insShelter.run({
      name: s.name,
      area: s.area ?? null,
      lat: s.lat ?? null,
      lng: s.lng ?? null,
      accessible: bool(s.accessible),
      pet_friendly: bool(s.pet_friendly),
      transit_accessible: bool(s.transit_accessible),
      water_bottles: s.resources?.water_bottles ?? null,
      canned_meals: s.resources?.canned_meals ?? null,
      cots: s.resources?.cots ?? null,
      status: s.status ?? null,
    });
});
insSheltersTx(sit.shelters ?? []);

// ---- situation_updates (chronological, feed order) -----------------------
const insUpdate = db.prepare(
  `INSERT INTO situation_updates
     (seq, t, epoch_ms, elapsed_min, type, source, tier, severity, text, zones,
      target_shelter, previous_target, route_note, reason,
      road, segment, shelter, level, status,
      at_risk_metric, at_risk_op, at_risk_value, raw)
   VALUES (@seq,@t,@epoch_ms,@elapsed_min,@type,@source,@tier,@severity,@text,@zones,
           @target_shelter,@previous_target,@route_note,@reason,
           @road,@segment,@shelter,@level,@status,
           @at_risk_metric,@at_risk_op,@at_risk_value,@raw)`
);
const insUpdatesTx = db.transaction((updates: any[]) => {
  updates.forEach((u, seq) =>
    insUpdate.run({
      seq,
      t: u.t,
      epoch_ms: epoch(u.t),
      elapsed_min: elapsed(u.t),
      type: u.type ?? null,
      source: u.source ?? null,
      tier: u.tier ?? null,
      severity: u.severity ?? null,
      text: u.text ?? null,
      zones: u.zones ? JSON.stringify(u.zones) : null,
      target_shelter: u.target_shelter ?? null,
      previous_target: u.previous_target ?? null,
      route_note: u.route_note ?? null,
      reason: u.reason ?? null,
      road: u.road ?? null,
      segment: u.segment ?? null,
      shelter: u.shelter ?? null,
      level: u.level ?? null,
      status: u.status ?? null,
      at_risk_metric: u.at_risk_predicate?.metric ?? null,
      at_risk_op: u.at_risk_predicate?.op ?? null,
      at_risk_value: u.at_risk_predicate?.value ?? null,
      raw: JSON.stringify(u),
    })
  );
});
insUpdatesTx(sit.updates ?? []);

// ---- report --------------------------------------------------------------
const n = (t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as any).c;
console.log(`Built ${DB_PATH}`);
console.log(`  user_profile      ${n("user_profile")} row(s)`);
console.log(`  location_pings    ${n("location_pings")} row(s)`);
console.log(`  shelters          ${n("shelters")} row(s)`);
console.log(`  situation_updates ${n("situation_updates")} row(s)`);
console.log(`  timeline (view)   ${n("timeline")} row(s)`);
db.close();
