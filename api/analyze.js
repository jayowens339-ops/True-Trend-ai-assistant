// app/api/analyze/route.ts
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { symbol, timeframe } = await request.json();

    if (!symbol) {
      return new Response(JSON.stringify({ error: "Missing symbol" }), { status: 400 });
    }

    const apiKey = process.env.TRUETREND_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "Server API key not set" }), { status: 500 });
    }

    const r = await fetch(process.env.TRUETREND_API_URL ?? "https://api.truetrend.ai/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ symbol, timeframe: timeframe || "Monthly" }),
      cache: "no-store",
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return new Response(JSON.stringify({ error: "Upstream error", detail }), { status: r.status });
    }

    const data = await r.json();
    return new Response(JSON.stringify(data), { status: 200 });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: "Unexpected server error" }), { status: 500 });
  }
}
