// /api/analyze.js
// Owner-aware endpoint. Uses Twelve Data first, Finnhub fallback, optional OpenAI vision fallback.
// CORS + POST JSON.

export default async function handler(req, res) {
  // ---------- CORS ----------
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Use POST' });
  }

  // ---------- config / env ----------
  const OWNER = process.env.OWNER_TOKEN || '';
  const ENFORCE = String(process.env.ENFORCE_LICENSE || '0') === '1';
  const TD_KEY = process.env.TWELVEDATA_API_KEY || '';
  const TD_CRYPTO_EX = process.env.TWELVEDATA_CRYPTO_EXCHANGE || 'Binance';
  const FINN = process.env.FINNHUB_API_KEY || '';
  const OPENAI = process.env.OPENAI_API_KEY || '';

  // ---------- license gate (store build turns this on) ----------
  try {
    const auth = req.headers['authorization'] || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (ENFORCE && bearer !== OWNER) {
      return res.status(200).json({ ok: false, error: 'license_required' });
    }
  } catch {}

  // ---------- parse body ----------
  let body = {};
  try { body = req.body || {}; } catch {}
  const { ticker = '', timeframe = 'Daily', strategy = 'Trendline', style = 'Day', image } = body;

  // ---------- utils ----------
  const nowSec = () => Math.floor(Date.now() / 1000);
  const pct = (a, b) => (b === 0 ? 0 : (a - b) / b);
  const ema = (period, arr) => {
    if (!arr?.length) return [];
    const k = 2 / (period + 1);
    let prev = arr[0]; const out = [prev];
    for (let i = 1; i < arr.length; i++) { prev = arr[i] * k + prev * (1 - k); out.push(prev); }
    return out;
  };

  // Classify symbol (rough)
  const classify = (sym) => {
    const s = (sym || '').toUpperCase().replace(/\s+/g, '');
    if (!s) return 'unknown';
    if (s.includes(':')) return 'explicit';
    if (/^[A-Z]{6,7}$/.test(s) || /[A-Z]+\/[A-Z]+/.test(s) || /(XAU|XAG|WTI|BRENT)/.test(s)) return 'forex';
    if (/USDT$/.test(s) || /(BTC|ETH|SOL|DOGE|ADA)/.test(s)) return 'crypto';
    return 'stock';
  };

  // Map timeframe to Twelve Data
  const tdInterval = (tf) => {
    const m = String(tf).toLowerCase();
    if (m.includes('5m')) return '5min';
    if (m.includes('15m')) return '15min';
    if (m.includes('1h')) return '1h';
    if (m.includes('4h')) return '4h';
    return '1day';
  };

  // Format symbols for Twelve Data
  function mapToTwelve(sym, type) {
    let s = (sym || '').toUpperCase().replace(/\s+/g, '');
    if (!s) return { symbol: '', extra: {} };

    if (type === 'forex') {
      // allow EURUSD → EUR/USD
      if (/^[A-Z]{6}$/.test(s)) s = s.slice(0, 3) + '/' + s.slice(3);
      if (!s.includes('/')) s = s.replace(/[_:]/g, '/');
      return { symbol: s, extra: {} }; // e.g., EUR/USD
    }
    if (type === 'crypto') {
      // BTCUSDT → BTC/USD (Twelve Data commonly uses /USD)
      if (/^[A-Z]{6,10}$/.test(s)) {
        const base = s.replace(/USDT|USD|USDC$/, '');
        s = base + '/USD';
      }
      if (!s.includes('/')) s = s + '/USD';
      return { symbol: s, extra: { exchange: TD_CRYPTO_EX } }; // e.g., BTC/USD&exchange=Binance
    }
    // stock – usually just AAPL; exchange optional
    return { symbol: s, extra: {} };
  }

  // Twelve Data candles
  async function getCandlesTwelveData(sym, tf) {
    if (!TD_KEY) return { ok: false, error: 'Missing TWELVEDATA_API_KEY' };
    const type = classify(sym);
    const { symbol, extra } = mapToTwelve(sym, type);
    if (!symbol) return { ok: false, error: 'No symbol' };

    const interval = tdInterval(tf);
    const params = new URLSearchParams({
      symbol,
      interval,
      outputsize: '500', // enough for strategy/EMAs
      apikey: TD_KEY
    });
    if (extra.exchange) params.set('exchange', extra.exchange);

    const url = `https://api.twelvedata.com/time_series?${params.toString()}`;
    const r = await fetch(url);
    if (!r.ok) return { ok: false, error: `TwelveData ${r.status}` };
    const j = await r.json();

    if (j.status === 'error' || !Array.isArray(j.values)) {
      return { ok: false, error: j?.message || 'TwelveData error', meta: { symbol, interval } };
    }

    // Twelve Data returns newest->oldest; reverse to oldest->newest
    const vals = [...j.values].reverse();
    const t = []; const o = []; const h = []; const l = []; const c = [];
    for (const v of vals) {
      const ts = Math.floor(new Date(v.datetime).getTime() / 1000);
      t.push(ts); o.push(+v.open); h.push(+v.high); l.push(+v.low); c.push(+v.close);
    }
    if (c.length < 60) return { ok: false, error: 'Too few candles', meta: { symbol, interval } };
    return { ok: true, vendor: 'twelvedata', symbol, interval, t, o, h, l, c };
  }

  // Finnhub fallback
  const resoFinn = (tf) => {
    const m = String(tf).toLowerCase();
    if (m.includes('5m')) return '5';
    if (m.includes('15m')) return '15';
    if (m.includes('1h')) return '60';
    if (m.includes('4h')) return '240';
    return 'D';
  };
  const mapToFinn = (sym) => {
    const s = (sym || '').toUpperCase().replace(/\s+/g, '');
    const type = classify(sym);
    if (type === 'forex') {
      const base = s.slice(0, 3), quote = s.slice(-3);
      return `OANDA:${base}_${quote}`;
    }
    if (type === 'crypto') return s.includes(':') ? s : `BINANCE:${s}`;
    return s;
  };
  async function getCandlesFinnhub(sym, tf) {
    if (!FINN) return { ok: false, error: 'No Finnhub key' };
    const symbol = mapToFinn(sym);
    const resolution = resoFinn(tf);
    const now = nowSec();
    const lookback = (resolution === 'D') ? 3600 * 24 * 400 : (resolution === '240' ? 3600 * 24 * 60 : 3600 * 24 * 7);
    const from = now - lookback;
    const base = 'https://finnhub.io/api/v1';
    let path = '/stock/candle';
    const isFx = symbol.startsWith('OANDA:');
    const isC = symbol.startsWith('BINANCE:');
    if (isFx) path = '/forex/candle';
    if (isC) path = '/crypto/candle';
    const url = `${base}${path}?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${now}&token=${FINN}`;
    const r = await fetch(url);
    if (!r.ok) return { ok: false, error: `Finnhub ${r.status}` };
    const j = await r.json();
    if (j.s !== 'ok' || !Array.isArray(j.c) || j.c.length < 60) return { ok: false, error: 'No candles', meta: { symbol, resolution } };
    return { ok: true, vendor: 'finnhub', symbol, resolution, t: j.t, o: j.o, h: j.h, l: j.l, c: j.c };
  }

  // Strategy logic (same as before, slightly tightened)
  function decide(closes, strategyName) {
    const e9 = ema(9, closes), e50 = ema(50, closes);
    const last = closes.at(-1), p9 = e9.at(-1), p50 = e50.at(-1);
    const slope = closes.at(-1) - closes.at(-6);
    const up = p9 > p50 && slope > 0, down = p9 < p50 && slope < 0;

    let action = up ? 'BUY' : (down ? 'SELL' : (last >= p9 ? 'SELL' : 'BUY'));
    let reason = up ? 'Above EMA50 with rising EMA9' : (down ? 'Below EMA50 with falling EMA9' : 'Mean reversion toward EMA9');

    const dist9 = Math.abs(pct(last, p9));
    const s = String(strategyName).toLowerCase();

    if (s.includes('ema touch')) {
      if (dist9 < 0.002) action = up ? 'BUY' : 'SELL'; else action = 'WAIT';
      reason = `Distance to EMA9 ${(dist9 * 100).toFixed(2)}%`;
    } else if (s.includes('orb')) {
      reason = 'Opening range breakout bias';
    } else if (s.includes('support')) {
      reason = up ? 'Buy pullback near prior resistance' : 'Sell bounce near prior support';
    } else if (s.includes('stoch') || s.includes('williams')) {
      reason = up ? 'Stoch/W%R up with trend' : 'Stoch/W%R down with trend';
    } else if (s.includes('rsi') && s.includes('macd')) {
      reason = up ? 'RSI>50 & MACD>0' : 'RSI<50 & MACD<0';
    } else if (s.includes('break of structure')) {
      reason = up ? 'Higher highs; buy on BOS retest' : 'Lower lows; sell on BOS retest';
    } else if (s.includes('pullback')) {
      reason = up ? 'Buy EMA9 pullbacks in uptrend' : 'Sell EMA9 pullbacks in downtrend';
    } else if (s.includes('mean reversion')) {
      action = last > p9 ? 'SELL' : 'BUY'; reason = 'Fade back to EMA9';
    }

    const conf = Math.max(0.5, Math.min(0.92, 0.55 + (up || down ? 0.2 : 0) + Math.abs(pct(p9, p50)) * 0.6));
    return { action, reason, confidence: conf };
  }

  // Simple entry/stop/take-profit helper from last 20 bars range
  function entryExitFromSignal(action, closes, highs, lows) {
    const n = Math.min(20, closes.length);
    const recentH = Math.max(...highs.slice(-n));
    const recentL = Math.min(...lows.slice(-n));
    const last = closes.at(-1);
    const risk = (recentH - recentL) / 2 || (last * 0.01);

    if (action === 'BUY') {
      return {
        entry: last.toFixed(5),
        stop: (last - risk).toFixed(5),
        tp1: (last + risk).toFixed(5),
        tp2: (last + risk * 2).toFixed(5)
      };
    } else if (action === 'SELL') {
      return {
        entry: last.toFixed(5),
        stop: (last + risk).toFixed(5),
        tp1: (last - risk).toFixed(5),
        tp2: (last - risk * 2).toFixed(5)
      };
    }
    return { entry: '', stop: '', tp1: '', tp2: '' };
  }

  // ---------- VISION path (same endpoint) ----------
  if (image && OPENAI) {
    try {
      const prompt = `You are TrueTrend AI. Read the chart image and answer with strict JSON:
{"summary":"","checklist":["","",""],"signals":[{"action":"","reason":"","confidence":0.0,"ttlSec":900}],"entryExit":{"entry":"","stop":"","tp1":"","tp2":""}}`;
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0.2,
          messages: [
            { role: 'system', content: 'Return strict JSON only.' },
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: image } }
              ]
            }
          ]
        })
      });
      const j = await r.json();
      const raw = j?.choices?.[0]?.message?.content || '';
      try {
        const parsed = JSON.parse(raw);
        return res.status(200).json({ ok: true, mode: 'vision-llm', ...parsed });
      } catch {
        return res.status(200).json({ ok: true, mode: 'vision-llm', raw });
      }
    } catch (e) {
      // fall through
    }
  }

  // ---------- LIVE DATA path ----------
  async function runLive() {
    // prefer Twelve Data
    let data = await getCandlesTwelveData(ticker, timeframe);
    let vendor = 'twelvedata';
    if (!data.ok) {
      // fallback to Finnhub
      data = await getCandlesFinnhub(ticker, timeframe);
      vendor = 'finnhub';
    }
    if (!data.ok) return { ok: false, error: data.error || 'No data', vendor };

    const closes = data.c.slice(-300);
    const highs  = data.h.slice(-300);
    const lows   = data.l.slice(-300);

    const sig = decide(closes, strategy);
    const ex  = entryExitFromSignal(sig.action, closes, highs, lows);

    return {
      ok: true,
      mode: vendor,
      vendor,
      ticker: (ticker || 'UNKNOWN').toUpperCase(),
      timeframe, strategy, style,
      summary: `${(ticker || 'UNKNOWN').toUpperCase()} on ${timeframe} — ${strategy}.`,
      checklist: [
        `EMA9 ${ema(9, closes).at(-1) > ema(50, closes).at(-1) ? 'above' : 'below'} EMA50`,
        `Last close ${closes.at(-1) >= ema(9, closes).at(-1) ? 'above' : 'below'} EMA9`,
        `Slope ${closes.at(-1) - closes.at(-6) > 0 ? 'up' : (closes.at(-1) - closes.at(-6) < 0 ? 'down' : 'flat')} (last 5 bars)`
      ],
      signals: [{ ...sig, ttlSec: 900 }],
      entryExit: ex,
      price: closes.at(-1)
    };
  }

  let result = await runLive();

  // Optional: if live fails & OPENAI exists, ask LLM for a generic JSON (text-only)
  if (!result.ok && OPENAI) {
    try {
      const prompt = `You are TrueTrend AI. JSON only with fields: summary, checklist(3), signals([{action,reason,confidence,ttlSec}]), entryExit({entry,stop,tp1,tp2}). Context: ticker ${ticker||'UNKNOWN'}, timeframe ${timeframe}, strategy ${strategy}, style ${style}.`;
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0.2,
          messages: [
            { role: 'system', content: 'Return strict JSON only.' },
            { role: 'user', content: prompt }
          ]
        })
      });
      const j = await r.json();
      const raw = j?.choices?.[0]?.message?.content || '';
      try {
        const parsed = JSON.parse(raw);
        return res.status(200).json({ ok: true, mode: 'text-llm', ...parsed });
      } catch {
        // fall through to hard fallback
      }
    } catch {}
  }

  if (!result.ok) {
    // hard fallback
    return res.status(200).json({
      ok: true, mode: 'fallback',
      ticker: (ticker || 'UNKNOWN'), timeframe, strategy,
      summary: `Fallback for ${(ticker || 'UNKNOWN')} on ${timeframe} — ${strategy}.`,
      checklist: ['Trend check unavailable', 'Data fetch failed', 'Use conservative risk'],
      signals: [{ action: 'BUY', reason: 'Fallback signal', confidence: 0.55, ttlSec: 900 }],
      entryExit: { entry: '', stop: '', tp1: '', tp2: '' },
      error: result.error || 'No data'
    });
  }
  return res.status(200).json(result);
}
