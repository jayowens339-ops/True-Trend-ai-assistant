// pages/api/analyze.js
// Node 18+ on Vercel: global fetch is available.

const FINNHUB_BASE = 'https://finnhub.io/api/v1';

// ---- Optional: Vercel KV for coupon usage tracking (best for limits) ----
let kv = null;
(async () => {
  try {
    const mod = await import('@vercel/kv'); // only if installed / configured
    kv = mod.kv;
  } catch (_) {
    // KV not available; we'll fall back to in-memory counters
  }
})();

// In-memory fallback for coupon usage counters (reset when function cold starts)
const inMemoryCouponUsage = new Map();

/**
 * Configure coupon codes here.
 * Each entry: code -> { maxUses, note }
 * If using Stripe coupons instead, you can still validate here
 * and return { coupon: { valid:true } } for your frontend to handle.
 */
const COUPONS = {
  FAMILY1: { maxUses: 25, note: 'Family & friends free trial' },
  FAMILY2: { maxUses: 25, note: 'Family & friends free trial' },
};

// ------------ Helpers: math + indicators -------------
function sma(values, period) {
  if (!values || values.length < period) return null;
  const out = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out.push(sum / period);
  }
  return out;
}

function rsi(values, period = 14) {
  if (!values || values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  const rsiOut = [];

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const rsi = 100 - 100 / (1 + rs);
    rsiOut.push(rsi);
  }
  return rsiOut;
}

// Simple swing high/low for key levels
function swingLevels(values, lookback = 20) {
  if (!values || values.length < lookback) return { support: null, resistance: null };
  const window = values.slice(-lookback);
  return {
    support: Math.min(...window),
    resistance: Math.max(...window),
  };
}

// Turn candle arrays into close price list
function toCloses(candles) {
  const { c } = candles || {};
  return Array.isArray(c) ? c : null;
}

// ------------- Symbol classification + Finnhub symbol mapping -------------
function classifyMarket(raw) {
  const s = raw.trim().toUpperCase();

  // Forex "EUR/USD", "GBPUSD" etc.
  if (s.includes('/')) {
    const [a, b] = s.split('/');
    if (a.length === 3 && b.length === 3) return { type: 'forex', base: a, quote: b };
    // Could also be crypto "BTC/USDT"
    if (b.length >= 3 && b.length <= 5) return { type: 'crypto', base: a, quote: b };
  }
  // Crypto like BTCUSDT, BTCUSD
  if (/^[A-Z]{2,6}(USD|USDT|USDC)$/.test(s)) {
    const base = s.replace(/(USD|USDT|USDC)$/, '');
    const quote = s.substring(base.length);
    return { type: 'crypto', base, quote };
  }
  // Stock fallback
  return { type: 'stock', symbol: s };
}

function mapToFinnhubSymbol(info) {
  if (info.type === 'stock') {
    return info.symbol; // e.g. AAPL
  }
  if (info.type === 'forex') {
    // Finnhub forex format: OANDA:EUR_USD (or similar broker)
    return `OANDA:${info.base}_${info.quote}`;
  }
  if (info.type === 'crypto') {
    // Finnhub crypto: BINANCE:BTCUSDT (no slash)
    const quote = info.quote === 'USD' ? 'USDT' : info.quote; // normalize to USDT when "USD" given
    return `BINANCE:${info.base}${quote}`;
  }
  return info.symbol || '';
}

// Resolution mapping: UI sends "1m","5m","15m","1h","4h","D","W","M" or just "60","D"
// Finnhub wants: 1,5,15,30,60, D, W, M
function mapResolution(res) {
  const r = (res || '').toLowerCase();
  if (['1', '1m'].includes(r)) return '1';
  if (['5', '5m'].includes(r)) return '5';
  if (['15', '15m'].includes(r)) return '15';
  if (['30', '30m'].includes(r)) return '30';
  if (['60', '1h', '60m'].includes(r)) return '60';
  if (['240', '4h'].includes(r)) return '240'; // Finnhub supports 240
  if (['w', '1w', 'weekly'].includes(r)) return 'W';
  if (['m', '1mo', 'monthly'].includes(r)) return 'M';
  return (r === 'd' || r === '1d' || r === 'daily') ? 'D' : '60';
}

function rangeFor(resMapped) {
  // pick a window long enough for SMA/RSI
  const now = Math.floor(Date.now() / 1000);
  let secondsBack = 60 * 60 * 24 * 30; // default ~30 days
  if (resMapped === '1') secondsBack = 60 * 60 * 24 * 3;      // 3 days
  else if (resMapped === '5') secondsBack = 60 * 60 * 24 * 7; // 1 week
  else if (resMapped === '15') secondsBack = 60 * 60 * 24 * 14;
  else if (resMapped === '30') secondsBack = 60 * 60 * 24 * 21;
  else if (resMapped === '60' || resMapped === '240') secondsBack = 60 * 60 * 24 * 90; // 3 months
  else if (resMapped === 'D') secondsBack = 60 * 60 * 24 * 400; // over a year
  else if (resMapped === 'W' || resMapped === 'M') secondsBack = 60 * 60 * 24 * 1500; // multi-year
  return { from: now - secondsBack, to: now };
}

// --------- Finnhub candles (stock/forex/crypto) ----------
async function getCandles(mappedSymbol, type, resolution, from, to, apiKey) {
  let path = '';
  if (type === 'stock') path = 'stock/candle';
  else if (type === 'forex') path = 'forex/candle';
  else if (type === 'crypto') path = 'crypto/candle';
  else path = 'stock/candle';

  const u = new URL(`${FINNHUB_BASE}/${path}`);
  u.searchParams.set('symbol', mappedSymbol);
  u.searchParams.set('resolution', resolution);
  u.searchParams.set('from', from);
  u.searchParams.set('to', to);
  u.searchParams.set('token', apiKey);

  const r = await fetch(u.toString());
  if (!r.ok) throw new Error('Finnhub request failed');
  const data = await r.json();
  if (data.s !== 'ok') throw new Error('No candle data from Finnhub');
  return data;
}

// ---------- Build bias/confidence from indicators ----------
function analyzeSeries(close) {
  const out = {
    price: null,
    bias: 'neutral',
    confidence: 0,
    rsi: null,
    levels: { support: null, resistance: null },
    notes: [],
  };
  if (!close || close.length < 60) return out;

  out.price = close[close.length - 1];

  const sma20 = sma(close, 20);
  const sma50 = sma(close, 50);
  const rsi14 = rsi(close, 14);

  out.rsi = rsi14 ? Math.round(rsi14[rsi14.length - 1]) : null;
  const lv = swingLevels(close, 25);
  out.levels = lv;

  if (sma20 && sma50) {
    const s20 = sma20[sma20.length - 1];
    const s50 = sma50[sma50.length - 1];
    const s20Prev = sma20[sma20.length - 2] ?? s20;
    const s50Prev = sma50[sma50.length - 2] ?? s50;
    const up = s20 > s50 && s20 > s20Prev && s50 >= s50Prev;
    const down = s20 < s50 && s20 < s20Prev && s50 <= s50Prev;

    if (up) {
      out.bias = 'long';
      out.notes.push('SMA20 above SMA50 and rising');
    } else if (down) {
      out.bias = 'short';
      out.notes.push('SMA20 below SMA50 and falling');
    } else {
      out.bias = 'neutral';
    }

    // confidence: distance and slope blend
    const dist = Math.abs(s20 - s50) / ((s20 + s50) / 2);
    let conf = Math.min(100, Math.round(dist * 600)); // scale 0..100
    if (out.rsi != null) {
      if (out.bias === 'long' && out.rsi > 70) { out.notes.push('RSI overbought'); conf -= 10; }
      if (out.bias === 'short' && out.rsi < 30) { out.notes.push('RSI oversold'); conf -= 10; }
    }
    out.confidence = Math.max(0, Math.min(100, conf));
  }
  return out;
}

// --------- Coupon usage tracking (validate + decrement) ----------
async function checkCoupon(code) {
  const key = code?.toUpperCase();
  if (!key || !COUPONS[key]) return { valid: false, remaining: 0, note: null };

  const { maxUses, note } = COUPONS[key];

  // Try Vercel KV first
  if (kv) {
    const kvKey = `coupon:${key}:used`;
    const used = Number((await kv.get(kvKey)) || 0);
    if (used >= maxUses) return { valid: false, remaining: 0, note };
    // NOTE: Only increment when you actually “consume” the code (e.g., on checkout success)
    // Here we only report remaining; do not increment here.
    return { valid: true, remaining: maxUses - used, note };
  }

  // Fallback to in-memory
  const usedLocal = inMemoryCouponUsage.get(key) || 0;
  if (usedLocal >= maxUses) return { valid: false, remaining: 0, note };
  return { valid: true, remaining: maxUses - usedLocal, note };
}

// (Optional) call this AFTER a successful checkout to decrement usage
async function consumeCoupon(code) {
  const key = code?.toUpperCase();
  if (!key || !COUPONS[key]) return;
  if (kv) {
    const kvKey = `coupon:${key}:used`;
    await kv.incr(kvKey);
  } else {
    inMemoryCouponUsage.set(key, (inMemoryCouponUsage.get(key) || 0) + 1);
  }
}

// ------------- API handler -------------
export default async function handler(req, res) {
  try {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Missing FINNHUB_API_KEY' });
    }

    const { symbol, resolution: resQuery, coupon, consume } = req.query;
    if (!symbol) return res.status(400).json({ error: 'Missing symbol' });

    // Coupon check (optional)
    if (coupon) {
      const info = await checkCoupon(coupon);
      if (consume && info.valid) {
        await consumeCoupon(coupon);
        info.remaining = Math.max(0, info.remaining - 1);
      }
      // Return JUST coupon info if called with only coupon (no analysis)
      if (!symbol || symbol === 'coupon-only') {
        return res.status(200).json({ coupon: info });
      }
      // else include it alongside analysis payload below
      req.couponInfo = info;
    }

    const classified = classifyMarket(symbol);
    const mapped = mapToFinnhubSymbol(classified);
    const resolution = mapResolution(resQuery || '60');
    const { from, to } = rangeFor(resolution);

    const candles = await getCandles(mapped, classified.type, resolution, from, to, apiKey);
    const closes = toCloses(candles);
    const result = analyzeSeries(closes);

    const payload = {
      symbol: symbol.toUpperCase(),
      mappedSymbol: mapped,
      market: classified.type,
      resolution,
      price: result.price,
      bias: result.bias,
      confidence: result.confidence,
      rsi: result.rsi,
      levels: result.levels,
      notes: result.notes,
    };

    if (req.couponInfo) payload.coupon = req.couponInfo;

    res.status(200).json(payload);
  } catch (err) {
    res.status(200).json({ error: err.message || 'Unable to analyze symbol' });
  }
}
