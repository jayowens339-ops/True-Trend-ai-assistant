// pages/api/analyze.js
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: true, message: "Method not allowed" });
  }

  try {
    const { symbol, timeframe } = req.body || {};
    if (!symbol) {
      return res.status(400).json({ error: true, message: "Missing symbol" });
    }

    const finnhubKey = process.env.FINNHUB_API_KEY;
    if (!finnhubKey) {
      return res.status(500).json({ error: true, message: "FINNHUB_API_KEY not set on server" });
    }

    // Finnhub stock quote endpoint (AAPL, NVDA, SPY, etc.)
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(
      symbol
    )}&token=${encodeURIComponent(finnhubKey)}`;

    const r = await fetch(url, { cache: "no-store" });
    const raw = await r.text();

    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }

    if (!r.ok) {
      return res
        .status(r.status)
        .json({ error: true, status: r.status, message: data?.error || data?.raw || `Finnhub error ${r.status}` });
    }

    // Normalize for your UI
    // Finnhub returns: c=current, h=high, l=low, o=open, pc=prev close, t=unix
    return res.status(200).json({
      ok: true,
      symbol,
      timeframe: timeframe || "Weekly",
      quote: data,
    });
  } catch (err) {
    console.error("analyze route error:", err);
    return res.status(500).json({ error: true, message: "Unexpected server error" });
  }
}
