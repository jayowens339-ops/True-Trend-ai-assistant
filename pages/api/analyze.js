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

    const apiKey = process.env.TRUETREND_API_KEY; // server-only (no NEXT_PUBLIC_)
    if (!apiKey) {
      return res.status(500).json({ error: true, message: "Server API key not set" });
    }

    const url = process.env.TRUETREND_API_URL || "https://api.truetrend.ai/analyze";

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ symbol, timeframe: timeframe || "Monthly" }),
      cache: "no-store",
    });

    const text = await r.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text }; // upstream sent plain text
    }

    if (!r.ok) {
      return res
        .status(r.status)
        .json({ error: true, status: r.status, message: data?.message || data?.error || data?.raw || `Upstream ${r.status}` });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error("analyze API error:", err);
    return res.status(500).json({ error: true, message: "Unexpected server error" });
  }
}
