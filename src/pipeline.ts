import "dotenv/config";
import db, { seedProfiles, allProfiles } from "./db.js";
import { mockAlerts } from "./sources/mock.js";
import { nwsAlerts } from "./sources/nws.js";
import { mauiScrapedAlerts } from "./sources/maui.js";
import { reconcile } from "./reconcile.js";
import { zoneForPoint } from "./zones.js";
import { sendMessage } from "./deliver.js";
import { readFileSync } from "fs";

const shelters = JSON.parse(readFileSync("data/shelters.json", "utf8"));

async function gatherAlerts(mode: string) {
  if (mode === "scenario") return mockAlerts();
  // Live: merge NWS API + real Maui pages scraped via Browserbase.
  const live = await nwsAlerts();
  const scraped = await mauiScrapedAlerts();
  const all = [...live, ...scraped];
  console.log(`[live sources] NWS: ${live.length}, scraped: ${scraped.length}`);
  return all.length ? all : mockAlerts();
}

async function runForProfile(p: any, alerts: any[], doSend: boolean) {
  const zone = zoneForPoint(p.lng, p.lat);
  const result = await reconcile(p, alerts, shelters, zone);

  console.log("\n=====", p.name, "(zone:", zone, ") =====");
  console.log(JSON.stringify(result, null, 2));

  if (doSend && p.phone) {
    const body = `${result.recommended_action}` +
      (result.destination ? `\nGo to: ${result.destination}.` : "") +
      (result.how_to_get_there ? `\n${result.how_to_get_there}` : "") +
      (result.fail_safe ? `\n(Follow official guidance; this is advisory.)` : "");
    await sendMessage(p.phone, body);
    console.log("[sent to", p.phone + "]");
  }
}

async function main() {
  seedProfiles();
  const mode = process.argv.includes("--live") ? "live" : "scenario";
  const doSend = process.argv.includes("--send");
  // Gather alerts ONCE — all residents see the same alerts; only personalization
  // differs. This also avoids re-running Browserbase scrapes per profile.
  const alerts = await gatherAlerts(mode);
  for (const p of allProfiles() as any[]) await runForProfile(p, alerts, doSend);
}

main();
