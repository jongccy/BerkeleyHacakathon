/**
 * replay.ts — track the demo timeline in real time from demo.db.
 *
 * Two capabilities, both over the merged `timeline` view (location pings +
 * situation updates), and usable from the CLI or imported into the app.
 *
 *   1. snapshot(asOf)   — every row up to AND INCLUDING a timestamp.
 *                         "What did we know, and where were they, by 14:38?"
 *
 *   2. liveReplay(from) — start a live timer at a scenario timestamp and emit
 *                         each later row when wall-clock reaches its offset.
 *                         Start at 10:00 wall with from=12:00 → at 10:01 the
 *                         12:01 row prints, at 10:02 the 12:02 row, and so on.
 *                         --speed N compresses time (N scenario-seconds per
 *                         real second); default 1 = true real time.
 *
 * CLI:
 *   npx tsx demo-data/replay.ts at   14:38
 *   npx tsx demo-data/replay.ts live 14:00 --speed 30
 *   npx tsx demo-data/replay.ts live 14:00 --table updates
 *
 *   (or: npm run demo:replay -- at 14:38)
 *
 * Time inputs accept:  HH:MM  |  full ISO  |  a bare integer (elapsed minutes).
 */
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(HERE, "demo.db");

export type TimelineRow = {
  elapsed_min: number;
  epoch_ms: number;
  t: string;
  category: "location" | "situation";
  type: string;
  ref: string;
  summary: string;
};

type Source = "timeline" | "pings" | "updates";

// ---- db + time helpers ---------------------------------------------------

function openDb(path = DB_PATH) {
  return new Database(path, { readonly: true, fileMustExist: true });
}

/** Scenario start ISO (e.g. "2026-06-20T14:00:00-10:00") from the meta table. */
function startTimeISO(db: Database.Database): string {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'start_time'").get() as
    | { value: string }
    | undefined;
  if (!row) throw new Error("meta.start_time missing — rebuild with npm run demo:build");
  return row.value;
}

/**
 * Parse a user time input against the scenario's date + UTC offset.
 *   "14:38"                      → that wall-clock time on the scenario date
 *   "2026-06-20T14:38:00-10:00"  → used as-is
 *   "38"                         → elapsed minutes since scenario start
 */
export function parseWhen(input: string, startISO: string): number {
  const startMs = new Date(startISO).getTime();
  const datePart = startISO.slice(0, 10); // YYYY-MM-DD
  const offset = (startISO.match(/([+-]\d{2}:\d{2})$/) ?? ["+00:00"])[0];

  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(input)) {
    const hms = input.length === 5 ? `${input}:00` : input;
    return new Date(`${datePart}T${hms}${offset}`).getTime();
  }
  if (/^\d+$/.test(input)) return startMs + Number(input) * 60_000;
  const ms = new Date(input).getTime();
  if (Number.isNaN(ms)) throw new Error(`Unrecognised time: "${input}"`);
  return ms;
}

const WHERE_BY_SOURCE: Record<Source, string> = {
  timeline: "",
  pings: "WHERE category = 'location'",
  updates: "WHERE category = 'situation'",
};

function rowsThrough(db: Database.Database, asOfMs: number, src: Source): TimelineRow[] {
  const base = WHERE_BY_SOURCE[src];
  const clause = base ? `${base} AND epoch_ms <= ?` : "WHERE epoch_ms <= ?";
  return db
    .prepare(`SELECT * FROM timeline ${clause} ORDER BY epoch_ms, category`)
    .all(asOfMs) as TimelineRow[];
}

function rowsAfter(db: Database.Database, fromMs: number, src: Source): TimelineRow[] {
  const base = WHERE_BY_SOURCE[src];
  const clause = base ? `${base} AND epoch_ms > ?` : "WHERE epoch_ms > ?";
  return db
    .prepare(`SELECT * FROM timeline ${clause} ORDER BY epoch_ms, category`)
    .all(fromMs) as TimelineRow[];
}

// ---- formatting ----------------------------------------------------------

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => c("2", s);
const bold = (s: string) => c("1", s);

const TYPE_COLOR: Record<string, string> = {
  gps_ping: "2", // dim
  alert: "31", // red
  road_closure: "33", // yellow
  evac_target: "35", // magenta
  flood_extent: "34", // blue
  resource: "32", // green
};

function fmtRow(r: TimelineRow): string {
  const clock = r.t.slice(11, 19); // HH:MM:SS (already HST in the string)
  const tplus = `T+${String(r.elapsed_min).padStart(2, " ")}m`;
  const tag = c(TYPE_COLOR[r.type] ?? "0", `${r.category[0].toUpperCase()}·${r.type}`);
  return `${bold(clock)} ${dim(tplus)}  ${tag.padEnd(COLOR ? 34 : 22)}  ${r.summary}`;
}

// ---- 1) snapshot ---------------------------------------------------------

/** Every timeline row up to and including `asOfMs`. */
export function snapshot(asOfMs: number, src: Source = "timeline", path = DB_PATH): TimelineRow[] {
  const db = openDb(path);
  try {
    return rowsThrough(db, asOfMs, src);
  } finally {
    db.close();
  }
}

function runSnapshot(whenInput: string, src: Source) {
  const db = openDb();
  const asOfMs = parseWhen(whenInput, startTimeISO(db));
  const rows = rowsThrough(db, asOfMs, src);
  db.close();

  const asOf = new Date(asOfMs).toISOString();
  console.log(
    bold(`\n── Snapshot · ${src} · as of ${whenInput} (${asOf}) ──`) +
      dim(`  ${rows.length} row(s)\n`)
  );
  for (const r of rows) console.log(fmtRow(r));
  if (!rows.length) console.log(dim("  (nothing yet at that time)"));
  console.log();
}

// ---- 2) live replay ------------------------------------------------------

export type LiveOpts = {
  speed?: number; // scenario-seconds per real second (default 1)
  src?: Source;
  showBacklog?: boolean; // print rows up to the start point first (default true)
  quiet?: boolean; // suppress all console output; only fire onRow/onDone
  path?: string;
  onRow?: (r: TimelineRow) => void; // called for each emitted (future) row
  onDone?: () => void;
};

/**
 * Start a live timer at scenario time `fromMs`. Rows strictly after `fromMs`
 * are emitted when wall-clock reaches (row.epoch_ms - fromMs) / speed.
 * Returns a stop() function that cancels all pending emissions.
 */
export function liveReplay(fromMs: number, opts: LiveOpts = {}): () => void {
  const {
    speed = 1,
    src = "timeline",
    showBacklog = true,
    quiet = false,
    path = DB_PATH,
    onRow,
    onDone,
  } = opts;
  const log = (s: string) => {
    if (!quiet) console.log(s);
  };
  const db = openDb(path);

  if (showBacklog && !quiet) {
    const backlog = rowsThrough(db, fromMs, src);
    log(bold(`\n── State at start (T+0) ──`) + dim(`  ${backlog.length} prior row(s)\n`));
    for (const r of backlog) log(dim(fmtRow(r)));
  }

  const future = rowsAfter(db, fromMs, src);
  db.close();

  const wallStart = new Date();
  log(
    bold(`\n── Live replay ──`) +
      dim(
        `  from ${new Date(fromMs).toISOString()} · speed ${speed}x · ` +
          `${future.length} upcoming row(s) · started ${wallStart.toLocaleTimeString()}\n`
      )
  );
  if (!future.length) {
    log(dim("  (no rows after the start point)\n"));
    onDone?.();
    return () => {};
  }

  const timers: NodeJS.Timeout[] = [];
  let remaining = future.length;

  future.forEach((r) => {
    const delayMs = Math.max(0, (r.epoch_ms - fromMs) / speed);
    timers.push(
      setTimeout(() => {
        const wall = new Date().toLocaleTimeString();
        log(`${dim(`[${wall}]`)} ${fmtRow(r)}`);
        onRow?.(r);
        if (--remaining === 0) {
          log(dim(`\n── Replay complete ──\n`));
          onDone?.();
        }
      }, delayMs)
    );
  });

  const stop = () => {
    for (const t of timers) clearTimeout(t);
  };
  process.once("SIGINT", () => {
    stop();
    log(dim("\n── Replay stopped ──\n"));
    process.exit(0);
  });
  return stop;
}

function runLive(whenInput: string, src: Source, speed: number) {
  const db = openDb();
  const fromMs = parseWhen(whenInput, startTimeISO(db));
  db.close();
  liveReplay(fromMs, { speed, src, onDone: () => process.exit(0) });
}

// ---- CLI -----------------------------------------------------------------

function parseSource(args: string[]): Source {
  const i = args.indexOf("--table");
  const v = i >= 0 ? args[i + 1] : "timeline";
  if (v === "pings" || v === "updates" || v === "timeline") return v;
  throw new Error(`--table must be timeline | pings | updates (got "${v}")`);
}

function parseSpeed(args: string[]): number {
  const i = args.indexOf("--speed");
  if (i < 0) return 1;
  const v = Number(args[i + 1]);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`--speed must be a positive number`);
  return v;
}

function main() {
  const [cmd, when, ...rest] = process.argv.slice(2);
  const usage =
    "Usage:\n" +
    "  replay.ts at   <time> [--table timeline|pings|updates]\n" +
    "  replay.ts live <time> [--speed N] [--table timeline|pings|updates]\n" +
    "  <time> = HH:MM | full ISO | integer minutes since start";

  if (!cmd || !when || (cmd !== "at" && cmd !== "live")) {
    console.log(usage);
    process.exit(when ? 1 : 0);
  }
  const src = parseSource(rest);
  if (cmd === "at") runSnapshot(when, src);
  else runLive(when, src, parseSpeed(rest));
}

// Run as CLI only when invoked directly (not when imported).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
