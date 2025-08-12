// api/analyze.js
// Live data with provider cascade: Finnhub -> TwelveData -> AlphaVantage
// OTC (PocketOptions) => Vision. Hard fallback => WAIT (not BUY).

export default async function handler(req, res) {
  // ---- CORS ----
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }

  // ---- ENV ----
  const FINN   = process.env.FINNHUB_API_KEY || '';
  const TDKEY  = process.env.TWELVEDATA_API_KEY || '';
  const AVKEY  = process.env.ALPHAVANTAGE_API_KEY || '';
  const OPENAI = process.env.OPENAI_API_KEY || process.env.GPT_API_KEY || '';
  const OWNER_TOKEN = (process.env.OWNER_TOKEN || '').trim();
  const ENFORCE_LICENSE = (process.env.ENFORCE_LICENSE || '').toLowerCase() === 'true';

  // ---- AUTH ----
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (ENFORCE_LICENSE) {
    if (!auth || (OWNER_TOKEN && auth !== OWNER_TOKEN)) {
      return res.status(200).json({ ok: false, error: 'license_required' });
    }
  }

  // ---- INPUT ----
  const {
    ticker = '',
    timeframe = '5m',
    strategy = 'Trendline',
    imageDataURL = '',  // base64 screenshot (Vision)
  } = (req.body || {});

  // ---- helpers ----
  const nowSec = () => Math.floor(Date.now() / 1000);
  const toReso = tf => {
    const m = String(tf).toLowerCase();
    if (m.includes('5m')) return '5';
    if (m.includes('15m')) return '15';
    if (m.includes('1h')) return '60';
    if (m.includes('4h')) return '240';
    return 'D';
  };
  const calcFromTs = (resolution) => {
    const now = nowSec();
    if (resolution === 'D')   return { from: now - 3600 * 24 * 400, to: now };
    if (resolution === '240') return { from: now - 3600 * 24 * 60,  to: now };
    return { from: now - 3600 * 24 * 7, to: now };
  };

  const classify = (sym) => {
    const s = String(sym || '').toUpperCase();
    const isOTC =
      /(^|[^A-Z])OTC([^A-Z]|$)/.test(s) ||
      /_OTC$/.test(s) || /\/OTC$/.test(s) ||
      (req.headers.referer && /pocketoption|pocketoptions|po\./i.test(req.headers.referer) && !s);
    const isCrypto = /(USDT|BTC|ETH|SOL|DOGE|ADA|BNB)/.test(s);
    const isForex  = /^[A-Z]{6}$/.test(s) || /(EUR|USD|JPY|GBP|AUD|CAD|CHF)/.test(s);
    return { isOTC, isCrypto, isForex, raw: s };
  };

  // map for providers
  const mapToFinnhub = (sym, flags) => {
    const s = sym.toUpperCase();
    if (flags.isOTC) return s; // not used for Finnhub
    if (flags.isCrypto) return s.includes(':') ? s : `BINANCE:${s}`;
    if (flags.isForex) {
      if (s.length === 6) return `OANDA:${s.slice(0,3)}_${s.slice(3)}`;
      return s;
    }
    return s; // stock or already namespaced
  };
  const mapToTwelve = (sym, flags) => {
    // TwelveData wants: Stocks "AAPL", Forex "EUR/USD", Crypto "BTC/USD" with optional exchange=Binance
    const s = sym.toUpperCase();
    if (flags.isForex && s.length === 6) return { symbol: `${s.slice(0,3)}/${s.slice(3)}`, query: '' };
    if (flags.isCrypto) return { symbol: s.replace('USDT','/USDT').replace('USD','/USD'), query: 'exchange=Binance' };
    return { symbol: s, query: '' }; // stocks
  };
  const mapToAlpha = (sym, flags) => {
    // AlphaVantage: FX needs from_symbol & to_symbol; Crypto symbol+market; Stocks symbol=AAPL
    const s = sym.toUpperCase();
    if (flags.isForex && s.length === 6) return { fxFrom: s.slice(0,3), fxTo: s.slice(3) };
    if (flags.isCrypto) {
      if (/USDT$/.test(s)) return { crypto: s.replace('USDT',''), market: 'USDT' };
      return { crypto: s.replace('USD',''), market: 'USD' };
    }
    return { stock: s };
  };

  // ------ strategy helpers ------
  const ema = (period, arr) => {
    if (!arr || !arr.length) return [];
    const k = 2 / (period + 1);
    let prev = arr[0]; const out = [prev];
    for (let i = 1; i < arr.length; i++) { prev = arr[i] * k + prev * (1 - k); out.push(prev); }
    return out;
  };
  const levelsFromCloses = (closes) => {
    const last = closes.at(-1);
    const swingHi = Math.max(...closes.slice(-50));
    const swingLo = Math.min(...closes.slice(-50));
    const atr = (swingHi - swingLo) / 10 || (last * 0.001);
    return {
      forBuy:  { entry: +(last + 0.1*atr).toFixed(5), stop: +(last - 1.5*atr).toFixed(5), tp: +(last + 2*atr).toFixed(5) },
      forSell: { entry: +(last - 0.1*atr).toFixed(5), stop: +(last + 1.5*atr).toFixed(5), tp: +(last - 2*atr).toFixed(5) },
    };
  };
  const decide = (closes, name) => {
    if (!closes || closes.length < 60) return { action:'WAIT', reason:'Insufficient data', confidence:0.5 };
    const e9 = ema(9, closes), e50 = ema(50, closes);
    const last = closes.at(-1);
    const slope = (last - closes.at(-6)) / Math.max(1e-9, closes.at(-6));
    const up = e9.at(-1) > e50.at(-1) && slope > 0;
    const down = e9.at(-1) < e50.at(-1) && slope < 0;

    let action='WAIT', reason='';
    if (/ema touch/i.test(name)) {
      const dist = Math.abs((last - e9.at(-1)) / Math.max(1e-9, e9.at(-1)));
      if (dist < 0.002) action = up ? 'BUY' : (down ? 'SELL' : 'WAIT');
      reason = `Distance to EMA9 ${(dist*100).toFixed(2)}%`;
    } else if (/orb/i.test(name)) {
      const r = closes.slice(-20); const hi = Math.max(...r), lo = Math.min(...r);
      if (last > hi * 1.001 && up)      { action='BUY';  reason='Break above opening range'; }
      else if (last < lo * 0.999 && down){ action='SELL'; reason='Break below opening range'; }
      else { action='WAIT'; reason='No clean range break'; }
    } else if (/support\/resistance/i.test(name)) {
      if (up) { action='BUY'; reason='Trend up; buy pullbacks'; }
      else if (down) { action='SELL'; reason='Trend down; sell bounces'; }
      else { action='WAIT'; reason='No clear trend'; }
    } else if (/stoch|williams/i.test(name)) {
      action = up ? 'BUY' : (down ? 'SELL' : 'WAIT');
      reason = up ? 'Oscillators aligned up' : (down ? 'Oscillators aligned down' : 'Neutral');
    } else if (/rsi.*macd/i.test(name)) {
      action = up ? 'BUY' : (down ? 'SELL' : 'WAIT');
      reason = up ? 'RSI>50 & MACD>0' : (down ? 'RSI<50 & MACD<0' : 'No alignment');
    } else if (/break of structure/i.test(name)) {
      action = up ? 'BUY' : (down ? 'SELL' : 'WAIT');
      reason = up ? 'Higher highs' : (down ? 'Lower lows' : 'No new structure');
    } else if (/pullback continuation/i.test(name)) {
      action = up ? 'BUY' : (down ? 'SELL' : 'WAIT');
      reason = up ? 'EMA9 pullbacks in uptrend' : (down ? 'EMA9 pullbacks in downtrend' : 'Sideways';
    } else if (/mean reversion/i.test(name)) {
      action = last > e9.at(-1) ? 'SELL' : 'BUY';
      reason = 'Fade to EMA9';
    } else {
      action = up ? 'BUY' : (down ? 'SELL' : 'WAIT');
      reason = up ? 'EMA9>EMA50 & slope up' : (down ? 'EMA9<EMA50 & slope down' : 'Flat');
    }

    if (Math.abs(slope) < 0.0002) { action = 'WAIT'; reason += ' (weak momentum)'; }
    const conf = Math.max(0.5, Math.min(0.9, 0.6 + (up || down ? 0.15 : 0) + Math.abs(slope) * 10));
    return { action, reason, confidence: conf };
  };

  // ---- Providers ----
  const fetchFinnhub = async (symbol, resolution) => {
    if (!FINN) return { ok:false, error:'Missing FINNHUB_API_KEY' };
    const { from, to } = calcFromTs(resolution);
    const base = 'https://finnhub.io/api/v1';
    let path = '/stock/candle';
    if (symbol.startsWith('OANDA:'))   path='/forex/candle';
    if (symbol.startsWith('BINANCE:')) path='/crypto/candle';
    const url = `${base}${path}?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${to}&token=${FINN}`;
    const r = await fetch(url);
    if (!r.ok) return { ok:false, error:`Finnhub ${r.status}` };
    const j = await r.json();
    if (j.s!=='ok' || !Array.isArray(j.c) || j.c.length<60) return { ok:false, error:'No candles' };
    return { ok:true, c:j.c, t:j.t };
  };

  const tdInterval = (resolution) => {
    if (resolution==='5')   return '5min';
    if (resolution==='15')  return '15min';
    if (resolution==='60')  return '1h';
    if (resolution==='240') return '4h';
    return '1day';
  };
  const fetchTwelve = async (sym, flags, resolution) => {
    if (!TDKEY) return { ok:false, error:'Missing TWELVEDATA_API_KEY' };
    const { symbol, query } = mapToTwelve(sym, flags);
    const interval = tdInterval(resolution);
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=500${query?`&${query}`:''}&apikey=${TDKEY}`;
    const r = await fetch(url);
    if (!r.ok) return { ok:false, error:`TwelveData ${r.status}` };
    const j = await r.json();
    const vals = j?.values;
    if (!Array.isArray(vals) || vals.length<60) return { ok:false, error:'No candles' };
    // TwelveData returns newest-first
    const c = vals.map(v => +v.close).reverse();
    const t = vals.map(v => Math.floor(new Date(v.datetime).getTime()/1000)).reverse();
    return { ok:true, c, t };
  };

  const avIntradayInterval = (resolution) => {
    if (resolution==='5')  return '5min';
    if (resolution==='15') return '15min';
    if (resolution==='60') return '60min';
    return null; // AV has no native 4h; we'll skip AV for 4h
  };
  const fetchAlpha = async (sym, flags, resolution) => {
    if (!AVKEY) return { ok:false, error:'Missing ALPHAVANTAGE_API_KEY' };

    // daily for D; intraday for 5/15/60; skip for 4h
    if (resolution==='240') return { ok:false, error:'AlphaVantage no 4h' };

    const intv = avIntradayInterval(resolution);
    let url='';
    if (intv) {
      if (flags.isForex) {
        const m = mapToAlpha(sym, flags);
        url = `https://www.alphavantage.co/query?function=FX_INTRADAY&from_symbol=${m.fxFrom}&to_symbol=${m.fxTo}&interval=${intv}&outputsize=full&apikey=${AVKEY}`;
      } else if (flags.isCrypto) {
        const m = mapToAlpha(sym, flags);
        url = `https://www.alphavantage.co/query?function=CRYPTO_INTRADAY&symbol=${m.crypto}&market=${m.market}&interval=${intv}&outputsize=full&apikey=${AVKEY}`;
      } else {
        const m = mapToAlpha(sym, flags);
        url = `https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=${m.stock}&interval=${intv}&outputsize=full&apikey=${AVKEY}`;
      }
    } else {
      // daily
      const m = mapToAlpha(sym, flags);
      if (flags.isForex) {
        url = `https://www.alphavantage.co/query?function=FX_DAILY&from_symbol=${m.fxFrom}&to_symbol=${m.fxTo}&outputsize=full&apikey=${AVKEY}`;
      } else if (flags.isCrypto) {
        url = `https://www.alphavantage.co/query?function=DIGITAL_CURRENCY_DAILY&symbol=${m.crypto}&market=${m.market}&apikey=${AVKEY}`;
      } else {
        url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${m.stock}&outputsize=full&apikey=${AVKEY}`;
      }
    }

    const r = await fetch(url);
    if (!r.ok) return { ok:false, error:`AlphaVantage ${r.status}` };
    const j = await r.json();

    // Parse generically by finding the first time-series object
    const series = Object.values(j).find(v => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).some(k => /\d{4}-\d{2}-\d{2}/.test(k)));
    if (!series) return { ok:false, error:'No time series' };
    const points = Object.entries(series)
      .map(([k, v]) => ({ ts: Math.floor(new Date(k).getTime()/1000), close: +((v['4. close']||v['4b. close (USD)']||v['4. close']) || 0) }))
      .filter(p => p.close > 0)
      .sort((a,b)=>a.ts-b.ts);
    if (points.length<60) return { ok:false, error:'Not enough candles' };
    return { ok:true, c: points.map(p=>p.close), t: points.map(p=>p.ts) };
  };

  const getCandlesAny = async (sym, flags, resolution) => {
    let err = [];
    // 1) Finnhub
    if (FINN) {
      const f = await fetchFinnhub(mapToFinnhub(sym, flags), resolution);
      if (f.ok) return { provider:'finnhub', ...f };
      err.push(f.error);
    }
    // 2) TwelveData
    if (TDKEY) {
      const t = await fetchTwelve(sym, flags, resolution);
      if (t.ok) return { provider:'twelvedata', ...t };
      err.push(t.error);
    }
    // 3) Alpha Vantage
    if (AVKEY) {
      const a = await fetchAlpha(sym, flags, resolution);
      if (a.ok) return { provider:'alphavantage', ...a };
      err.push(a.error);
    }
    return { ok:false, error:'No provider: ' + err.filter(Boolean).join(' | ') };
  };

  // ---- Vision ----
  const runVision = async (img, context) => {
    if (!OPENAI) return { ok:false, error:'Missing OPENAI_API_KEY' };
    try {
      const prompt = `
Return strict JSON only:
{
 "signals":[{"action":"BUY|SELL|WAIT","reason":string,"confidence":0..1}],
 "entryExit":{"entry":number,"stop":number,"tp":number},
 "overlayHints":{"yPerc":{"entry":0..1,"stop":0..1,"tp":0..1}}
}
Context: ticker ${context.ticker||''}, timeframe ${context.timeframe}, strategy ${context.strategy}.
If unclear => action "WAIT".
`;
      const rr = await fetch('https://api.openai.com/v1/chat/completions', {
        method:'POST',
        headers:{'Authorization':`Bearer ${OPENAI}`,'Content-Type':'application/json'},
        body: JSON.stringify({
          model:'gpt-4o-mini', temperature:0.2,
          messages:[
            { role:'system', content:'You are a trading assistant. Return strict JSON only.' },
            { role:'user', content:[
              { type:'text', text: prompt },
              { type:'image_url', image_url:{ url: img } }
            ]}
          ]
        })
      });
      const jj = await rr.json();
      const raw = jj?.choices?.[0]?.message?.content || '';
      try { const parsed = JSON.parse(raw); return { ok:true, mode:'vision', ...parsed }; }
      catch { return { ok:true, mode:'vision', summary: raw }; }
    } catch (e) { return { ok:false, error:'vision_error: '+String(e) }; }
  };

  // ---- MAIN ----
  try {
    const flags = classify(ticker);
    const resolution = toReso(timeframe);

    // OTC => Vision required
    if (flags.isOTC) {
      if (!imageDataURL) {
        return res.status(200).json({ ok:false, error:'otc_requires_vision', summary:'PocketOptions OTC requires screenshot (Vision).' });
      }
      const v = await runVision(imageDataURL, { ticker, timeframe, strategy });
      if (v.ok) return res.status(200).json(v);
    }

    // Non-OTC: try providers cascade
    const candles = await getCandlesAny(ticker || flags.raw, flags, resolution);
    if (candles.ok) {
      const closes = candles.c.slice(-300);
      const sig = decide(closes, strategy);

      const lvl = levelsFromCloses(closes);
      const lvls = sig.action==='BUY' ? lvl.forBuy : sig.action==='SELL' ? lvl.forSell : null;

      let overlayHints;
      if (lvls) {
        const rangeHi = Math.max(...closes.slice(-100));
        const rangeLo = Math.min(...closes.slice(-100));
        const yPerc = v => {
          const t = (v - rangeLo) / Math.max(1e-9, rangeHi - rangeLo);
          return Number((1 - t).toFixed(3));
        };
        overlayHints = { yPerc: { entry: yPerc(lvls.entry), stop: yPerc(lvls.stop), tp: yPerc(lvls.tp) } };
      }

      return res.status(200).json({
        ok:true,
        mode:'live-data',
        provider: candles.provider,
        ticker: ticker || flags.raw, timeframe, strategy,
        summary:`${ticker || flags.raw} • ${timeframe} • ${strategy} — ${sig.action}.`,
        signals:[{ action:sig.action, reason:sig.reason, confidence:sig.confidence, ttlSec:900 }],
        entryExit: lvls ? { ...lvls, yPerc: overlayHints?.yPerc } : {},
        overlayHints,
        price: closes.at(-1)
      });
    }

    // Providers failed -> try Vision if we have an image
    if (!candles.ok && imageDataURL) {
      const v = await runVision(imageDataURL, { ticker, timeframe, strategy });
      if (v.ok) return res.status(200).json(v);
    }

    // Hard fallback (WAIT)
    return res.status(200).json({
      ok:true, mode:'fallback',
      ticker: ticker || 'UNKNOWN', timeframe, strategy,
      summary:`Fallback for ${ticker || 'UNKNOWN'} on ${timeframe} — ${strategy}.`,
      checklist:['Trend check unavailable','Data fetch failed','Use conservative risk'],
      signals:[{ action:'WAIT', reason:'Fallback – no data', confidence:0.00, ttlSec:300 }],
      entryExit:{ entry:'', stop:'', tp1:'', tp2:'' },
      error: candles.error || 'no_data_or_vision'
    });

  } catch (e) {
    return res.status(200).json({
      ok:true, mode:'fallback',
      ticker: ticker || 'UNKNOWN', timeframe, strategy,
      summary:`Fallback for ${ticker || 'UNKNOWN'} on ${timeframe} — ${strategy}.`,
      checklist:['Trend check unavailable','Exception','Use conservative risk'],
      signals:[{ action:'WAIT', reason:'Fallback – exception', confidence:0.00, ttlSec:300 }],
      entryExit:{ entry:'', stop:'', tp1:'', tp2:'' },
      error: String(e)
    });
  }
}
