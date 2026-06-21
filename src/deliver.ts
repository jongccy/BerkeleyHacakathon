// twilio is imported lazily (inside getTwilioClient) so this module loads even when
// the package isn't installed — e.g. Poke-only demos, which never touch Twilio.

// Normalize a phone number to E.164 (what Twilio requires): a leading "+",
// country code, then digits — no spaces, dashes, or parens. We default a bare
// 10-digit number to US (+1) so a judge can type "650-963-6822" and it still works.
export function toE164(raw: string): string {
  const trimmed = (raw || "").trim();
  if (trimmed.startsWith("+")) {
    return "+" + trimmed.slice(1).replace(/\D/g, "");
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;          // bare US number
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return "+" + digits;                                      // best effort
}

async function sendViaPoke(_to: string, body: string) {
  if (!process.env.POKE_API_KEY) throw new Error("POKE_API_KEY not set");
  const res = await fetch("https://poke.com/api/v1/inbound-sms/webhook", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.POKE_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ message: body })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Poke send failed (${res.status}): ${text}`);
  }
  return res.json();
}

// Lazily import + construct the Twilio client so the module still loads when the
// twilio package or creds are absent (e.g. Poke-only or compute-only runs). Only
// built when we actually send via Twilio.
let twilioClient: any = null;
async function getTwilioClient() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    throw new Error("Twilio not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN missing)");
  }
  if (!twilioClient) {
    const { default: twilio } = await import("twilio");
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return twilioClient;
}

// Replace common non-GSM-7 characters (em/en dashes, curly quotes, ellipsis) with
// ASCII equivalents. Non-GSM characters force UCS-2 encoding, which drops the SMS
// segment limit from 160 to 70 chars and trips trial-account limits (error 30044).
export function gsmSafe(s: string): string {
  return (s || "")
    .replace(/[—–]/g, "-")   // em / en dash
    .replace(/[‘’]/g, "'")   // curly single quotes
    .replace(/[“”]/g, '"')   // curly double quotes
    .replace(/…/g, "...")          // ellipsis
    .replace(/[^\x00-\x7F]/g, "");      // drop any remaining non-ASCII
}

async function sendViaTwilio(to: string, body: string) {
  if (!process.env.TWILIO_FROM_NUMBER) throw new Error("TWILIO_FROM_NUMBER not set");
  // Cap to 2 GSM-7 segments (320 chars) so trial accounts accept it.
  const safeBody = gsmSafe(body).slice(0, 320);
  return (await getTwilioClient()).messages.create({
    from: process.env.TWILIO_FROM_NUMBER,
    to: toE164(to),
    body: safeBody
  });
}

// Delivery strategy is configurable so the demo can force a known-good channel.
// DELIVERY=twilio -> Twilio only; DELIVERY=poke -> Poke only; default tries Poke
// first and falls back to Twilio SMS (the handoff's primary live-demo channel).
export async function sendMessage(to: string, body: string) {
  const channel = (process.env.DELIVERY || "").toLowerCase();

  if (channel === "twilio") return sendViaTwilio(to, body);
  if (channel === "poke") return sendViaPoke(to, body);

  try {
    return await sendViaPoke(to, body);
  } catch (e) {
    console.warn("[deliver] Poke failed, falling back to Twilio:", (e as Error).message);
    return sendViaTwilio(to, body);
  }
}
