/**
 * replay.test.ts — verify snapshot() and liveReplay() against demo.db.
 *
 * Run twice with two different initial timestamps (14:18 and 14:48). Expected
 * counts are derived by hand from the feed data as independent ground truth:
 *
 *   Situation updates (15): 14:00 x2, 14:06, 14:10 x2, 14:14, 14:18, 14:24,
 *                           14:30, 14:38, 14:42, 14:45, 14:48, 14:52, 14:58
 *   Location pings (60):    one per minute, 14:00..14:59 (elapsed 0..59)
 *
 *   as of 14:18  → updates<=  7, pings<= 19, timeline<= 26, timeline> 49
 *   as of 14:48  → updates<= 13, pings<= 49, timeline<= 62, timeline> 13
 *   (timeline<= + timeline> always = 75)
 *
 * Run:  npm run demo:test   (or: npx tsx demo-data/replay.test.ts)
 */
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { snapshot, liveReplay, parseWhen, type TimelineRow } from "./replay.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = join(HERE, "demo.db");

// ---- ground truth straight from the db (independent of replay.ts paths) ----
function meta(key: string): string {
  const db = new Database(DB, { readonly: true });
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string };
  db.close();
  return row.value;
}
function rowsAfterTruth(fromMs: number): TimelineRow[] {
  const db = new Database(DB, { readonly: true });
  const rows = db
    .prepare("SELECT * FROM timeline WHERE epoch_ms > ? ORDER BY epoch_ms, category")
    .all(fromMs) as TimelineRow[];
  db.close();
  return rows;
}
const START_ISO = meta("start_time");

// ---- tiny test harness -----------------------------------------------------
let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (e) {
    console.log(`  \x1b[31m✗ ${name}\x1b[0m\n      ${(e as Error).message.replace(/\n/g, "\n      ")}`);
    failed++;
  }
}

type Case = {
  ts: string;
  timelineThrough: number;
  pingsThrough: number;
  updatesThrough: number;
  timelineAfter: number;
};

const CASES: Case[] = [
  { ts: "14:18", timelineThrough: 26, pingsThrough: 19, updatesThrough: 7, timelineAfter: 49 },
  { ts: "14:48", timelineThrough: 62, pingsThrough: 49, updatesThrough: 13, timelineAfter: 13 },
];

const SPEED = 600; // 600 scenario-seconds / real second → whole hour in ~6s
const TOTAL = 75;

// ---- snapshot tests (synchronous) -----------------------------------------
function testSnapshot(cs: Case) {
  const asOf = parseWhen(cs.ts, START_ISO);
  const tl = snapshot(asOf, "timeline", DB);
  const pings = snapshot(asOf, "pings", DB);
  const updates = snapshot(asOf, "updates", DB);

  check(`snapshot ${cs.ts}: timeline count = ${cs.timelineThrough}`, () =>
    assert.equal(tl.length, cs.timelineThrough)
  );
  check(`snapshot ${cs.ts}: pings count = ${cs.pingsThrough}`, () =>
    assert.equal(pings.length, cs.pingsThrough)
  );
  check(`snapshot ${cs.ts}: updates count = ${cs.updatesThrough}`, () =>
    assert.equal(updates.length, cs.updatesThrough)
  );
  check(`snapshot ${cs.ts}: pings + updates = timeline`, () =>
    assert.equal(pings.length + updates.length, tl.length)
  );
  check(`snapshot ${cs.ts}: chronologically sorted`, () => {
    for (let i = 1; i < tl.length; i++)
      assert.ok(tl[i].epoch_ms >= tl[i - 1].epoch_ms, `out of order at index ${i}`);
  });
  check(`snapshot ${cs.ts}: inclusive — every row's epoch_ms <= asOf`, () => {
    for (const r of tl) assert.ok(r.epoch_ms <= asOf, `${r.ref} is after asOf`);
  });
  check(`snapshot ${cs.ts}: inclusive — a row exists exactly at asOf`, () =>
    assert.ok(tl.some((r) => r.epoch_ms === asOf), "no boundary row found")
  );
}

// ---- liveReplay tests (asynchronous) --------------------------------------
function testLiveReplay(cs: Case): Promise<void> {
  return new Promise((resolve) => {
    const fromMs = parseWhen(cs.ts, START_ISO);
    const truth = rowsAfterTruth(fromMs);
    const got: { row: TimelineRow; at: number }[] = [];
    const t0 = performance.now();

    liveReplay(fromMs, {
      speed: SPEED,
      quiet: true,
      showBacklog: false,
      path: DB,
      onRow: (r) => got.push({ row: r, at: performance.now() - t0 }),
      onDone: () => {
        check(`live ${cs.ts}: emitted count = ${cs.timelineAfter}`, () =>
          assert.equal(got.length, cs.timelineAfter)
        );
        check(`live ${cs.ts}: backlog + emitted = ${TOTAL} (no gaps/overlap)`, () =>
          assert.equal(cs.timelineThrough + got.length, TOTAL)
        );
        check(`live ${cs.ts}: every emitted row is strictly after start`, () => {
          for (const g of got) assert.ok(g.row.epoch_ms > fromMs, `${g.row.ref} not after start`);
        });
        check(`live ${cs.ts}: emitted rows match canonical order exactly`, () =>
          assert.deepEqual(
            got.map((g) => g.row.ref),
            truth.map((r) => r.ref)
          )
        );
        check(`live ${cs.ts}: emission times are non-decreasing`, () => {
          for (let i = 1; i < got.length; i++)
            assert.ok(got[i].at >= got[i - 1].at - 1, `regressed at index ${i}`);
        });
        check(`live ${cs.ts}: each row fires at (epoch-start)/speed wall-time`, () => {
          for (const g of got) {
            const expected = (g.row.epoch_ms - fromMs) / SPEED; // ms
            const drift = g.at - expected;
            assert.ok(
              drift >= -60 && drift <= 600,
              `${g.row.ref}: expected ~${expected.toFixed(0)}ms, got ${g.at.toFixed(0)}ms (drift ${drift.toFixed(0)}ms)`
            );
          }
        });
        check(`live ${cs.ts}: inter-row gaps track scenario gaps / speed`, () => {
          for (let i = 1; i < got.length; i++) {
            const wallGap = got[i].at - got[i - 1].at;
            const scenGap = (got[i].row.epoch_ms - got[i - 1].row.epoch_ms) / SPEED;
            assert.ok(
              Math.abs(wallGap - scenGap) <= 250,
              `gap ${i}: scenario→${scenGap.toFixed(0)}ms but wall→${wallGap.toFixed(0)}ms`
            );
          }
        });
        resolve();
      },
    });
  });
}

// ---- run -------------------------------------------------------------------
async function main() {
  console.log(`\nVerifying replay against ${DB}`);
  console.log(`Scenario start: ${START_ISO} · live speed: ${SPEED}x\n`);

  for (const cs of CASES) {
    console.log(`\x1b[1m── Run: initial timestamp ${cs.ts} ──\x1b[0m`);
    console.log(`  [snapshot]`);
    testSnapshot(cs);
    console.log(`  [liveReplay]`);
    await testLiveReplay(cs);
    console.log();
  }

  console.log(`\x1b[1mResult:\x1b[0m ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main();
