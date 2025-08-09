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
      return res.status(500).json({ error: true, message: "FINNHUB_API_KEY not set" });
    }

    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(finnhubKey)}`;
    const r = await fetch(url, { cache: "no-store" });
    const text = await r.text();

    let data;
    try { 
      data = JSON.parse(text); 
    } catch {
      console.error("Non-JSON from Finnhub:", text);
      return res.status(502).json({ error: true, raw: text });
    }

    if (!r.ok) {
      return res.status(r.status).json({ error: true, ...data });
    }

    return res.status(200).json({
      ok: true,
      symbol,
      timeframe: timeframe || "Weekly",
      quote: data, // Finnhub fields: c, h, l, o, pc, t
    });
  } catch (err) {
    console.error("Analyze API error:", err);
    return res.status(500).json({ error: true, message: "Unexpected server error" });
  }
}
