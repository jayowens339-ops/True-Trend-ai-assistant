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

    // Read Finnhub key (your current Vercel var)
    const finnhubKey = process.env.FINNHUB_API_KEY;
    if (!finnhubKey) {
      return res.status(500).json({ error: true, message: "FINNHUB_API_KEY not set on server" });
    }

    // Simple: use Finnhub quote endpoint (works for stocks; forex/crypto need provider-specific symbols)
    // https://finnhub.io/api/v1/quote?symbol=AAPL&token=KEY
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(finnhubKey)}`;

    const r = await fetch(url, { cache: "no-store" });
    const text = await r.text();

    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

    if (!r.ok) {
      return res.status(r.status).json({
        error: true,
        status: r.status,
        message: data?.error || data?.raw || `Finnhub error ${r.status}`
      });
    }

    // Normalize a tiny response for your UI
    // Finnhub quote fields: c=current, h=high, l=low, o=open, pc=prev close, t=timestamp
    return res.status(200).json({
      symbol,
      timeframe: timeframe || "Monthly",
      quote: data,
      ok: true
    });

  } catch (err) {
    console.error("analyze route error:", err);
    return res.status(500).json({ error: true, message: "Unexpected server error" });
  }
}
