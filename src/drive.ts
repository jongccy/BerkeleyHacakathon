import "dotenv/config";
import { readFileSync } from "fs";
import { reconcile } from "./reconcile.js";
import { zoneForPoint } from "./zones.js";
import { sendMessage } from "./deliver.js";
import {
  loadSituationFeed,
  loadLocationFeed,
  loadProfile,
  feedAlerts,
  positionAt,
} from "./sources/feed.js";

// demo:drive — replay the hard-coded family scenario through the real pipeline.
//
// Walks the situation feed in time order. At each update it (1) advances the
// family's position from their GPS track, (2) gathers every alert known SO FAR,
// (3) reconciles them into one personalized, fail-safe instruction, and (4) pushes
// it to Poke ONLY when the guidance materially changes — so the resident gets
// timely updates as the dam escalates and roads close, not a message every minute.
//
// This is the same reconcile() + sendMessage() the live MCP/Browserbase path uses;
// only the alert SOURCE differs (the structured feed instead of a web scrape).
//
// Flags:
//   --send            actually deliver via Poke (default: dry run, prints only)
//   --list            offline: print the decision timeline, no LLM, no send
//   --speed N         real-time compressed: N scenario-seconds per real second
//   --from HH:MM      start the replay at this scenario time (skip earlier updates)
//   --to HH:MM        stop the replay at this scenario time (for demo segments)
//   --ask --at HH:MM  one-shot: print the guidance the family would get at that time

const shelters = JSON.parse(readFileSync("data/shelters.json", "utf8"));
const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const sit = loadSituationFeed();
const loc = loadLocationFeed();
const profileRaw = loadProfile();

const startISO: string = sit.start_time;
const datePart = startISO.slice(0, 10);
const offset = (startISO.match(/([+-]\d{2}:\d{2})$/) ?? ["-10:00"])[0];
function parseWhen(input: string): number {
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(input)) {
    const hms = input.length === 5 ? `${input}:00` : input;
    return new Date(`${datePart}T${hms}${offset}`).getTime();
  }
  return new Date(input).getTime();
}
const clock = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const hst = (iso: string) => iso.slice(11, 16); // HH:MM in the feed's HST string
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Build the resident profile reconcile expects, enriched with their CURRENT GPS
// telemetry so guidance can react to where they are (moving, near coast, low ground).
function profileAt(ping: any) {
  return {
    lat: ping?.lat ?? profileRaw.home?.lat,
    lng: ping?.lng ?? profileRaw.home?.lng,
    household_size: profileRaw.household_size ?? 1,
    has_car: profileRaw.has_car ? 1 : 0,
    mobility_needs: profileRaw.mobility_needs ?? "none",
    pets: profileRaw.pets ? 1 : 0,
    language: profileRaw.language ?? "en",
    current_position: ping
      ? {
          moving: (ping.speed_mph ?? 0) > 1,
          speed_mph: ping.speed_mph,
          altitude_m: ping.altitude_m,
          coast_dist_km: ping.coast_dist_km,
          note: "Live GPS of the resident; they may be mid-evacuation. Account for this.",
        }
      : { note: "At home; no live GPS yet." },
  };
}

function smsBody(result: any): string {
  return (
    `${result.recommended_action}` +
    (result.destination ? `\nGo to: ${result.destination}.` : "") +
    (result.fail_safe ? `\n(Follow official guidance; this is advisory.)` : "")
  );
}

// ---- --list : offline decision timeline (no LLM, no send) -------------------
function runList(fromMs: number) {
  console.log(`\nDecision timeline for "${sit.scenario}"`);
  console.log(`Family: ${profileRaw.name} (home ${profileRaw.home?.label})\n`);
  let prevCount = 0;
  for (const u of sit.updates) {
    const ms = new Date(u.t).getTime();
    if (ms < fromMs) continue;
    const known = feedAlerts(sit, ms);
    const ping = positionAt(loc, ms);
    const newOnes = known.length - prevCount;
    prevCount = known.length;
    const where = ping
      ? `${ping.speed_mph > 1 ? "moving" : "stopped"} @ (${ping.lat.toFixed(4)}, ${ping.lng.toFixed(4)}), ${ping.coast_dist_km}km coast`
      : "at home";
    console.log(
      `${hst(u.t)} [${u.severity?.padEnd(8) || "        "}] ${u.type.padEnd(13)} | ${where} | known=${known.length} (+${newOnes})`
    );
    console.log(`         ${u.text.slice(0, 110)}`);
  }
  console.log(`\n${sit.updates.length} updates, ${loc.pings.length} GPS pings.\n`);
}

// ---- --ask : one-shot "what would they be told at time T?" ------------------
async function runAsk(atMs: number) {
  const ping = positionAt(loc, atMs);
  const alerts = feedAlerts(sit, atMs);
  const profile = profileAt(ping);
  const zone = ping ? zoneForPoint(ping.lng, ping.lat) : null;
  console.log(`\nAs of ${hst(clock(atMs))} HST — ${alerts.length} alert(s) known, family ${ping ? `at (${ping.lat.toFixed(4)}, ${ping.lng.toFixed(4)})` : "at home"}`);
  const result = await reconcile(profile, alerts, shelters, zone);
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nSMS the resident would receive:\n  ${smsBody(result).replace(/\n/g, "\n  ")}\n`);
}

// ---- default : chronological replay, push on material change ----------------
async function runReplay(fromMs: number, toMs: number, doSend: boolean, speed?: number) {
  console.log(`\nReplaying "${sit.scenario}"`);
  console.log(`Family: ${profileRaw.name}, home ${profileRaw.home?.label} -> ${loc.destination_shelter}`);
  console.log(doSend ? "Delivery: Poke (live)\n" : "Delivery: DRY RUN (prints only; pass --send to deliver)\n");

  const updates = sit.updates.filter((u: any) => {
    const ms = new Date(u.t).getTime();
    return ms >= fromMs && ms <= toMs;
  });
  let lastSig: string | null = null;
  let prevMs: number | null = null;
  let sent = 0;

  for (const u of updates) {
    const ms = new Date(u.t).getTime();
    if (speed && prevMs != null) await sleep(Math.min(8000, (ms - prevMs) / speed));
    else if (!speed) await sleep(400); // gentle pacing so the demo is watchable
    prevMs = ms;

    const ping = positionAt(loc, ms);
    const alerts = feedAlerts(sit, ms);
    const profile = profileAt(ping);
    const zone = ping ? zoneForPoint(ping.lng, ping.lat) : null;
    const result = await reconcile(profile, alerts, shelters, zone);

    // Re-send only when the DECISION changes (destination / evacuate-vs-advisory /
    // whether it applies) — not when the LLM merely rephrases the same instruction.
    const sig = `${result.destination}|${result.fail_safe}|${result.applies_to_user}`;
    const changed = sig !== lastSig;
    const where = ping ? `(${ping.lat.toFixed(4)}, ${ping.lng.toFixed(4)})` : "home";

    console.log(`\n--- ${hst(u.t)} HST | ${u.type} [${u.severity}] | family ${where} ---`);
    console.log(`  ${u.text.slice(0, 100)}`);
    console.log(`  -> ${result.recommended_action}${result.destination ? ` [${result.destination}]` : ""}`);

    if (!changed) {
      console.log(`  (no change — not re-sending)`);
      continue;
    }
    lastSig = sig;
    if (doSend && profileRaw.phone && !String(profileRaw.phone).includes("X")) {
      await sendMessage(profileRaw.phone, smsBody(result));
      console.log(`  [SENT to ${profileRaw.phone}]`);
    } else {
      console.log(`  [would send]\n  "${smsBody(result).replace(/\n/g, " / ")}"`);
    }
    sent++;
  }
  console.log(`\nDone. ${sent} update message(s) ${doSend ? "sent" : "would be sent"} across ${updates.length} situation updates.\n`);
}

async function main() {
  const fromMs = val("--from") ? parseWhen(val("--from")!) : 0;
  const toMs = val("--to") ? parseWhen(val("--to")!) : Number.MAX_SAFE_INTEGER;
  const speed = val("--speed") ? Number(val("--speed")) : undefined;

  if (has("--list")) return runList(fromMs);
  if (has("--ask")) {
    const at = val("--at");
    if (!at) {
      console.error("--ask requires --at HH:MM");
      process.exit(1);
    }
    return runAsk(parseWhen(at));
  }
  return runReplay(fromMs, toMs, has("--send"), speed);
}

main();
