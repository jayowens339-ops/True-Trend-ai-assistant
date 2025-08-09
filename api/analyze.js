// /api/analyze.js
// Works on Vercel/Node serverless.
// Requires: FINNHUB_API_KEY in your env (Vercel > Project > Settings > Environment Variables)
// Output fields used by your front-end: bias, confidence, rsi, levels {support,resistance}, notes[], price

const API_KEY = process.env.FINNHUB_API_KEY;

// ---- helpers ---------------------------------------------------------------

const CRYPTO_BASES = new Set([
  'BTC','ETH','SOL','ADA','XRP','DOGE','SHIB','LTC','BNB','AVAX','DOT','LINK','MATIC','ARB','OP',
  'ATOM','NEAR','ETC','BCH','FTM','APT','INJ','SUI','TIA','PEPE'
]);

const tfMap = {
  '1m':  '1',
  '5m':  '5',
  '15m': '15',
  '30m': '30',
  '1h':  '60',
  '4h':  '240',
  'D':   'D',
  'W':   'W',
  'M':   'M'
};

function nowSec() { return Math.floor(Date.now() / 1000); }

// candle span approx (how many bars we try to pull)
function spanSeconds(tf) {
  switch (tf) {
    case '1m':  return 60 * 60 * 12;     // 12h
    case '5m':  return 60 * 60 * 24 * 2; // 2d
    case '15m': return 60 * 60 * 24 * 4;
    case '30m': return 60 * 60 * 24 * 7;
    case '1h':  return 60 * 60 * 24 * 14;
    case '4h':  return 60 * 60 * 24 * 60;
    case 'D':   return 60 * 60 * 24 * 365;
    case 'W':   return 60 * 60 * 24 * 365 * 2;
    case 'M':   return 60 * 60 * 24 * 365 * 5;
    default:    return 60 * 60 * 24 * 60;
  }
}

// simple SMA
function sma(values, period) {
  if (values.length < period) return null;
  let sum = 0, out = [];
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out.push(sum / period);
  }
  return out;
}

// RSI(14) classic
function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const ch = values[i] - values[i-1];
    if (ch >= 0) gains += ch; else losses -= ch;
  }
  gains /= period; losses /= period;
  let rs = losses === 0 ? 100 : gains / (losses || 1e-10);
  let rsiArr = [100 - 100 / (1 + rs)];
  for (let i = period + 1; i < values.length; i++) {
    const ch = values[i] - values[i-1];
    const gain = Math.max(ch, 0), loss = Math.max(-ch, 0);
    gains = (gains * (period - 1) + gain) / period;
    losses = (losses * (period - 1) + loss) / period;
    rs = losses === 0 ? 100 : gains / (losses || 1e-10);
    rsiArr.push(100 - 100 / (1 + rs));
  }
  return rsiArr;
}

// rough S/R from recent swings
function supportResistance(closes, lookback = 60) {
  const n = closes.length;
  if (n < lookback + 5) return { support: null, resistance: null };
  const slice = closes.slice(-lookback);
  const hi = Math.max(...slice);
  const lo = Math.min(...slice);
  return { support: lo, resistance: hi };
}

// ---- symbol normalization --------------------------------------------------
// Figures out whether input is stock / forex / crypto and returns Finnhub endpoint+symbol
// Examples accepted: "AAPL", "NVDA", "EUR/USD", "EURUSD", "BTCUSD", "BTC/USDT", "BINANCE:BTCUSDT", "OANDA:EUR_USD"
function normalize(input) {
  const raw = String(input || '').trim().toUpperCase();

  // If user passes a direct Finnhub symbol like BINANCE:BTCUSDT or OANDA:EUR_USD, pass through
  if (raw.includes(':')) {
    const [venue] = raw.split(':');
    if (venue === 'BINANCE')  return { type: 'crypto', endpoint: 'crypto', symbol: raw };
    if (venue === 'OANDA')    return { type: 'forex',  endpoint: 'forex',  symbol: raw };
    // assume it’s a stock on unknown venue → strip venue and use stock
    const after = raw.split(':')[1] || raw;
    return { type: 'stock', endpoint: 'stock', symbol: after };
  }

  // has slash?
  if (raw.includes('/')) {
    const [b, q] = raw.split('/').map(s => s.replace(/[^A-Z]/g,''));
    // guess crypto if base looks like crypto
    if (CRYPTO_BASES.has(b)) {
      const quote = (q === 'USDT' || q === 'USD' || q === 'USDC') ? q : 'USDT';
      return { type: 'crypto', endpoint: 'crypto', symbol: `BINANCE:${b}${quote}` };
    }
    // else treat as FOREX
    return { type: 'forex', endpoint: 'forex', symbol: `OANDA:${b}_${q}` };
  }

  // no slash, maybe “EURUSD”, “BTCUSD” or plain stock like “NVDA”
  if (raw.length >= 6) {
    const b = raw.slice(0,3);
    const q3 = raw.slice(3,6);
    if (CRYPTO_BASES.has(b)) {
      // crypto without slash -> default to USDT if quote missing
      const quote = raw.endsWith('USDT') ? 'USDT' : (q3 === 'USD' ? 'USDT' : 'USDT');
      const base = CRYPTO_BASES.has(raw.replace(/USDT|USD$/,'')) ? raw.replace(/USDT|USD$/,'') : b;
      return { type: 'crypto', endpoint: 'crypto', symbol: `BINANCE:${base}${quote}` };
    }
    // if looks like a forex compact pair (EURUSD, GBPJPY etc.)
    if (/^[A-Z]{6,7}$/.test(raw)) {
      const base = raw.slice(0,3);
      const quote = raw.slice(3).replace(/[^A-Z]/g,'') || 'USD';
      return { type: 'forex', endpoint: 'forex', symbol: `OANDA:${base}_${quote}` };
    }
  }

  // default → stock
  return { type: 'stock', endpoint: 'stock', symbol: raw };
}

// ---- Finnhub fetch ---------------------------------------------------------

async function fetchFinnhub(endpoint, params) {
  const query = new URLSearchParams({ ...params, token: API_KEY }).toString();
  const url = `https://finnhub.io/api/v1/${endpoint}?${query}`;
  const r = await fetch(url);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Finnhub ${endpoint} error ${r.status}: ${text}`);
  }
  return r.json();
}

async function getCandles({ type, symbol, tf }) {
  const to = nowSec();
  const from = to - spanSeconds(tf);
  const resolution = tfMap[tf] || '60';

  let endpoint;
  if (type === 'stock') endpoint = 'stock/candle';
  else if (type === 'forex') endpoint = 'forex/candle';
  else endpoint = 'crypto/candle';

  const data = await fetchFinnhub(endpoint, { symbol, resolution, from, to });
  return { data, resolution, from, to, endpoint, symbol };
}

// try a fallback order if no data
const FALLBACKS = {
  '1m':  ['5m','15m','1h','D'],
  '5m':  ['15m','1h','D'],
  '15m': ['1h','D'],
  '30m': ['1h','D'],
  '1h':  ['4h','D'],
  '4h':  ['D'],
  'D':   ['W','M'],
  'W':   ['D','M'],
  'M':   ['W','D']
};

// ---- analysis --------------------------------------------------------------

function analyzeCloses(closes) {
  const notes = [];
  const price = closes[closes.length - 1];

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const last20 = sma20 ? sma20[sma20.length - 1] : null;
  const last50 = sma50 ? sma50[sma50.length - 1] : null;

  const rsiArr = rsi(closes, 14);
  const rsiLast = rsiArr ? rsiArr[rsiArr.length - 1] : null;

  let bias = 'neutral';
  let confidence = 50;

  if (last20 && last50) {
    if (last20 > last50) { bias = 'long'; confidence = 60; }
    if (last20 < last50) { bias = 'short'; confidence = 60; }
  }
  if (rsiLast != null) {
    if (bias === 'long' && rsiLast >= 55) confidence += 10;
    if (bias === 'short' && rsiLast <= 45) confidence += 10;
    if (rsiLast > 70) notes.push('RSI overbought');
    if (rsiLast < 30) notes.push('RSI oversold');
  }

  const levels = supportResistance(closes);
  if (levels.support != null && price < levels.support) {
    notes.push('Price near/below support');
  }
  if (levels.resistance != null && price > levels.resistance) {
    notes.push('Price near/above resistance');
  }

  confidence = Math.max(0, Math.min(100, Math.round(confidence)));

  return {
    bias,
    confidence,
    rsi: rsiLast != null ? Number(rsiLast.toFixed(2)) : null,
    levels,
    notes,
    price
  };
}

// ---- handler ---------------------------------------------------------------

export default async function handler(req, res) {
  try {
    if (!API_KEY) {
      res.status(500).json({ error: 'Missing FINNHUB_API_KEY on server' });
      return;
    }

    const { symbol: rawSymbol = 'NVDA', timeframe = '1h' } = (req.method === 'POST' ? req.body : req.query) || {};
    const tf = String(timeframe || '1h').trim();

    const meta = normalize(rawSymbol);

    // Try requested tf, then fallbacks if needed
    const tfsToTry = [tf, ...(FALLBACKS[tf] || [])];

    let got = null, tried = [];
    for (const tfTry of tfsToTry) {
      tried.push(tfTry);
      const resp = await getCandles({ type: meta.type, symbol: meta.symbol, tf: tfTry });
      const d = resp.data;
      if (d && d.s === 'ok' && Array.isArray(d.c) && d.c.length > 0) {
        got = { tfUsed: tfTry, candles: d, endpoint: resp.endpoint, symbol: meta.symbol, type: meta.type };
        break;
      }
    }

    if (!got) {
      res.status(404).json({
        error: `No candle data found for ${rawSymbol} on requested/fallback timeframes.`,
        tried
      });
      return;
    }

    const closes = got.candles.c;
    const result = analyzeCloses(closes);

    // cache a little to cut costs (1 minute ok for 1m+)
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=30');
    res.status(200).json({
      symbol: rawSymbol,
      normalizedSymbol: got.symbol,
      assetType: got.type,
      timeframeUsed: got.tfUsed,
      ...result
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
}
