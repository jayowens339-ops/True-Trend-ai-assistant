export default async function handler(req, res) {
  const symbol = (req.query.symbol || "AAPL").toUpperCase();
  const apiKey = process.env.FINNHUB_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: "Missing FINNHUB_API_KEY in environment variables" });
  }

  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Finnhub error ${response.status}`);
    const data = await response.json();

    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: "Error fetching data from Finnhub", details: error.message });
  }
}
