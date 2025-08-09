// /api/finance.js
export default async function handler(req, res) {
  try {
    const { symbol = '', resolution = 'D' } = req.query;
    const key = process.env.FINNHUB_API_KEY;

    if (!key) {
      return res.status(500).json({ error: 'Missing FINNHUB_API_KEY' });
    }

    // quick validation
    const allowed = new Set(['1','5','15','30','60','D','W','M']);
    const cleanRes = allowed.has(resolution.toUpperCase())
      ? resolution.toUpperCase()
      : 'D';

    const cleanSymbol = String(symbol || '').trim().toUpperCase();
    if (!cleanSymbol) {
      return res.status(400).json({ error: 'Missing symbol' });
    }

    // time range: last ~180 days (or minutes for intraday)
    const now = Math.floor(Date.now() / 1000);
    // 6 months of seconds
    const sixMonthsSec = 60 * 60 * 24 * 30 * 6;

    // Finnhub wants: resolution in (1,5,15,30,60,D,W,M)
    const url = new URL('https://finnhub.io/api/v1/stock/candle');
    url.searchParams.set('symbol', cleanSymbol);
    url.searchParams.set('resolution', cleanRes);
    url.searchParams.set('from', String(now - sixMonthsSec));
    url.searchParams.set('to', String(now));
    url.searchParams.set('token', key);

    const r = await fetch(url.toString());
    const json = await r.json();

    if (json.s !== 'ok') {
      return res.status(400).json({ error: json.s || 'Bad response', details: json });
    }

    // Return candles and a tiny summary (you can expand later)
    const candles = (json.t || []).map((t, i) => ({
      t, o: json.o[i], h: json.h[i], l: json.l[i], c: json.c[i], v: json.v[i]
    }));

    res.status(200).json({
      symbol: cleanSymbol,
      resolution: cleanRes,
      count: candles.length,
      candles
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error', message: e.message });
  }
}
