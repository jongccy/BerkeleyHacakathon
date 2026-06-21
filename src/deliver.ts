export async function sendMessage(to: string, body: string) {
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
