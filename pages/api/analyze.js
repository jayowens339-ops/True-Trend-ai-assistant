// pages/api/analyze.js
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { symbol, timeframe } = req.body || {};
    if (!symbol) return res.status(400).json({ error: "Missing symbol" });

    // ✅ Server-only key (DO NOT prefix with NEXT_PUBLIC_)
    const apiKey = process.env.TRUETREND_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Server API key not set" });

    // Call your backend/3rd-party service here
    const r = await fetch(process.env.TRUETREND_API_URL ?? "https://api.truetrend.ai/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ symbol, timeframe: timeframe || "Monthly" }),
      // Prevent any caching surprises on Vercel
      cache: "no-store",
    });

    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return res.status(r.status).json({
        error: "Upstream error",
        detail: text || `Status ${r.status}`,
      });
    }

    const data = await r.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
}
