import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ASI:One (Fetch.ai) is an OpenAI-compatible chat-completions API. Routing the
// reconcile step through it lets the project legitimately run on Fetch's model
// (the sponsor-prize "orchestrator" path, handoff 2c light path).
// Opt in with LLM_PROVIDER=asi1; default stays Anthropic (claude-sonnet-4-6),
// the model the demo divergence was validated on. If asi1 is requested but no
// key is set, we fall back to Anthropic so the demo can never hard-fail.
const ASI1_BASE = "https://api.asi1.ai/v1";
const ASI1_MODEL = process.env.ASI1_MODEL || "asi1-mini";

async function callLLM(system: string, userContent: string): Promise<string> {
  const wantAsi1 = process.env.LLM_PROVIDER === "asi1";

  if (wantAsi1 && process.env.ASI1_API_KEY) {
    const res = await fetch(`${ASI1_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.ASI1_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: ASI1_MODEL,
        max_tokens: 1000,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent }
        ]
      })
    });
    if (!res.ok) throw new Error(`ASI1 reconcile failed (${res.status}): ${await res.text()}`);
    const data = await res.json() as any;
    return data.choices?.[0]?.message?.content?.trim() || "{}";
  }

  if (wantAsi1) {
    console.warn("[reconcile] LLM_PROVIDER=asi1 but ASI1_API_KEY is empty — falling back to Anthropic.");
  }

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    system,
    messages: [{ role: "user", content: userContent }]
  });
  const textBlock = msg.content.find((c: any) => c.type === "text") as any;
  return textBlock?.text?.trim() || "{}";
}

export async function reconcile(profile: any, alerts: any[], shelters: any[], zoneName: string | null) {
  const system = `You are an emergency guidance assistant for Maui County.
You receive (1) multiple, possibly conflicting alerts from official channels, (2) one resident's household profile, (3) the official list of shelters, and (4) the resident's evacuation zone if known.

Hard rules:
- NEVER invent a destination. Only choose from the official shelter list provided.
- NEVER contradict an official evacuation order. If an order says evacuate, do not tell them to stay.
- If the alerts conflict on the core action (evacuate vs shelter in place), or you are not confident, set fail_safe=true and tell the resident to follow official guidance and monitor official channels.
- Personalize: someone with no car needs transit-accessible or pickup options, not a driving route. A family with pets needs a pet-friendly shelter. Mobility needs require accessible shelters.
- Be concise and calm. Output STRICT JSON only, no markdown.
- recommended_action MUST be at most 2 short sentences (under 240 characters) and use plain ASCII punctuation only (no em dashes or curly quotes) — it is sent verbatim as one SMS.`;

  const user = {
    profile, zone: zoneName, alerts, shelters,
    output_schema: {
      authoritative_summary: "string: what is actually being ordered, conflicts resolved",
      applies_to_user: "boolean",
      recommended_action: "string: one clear instruction for THIS resident",
      destination: "string|null: shelter name from the official list, or null",
      how_to_get_there: "string: tailored to their car/mobility situation",
      confidence: "number 0..1",
      fail_safe: "boolean",
      reasoning: "string: short"
    }
  };

  let raw = await callLLM(system, JSON.stringify(user));
  raw = raw.replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  try { return JSON.parse(raw); }
  catch { return { fail_safe: true, recommended_action: "Follow official guidance and monitor local emergency channels.", confidence: 0, reasoning: "parse_error" }; }
}
