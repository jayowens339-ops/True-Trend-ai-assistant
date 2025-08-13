// /api/analyze.js  — one-file endpoint
// Node 18+ (Vercel / Netlify / Express serverless ok)

/* eslint-disable no-cond-assign */
export default async function handler(req, res) {
  // ---------- CORS ----------
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }

  try {
    const body = await readBody(req);
    const {
      ticker = '',
      timeframe = '5m',
      strategy = 'Trendline',
      style = 'swing',                 // scalp | day | swing
      image,                           // data URL for Vision
      token: tokenFromBody
    } = body || {};

    // ---------- License / Owner bypass ----------
    const bearer = extractBearer(req) || tokenFromBody || '';
    const OWNER_TOKEN = process.env.OWNER_TOKEN || 'OWNER';
    const ENFORCE_LICENSE = String(process.env.ENFORCE_LICENSE ?? 'true').toLowerCase() !== 'false';
    const isOwner = !!bearer && bearer === OWNER_TOKEN;

    if (ENFORCE_LICENSE && !isOwner && !bearer) {
      return res.status(200).json({ ok: false, error: 'license_required' });
    }

    // ---------- Vision path ----------
    if (image && process.env.OPENAI_API_KEY) {
      const v = await visionAnalyze({ image, ticker, timeframe, strategy, style });
      if (v.ok) return res.status(200).json(v);
      // if vision failed, continue to data route as fallback
    }

    // ---------- Data path (Finnhub -> Yahoo) ----------
    const tf = normalizeTF(timeframe);
    const sym = (ticker || '').trim().toUpperCase();

    // fetch candles (Finnhub first)
    let dataResp = await getFinnhubCandles(sym, tf);
    let mode = 'data-finnhub';
    if (!dataResp.ok) {
      dataResp = await getYahooCandles(sym, tf);
      mode = 'data-yahoo';
    }
    if (!dataResp.ok) {
      return res.status(200).json(hardFallback({ ticker: sym, timeframe: tf.raw, strategy, error: dataResp.error || 'No data' }));
    }

    const { t, o, h, l, c } = dataResp;
    // Need enough bars
    if (!Array.isArray(c) || c.length < 100) {
      return res.status(200).json(hardFallback({ ticker: sym, timeframe: tf.raw, strategy, error: 'Too few candles' }));
    }

    // ---------- Signal engine ----------
    const engine = decideSignal({ o, h, l, c, strategy, tf, style });
    const entryExit = entryExitFromSignal({ o, h, l, c, action: engine.action, tf, style });

    const checklist = [
      `EMA9 ${EMA(9, c).at(-1) > EMA(50, c).at(-1) ? 'above' : 'below'} EMA50`,
      `Last close ${c.at(-1) >= EMA(9, c).at(-1) ? 'above' : 'below'} EMA9`,
      `Slope ${slope(c, 5) > 0 ? 'up' : slope(c, 5) < 0 ? 'down' : 'flat'} (last 5 bars)`
    ];

    return res.status(200).json({
      ok: true,
      mode,
      ticker: sym,
      timeframe: tf.raw,
      strategy,
      style,
      summary: `${sym || 'UNKNOWN'} on ${tf.raw} — ${strategy}.`,
      checklist,
      signals: [{
        action: engine.action,
        reason: engine.reason,
        confidence: engine.confidence,
        ttlSec: 900
      }],
      entryExit
    });

  } catch (e) {
    return res.status(200).json(hardFallback({ ticker: 'UNKNOWN', timeframe: '5m', strategy: 'Trendline', error: String(e?.message || e) }));
  }
}

/* ----------------------- helpers ----------------------- */

function extractBearer(req) {
  const h = req.headers?.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : '';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
  });
}

function hardFallback({ ticker, timeframe, strategy, error }) {
  return {
    ok: true,
    mode: 'fallback',
    ticker,
    timeframe,
    strategy,
    summary: `Fallback for ${ticker} on ${timeframe} — ${strategy}.`,
    checklist: ['Trend check unavailable', 'Data fetch failed', 'Use conservative risk'],
    signals: [{ action: 'BUY', reason: 'Fallback signal', confidence: 0.55, ttlSec: 900 }],
    entryExit: { entry: '', stop: '', tp1: '', tp2: '' },
    error
  };
}

/* ---------- Timeframe mapping ---------- */
function normalizeTF(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('1m')) return { raw: '1m', finnhub: '1', yahooInt: '1m', yahooRange: '7d' };
  if (s.includes('5m')) return { raw: '5m', finnhub: '5', yahooInt: '5m', yahooRange: '60d' };
  if (s.includes('15m')) return { raw: '15m', finnhub: '15', yahooInt: '15m', yahooRange: '60d' };
  if (s.includes('1h')) return { raw: '1h', finnhub: '60', yahooInt: '60m', yahooRange: '730d' };
  if (s.includes('4h')) return { raw: '4h', finnhub: '60', yahooInt: '60m', yahooRange: '730d', build4h: true };
  return { raw: 'Daily', finnhub: 'D', yahooInt: '1d', yahooRange: '10y' };
}

/* ---------- Data providers ---------- */
async function getFinnhubCandles(symbol, tf) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return { ok: false, error: 'Missing FINNHUB_API_KEY' };
  const now = Math.floor(Date.now() / 1000);
  const lookbackSec =
    tf.finnhub === 'D' ? 3600 * 24 * 500 :
    tf.finnhub === '60' ? 3600 * 24 * 60 :
    3600 * 24 * 10;
  const from = now - lookbackSec;

  // try stock; forex; crypto endpoints
  const tryPaths = [
    `/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=${tf.finnhub}&from=${from}&to=${now}&token=${key}`,
    `/forex/candle?symbol=OANDA:${encodeURIComponent(symbol)}&resolution=${tf.finnhub}&from=${from}&to=${now}&token=${key}`,
    `/crypto/candle?symbol=BINANCE:${encodeURIComponent(symbol)}&resolution=${tf.finnhub}&from=${from}&to=${now}&token=${key}`
  ];
  for (const path of tryPaths) {
    const url = `https://finnhub.io/api/v1${path}`;
    const r = await safeFetch(url);
    if (!r.ok) continue;
    const j = await r.json();
    if (j.s === 'ok' && Array.isArray(j.c) && j.c.length > 50) {
      if (tf.build4h) return build4hFrom1h(j);
      return { ok: true, ...j };
    }
  }
  return { ok: false, error: 'Finnhub failed' };
}

async function getYahooCandles(symbol, tf) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${tf.yahooInt}&range=${tf.yahooRange}`;
  const r = await safeFetch(url);
  if (!r.ok) return { ok: false, error: `Yahoo ${r.status}` };
  const j = await r.json();
  const result = j?.chart?.result?.[0];
  const q = result?.indicators?.quote?.[0];
  const ts = result?.timestamp;
  if (!q || !ts || !q.close) return { ok: false, error: 'Yahoo no data' };

  const out = {
    ok: true,
    t: ts,
    o: q.open || [],
    h: q.high || [],
    l: q.low || [],
    c: q.close || []
  };
  if (tf.build4h) return build4hFrom1h(out);
  return out;
}

async function safeFetch(url, init) {
  try { return await fetch(url, init); }
  catch { return { ok: false, status: 0, json: async () => ({}) }; }
}

function build4hFrom1h(src) {
  // downsample 1h arrays to 4h
  const k = 4;
  const n = Math.floor(src.c.length / k);
  const t=[], o=[], h=[], l=[], c=[];
  for (let i=0;i<n;i++){
    const s=i*k;
    const e=s+k;
    const segO = src.o[s];
    const segC = src.c[e-1];
    const segH = Math.max(...src.h.slice(s,e));
    const segL = Math.min(...src.l.slice(s,e));
    t.push(src.t[e-1]);
    o.push(segO); h.push(segH); l.push(segL); c.push(segC);
  }
  return { ok:true, t,o,h,l,c };
}

/* ---------- Indicators ---------- */
function EMA(period, arr) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = arr.find(v => Number.isFinite(v));
  if (prev == null) return out;
  out.push(prev);
  for (let i = 1; i < arr.length; i++) {
    const v = Number.isFinite(arr[i]) ? arr[i] : out[out.length-1];
    prev = v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}
function SMA(period, arr) {
  const out = [];
  let sum = 0;
  for (let i=0;i<arr.length;i++){
    sum += arr[i];
    if (i>=period) sum -= arr[i-period];
    if (i>=period-1) out.push(sum/period);
    else out.push(arr[i]);
  }
  return out;
}
function RSI(period, arr) {
  let gains = 0, losses = 0;
  for (let i=1;i<=period;i++){
    const ch = arr[i]-arr[i-1];
    if (ch>=0) gains += ch; else losses -= ch;
  }
  gains/=period; losses/=period;
  const rsis=[100 - 100/(1+(gains/(losses||1e-9)))];
  for (let i=period+1;i<arr.length;i++){
    const ch = arr[i]-arr[i-1];
    const g = ch>0?ch:0, l = ch<0?-ch:0;
    gains = (gains*(period-1)+g)/period;
    losses = (losses*(period-1)+l)/period;
    rsis.push(100 - 100/(1+(gains/(losses||1e-9)))));
  }
  // pad to length
  while (rsis.length<arr.length) rsis.unshift(rsis[0]);
  return rsis;
}
function MACD(arr, fast=12, slow=26, signal=9){
  const macd = EMA(fast, arr).map((v,i)=>v-(EMA(slow,arr)[i]||v));
  const sig = EMA(signal, macd);
  const hist = macd.map((v,i)=>v-(sig[i]||0));
  return { macd, signal: sig, hist };
}
function StochK(arrH, arrL, arrC, kPeriod=14) {
  const out=[];
  for (let i=0;i<arrC.length;i++){
    const s=Math.max(0,i-kPeriod+1), e=i+1;
    const hh=Math.max(...arrH.slice(s,e)), ll=Math.min(...arrL.slice(s,e));
    out.push(( (arrC[i]-ll) / Math.max(1e-9, (hh-ll)) ) *100);
  }
  return out;
}
function WilliamsR(arrH, arrL, arrC, look=14){
  const out=[];
  for (let i=0;i<arrC.length;i++){
    const s=Math.max(0,i-look+1), e=i+1;
    const hh=Math.max(...arrH.slice(s,e)), ll=Math.min(...arrL.slice(s,e));
    out.push(-100 * ( (hh - arrC[i]) / Math.max(1e-9, (hh-ll)) ));
  }
  return out;
}
function slope(arr, bars=5){ return (arr.at(-1) - arr.at(-1-bars)) || 0; }
function lastSwingLow(h,l, look=10){
  let idx = -1, val = Infinity;
  for (let i=l.length-2;i>=Math.max(1,l.length-look-1);i--){
    if (l[i] < l[i-1] && l[i] < l[i+1] && l[i] < val) { val=l[i]; idx=i; }
  }
  return idx>=0 ? val : l.at(-2);
}
function lastSwingHigh(h,l, look=10){
  let idx=-1, val=-Infinity;
  for (let i=h.length-2;i>=Math.max(1,h.length-look-1);i--){
    if (h[i] > h[i-1] && h[i] > h[i+1] && h[i] > val) { val=h[i]; idx=i; }
  }
  return idx>=0 ? val : h.at(-2);
}

/* ---------- Strategy engine (9 strategies) ---------- */
function decideSignal({ o,h,l,c, strategy, tf, style }) {
  const e9 = EMA(9, c), e50 = EMA(50, c);
  const last = c.at(-1), s5 = slope(c, 5);
  const up = e9.at(-1) > e50.at(-1) && s5 > 0;
  const down = e9.at(-1) < e50.at(-1) && s5 < 0;
  const confBase = 0.55 + Math.min(0.25, Math.abs( (e9.at(-1)-e50.at(-1)) / (e50.at(-1)||1e-9) ));
  const rsi = RSI(14, c), stoch = StochK(h,l,c,14), wr = WilliamsR(h,l,c,14), macd = MACD(c);

  let action='WAIT', reason='No setup', conf=confBase;

  const name = String(strategy||'').toLowerCase();

  const crossUp = e9.at(-2) <= e50.at(-2) && e9.at(-1) > e50.at(-1);
  const crossDn = e9.at(-2) >= e50.at(-2) && e9.at(-1) < e50.at(-1);

  if (name.includes('trendline')) {
    if (up) { action='BUY'; reason='Above EMA50 with rising EMA9'; }
    else if (down) { action='SELL'; reason='Below EMA50 with falling EMA9'; }
    conf += 0.05;
  } else if (name.includes('ema touch')) {
    const dist = Math.abs((last - e9.at(-1)) / (e9.at(-1)||1e-9));
    if (dist < 0.003) { action = up ? 'BUY':'SELL'; reason = `Touching EMA9 (${(dist*100).toFixed(2)}%)`; }
  } else if (name.includes('orb')) {
    // ORB: break of first N bars range (use 3 bars)
    const N = 3;
    const hi = Math.max(...h.slice(-N-20, -20+N));
    const lo = Math.min(...l.slice(-N-20, -20+N));
    if (last > hi && up) { action='BUY'; reason='ORB breakout above opening range'; }
    else if (last < lo && down) { action='SELL'; reason='ORB breakdown below opening range'; }
  } else if (name.includes('support') || name.includes('resistance')) {
    const sup = lastSwingLow(h,l,20), res = lastSwingHigh(h,l,20);
    if (up && last > res) { action='BUY'; reason='Break and hold above resistance'; }
    else if (down && last < sup) { action='SELL'; reason='Break and hold below support'; }
  } else if (name.includes('stoch') || name.includes('williams')) {
    if (up && stoch.at(-1) > 55 && wr.at(-1) > -45) { action='BUY'; reason='Momentum up (Stoch & W%R) with trend'; }
    else if (down && stoch.at(-1) < 45 && wr.at(-1) < -55) { action='SELL'; reason='Momentum down (Stoch & W%R) with trend'; }
  } else if (name.includes('rsi') && name.includes('macd')) {
    if (up && rsi.at(-1) > 50 && macd.macd.at(-1) > macd.signal.at(-1)) { action='BUY'; reason='RSI>50 & MACD>signal with trend'; }
    else if (down && rsi.at(-1) < 50 && macd.macd.at(-1) < macd.signal.at(-1)) { action='SELL'; reason='RSI<50 & MACD<signal with trend'; }
  } else if (name.includes('break of structure')) {
    const hh = Math.max(...h.slice(-20,-10)), nh = Math.max(...h.slice(-10));
    const ll = Math.min(...l.slice(-20,-10)), nl = Math.min(...l.slice(-10));
    if (nh > hh && up) { action='BUY'; reason='Higher highs; BOS up'; }
    else if (nl < ll && down) { action='SELL'; reason='Lower lows; BOS down'; }
  } else if (name.includes('pullback continuation')) {
    const touched9 = (c.at(-2) < e9.at(-2) && c.at(-1) > e9.at(-1)) || (c.at(-2) > e9.at(-2) && c.at(-1) < e9.at(-1));
    if (up && touched9) { action='BUY'; reason='Pullback to EMA9 then continuation'; }
    else if (down && touched9) { action='SELL'; reason='Pullback to EMA9 then continuation'; }
  } else if (name.includes('mean reversion')) {
    action = last > e9.at(-1) ? 'SELL' : 'BUY';
    reason = 'Fade back to EMA9';
  } else {
    // default trendline
    if (up) { action='BUY'; reason='Above EMA50 with rising EMA9'; }
    else if (down) { action='SELL'; reason='Below EMA50 with falling EMA9'; }
  }

  // micro adjustments
  if (crossUp && action==='BUY') conf += 0.05;
  if (crossDn && action==='SELL') conf += 0.05;
  conf = Math.max(0.5, Math.min(0.92, conf));

  return { action, reason, confidence: conf };
}

/* ---------- Entry/Stop/TP builder ---------- */
function entryExitFromSignal({ o,h,l,c, action, tf, style }) {
  if (!action || action === 'WAIT') return { entry:'', stop:'', tp1:'', tp2:'' };

  // style risk knobs
  const riskMult =
    String(style).toLowerCase().startsWith('scalp') ? 0.6 :
    String(style).toLowerCase().startsWith('day')   ? 1.0 : 1.5;

  const entry = c.at(-1);
  let stop, rr = 1.0;

  if (action === 'BUY') {
    const sw = lastSwingLow(h,l,12);
    stop = Math.min(sw, entry * 0.997); // small buffer
    rr = Math.max( (entry - stop) || (entry*0.002), entry*0.0015 );
    return {
      entry: fixed(entry),
      stop: fixed(stop),
      tp1: fixed(entry + rr * riskMult),
      tp2: fixed(entry + rr * 2 * riskMult),
    };
  } else {
    const sw = lastSwingHigh(h,l,12);
    stop = Math.max(sw, entry * 1.003);
    rr = Math.max( (stop - entry) || (entry*0.002), entry*0.0015 );
    return {
      entry: fixed(entry),
      stop: fixed(stop),
      tp1: fixed(entry - rr * riskMult),
      tp2: fixed(entry - rr * 2 * riskMult),
    };
  }
}
function fixed(x){ return Number(x).toFixed(5).replace(/0+$/,'').replace(/\.$/,''); }

/* ---------- Vision (OpenAI) ---------- */
async function visionAnalyze({ image, ticker, timeframe, strategy, style }) {
  try {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return { ok:false, error:'Missing OPENAI_API_KEY' };

    const prompt = `Return STRICT JSON with:
{
  "summary": string,
  "checklist": [string,string,string],
  "signals": [{"action":"BUY|SELL|WAIT","reason":string,"confidence": number between 0 and 1,"ttlSec":900}],
  "entryExit": {"entry":string,"stop":string,"tp1":string,"tp2":string}
}
Context: Chart screenshot. Ticker:${ticker||'UNKNOWN'} Timeframe:${timeframe} Strategy:${strategy} Style:${style}.
Rules: prefer conservative entries; if unclear set action "WAIT".`;

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST',
      headers:{ 'Authorization':`Bearer ${key}`, 'Content-Type':'application/json' },
      body: JSON.stringify({
        model:'gpt-4o-mini',
        temperature:0.2,
        messages: [
          { role:'system', content:'You are a trading helper. Respond ONLY with JSON.' },
          { role:'user', content:[
            { type:'text', text: prompt },
            { type:'image_url', image_url:{ url: image } }
          ]}
        ]
      })
    });
    const j = await r.json();
    const raw = j?.choices?.[0]?.message?.content?.trim() || '';
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {}
    if (!parsed) return { ok:false, error:'Vision parse failed', raw };
    return {
      ok:true,
      mode:'vision',
      ticker,
      timeframe,
      strategy,
      style,
      ...parsed
    };
  } catch (e) {
    return { ok:false, error:String(e?.message||e) };
  }
}
