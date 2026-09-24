// Server-only helper — never import from client code.
export function callLovableAI(messages: { role: "system" | "user" | "assistant"; content: string }[], model = "google/gemini-2.5-flash") {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("Missing LOVABLE_API_KEY");
  return fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": key,
    },
    body: JSON.stringify({ model, messages }),
  });
}

export async function aiComplete(system: string, user: string, model?: string): Promise<string> {
  const res = await callLovableAI(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    model,
  );
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) throw new Error("AI rate limit reached. Try again in a moment.");
    if (res.status === 402) throw new Error("AI credits exhausted. Add credits in Lovable Cloud.");
    throw new Error(`AI request failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? "";
}
