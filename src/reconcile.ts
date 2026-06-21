import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "demo" });

function hasLlmCredentials() {
  if (process.env.LLM_PROVIDER === "asi1" && process.env.ASI1_API_KEY) return true;
  return !!process.env.ANTHROPIC_API_KEY;
}

function demoGuidance(profile: any, alerts: any[], shelters: any[], zoneName: string | null) {
  const hasCar = profile.has_car === 1;
  const hasPets = profile.pets === 1;
  const mobility = profile.mobility_needs && profile.mobility_needs !== "none";

  let destination: string | null = null;
  if (hasPets) {
    destination = shelters.find((s: any) => s.pet_friendly)?.name ?? shelters[0]?.name ?? null;
  } else if (mobility) {
    destination = shelters.find((s: any) => s.accessible)?.name ?? shelters[0]?.name ?? null;
  } else if (hasCar) {
    destination = shelters[0]?.name ?? null;
  } else {
    destination = shelters.find((s: any) => s.transit_accessible)?.name ?? shelters[0]?.name ?? null;
  }

  const alertSummary = alerts[0]?.event
    ? `${alerts[0].event} — follow official county guidance.`
    : "Sample evacuation advisory for West Maui.";

  const recommended_action = zoneName
    ? hasCar
      ? "Evacuate now via official routes. Take your household and go-bag."
      : "Evacuate now. Use Maui County transit or proceed to the nearest pickup point."
    : "No active evacuation order for your address. Stay alert and monitor official channels.";

  return {
    authoritative_summary: alertSummary,
    applies_to_user: !!zoneName,
    recommended_action,
    destination,
    how_to_get_there: hasCar
      ? "Drive on designated evacuation routes. Do not use unmarked shortcuts."
      : "Use county transit or evacuation pickup locations listed on mauicounty.gov.",
    confidence: 0.75,
    fail_safe: false,
    reasoning: "Demo guidance generated locally (LLM unavailable).",
  };
}

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
  if (!hasLlmCredentials()) {
    console.warn("[reconcile] No LLM credentials — using demo guidance.");
    return demoGuidance(profile, alerts, shelters, zoneName);
  }

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

  let raw: string;
  try {
    raw = await callLLM(system, JSON.stringify(user));
  } catch (err) {
    console.warn("[reconcile] LLM call failed — using demo guidance.", err);
    return demoGuidance(profile, alerts, shelters, zoneName);
  }

  raw = raw.replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    return demoGuidance(profile, alerts, shelters, zoneName);
  }
}
