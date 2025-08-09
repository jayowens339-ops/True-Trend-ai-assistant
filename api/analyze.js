// /api/analyze.js
// Works on Vercel/Node serverless.
// Requires: FINNHUB_API_KEY in your env (Vercel > Project > Settings > Environment Variables)
//
// Request:
//   GET /api/analyze?symbol=NVDA&timeframe=1h
//     symbol:  AAPL, NVDA, SPY, BTCUSD, BTC/USDT, EUR/USD, etc.
//     timeframe: 1m 5m 15m 30m 1h 4h D W M   (defaults to 1h)
//     lookbackDays: integer (defaults 10)
//
// Response:
//   { bias, confidence, rsi, levels: {support, resistance}, price, notes[] }

const API_KEY = process.env.FINNHUB_API_KEY;

// --- configuration ------------------------------------------------------------

const CRYPTO_BASES = new Set([
  'BTC', 'ETH', 'SOL', 'ADA', 'XRP', 'DOGE', 'SHIB', 'LTC', 'BNB', 'AVAX',
  'DOT', 'LINK', 'MATIC', 'ARB', 'OP', 'ATOM', 'NEAR', 'ETC', 'BCH', 'FTM',
  'APT', 'INJ', 'SUI', 'TIA', 'PEPE'
]);

const FX_DEFAULT_VENDOR = 'FX_IDC'; // safer mapping; OANDA can be used too

// map UI timeframe -> Finnhub resolution + suggested history in days
const TF = {
  '1m':  { res: '1',   days: 2 },
  '5m':  { res: '5',   days: 7 },
  '15m': { res: '15',  days: 14 },
  '30m': { res: '30',  days: 20 },
  '1h':  { res: '60',  days: 30 },
  '4h':  { res: '240', days: 120 },
  'D':   { res: 'D',   days: 365 },
  'W':   { res: 'W',   days: 365 * 2 },
  'M':   { res: 'M',   days: 365 * 5 }
};

// --- tiny helpers -------------------------------------------------------------

const nowSec = () => Math.floor(Date.now() / 1000);
const daysAgoSec = (d) => nowSec() - Math.floor(d * 86400);

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / (arr.length || 1); }
function sum(arr)  { return arr.reduce((a, b) => a + b, 0); }

function sma(values, length) {
  if (values.length < length) return null;
  let s = 0;
  for (let i = values.length - length; i < values.length; i++) s += values[i];
  return s / length;
}

function rsi(values, length = 14) {
  if (values.length <= length) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - length; i < values.length; i++) {
    const chg = values[i] - values[i - 1];
    if (chg >= 0) gains += chg; else losses -= chg;
  }
  const avgGain = gains / length;
  const avgLoss = losses / length;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function recentLevels(values, span = 20) {
  if (values.length < span) return { support: null, resistance: null };
  const slice = values.slice(-span);
  return { support: Math.min(...slice), resistance: Math.max(...slice) };
}

function slope(arr) {
  // last N slope: simple linear regression slope sign
  const N = Math.min(arr.length, 20);
  if (N < 3) return 0;
  const y = arr.slice(-N);
  const x = Array.from({ length: N }, (_, i) => i + 1);
  const xMean = mean(x), yMean = mean(y);
  const num = sum(x.map((xi, i) => (xi - xMean) * (y[i] - yMean)));
  const den = sum(x.map((xi) => Math.pow(xi - xMean, 2)));
  if (den === 0) return 0;
  return num / den;
}

// --- symbol parsing & endpoint selection -------------------------------------

function normalizeSymbol(raw) {
  // returns { asset, finnhubSymbol, pretty, notes[] }
  // asset: 'stock' | 'crypto' | 'fx'
  const s = (raw || '').toUpperCase().trim();
  const notes = [];

  // Crypto patterns
  if (s.includes('BTC') || s.includes('ETH') || s.includes('USDT') || s.includes('USDC')) {
    const base = s.replace(/[^A-Z/]/g, '').split(/[\/]/)[0];
    let quote = 'USDT';
    if (s.includes('/')) {
      const parts = s.split('/');
      if (parts[1]) quote = parts[1].replace(/[^A-Z]/g, '') || 'USDT';
    } else if (s.endsWith('USDT')) {
      return { asset: 'crypto', finnhubSymbol: `BINANCE:${s}`, pretty: s, notes };
    }
    const sym = `BINANCE:${base}${quote}`;
    notes.push(`Crypto detected → ${sym}`);
    return { asset: 'crypto', finnhubSymbol: sym, pretty: `${base}/${quote}`, notes };
  }
  // Crypto by base-only (e.g., "SOL")
  const token = s.replace(/[^A-Z]/g, '');
  if (CRYPTO_BASES.has(token)) {
    const sym = `BINANCE:${token}USDT`;
    notes.push(`Crypto detected → ${sym}`);
    return { asset: 'crypto', finnhubSymbol: sym, pretty: `${token}/USDT`, notes };
  }

  // FX patterns
  if (s.includes('/')) {
    const [a, b] = s.split('/');
    const base = (a || '').replace(/[^A-Z]/g, '');
    const quote = (b || '').replace(/[^A-Z]/g, '');
    if (base.length === 3 && quote.length === 3) {
      const fx = `${FX_DEFAULT_VENDOR}:${base}${quote}`;
      notes.push(`Forex detected → ${fx}`);
      return { asset: 'fx', finnhubSymbol: fx, pretty: `${base}/${quote}`, notes };
    }
  }
  // raw like "EURUSD"
  if (s.length === 6 && /^[A-Z]{6}$/.test(s)) {
    const fx = `${FX_DEFAULT_VENDOR}:${s}`;
    notes.push(`Forex detected → ${fx}`);
    return { asset: 'fx', finnhubSymbol: fx, pretty: `${s.slice(0,3)}/${s.slice(3)}`, notes };
  }

  // Default: stocks / ETFs / indices
  notes.push(`Assuming stock/ETF: ${s}`);
  return { asset: 'stock', finnhubSymbol: s, pretty: s, notes };
}

function pickEndpoint(asset) {
  if (asset === 'crypto') return 'crypto/candle';
  if (asset === 'fx') return 'forex/candle';
  return 'stock/candle';
}

// --- fetch wrappers -----------------------------------------------------------

async function fhJSON(url) {
  const r = await fetch(url);
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch (_) {
    throw new Error(`Finnhub response not JSON: ${text.slice(0, 120)}`);
  }
  if (!r.ok) {
    const err = json && (json.error || json.msg || text);
    throw new Error(err || `HTTP ${r.status}`);
  }
  return json;
}

async function getCandles(endpoint, symbol, resolution, from, to) {
  const url = `https://finnhub.io/api/v1/${endpoint}?symbol=${encodeURIComponent(symbol)}&resolution=${encodeURIComponent(resolution)}&from=${from}&to=${to}&token=${API_KEY}`;
  const j = await fhJSON(url);
  if (j.s !== 'ok' || !Array.isArray(j.c) || j.c.length < 2) {
    const why = j.s || j.error || 'no data';
    throw new Error(`No candle data for ${symbol} (${why})`);
  }
  return j; // { c, h, l, o, s, t, v }
}

async function getQuoteIfStock(asset, symbol) {
  if (asset !== 'stock') return null;
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${API_KEY}`;
  try { return await fhJSON(url); } catch { return null; }
}

// --- main logic ---------------------------------------------------------------

export default async function handler(req, res) {
  try {
    if (!API_KEY) {
      return res.status(500).json({ error: 'Missing FINNHUB_API_KEY' });
    }

    const {
      symbol: rawSymbol = 'NVDA',
      timeframe = '1h',
      lookbackDays
    } = req.query;

    const tfKey = (timeframe || '1h').toUpperCase();
    const tf = TF[tfKey] || TF['1h'];
    const days = Number(lookbackDays) > 0 ? Number(lookbackDays) : tf.days;

    const parsed = normalizeSymbol(rawSymbol);
    const endpoint = pickEndpoint(parsed.asset);
    const to = nowSec();
    const from = daysAgoSec(days);

    const candles = await getCandles(endpoint, parsed.finnhubSymbol, tf.res, from, to);
    const closes = candles.c;

    // features
    const price = closes.at(-1);
    const sma20 = sma(closes, 20);
    const sma50 = sma(closes, 50);
    const _rsi = rsi(closes, 14);
    const { support, resistance } = recentLevels(closes, 20);
    const sl = slope(closes);

    // bias + confidence (very simple rules; expand as you wish)
    let bias = 'neutral';
    const notes = [...(parsed.notes || [])];

    if (sma20 && sma50) {
      if (sma20 > sma50) {
        bias = 'long';
        notes.push('SMA20 > SMA50 (bullish)');
      } else if (sma20 < sma50) {
        bias = 'short';
        notes.push('SMA20 < SMA50 (bearish)');
      }
    }
    // nudge by slope
    if (Math.abs(sl) > 0.02) {
      if (sl > 0) { bias = 'long'; notes.push('Positive slope of recent closes'); }
      else { bias = 'short'; notes.push('Negative slope of recent closes'); }
    }

    // confidence (0..100)
    let conf = 50;
    if (bias !== 'neutral') {
      conf = 60;
      if (_rsi !== null) {
        if (bias === 'long' && _rsi > 50) conf += 15;
        if (bias === 'short' && _rsi < 50) conf += 15;
        if (_rsi > 70 || _rsi < 30) conf -= 10; // overbought/oversold caution
      }
      if (sma20 && price) {
        const dist = Math.abs(price - sma20) / price;
        if (dist < 0.01) conf += 10; // price near mean
      }
      conf = Math.max(5, Math.min(95, conf));
    }

    // add rsi bands note
    if (_rsi !== null) {
      if (_rsi >= 70) notes.push('RSI overbought (≥70)');
      else if (_rsi <= 30) notes.push('RSI oversold (≤30)');
    }

    // try live quote for stocks for a fresher price
    const q = await getQuoteIfStock(parsed.asset, parsed.finnhubSymbol);
    const livePrice = q && typeof q.c === 'number' && q.c > 0 ? q.c : price;

    return res.status(200).json({
      symbol: parsed.pretty,
      asset: parsed.asset,
      timeframe: tfKey,
      price: livePrice,
      bias,
      confidence: Math.round(conf),
      rsi: _rsi !== null ? Math.round(_rsi * 10) / 10 : null,
      levels: {
        support: support !== null ? Math.round(support * 100) / 100 : null,
        resistance: resistance !== null ? Math.round(resistance * 100) / 100 : null
      },
      notes
    });
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
}
