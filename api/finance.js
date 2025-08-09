export default async function handler(req, res) {
  const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
  if (!FINNHUB_API_KEY) {
    return res.status(400).json({ error: 'Missing FINNHUB_API_KEY' });
  }

  try {
    const symbol = (req.query.symbol || '').trim();
    const resolution = (req.query.resolution || '60').trim(); // 1,5,15,30,60,240,D,W
    const limit = Math.min(parseInt(req.query.limit || '220', 10), 500);

    if (!symbol) return res.status(400).json({ error: 'Missing symbol' });

    // Normalize symbol for Finnhub if user types EUR/USD or BTC/USD
    const norm = symbol.replace(/\s+/g, '');
    const finSymbol = norm.includes('/') ? norm.toUpperCase() : norm.toUpperCase();

    const base = 'https://finnhub.io/api/v1';
    const qs = new URLSearchParams({ token: FINNHUB_API_KEY }).toString();

    // Quote (for last price)
    const qResp = await fetch(`${base}/quote?symbol=${encodeURIComponent(finSymbol)}&${qs}`);
    const quote = await qResp.json();

    // Candle data
    // We request “recent window” using 'count' via from-to helper: use last N trades. Finnhub needs UNIX from/to.
    const now = Math.floor(Date.now() / 1000);
    // rough seconds per bar:
    const secPerBar = resolution === 'D' ? 86400 : resolution === 'W' ? 604800 : parseInt(resolution, 10) * 60;
    const from = now - secPerBar * (limit + 5);
    const cResp = await fetch(`${base}/stock/candle?symbol=${encodeURIComponent(finSymbol)}&resolution=${encodeURIComponent(resolution)}&from=${from}&to=${now}&${qs}`);
    const candles = await cResp.json();

    if (candles.s !== 'ok') {
      return res.status(200).json({ error: 'No data', raw: candles });
    }

    const closes = candles.c || [];
    const highs = candles.h || [];
    const lows = candles.l || [];

    // Simple indicators
    const rsi = calcRSI(closes, 14);
    const sma20 = SMA(closes, 20);
    const sma50 = SMA(closes, 50);

    // S/R from recent swings
    const levels = swingLevels(highs, lows);

    // Bias: SMA 20/50 slope + cross + RSI filter
    const biasObj = biasFromSMAsAndRSI(closes, sma20, sma50, rsi);

    const notes = [];
    if (rsi.at(-1) !== undefined) notes.push(`RSI ${rsi.at(-1).toFixed(1)}`);
    if (levels.support) notes.push(`Support ${levels.support.toFixed(2)}`);
    if (levels.resistance) notes.push(`Resistance ${levels.resistance.toFixed(2)}`);

    return res.status(200).json({
      symbol: finSymbol,
      price: quote.c ?? closes.at(-1),
      bias: biasObj.bias,
      confidence: biasObj.confidence,
      rsi: rsi.at(-1) ?? null,
      levels,
      notes
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// --- helpers ---
function SMA(arr, len) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= len) sum -= arr[i - len];
    out.push(i >= len - 1 ? sum / len : NaN);
  }
  return out;
}

function calcRSI(close, period = 14) {
  if (close.length < period + 1) return [];
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const ch = close[i] - close[i - 1];
    if (ch >= 0) gains += ch; else losses -= ch;
  }
  let rs = gains / Math.max(losses, 1e-9);
  const rsiArr = [100 - 100 / (1 + rs)];
  for (let i = period + 1; i < close.length; i++) {
    const ch = close[i] - close[i - 1];
    gains = (gains * (period - 1) + Math.max(ch, 0)) / period;
    losses = (losses * (period - 1) + Math.max(-ch, 0)) / period;
    rs = gains / Math.max(losses, 1e-9);
    rsiArr.push(100 - 100 / (1 + rs));
  }
  // pad left with NaN to align
  return Array(close.length - rsiArr.length).fill(NaN).concat(rsiArr);
}

function biasFromSMAsAndRSI(close, sma20, sma50, rsi) {
  const n = close.length - 1;
  const p = (arr) => arr[n];
  const slope = (arr) => arr[n] - arr[n - 3];
  const rsiv = rsi[n];

  let bias = 'neutral', conf = 50;

  const up = p(sma20) > p(sma50) && slope(sma20) > 0 && slope(sma50) > 0;
  const dn = p(sma20) < p(sma50) && slope(sma20) < 0 && slope(sma50) < 0;

  if (up) { bias = 'long'; conf = 60; }
  if (dn) { bias = 'short'; conf = 60; }
  if (!isNaN(rsiv)) {
    if (bias === 'long' && rsiv > 55) conf += 10;
    if (bias === 'short' && rsiv < 45) conf += 10;
    if (rsiv > 70 || rsiv < 30) conf -= 5; // potential exhaustion
  }
  conf = Math.max(1, Math.min(95, Math.round(conf)));
  return { bias, confidence: conf };
}

function swingLevels(highs, lows) {
  const len = highs.length;
  const win = Math.min(30, len);
  if (win < 5) return { support: null, resistance: null };
  const hi = Math.max(...highs.slice(-win));
  const lo = Math.min(...lows.slice(-win));
  return { support: lo, resistance: hi };
}
