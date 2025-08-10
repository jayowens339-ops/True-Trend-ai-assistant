// /api/analyze.js  — Vercel/Next.js (Pages router)
// Uses FINNHUB_API_KEY for live candles. OPENAI_API_KEY is optional.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Use POST' });
  }

  const { ticker = 'EURUSD', timeframe = 'Daily', strategy = 'Trendline' } = req.body || {};
  const FINN = process.env.FINNHUB_API_KEY;
  const OPENAI = process.env.OPENAI_API_KEY || process.env.GPT_API_KEY;

  // --- helpers --------------------------------------------------------------
  const nowSec = () => Math.floor(Date.now() / 1000);
  const toSec = (ms) => Math.floor(ms / 1000);

  const classify = (sym) => {
    const s = (sym || '').toUpperCase().replace(/\s+/g, '');
    if (s.includes(':')) return 'explicit';              // already FINNHUB format
    if (/[A-Z]+\/[A-Z]+/.test(s)) return 'forex';
    if (/USDT$/.test(s) || /(BTC|ETH|SOL|DOGE|ADA)/.test(s)) return 'crypto';
    if (/^[A-Z]{6,7}$/.test(s)) return 'forex';          // e.g., EURUSD, XAUUSD
    return 'stock';
  };

  const mapToFinnhub = (sym, type) => {
    const s = sym.toUpperCase().replace(/\s+/g, '');
    if (type === 'explicit') return s;                   // already like OANDA:EUR_USD
    if (type === 'forex') {
      // EURUSD -> OANDA:EUR_USD, XAUUSD -> OANDA:XAU_USD
      const base = s.slice(0, 3), quote = s.slice(-3);
      return `OANDA:${base}_${quote}`;
    }
    if (type === 'crypto') {
      // Default to BINANCE. Example: BTCUSDT -> BINANCE:BTCUSDT
      return s.includes(':') ? s : `BINANCE:${s}`;
    }
    // stock by default, e.g., AAPL
    return s;
  };

  const reso = (tf) => {
    const m = String(tf).toLowerCase();
    if (m.includes('5m')) return '5';
    if (m.includes('15m')) return '15';
    if (m.includes('1h')) return '60';
    if (m.includes('4h')) return '240';
    if (m.includes('daily') || m === 'd' || m === '1d') return 'D';
    return 'D';
  };

  const ema = (period, arr) => {
    const k = 2 / (period + 1);
    let prev = arr[0], out = [prev];
    for (let i = 1; i < arr.length; i++) {
      prev = arr[i] * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  };

  const pct = (a, b) => (b === 0 ? 0 : (a - b) / b);

  // --- fetch candles from Finnhub ------------------------------------------
  async function getCandles(sym, tf) {
    if (!FINN) return { ok: false, error: 'Missing FINNHUB_API_KEY' };

    const kind = classify(sym);
    const symbol = mapToFinnhub(sym, kind);
    const resolution = reso(tf);

    // pull ~300 candles
    const now = nowSec();
    const lookbackSec = (
      resolution === 'D' ? 3600 * 24 * 400 :
      resolution === '240' ? 3600 * 24 * 60 :
      3600 * 24 * 7
    );
    const from = now - lookbackSec;
    const base = 'https://finnhub.io/api/v1';

    let path = '/stock/candle';
    if (kind === 'forex' || symbol.startsWith('OANDA:')) path = '/forex/candle';
    if (kind === 'crypto' || symbol.startsWith('BINANCE:')) path = '/crypto/candle';

    const url = `${base}${path}?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${now}&token=${FINN}`;

    const r = await fetch(url);
    if (!r.ok) return { ok: false, error: `Finnhub ${r.status}` };
    const j = await r.json();

    if (j.s !== 'ok' || !Array.isArray(j.c) || j.c.length < 20) {
      return { ok: false, error: 'No candles', meta: { symbol, path, resolution } };
    }
    return {
      ok: true,
      symbol,
      path,
      resolution,
      t: j.t,
      o: j.o,
      h: j.h,
      l: j.l,
      c: j.c
    };
  }

  // --- analysis engine (EMA-based, strategy-aware messaging) ----------------
  async function analyzeWithFinnhub() {
    const data = await getCandles(ticker, timeframe);
    if (!data.ok) return { ok: false, error: data.error, meta: data.meta };

    const closes = data.c;
    const ema9 = ema(9, closes);
    const ema50 = ema(50, closes);
    const last = closes[closes.length - 1];
    const e9 = ema9[ema9.length - 1];
    const e50 = ema50[ema50.length - 1];

    // recent slope (last 5 bars)
    const slope = closes.slice(-5)[4] - closes.slice(-5)[0];
    const upTrend = e9 > e50 && slope > 0;
    const downTrend = e9 < e50 && slope < 0;

    // strategy-aware suggestion (simple rules)
    let action = upTrend ? 'BUY' : (downTrend ? 'SELL' : (last >= e9 ? 'SELL' : 'BUY'));
    let reason = upTrend ? 'Above EMA50 with rising EMA9'
               : downTrend ? 'Below EMA50 with falling EMA9'
               : `Mean reversion toward EMA9`;
    if (/ema touch/i.test(strategy)) {
      const dist = Math.abs(pct(last, e9));
      action = dist < 0.002 ? (upTrend ? 'BUY' : 'SELL') : (upTrend ? 'WAIT for touch' : 'WAIT for touch');
      reason = `Distance to EMA9: ${(dist*100).toFixed(2)}%`;
    } else if (/orb/i.test(strategy)) {
      reason = 'Use first 15m range break (hint).';
    }

    const confidence =
      Math.max(0.5, Math.min(0.9,
        0.55 + (upTrend || downTrend ? 0.2 : 0) + (Math.abs(pct(e9, e50)) * 0.6)));

    return {
      ok: true,
      mode: 'live-data',
      summary: `${ticker.toUpperCase()} • ${timeframe} • ${strategy} — ${upTrend ? 'trend up' : (downTrend ? 'trend down' : 'range/mixed')}.`,
      checklist: [
        `EMA9 ${e9 > e50 ? 'above' : 'below'} EMA50`,
        `Last close ${last >= e9 ? 'above' : 'below'} EMA9`,
        `Slope ${slope > 0 ? 'up' : (slope < 0 ? 'down' : 'flat')} (last 5 bars)`
      ],
      signals: [{ action, reason, confidence, ttlSec: 900 }],
      note: { finnhubSymbol: data.symbol, resolution: data.resolution }
    };
  }

  // 1) Try live Finnhub analysis
  let result = await analyzeWithFinnhub();

  // 2) If Finnhub failed but OPENAI is available, produce an LLM summary anyway
  if (!result.ok && OPENAI) {
    try {
      const prompt = `You are TrueTrend AI. JSON only.
Fields: summary (1-2 sentences), checklist (3 items), signals (array with one {action, reason, confidence 0-1, ttlSec}).
Context: ticker ${ticker}, timeframe ${timeframe}, strategy ${strategy}.`;
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0.2,
          messages: [
            { role: 'system', content: 'Return strict JSON; concise and tradable.' },
            { role: 'user', content: prompt }
          ]
        })
      });
      const j = await r.json();
      const raw = j?.choices?.[0]?.message?.content || '';
      try {
        const parsed = JSON.parse(raw);
        return res.status(200).json({ ok: true, mode: 'live-llm', ...parsed, note: result.meta || undefined });
      } catch {
        // non-JSON content
        return res.status(200).json({ ok: true, mode: 'live-llm', raw, note: result.meta || undefined });
      }
    } catch (e) {
      // fall through to demo/fallback
    }
  }

  // 3) If still not ok, fallback/demo so UI never breaks
  if (!result.ok) {
    return res.status(200).json({
      ok: true, mode: 'fallback',
      summary: `Fallback analysis for ${ticker} on ${timeframe} — ${strategy}.`,
      checklist: ['Trend check unavailable','Data fetch failed','Use conservative risk'],
      signals: [{ action: 'BUY', reason: 'Fallback signal', confidence: 0.55, ttlSec: 900 }],
      error: result.error || 'Unknown'
    });
  }

  return res.status(200).json(result);
}
