// api/analyze.js
// Vercel serverless function – requires FINNHUB_API_KEY in Project Settings

export default async function handler(req, res) {
  try {
    const { symbol = 'AAPL', resolution = '60', days = '10' } = req.query;

    const token = process.env.FINNHUB_API_KEY;
    if (!token) {
      return res.status(200).json({ error: 'Missing FINNHUB_API_KEY' });
    }

    // Finnhub resolutions allowed: 1,5,15,30,60,D,W,M
    const allowed = new Set(['1','5','15','30','60','D','W','M']);
    const r = allowed.has(resolution) ? resolution : '60';

    const now = Math.floor(Date.now() / 1000);
    const from = now - (parseInt(days, 10) || 10) * 86400;

    // Fetch candles
    const candleUrl = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=${r}&from=${from}&to=${now}&token=${token}`;
    const candleResp = await fetch(candleUrl);
    const candle = await candleResp.json();

    if (!candle || candle.s !== 'ok' || !Array.isArray(candle.c) || candle.c.length < 15) {
      return res.status(200).json({ error: `No candle data for ${symbol} (${r})` });
    }

    const closes = candle.c;
    const price = closes[closes.length - 1];

    // helpers
    const sma = (arr, n) => {
      if (arr.length < n) return null;
      const out = [];
      let sum = 0;
      for (let i = 0; i < arr.length; i++) {
        sum += arr[i];
        if (i >= n) sum -= arr[i - n];
        if (i >= n - 1) out.push(sum / n);
      }
      return out;
    };

    const rsi14 = (arr, period = 14) => {
      if (arr.length <= period) return null;
      let gains = 0, losses = 0;
      for (let i = 1; i <= period; i++) {
        const diff = arr[i] - arr[i - 1];
        if (diff >= 0) gains += diff; else losses -= diff;
      }
      let avgGain = gains / period;
      let avgLoss = losses / period;
      for (let i = period + 1; i < arr.length; i++) {
        const diff = arr[i] - arr[i - 1];
        const gain = Math.max(diff, 0);
        const loss = Math.max(-diff, 0);
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
      }
      if (avgLoss === 0) return 100;
      const rs = avgGain / avgLoss;
      return +(100 - (100 / (1 + rs))).toFixed(2);
    };

    // compute indicators
    const sma20Arr = sma(closes, 20);
    const sma50Arr = sma(closes, 50);
    const lastSMA20 = sma20Arr ? sma20Arr[sma20Arr.length - 1] : null;
    const lastSMA50 = sma50Arr ? sma50Arr[sma50Arr.length - 1] : null;
    const rsi = rsi14(closes);

    // support/resistance: recent min/max of last N closes
    const look = Math.min(50, closes.length);
    const recent = closes.slice(-look);
    const support = Math.min(...recent);
    const resistance = Math.max(...recent);

    // bias logic
    let bias = 'neutral';
    let confidence = 50;
    const notes = [];

    if (lastSMA20 && lastSMA50) {
      if (lastSMA20 > lastSMA50 && price > lastSMA20) {
        bias = 'long';
        confidence = 60;
        notes.push('SMA20>SMA50');
      } else if (lastSMA20 < lastSMA50 && price < lastSMA20) {
        bias = 'short';
        confidence = 60;
        notes.push('SMA20<SMA50');
      }
    }
    if (rsi !== null) {
      if (bias === 'long' && rsi >= 50) { confidence += 10; notes.push('RSI ≥ 50'); }
      if (bias === 'short' && rsi <= 50) { confidence += 10; notes.push('RSI ≤ 50'); }
      if (rsi > 70) notes.push('RSI > 70 (overbought)');
      if (rsi < 30) notes.push('RSI < 30 (oversold)');
    }

    confidence = Math.max(0, Math.min(95, confidence));

    return res.status(200).json({
      symbol, timeframe: r, price,
      bias, confidence,
      rsi,
      levels: { support: +support.toFixed(2), resistance: +resistance.toFixed(2) },
      notes,
    });
  } catch (e) {
    return res.status(200).json({ error: 'Analysis failed' });
  }
}
