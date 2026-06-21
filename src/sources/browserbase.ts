import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";

export async function scrapeAlerts(url: string, what: string) {
  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    apiKey: process.env.BROWSERBASE_API_KEY,
    projectId: process.env.BROWSERBASE_PROJECT_ID,
    // Stagehand 2.5.9's extract() resolves the model via its internal
    // modelToProviderMap, whose only Claude entries are claude-haiku-4-5 and the
    // two Sonnet 3.7 IDs. Sonnet 4.x isn't in the map (UnsupportedModelError),
    // and the Sonnet 3.7 IDs 404 on this account (no access to retired models).
    // Haiku 4.5 is the one current model both in the map and available here.
    modelName: "claude-haiku-4-5",
    modelClientOptions: { apiKey: process.env.ANTHROPIC_API_KEY }
  });

  await stagehand.init();
  try {
    const page = stagehand.page;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const result = await page.extract({
      instruction: `Extract any active emergency alerts about ${what}. For each, return its title/event, the area it affects, and the instruction to residents.`,
      schema: z.object({
        alerts: z.array(z.object({
          event: z.string(),
          area: z.string(),
          text: z.string()
        }))
      })
    });
    return (result.alerts || []).map((a: any) => ({ source: url, severity: "unknown", ...a }));
  } catch (e) {
    console.error("scrape failed:", e);
    return [];
  } finally {
    await stagehand.close();
  }
}
