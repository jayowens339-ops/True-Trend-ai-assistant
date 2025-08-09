// /api/analyze.js
export default async function handler(req, res) {
  try {
    const { symbol = '', timeframe = '60' } = req.query;

    if (!symbol) {
      return res.status(400).json({ error: 'Missing symbol' });
    }

    const FINNHUB_API_KEY =
      process.env.FINNHUB_API_KEY ||
      'd2b68fpr01qrj4ikj0n0d2b68fpr01qrj4ikj0ng'; // fallback for demo

    // Map timeframe to Finnhub resolution/candle count
    const map = {
      '1':  { res: '1',   candles: 300 },
      '5':  { res: '5',   candles: 300 },
      '15': { res: '15',  candles: 300 },
      '30': { res: '30',  candles: 300 },
      '60': { res: '60',  candles: 300 }, // 1h default
      'D':  { res: 'D',   candles: 250 },
      'W':  { res: 'W',   candles: 156 }
    };
    const { res: resolution, candles } = map[timeframe] || map['60'];

    const now = Math.floor(Date.now() / 1000);
    const seconds = (() => {
      switch (resolution) {
        case '1':   return 3600 * 6;     // ~6h
        case '5':   return 3600 * 24;    // 1 day
        case '15':  return 3600 * 24 * 3;
        case '30':  return 3600 * 24 * 6;
        case '60':  return 3600 * 24 * 14;
        case 'D':   return 3600 * 24 * 250;
        case 'W':   return 3600 * 24 * 7 * 156;
        default:    return 3600 * 24 * 14;
      }
    })();

    const from = now - seconds;
    const url =
      `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}` +
      `&resolution=${resolution}&from=${from}&to=${now}&token=${FINNHUB_API_KEY}`;

    const r = await fetch(url);
    const data = await r.json();

    if (!r.ok || data.s !== 'ok') {
      return res.status(400).json({
        error: data?.error || data?.s || 'Upstream error',
      });
    }

    // Basic direction using last two closes
    const closes = data.c || [];
    const last = closes[closes.length - 1];
    const prev = closes[closes.length - 2];
    const direction = last > prev ? 'long' : last < prev ? 'short' : 'neutral';

    return res.status(200).json({
      symbol,
      timeframe,
      resolution,
      direction,
      lastPrice: last,
      totalCandles: closes.length
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Server error' });
  }
}
