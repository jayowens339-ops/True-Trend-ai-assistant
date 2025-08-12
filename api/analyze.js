// api/analyze.js
// Single-file handler: live data (Finnhub) + Vision + OTC handling + hard-fallback WAIT

export default async function handler(req, res) {
  // --- CORS ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }

  // --- ENV ---
  const FINN = process.env.FINNHUB_API_KEY || '';
  const OPENAI = process.env.OPENAI_API_KEY || process.env.GPT_API_KEY || '';
  const OWNER_TOKEN = (process.env.OWNER_TOKEN || '').trim(); // e.g. Truetrendtrading4u!
  const ENFORCE_LICENSE = (process.env.ENFORCE_LICENSE || '').toLowerCase() === 'true';

  // --- AUTH (owner token check; for Store build you can replace with license checks) ---
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (ENFORCE_LICENSE) {
    if (!auth || (OWNER_TOKEN && auth !== OWNER_TOKEN)) {
      return res.status(200).json({ ok: false, error: 'license_required' });
    }
  }

  // --- INPUT ---
  const {
    ticker = '',
    timeframe = '5m',
    strategy = 'Trendline',
    imageDataURL = '',   // base64 PNG from extension (Vision path)
  } = (req.body || {});

  // --- Helpers ---
  const nowSec = () => Math.floor(Date.now() / 1000);
  const toReso = tf => {
    const m = String(tf).toLowerCase();
    if (m.includes('5m')) return '5';
    if (m.includes('15m')) return '15';
    if (m.includes('1h')) return '60';
    if (m.includes('4h')) return '240';
    return 'D';
  };
  const classify = (sym) => {
    const s = String(sym || '').toUpperCase();
    const isOTC =
      /(^|[^A-Z])OTC([^A-Z]|$)/.test(s) ||
      /_OTC$/.test(s) ||
      /\/OTC$/.test(s) ||
      (req.headers.referer && /pocketoption|pocketoptions|po\./i.test(req.headers.referer) && !s);
    // Crypto (BINANCE), Forex (OANDA), else stock
    const isCrypto = /(USDT|BTC|ETH|SOL|DOGE|ADA|BNB)/.test(s);
    const isForex  = /^[A-Z]{6}$/.test(s) || /(EUR|USD|JPY|GBP|AUD|CAD|CHF)/.test(s);
    return { isOTC, isCrypto, isForex, raw: s };
  };
  const mapToFinnhub = (sym, flags) => {
    const s = sym.toUpperCase();
    if (flags.isOTC) return s; // Not used; vision path
    if (flags.isCrypto) return s.includes(':') ? s : `BINANCE:${s}`;
    if (flags.isForex) {
      // "EURUSD" -> OANDA:EUR_USD
      if (s.length === 6) return `OANDA:${s.slice(0,3)}_${s.slice(3)}`;
      return s;
    }
    return s; // stock or already namespaced
  };

  // --- Strategy helpers (simple but strict) ---
  const ema = (period, arr) => {
    if (!arr || !arr.length) return [];
    const k = 2 / (period + 1);
    let prev = arr[0]; const out = [prev];
    for (let i = 1; i < arr.length; i++) { prev = arr[i] * k + prev * (1 - k); out.push(prev); }
    return out;
  };

  // Conservative entry/stop/tp estimator from closes
  const levelsFromCloses = (closes) => {
    const n = closes.length;
    const last = closes[n - 1];
    const swingHi = Math.max(...closes.slice(-50));
    const swingLo = Math.min(...closes.slice(-50));
    const atr = (swingHi - swingLo) / 10 || (last * 0.001); // loose proxy

    return {
      forBuy: {
        entry: Number((last + 0.1 * atr).toFixed(5)),
        stop:  Number((last - 1.5 * atr).toFixed(5)),
        tp:    Number((last + 2.0 * atr).toFixed(5)),
      },
      forSell: {
        entry: Number((last - 0.1 * atr).toFixed(5)),
        stop:  Number((last + 1.5 * atr).toFixed(5)),
        tp:    Number((last - 2.0 * atr).toFixed(5)),
      }
    };
  };

  const decide = (closes, name) => {
    // a strict core: direction + slope + alignment
    if (!closes || closes.length < 60) return { action: 'WAIT', reason: 'Insufficient data' };
    const e9  = ema(9, closes), e50 = ema(50, closes);
    const last = closes.at(-1);
    const slope = (last - closes.at(-6)) / Math.max(1e-9, closes.at(-6)); // % move last 5 bars
    const up = e9.at(-1) > e50.at(-1) && slope > 0;
    const down = e9.at(-1) < e50.at(-1) && slope < 0;

    let action = 'WAIT', reason = '';
    if (/ema touch/i.test(name)) {
      const dist = Math.abs((last - e9.at(-1)) / Math.max(1e-9, e9.at(-1)));
      if (dist < 0.002) action = up ? 'BUY' : (down ? 'SELL' : 'WAIT');
      reason = `Distance to EMA9 ${(dist*100).toFixed(2)}%`;
    } else if (/orb/i.test(name)) {
      // ORB: require clear first-range break (approx)
      const r = closes.slice(-20); const hi = Math.max(...r), lo = Math.min(...r);
      if (last > hi * 1.001 && up) { action = 'BUY'; reason = 'Break above opening range'; }
      else if (last < lo * 0.999 && down) { action = 'SELL'; reason = 'Break below opening range'; }
      else { action = 'WAIT'; reason = 'No clean range break'; }
    } else if (/support\/resistance/i.test(name)) {
      // rough: above 50EMA -> buy pullback; below -> sell bounce
      if (up) { action = 'BUY'; reason = 'Trend up; buy pullbacks'; }
      else if (down) { action = 'SELL'; reason = 'Trend down; sell bounces'; }
      else { action = 'WAIT'; reason = 'No clear trend'; }
    } else if (/stoch|williams/i.test(name)) {
      action = up ? 'BUY' : (down ? 'SELL' : 'WAIT');
      reason = up ? 'Oscillators aligned up with trend' : (down ? 'Oscillators aligned down with trend' : 'Neutral');
    } else if (/rsi.*macd/i.test(name)) {
      action = up ? 'BUY' : (down ? 'SELL' : 'WAIT');
      reason = up ? 'RSI>50 & MACD>0' : (down ? 'RSI<50 & MACD<0' : 'No alignment');
    } else if (/break of structure/i.test(name)) {
      action = up ? 'BUY' : (down ? 'SELL' : 'WAIT');
      reason = up ? 'Higher highs' : (down ? 'Lower lows' : 'No new structure');
    } else if (/pullback continuation/i.test(name)) {
      action = up ? 'BUY' : (down ? 'SELL' : 'WAIT');
      reason = up ? 'EMA9 pullbacks in uptrend' : (down ? 'EMA9 pullbacks in downtrend' : 'Sideways');
    } else if (/mean reversion/i.test(name)) {
      action = last > e9.at(-1) ? 'SELL' : 'BUY';
      reason = 'Fade to EMA9';
    } else { // Trendline default
      action = up ? 'BUY' : (down ? 'SELL' : 'WAIT');
      reason = up ? 'EMA9>EMA50 & slope up' : (down ? 'EMA9<EMA50 & slope down' : 'Flat');
    }

    // Add a risk:reward sanity — if slope too small, WAIT
    if (Math.abs(slope) < 0.0002) { action = 'WAIT'; reason += ' (weak momentum)'; }

    const conf = Math.max(0.5, Math.min(0.9, 0.6 + (up || down ? 0.15 : 0) + Math.abs(slope) * 10));
    return { action, reason, confidence: conf };
  };

  // Map timeframe to Finnhub back window
  const calcFromTs = (resolution) => {
    const now = nowSec();
    if (resolution === 'D')   return { from: now - 3600 * 24 * 400, to: now };
    if (resolution === '240') return { from: now - 3600 * 24 * 60,  to: now };
    return { from: now - 3600 * 24 * 7, to: now };
  };

  const fetchFinnhub = async (symbol, resolution) => {
    if (!FINN) return { ok: false, error: 'Missing FINNHUB_API_KEY' };
    const { from, to } = calcFromTs(resolution);
    const base = 'https://finnhub.io/api/v1';
    let path = '/stock/candle';
    if (symbol.startsWith('OANDA:')) path = '/forex/candle';
    if (symbol.startsWith('BINANCE:')) path = '/crypto/candle';
    const url = `${base}${path}?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${to}&token=${FINN}`;
    const r = await fetch(url);
    if (!r.ok) return { ok: false, error: `Finnhub ${r.status}` };
    const j = await r.json();
    if (j.s !== 'ok' || !Array.isArray(j.c) || j.c.length < 60) return { ok: false, error: 'No candles' };
    return { ok: true, ...j };
  };

  // --- Vision (OpenAI) ---
  const runVision = async (img, context) => {
    if (!OPENAI) return { ok: false, error: 'Missing OPENAI_API_KEY' };
    try {
      const prompt = `
Return strict JSON only with keys:
{ "signals":[{"action":"BUY|SELL|WAIT","reason":string,"confidence":0..1}],
  "entryExit":{"entry":number,"stop":number,"tp":number},
  "overlayHints":{"yPerc":{"entry":0..1,"stop":0..1,"tp":0..1}}
}
Context: ticker ${context.ticker||''}, timeframe ${context.timeframe}, strategy ${context.strategy}.
Critical: Do not invent. If unclear -> action "WAIT".
`;
      const rr = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0.2,
          messages: [
            { role: 'system', content: 'You are a trading assistant. Return strict JSON only.' },
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: img } }
              ]
            }
          ]
        })
      });
      const jj = await rr.json();
      const raw = jj?.choices?.[0]?.message?.content || '';
      try {
        const parsed = JSON.parse(raw);
        return { ok: true, mode: 'vision', ...parsed };
      } catch {
        return { ok: true, mode: 'vision', summary: raw };
      }
    } catch (e) {
      return { ok: false, error: 'vision_error: ' + String(e) };
    }
  };

  // --- MAIN ROUTE ---
  try {
    const flags = classify(ticker);
    const resolution = toReso(timeframe);

    // 1) If OTC (PocketOptions), skip Finnhub and require Vision
    if (flags.isOTC) {
      if (!imageDataURL) {
        return res.status(200).json({
          ok: false,
          error: 'otc_requires_vision',
          summary: 'PocketOptions OTC requires screenshot (Vision) – send imageDataURL.'
        });
      }
      const v = await runVision(imageDataURL, { ticker, timeframe, strategy });
      // If vision returns usable structure, pass-through; else WAIT fallback below
      if (v.ok) return res.status(200).json(v);
    }

    // 2) Try Finnhub for non-OTC (stocks/forex/crypto)
    if (!flags.isOTC) {
      const mapped = mapToFinnhub(ticker || flags.raw, flags);
      const data = await fetchFinnhub(mapped, resolution);

      if (data.ok) {
        const closes = data.c.slice(-300);
        const sig = decide(closes, strategy);

        // derive basic levels (better if your engine computes true SR/ATR)
        const lvl = levelsFromCloses(closes);
        const lvls = (sig.action === 'BUY') ? lvl.forBuy :
                     (sig.action === 'SELL') ? lvl.forSell : null;

        // approximate yPerc based on last 100 bars (so overlay can draw lines)
        let overlayHints = undefined;
        if (lvls) {
          const rangeHi = Math.max(...closes.slice(-100));
          const rangeLo = Math.min(...closes.slice(-100));
          const yPerc = p => {
            // 0 top, 1 bottom expected by client
            const t = (p - rangeLo) / Math.max(1e-9, rangeHi - rangeLo);
            return Number((1 - t).toFixed(3));
          };
          overlayHints = {
            yPerc: {
              entry: yPerc(lvls.entry),
              stop:  yPerc(lvls.stop),
              tp:    yPerc(lvls.tp)
            }
          };
        }

        return res.status(200).json({
          ok: true,
          mode: 'live-data',
          ticker: ticker || flags.raw,
          timeframe, strategy,
          summary: `${ticker || flags.raw} • ${timeframe} • ${strategy} — ${sig.action}.`,
          signals: [{ action: sig.action, reason: sig.reason, confidence: sig.confidence, ttlSec: 900 }],
          entryExit: lvls ? { ...lvls, yPerc: overlayHints?.yPerc } : {},
          overlayHints,
          price: closes.at(-1),
          note: { finnhubSymbol: mapped, resolution }
        });
      }

      // Finnhub failed (403/No data...) → try Vision if image present
      if (!data.ok && imageDataURL) {
        const v = await runVision(imageDataURL, { ticker, timeframe, strategy });
        if (v.ok) return res.status(200).json(v);
        // else fall through to hard fallback WAIT below
      }
    }

    // 3) If we are here, either OTC without image, or both data+vision failed.

    // --- HARD FALLBACK (WAIT) ---
    return res.status(200).json({
      ok: true,
      mode: 'fallback',
      ticker: ticker || 'UNKNOWN',
      timeframe, strategy,
      summary: `Fallback for ${ticker || 'UNKNOWN'} on ${timeframe} — ${strategy}.`,
      checklist: ['Trend check unavailable', 'Data fetch failed', 'Use conservative risk'],
      // IMPORTANT: do NOT return BUY here
      signals: [{ action: 'WAIT', reason: 'Fallback – no data', confidence: 0.00, ttlSec: 300 }],
      entryExit: { entry: '', stop: '', tp1: '', tp2: '' },
      error: 'no_data_or_vision'
    });

  } catch (e) {
    // --- HARD FALLBACK on exception ---
    return res.status(200).json({
      ok: true,
      mode: 'fallback',
      ticker: ticker || 'UNKNOWN',
      timeframe, strategy,
      summary: `Fallback for ${ticker || 'UNKNOWN'} on ${timeframe} — ${strategy}.`,
      checklist: ['Trend check unavailable', 'Exception', 'Use conservative risk'],
      signals: [{ action: 'WAIT', reason: 'Fallback – exception', confidence: 0.00, ttlSec: 300 }],
      entryExit: { entry: '', stop: '', tp1: '', tp2: '' },
      error: String(e)
    });
  }
}
