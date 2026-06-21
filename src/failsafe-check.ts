import "dotenv/config";
import { conflictAlerts } from "./sources/mock.js";
import { reconcile } from "./reconcile.js";
import { zoneForPoint } from "./zones.js";
import { readFileSync } from "fs";

// 2d — Fail-safe verification.
// Feed reconcile two equally authoritative official orders that flatly contradict
// each other (evacuate vs. shelter-in-place) and assert it refuses to guess:
// fail_safe must be true and the advice must defer to official guidance.
const shelters = JSON.parse(readFileSync("data/shelters.json", "utf8"));

const profile = {
  name: "Test resident", lat: 20.875, lng: -156.675,
  household_size: 3, has_car: 1, mobility_needs: "none", pets: 0, language: "en"
};

async function main() {
  const alerts = conflictAlerts();
  const zone = zoneForPoint(profile.lng, profile.lat);

  console.log("Contradictory official orders (equal authority):");
  for (const a of alerts) console.log(`  - [${a.source}] ${a.text}`);

  const result = await reconcile(profile, alerts, shelters, zone);
  console.log("\nReconcile result:");
  console.log(JSON.stringify(result, null, 2));

  const failSafe = result.fail_safe === true;
  // Safety rule: when an order says evacuate, never tell the resident to "shelter
  // in place". On contradiction the action must defer to official guidance.
  const action = (result.recommended_action || "").toLowerCase();
  const noShelterInPlace = !action.includes("shelter in place");

  const pass = failSafe && noShelterInPlace;
  console.log(`\nfail_safe === true:            ${failSafe}`);
  console.log(`action defers (not "shelter"): ${noShelterInPlace}`);
  console.log(`\n${pass ? "PASS" : "FAIL"} — fail-safe ${pass ? "triggered" : "did NOT trigger"} on contradictory alerts.`);
  process.exit(pass ? 0 : 1);
}

main();
