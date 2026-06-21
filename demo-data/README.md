# Demo data

Self-contained, hard-coded data for the live evacuation demos. Two scenarios live here:

- **West Maui flash flood** (`mock-*.json`) — ingested into a chronological SQLite DB
  (`build-demo-db.ts` → `demo.db`) and replayed with `replay.ts`. See below.
- **East Maui / Kaupakalua Dam** (`kaupakalua-*.json`) — the real March 2021 Haiku dam
  overflow; this is the family portrayed in the live pipeline demo. It is driven straight
  through the real `reconcile()` + Poke pipeline by [`src/drive.ts`](../src/drive.ts).
  See "Kaupakalua scenario" at the bottom.

## Files

| File | Role |
|------|------|
| `user-profile.json` | Resident household profile (identity + home from the location feed; `has_car` / `mobility_needs` / `pets` / `language` are editable demo assumptions). |
| `mock-user-location-feed.json` | Synthetic GPS feed, 1 fix/min, 14:00–14:59 HST. Lahaina → Maalaea → War Memorial Gym. |
| `mock-disaster-situation-feed.json` | Evolving alerts, road closures, flood extent, evac target, and shelter resources over the same window. |
| `build-demo-db.ts` | Ingestion script — reads the three JSONs and (re)builds `demo.db`. |
| `replay.ts` | Track the timeline in real time: as-of snapshots + live streaming replay. |
| `replay.test.ts` | Verifies snapshot + liveReplay against `demo.db` (run via `npm run demo:test`). |
| `demo.db` | Generated SQLite database (regenerable; gitignored via root `*.db`). |
| `kaupakalua-situation-feed.json` | East Maui scenario: 26 timestamped situation updates of the March 2021 Kaupakalua Dam overflow. |
| `kaupakalua-location-feed.json` | East Maui scenario: the family's GPS track (103 fixes), Haiku → Hana Hwy → Hana High School. |
| `kaupakalua-profile.json` | The family being portrayed (identity/home from the location feed; personalization fields editable). |

## Build / rebuild

```bash
npm run demo:build          # or: npx tsx demo-data/build-demo-db.ts
```

The script **drops and recreates** every table each run, so it is idempotent —
edit any input JSON and re-run to get a fresh, deterministic `demo.db`.

## Schema

Everything is stored chronologically. Pings and updates each keep their feed
order in `seq` and an `epoch_ms` (parsed from the `-10:00` timestamps) for
exact time sorting.

- **`meta`** — `key`/`value` scenario facts (scenario, timezone, start_time, interval, counts, `generated_at`).
- **`user_profile`** — one row; booleans stored as `0/1` (`has_car`, `pets`).
- **`location_pings`** — 60 GPS fixes ordered by `seq`/`epoch_ms`: `lat`, `lng`, `accuracy_m`, `speed_mph`, `heading_deg` (null when stationary), `altitude_m`, `coast_dist_km`.
- **`shelters`** — 3 shelters with location, accessibility flags, and starting resource counts.
- **`situation_updates`** — 15 heterogeneous updates flattened to common columns (`type`, `source`, `tier`, `severity`, `text`, `zones`, evac-target fields, road-closure fields, resource fields, `at_risk_predicate` split into `at_risk_metric/op/value`). The **full original object is preserved in `raw`** so no type-specific field is ever lost.
- **`timeline`** *(view)* — `location_pings` + `situation_updates` merged into one time-ordered stream (`epoch_ms`, `t`, `kind`, `ref`, `summary`). Replay the whole demo minute-by-minute.

## Handy queries

```sql
-- The full merged story, in order
SELECT t, kind, ref, summary FROM timeline;

-- What had the resident been told, and where were they, by 14:38 (target switch)?
SELECT * FROM timeline WHERE epoch_ms <= strftime('%s','2026-06-20T14:38:00') * 1000 - 36000000;

-- Evac target changes over time
SELECT t, target_shelter, previous_target, reason FROM situation_updates WHERE type='evac_target';

-- Shelter resource depletion
SELECT t, shelter, level, raw FROM situation_updates WHERE type='resource' ORDER BY epoch_ms;
```

> Note: timestamps are HST (UTC−10). `epoch_ms` already accounts for the offset.

## Real-time tracking (`replay.ts`)

Two ways to track the scenario over time, both over the merged `timeline` view.
Time inputs accept `HH:MM`, a full ISO string, or a bare integer (minutes since start).

### 1. As-of snapshot — everything up to & including a time

```bash
npm run demo:replay -- at 14:38                  # full timeline through 14:38
npm run demo:replay -- at 14:38 --table updates  # just situation updates
npm run demo:replay -- at 30   --table pings     # GPS pings through T+30m
```

Answers "what did we know, and where were they, by 14:38?" — the evac-target
switch at 14:38 is included (inclusive bound).

### 2. Live replay — stream rows in real time from a start point

```bash
npm run demo:replay -- live 14:00                # true real time (1 min = 1 min)
npm run demo:replay -- live 14:00 --speed 60     # 60x: the whole hour in ~1 min
npm run demo:replay -- live 14:36 --speed 30 --table updates
```

Prints the state at the start point, then emits each later row when wall-clock
reaches its scenario offset. Start at 10:00 wall with `live 12:00` → the 12:01
row prints at 10:01, 12:02 at 10:02, and so on. `--speed N` runs N scenario-seconds
per real second (default `1`); use a high value so a demo doesn't take an hour.

### Programmatic use

Both are exported for the app pipeline:

```ts
import { snapshot, liveReplay, parseWhen } from "./demo-data/replay.ts";

const rows = snapshot(parseWhen("14:38", startISO));      // TimelineRow[]
const stop = liveReplay(fromMs, { speed: 60, onRow: (r) => reconcile(r) });
// stop() cancels all pending emissions.
```

### Tests

```bash
npm run demo:test
```

Runs the whole verification twice, from two different initial timestamps
(`14:18` and `14:48`). For each it checks **snapshot** (counts per table,
chronological order, inclusive `<= asOf` boundary) and **liveReplay** (emits
exactly the rows strictly after the start, in canonical order, with backlog +
emitted = 75, and each row firing at `(epoch − start) / speed` wall-time).
Expected counts are derived by hand from the feed data as independent ground
truth. 28 assertions, all passing.

---

# Kaupakalua scenario (East Maui) — live pipeline demo

`kaupakalua-*.json` reconstruct the real March 8–9 2021 Kaupakalua Dam overflow in
Haiku, and the GPS track of the **family being portrayed** as they evacuate Haiku →
Hana Highway → Hana High School. This is the same event the live Browserbase discovery
path already searches for (`DEMO_QUERY` in [`src/sources/maui.ts`](../src/sources/maui.ts)),
so the structured feed is the deterministic twin of what the web scrape finds.

It runs through the **real** pipeline — [`src/sources/feed.ts`](../src/sources/feed.ts)
adapts the situation feed into the same `alerts[]` shape `reconcile()` / `isThreat()`
consume; only the alert *source* differs from the live path.

```bash
npm run demo:drive -- --list                 # offline: decision timeline, no LLM, no send
npm run demo:drive -- --ask --at 14:42       # one-shot: guidance the family gets at 14:42
npm run demo:drive                           # full replay (DRY RUN), reconcile per update
npm run demo:drive -- --from 14:42 --to 16:11   # just a segment
npm run demo:drive -- --send                 # actually deliver updates via Poke
npm run demo:drive -- --speed 600            # real-time compressed (scenario-sec/real-sec)
```

What the replay does at each situation update: advances the family's position from their
GPS track, gathers every alert known **so far**, reconciles them into one personalized
fail-safe instruction, and pushes to Poke **only when the decision changes** (destination
/ evacuate-vs-advisory / applies-to-user) — so the resident gets timely updates as the dam
escalates and roads close, not a message every minute.

Two-way (resident texts Poke) stays on the existing MCP tools (`get_evacuation_guidance`,
`check_active_threats`); `--ask --at HH:MM` shows the same time-aware answer offline.

> Requires `data/shelters.json` to include the East Maui shelters (Paia Community Center,
> Hana High School, Eddie Tam Memorial Center) — added so `reconcile()` can name the
> correct destination. `--send` needs `POKE_API_KEY`; reconcile needs `ANTHROPIC_API_KEY`.
