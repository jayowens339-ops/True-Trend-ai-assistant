// /api/finance.js
// Usage: /api/finance?symbol=NVDA&resolution=60&days=7
// Env: FINNHUB_API_KEY

export default async function handler(req, res) {
  try {
    const token = process.env.FINNHUB_API_KEY;
    if (!token) {
      return res.status(500).json({ error: 'Missing FINNHUB_API_KEY' });
    }

    const { symbol = 'NVDA', resolution = '60', days = '5' } = req.query;

    // time window
    const nowSec = Math.floor(Date.now() / 1000);
    const fromSec = nowSec - Number(days) * 24 * 60 * 60;

    // Helper to try stock -> forex -> crypto
    const fetchCandles = async () => {
      // stock
      let url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${fromSec}&to=${nowSec}&token=${token}`;
      let r = await fetch(url);
      let j = await r.json();
      if (j && j.s === 'ok') return j;

      // forex
      url = `https://finnhub.io/api/v1/forex/candle?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${fromSec}&to=${nowSec}&token=${token}`;
      r = await fetch(url);
      j = await r.json();
      if (j && j.s === 'ok') return j;

      // crypto
      url = `https://finnhub.io/api/v1/crypto/candle?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${fromSec}&to=${nowSec}&token=${token}`;
      r = await fetch(url);
      j = await r.json();
      if (j && j.s === 'ok') return j;

      throw new Error('No candles returned for symbol');
    };

    const candles = await fetchCandles();

    // get latest quote if available (stocks only, ok if it fails)
    let price = null;
    try {
      const qr = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${token}`
      );
      const qj = await qr.json();
      if (qj && typeof qj.c === 'number') price = qj.c;
    } catch (_) {}

    // --- Technical helpers ---
    const close = candles.c || [];
    const high = candles.h || [];
    const low = candles.l || [];

    const SMA = (arr, len) => {
      if (arr.length < len) return [];
      const out = [];
      let sum = 0;
      for (let i = 0; i < arr.length; i++) {
        sum += arr[i];
        if (i >= len) sum -= arr[i - len];
        if (i >= len - 1) out.push(sum / len);
      }
      return out;
    };

    const RSI = (arr, period = 14) => {
      if (arr.length < period + 1) return null;
      let gains = 0, losses = 0;
      for (let i = 1; i <= period; i++) {
        const diff = arr[i] - arr[i - 1];
        if (diff >= 0) gains += diff; else losses -= diff;
      }
      let rs = gains / (losses || 1e-9);
      let rsi = 100 - 100 / (1 + rs);

      // Wilder
      for (let i = period + 1; i < arr.length; i++) {
        const diff = arr[i] - arr[i - 1];
        const gain = diff > 0 ? diff : 0;
        const loss = diff < 0 ? -diff : 0;
        gains = (gains * (period - 1) + gain) / period;
        losses = (losses * (period - 1) + loss) / period;
        rs = gains / (losses || 1e-9);
        rsi = 100 - 100 / (1 + rs);
      }
      return Math.round(rsi * 10) / 10;
    };

    const sma20 = SMA(close, 20);
    const sma50 = SMA(close, 50);
    const rsi14 = RSI(close, 14);

    // simple bias / confidence
    const last = close[close.length - 1];
    const prev = close[close.length - 2];

    let bias = 'neutral';
    let confidence = 50;

    const slope20 = sma20.length >= 2 ? sma20[sma20.length - 1] - sma20[sma20.length - 2] : 0;
    const slope50 = sma50.length >= 2 ? sma50[sma50.length - 1] - sma50[sma50.length - 2] : 0;

    if (sma20.length && sma50.length) {
      const above = last > sma20[sma20.length - 1] && last > sma50[sma50.length - 1];
      const crossUp = sma20[sma20.length - 1] > sma50[sma50.length - 1];
      const upward = slope20 > 0 && slope50 >= 0;

      const below = last < sma20[sma20.length - 1] && last < sma50[sma50.length - 1];
      const crossDn = sma20[sma20.length - 1] < sma50[sma50.length - 1];
      const downward = slope20 < 0 && slope50 <= 0;

      if (above && crossUp && upward) {
        bias = 'long'; confidence = 70 + Math.min(20, Math.round((slope20 + slope50) * 100));
      } else if (below && crossDn && downward) {
        bias = 'short'; confidence = 70 + Math.min(20, Math.round(Math.abs(slope20 + slope50) * 100));
      } else {
        bias = 'neutral'; confidence = 50;
      }
    }

    // quick S/R from last 20 bars
    const window = Math.min(20, high.length);
    const recentHigh = Math.max(...high.slice(-window));
    const recentLow = Math.min(...low.slice(-window));
    const support = Math.round(recentLow * 100) / 100;
    const resistance = Math.round(recentHigh * 100) / 100;

    const notes = [];
    if (rsi14 != null) {
      if (rsi14 > 70) notes.push('RSI overbought');
      else if (rsi14 < 30) notes.push('RSI oversold');
      else notes.push('RSI neutral');
    }
    if (bias !== 'neutral') notes.push(`Trend ${bias} via 20/50 SMA`);

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=600');

    return res.status(200).json({
      symbol,
      timeframe: resolution,
      price: price ?? last ?? null,
      bias,
      confidence,
      rsi: rsi14,
      levels: { support, resistance },
      notes,
      meta: { source: 'finnhub', days: Number(days) }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Finance endpoint failed', details: err.message });
  }
}
