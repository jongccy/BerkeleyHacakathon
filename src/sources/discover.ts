import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";

// Agentic discovery: Browserbase opens Google News for an event + date window, picks
// the top N articles itself, follows each link (Google News redirects to the real
// outlet), and extracts the emergency warnings/evacuations. We supply only the search
// intent (query + date range) — Browserbase finds the actual sources on its own.
// Google News RSS is used as the results surface because it's reliable and captcha-free.
export interface DiscoverOpts {
  query: string;          // e.g. "Maui Kaupakalua Dam evacuation flood"
  after?: string;         // YYYY-MM-DD (publication date floor)
  before?: string;        // YYYY-MM-DD (publication date ceiling)
  maxArticles?: number;   // default 10
}

function googleNewsUrl(query: string, after?: string, before?: string): string {
  let q = query;
  if (after) q += ` after:${after}`;
  if (before) q += ` before:${before}`;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
}

const ARTICLE_INSTRUCTION =
  "This is a news article about a flood / dam / storm / evacuation emergency. Extract every official emergency warning, evacuation order, shelter-in-place notice, shelter location, and road closure mentioned. For each, give: the event name, the area affected, the instruction to residents, and issued_at = the specific date/time it was issued, took effect, or expires if the article states one (e.g. '2:58 p.m. March 8, 2021', 'until 8:45 p.m.'), otherwise an empty string.";

// Pull the article's precise publication timestamp from page metadata (more reliable
// than the Google News feed, which normalizes old items to a placeholder time).
function parsePublishedTime(html: string): string | null {
  const patterns = [
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i,
    /"datePublished"\s*:\s*"([^"]+)"/i,
    /<meta[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']+)["']/i,
    /<time[^>]+datetime=["']([^"']+)["']/i
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

export async function discoverAlerts(opts: DiscoverOpts): Promise<any[]> {
  const max = opts.maxArticles ?? 10;
  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    apiKey: process.env.BROWSERBASE_API_KEY,
    projectId: process.env.BROWSERBASE_PROJECT_ID,
    modelName: "claude-haiku-4-5",
    modelClientOptions: { apiKey: process.env.ANTHROPIC_API_KEY }
  });

  await stagehand.init();
  const out: any[] = [];
  try {
    const page = stagehand.page;

    // 1) DISCOVER — open Google News and let Browserbase list the matching articles.
    await page.goto(googleNewsUrl(opts.query, opts.after, opts.before), { waitUntil: "domcontentloaded" });
    const found = await page.extract({
      instruction: `This is a Google News results feed for a disaster event. Extract the top ${max} news articles. For each, return its headline, its publication date/time, and its link URL.`,
      schema: z.object({
        articles: z.array(z.object({ title: z.string(), published: z.string(), link: z.string() }))
      })
    });
    const articles = (found.articles || []).filter((a: any) => a.link).slice(0, max);
    console.log(`[discover] "${opts.query}" -> ${articles.length} articles selected`);

    // 2) INGEST — visit each article (the Google News link redirects to the real
    // outlet) and extract its emergency info. Each failure is isolated.
    for (const a of articles) {
      try {
        await page.goto(a.link, { waitUntil: "domcontentloaded" });
        const realUrl = page.url();
        // Precise publish time from the real article's metadata (feed time is unreliable).
        let articlePublished = a.published;
        try {
          const html = await page.content();
          articlePublished = parsePublishedTime(html) || a.published;
        } catch { /* keep feed time */ }
        const ext = await page.extract({
          instruction: ARTICLE_INSTRUCTION,
          schema: z.object({
            alerts: z.array(z.object({ event: z.string(), area: z.string(), text: z.string(), issued_at: z.string() }))
          })
        });
        const alerts = ext.alerts || [];
        for (const al of alerts) {
          out.push({
            source: realUrl, headline: a.title, article_published: articlePublished,
            issued_at: al.issued_at || "", severity: "unknown",
            event: al.event, area: al.area, text: al.text
          });
        }
        console.log(`[discover] ${a.title.slice(0, 55)} -> ${alerts.length} alerts (pub ${articlePublished}) (${realUrl.slice(0, 45)})`);
      } catch (e) {
        console.error(`[discover] article failed: ${String(a.link).slice(0, 50)} - ${(e as Error).message}`);
      }
    }
  } finally {
    await stagehand.close();
  }

  // Dedup exact repeats (same event + area) across articles.
  const seen = new Set<string>();
  return out.filter((a) => {
    const key = `${String(a.event || "").toLowerCase().trim()}|${String(a.area || "").toLowerCase().trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
