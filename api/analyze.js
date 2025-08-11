// /pages/api/analyze.js
// One endpoint: 9 strategies, Finnhub analysis, Vision analysis (imageDataURL),
// entry/stop/targets per strategy, Alexa announce (optional), owner/JWT auth.

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } } // allow compressed screenshots from the extension
};

export default async function handler(req, res) {
  // --- CORS ---
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Use POST' });

  // --- Auth: owner token or JWT license ---
  const OWNER = (process.env.OWNER_LICENSE || '').trim();
  const authHeader = (req.headers.authorization || '').toString();
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ ok:false, error:'Missing token' });
  if (!(OWNER && token === OWNER)) {
    try {
      const jwt = (await import('jsonwebtoken')).default;
      jwt.verify(token, process.env.LICENSE_SECRET);
    } catch {
      return res.status(401).json({ ok:false, error:'Invalid license' });
    }
  }

  // --- Request body ---
  const {
    ticker = 'EURUSD',
    timeframe = 'Daily',
    strategy = 'Trendline', // one of the 9 strategies
    imageDataURL,           // if present -> Vision path
    alexaUrl                // optional webhook to announce
  } = req.body || {};

  // ---------- helpers ----------
  const nowSec = () => Math.floor(Date.now()/1000);
  const pct = (a,b)=> (b===0?0:(a-b)/b);
  const clip = (x,lo,hi)=> Math.max(lo, Math.min(hi,x));

  function ema(period, arr){
    if (!arr || !arr.length) return [];
    const k=2/(period+1); let prev=arr[0]; const out=[prev];
    for(let i=1;i<arr.length;i++){ prev = arr[i]*k + prev*(1-k); out.push(prev); }
    return out;
  }
  function sma(p, arr){ const out=[]; let s=0; for(let i=0;i<arr.length;i++){ s+=arr[i]; if(i>=p) s-=arr[i-p]; if(i>=p-1) out.push(s/p); } return out; }

  function rsi(values, period=14) {
    if (!values || values.length < period+1) return [];
    let gains=0, losses=0;
    for (let i=1;i<=period;i++){
      const d = values[i]-values[i-1];
      if (d>=0) gains+=d; else losses-=d;
    }
    let avgG=gains/period, avgL=losses/period, out=[100 - 100/(1+(avgG/(avgL||1e-9)))];
    for (let i=period+1;i<values.length;i++){
      const d = values[i]-values[i-1];
      const g = Math.max(d,0), l = Math.max(-d,0);
      avgG = (avgG*(period-1)+g)/period;
      avgL = (avgL*(period-1)+l)/period;
      out.push(100 - 100/(1+(avgG/(avgL||1e-9))));
    }
    return out;
  }

  function macd(arr, f=12, s=26, sig=9){
    if (!arr || arr.length < s+sig+5) return { line:[], signal:[], hist:[] };
    const emaf = ema(f,arr), emas = ema(s,arr);
    const line = emaf.map((v,i)=>v-(emas[i]||v));
    const signal = ema(sig, line.slice(s-1));
    const hist = line.slice(s-1).map((v,i)=>v-(signal[i]||0));
    return { line: line.slice(s-1), signal, hist };
  }

  function stoch(high, low, close, period=14, kPeriod=3, dPeriod=3){
    if (close.length < period) return { k:[], d:[] };
    const kArr = [];
    for (let i=period-1;i<close.length;i++){
      const h = Math.max(...high.slice(i-period+1, i+1));
      const l = Math.min(...low.slice(i-period+1, i+1));
      const k = (h===l) ? 50 : ((close[i]-l)/(h-l))*100;
      kArr.push(k);
    }
    const kSm = sma(kPeriod, kArr);
    const dSm = sma(dPeriod, kSm);
    return { k: kSm, d: dSm };
  }

  function williamsR(high, low, close, period=14){
    const out=[];
    for(let i=period-1;i<close.length;i++){
      const h = Math.max(...high.slice(i-period+1, i+1));
      const l = Math.min(...low.slice(i-period+1, i+1));
      const r = (h===l) ? -50 : -100 * (h - close[i]) / (h - l);
      out.push(r);
    }
    return out;
  }

  function atr(high, low, close, period=14){
    const tr = [];
    for(let i=1;i<close.length;i++){
      tr.push(Math.max(
        high[i]-low[i],
        Math.abs(high[i]-close[i-1]),
        Math.abs(low[i]-close[i-1])
      ));
    }
    const a = ema(period, tr);
    return a.at(-1) || 0;
  }

  function linregSlope(arr, len=50){
    const n = Math.min(arr.length, len);
    const xs = Array.from({length:n}, (_,i)=>i+1);
    const ys = arr.slice(-n);
    const sx = xs.reduce((a,b)=>a+b,0);
    const sy = ys.reduce((a,b)=>a+b,0);
    const sxx = xs.reduce((a,b)=>a+b*b,0);
    const sxy = xs.reduce((a,b,i)=>a+b*ys[i],0);
    const denom = (n*sxx - sx*sx) || 1;
    return (n*sxy - sx*sy) / denom; // slope per bar
  }

  function tfRisk(tf){ const m={'5m':0.0015,'15m':0.0025,'1h':0.004,'4h':0.006,'Daily':0.01}; return m[tf]||0.004; }

  // Strategy-aware entry/exit generator using context (levels) when available
  function entryExitFromStrategy(action, price, tf, ctx={}){
    const p = Number(price||0), r = tfRisk(tf);
    if (!p) return { entry:'', stop:'', tp1:'', tp2:'' };

    // ORB uses range-based R
    if (ctx.type === 'ORB' && ctx.orHigh && ctx.orLow) {
      const range = Math.max(0.00001, ctx.orHigh - ctx.orLow);
      const buf = range * 0.05;
      if (action==='BUY') {
        const entry = (ctx.orHigh + buf).toFixed(4);
        const stop  = (ctx.orLow - buf).toFixed(4);
        const tp1   = (Number(entry) + range*1.0).toFixed(4);
        const tp2   = (Number(entry) + range*2.0).toFixed(4);
        return { entry:`Breakout > ${entry}`, stop:`Stop < ${stop}`, tp1:`TP1 ~ ${tp1}`, tp2:`TP2 ~ ${tp2}` };
      } else if (action==='SELL') {
        const entry = (ctx.orLow - buf).toFixed(4);
        const stop  = (ctx.orHigh + buf).toFixed(4);
        const tp1   = (Number(entry) - range*1.0).toFixed(4);
        const tp2   = (Number(entry) - range*2.0).toFixed(4);
        return { entry:`Breakdown < ${entry}`, stop:`Stop > ${stop}`, tp1:`TP1 ~ ${tp1}`, tp2:`TP2 ~ ${tp2}` };
      }
    }

    // Support/Resistance & BOS use swing levels if present
    if ((ctx.type === 'S/R' || ctx.type === 'BOS') && (ctx.level || ctx.support || ctx.resistance)) {
      const level = ctx.level || (action==='BUY' ? ctx.resistance : ctx.support) || p;
      const pad = p * r * 0.5;
      if (action==='BUY') {
        return {
          entry: `Retest above ${ (level + pad).toFixed(4) } or limit near ${ (level - pad*0.5).toFixed(4) }`,
          stop : `Protect < ${ ( (ctx.support ?? level) - pad ).toFixed(4) }`,
          tp1  : `TP1 ~ ${ (p + r*p*1.5).toFixed(4) }`,
          tp2  : `TP2 ~ ${ (p + r*p*3.0).toFixed(4) }`,
        };
      } else if (action==='SELL') {
        return {
          entry: `Retest below ${ (level - pad).toFixed(4) } or limit near ${ (level + pad*0.5).toFixed(4) }`,
          stop : `Protect > ${ ( (ctx.resistance ?? level) + pad ).toFixed(4) }`,
          tp1  : `TP1 ~ ${ (p - r*p*1.5).toFixed(4) }`,
          tp2  : `TP2 ~ ${ (p - r*p*3.0).toFixed(4) }`,
        };
      }
    }

    // EMA Touch / Pullback continuation: use EMAs if present
    if ((ctx.type === 'EMA' || ctx.type === 'PULLBACK') && ctx.ema9 && ctx.ema50) {
      const near = ctx.ema9;
      const pad = p * r;
      if (action==='BUY') {
        return {
          entry: `Touch/pullback near EMA9 ~ ${ near.toFixed(4) }`,
          stop : `Protect < EMA50 ~ ${ (ctx.ema50).toFixed(4) }`,
          tp1  : `TP1 ~ ${ (p + r*p*1.5).toFixed(4) }`,
          tp2  : `TP2 ~ ${ (p + r*p*3.0).toFixed(4) }`,
        };
      } else if (action==='SELL') {
        return {
          entry: `Touch/pullback near EMA9 ~ ${ near.toFixed(4) }`,
          stop : `Protect > EMA50 ~ ${ (ctx.ema50).toFixed(4) }`,
          tp1  : `TP1 ~ ${ (p - r*p*1.5).toFixed(4) }`,
          tp2  : `TP2 ~ ${ (p - r*p*3.0).toFixed(4) }`,
        };
      }
    }

    // Generic fallback (ATR-based)
    const rr = Math.max(0.00001, ctx.atr || (p*r));
    if (action==='BUY'){
      return {
        entry: `Break > ${(p + rr*0.2).toFixed(4)} or pullback near ${(p - rr*0.2).toFixed(4)}`,
        stop : `Protect < ${(p - rr*1.0).toFixed(4)}`,
        tp1  : `TP1 ~ ${(p + rr*1.5).toFixed(4)}`,
        tp2  : `TP2 ~ ${(p + rr*3.0).toFixed(4)}`
      };
    } else if (action==='SELL'){
      return {
        entry: `Break < ${(p - rr*0.2).toFixed(4)} or pullback near ${(p + rr*0.2).toFixed(4)}`,
        stop : `Protect > ${(p + rr*1.0).toFixed(4)}`,
        tp1  : `TP1 ~ ${(p - rr*1.5).toFixed(4)}`,
        tp2  : `TP2 ~ ${(p - rr*3.0).toFixed(4)}`
      };
    }
    return { entry:`WAIT — recheck after ±${(rr).toFixed(4)}`, stop:'', tp1:'', tp2:'' };
  }

  // ---------- symbol mapping for Finnhub ----------
  const classify = (sym) => {
    const s=(sym||'').toUpperCase().replace(/\s+/g,'');
    if (s.includes(':')) return 'explicit';
    if (/^[A-Z]{6,7}$/.test(s) || /[A-Z]+\/[A-Z]+/.test(s) || /(XAU|XAG|WTI|BRENT)/.test(s)) return 'forex';
    if (/USDT$/.test(s) || /(BTC|ETH|SOL|DOGE|ADA)/.test(s)) return 'crypto';
    return 'stock';
  };
  const mapToFinnhub = (sym, type) => {
    const s=sym.toUpperCase().replace(/\s+/g,'');
    if (type==='explicit') return s;
    if (type==='forex') { const m = s.includes('/') ? s.split('/') : [s.slice(0,3), s.slice(-3)]; return `OANDA:${m[0]}_${m[1]}`; }
    if (type==='crypto') return s.includes(':')?s:`BINANCE:${s}`;
    return s;
  };
  const reso = (tf) => {
    const m=String(tf).toLowerCase();
    if (m.includes('5m')) return '5';
    if (m.includes('15m')) return '15';
    if (m.includes('1h')) return '60';
    if (m.includes('4h')) return '240';
    return 'D';
  };

  // ---------- Vision path (if a screenshot is provided) ----------
  if (imageDataURL) {
    try {
      const OPENAI = process.env.OPENAI_API_KEY;
      if (!OPENAI) throw new Error('Missing OPENAI_API_KEY');

      const messages = [
        { role:'system', content:
          'Return ONLY JSON with keys: ' +
          '{"summary":string,"ticker":string?,"timeframe":string?,' +
          '"signals":[{"action":"BUY"|"SELL"|"WAIT","reason":string,"confidence":0..1,"ttlSec":900}],' +
          '"checklist":[string,string,string],"price":number?}. Prefer WAIT if ambiguous.' },
        { role:'user', content: [
          { type:'text', text:`Analyze this chart with strategy="${strategy}". Hints: ${JSON.stringify({ timeframe, strategy, ticker })}` },
          { type:'image_url', image_url: { url: imageDataURL } }
        ]}
      ];

      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method:'POST',
        headers:{ 'Authorization':`Bearer ${OPENAI}`, 'Content-Type':'application/json' },
        body: JSON.stringify({ model:'gpt-4o-mini', temperature:0.2, messages })
      });
      const j = await r.json();
      let raw = j?.choices?.[0]?.message?.content || '';
      raw = raw.trim().replace(/^```json\s*/i,'').replace(/```$/,'');
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch {
        parsed = {
          summary: 'Vision parse failed. Use engine/fallback.',
          checklist: ['Check trend','Check momentum','Manage risk'],
          signals: [{ action:'WAIT', reason:'Vision parse error', confidence:0.5, ttlSec:900 }]
        };
      }

      const sig = (parsed.signals && parsed.signals[0]) || { action:'WAIT', reason:'No signal', confidence:0.5, ttlSec:900 };
      const price = typeof parsed.price === 'number' ? parsed.price : 0;
      const guide = entryExitFromStrategy(sig.action, price, parsed.timeframe || timeframe, { type:'VISION' });

      const out = {
        ok:true,
        mode:'vision',
        summary: parsed.summary || 'Vision result',
        ticker: parsed.ticker || ticker,
        timeframe: parsed.timeframe || timeframe,
        checklist: Array.isArray(parsed.checklist) ? parsed.checklist.slice(0,3) : ['Trend','Momentum','Risk'],
        signals: [sig],
        price,
        entryExit: guide
      };

      if (alexaUrl && sig && sig.action !== 'WAIT') {
        const text = `${out.ticker} ${out.timeframe}: ${sig.action}. ${sig.reason}. Entry ${guide.entry}. Stop ${guide.stop}. Target ${guide.tp1}.`;
        try { await fetch(alexaUrl, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text }) }); } catch {}
      }

      return res.status(200).json(out);

    } catch (e) {
      return res.status(200).json({
        ok:true, mode:'vision-fallback',
        summary:'Vision service unavailable. Use engine fallback.',
        checklist:['Trend check','Momentum check','Conservative risk'],
        signals:[{ action:'WAIT', reason:String(e?.message||'Vision error'), confidence:0.5, ttlSec:900 }]
      });
    }
  }

  // ---------- Finnhub data path ----------
  const FINN = process.env.FINNHUB_API_KEY;
  async function getCandles(sym, tf) {
    if (!FINN) return { ok:false, error:'Missing FINNHUB_API_KEY' };
    const type = classify(sym);
    const symbol = mapToFinnhub(sym, type);
    const resolution = reso(tf);
    const now = nowSec();
    const lookback = (resolution==='D')? 3600*24*400 : (resolution==='240'?3600*24*120 : 3600*24*14);
    const from = now - lookback;
    const base = 'https://finnhub.io/api/v1';
    let path = '/stock/candle';
    if (type==='forex' || symbol.startsWith('OANDA:')) path='/forex/candle';
    if (type==='crypto' || symbol.startsWith('BINANCE:')) path='/crypto/candle';
    const url = `${base}${path}?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${now}&token=${FINN}`;
    const r = await fetch(url);
    if (!r.ok) return { ok:false, error:`Finnhub ${r.status}` };
    const j = await r.json();
    if (j.s!=='ok' || !Array.isArray(j.c) || j.c.length<80) return { ok:false, error:'No candles', meta:{symbol,resolution}};
    return { ok:true, symbol, resolution, t:j.t, o:j.o, h:j.h, l:j.l, c:j.c };
  }

  // swing points for S/R & BOS
  function lastSwingHighIdx(h){
    for (let i=h.length-3;i>=2;i--){
      if (h[i] >= h[i-1] && h[i] >= h[i-2] && h[i] >= h[i+1] && h[i] >= h[i+2]) return i;
    }
    return null;
  }
  function lastSwingLowIdx(l){
    for (let i=l.length-3;i>=2;i--){
      if (l[i] <= l[i-1] && l[i] <= l[i-2] && l[i] <= l[i+1] && l[i] <= l[i+2]) return i;
    }
    return null;
  }

  function strategyEngine(ohlc, tf, strategyName){
    const { t, o, h, l, c } = ohlc;
    const closes = c;
    const last = c.at(-1);
    const e9 = ema(9, closes), e20 = ema(20, closes), e50 = ema(50, closes);
    const rsiV = rsi(closes); const r = rsiV.at(-1) ?? 50;
    const { line: mac, signal: macSig } = macd(closes);
    const macUp = (mac.at(-1) ?? 0) > (macSig.at(-1) ?? 0);
    const slope5 = last - closes.at(-6);
    const trendUp = (e9.at(-1) > e50.at(-1)) && slope5 > 0;
    const trendDown = (e9.at(-1) < e50.at(-1)) && slope5 < 0;
    const atr14 = atr(h, l, c, 14);
    const lrSlope = linregSlope(closes, 50);

    const name = String(strategyName || '').toLowerCase();

    // 1) Trendline (approx via regression + bounce)
    if (name.includes('trendline')) {
      const nearReg = Math.abs(lrSlope) > 0 ? Math.abs((last - c.at(-2)) - lrSlope) < atr14*0.2 : false;
      if (lrSlope > 0 && (trendUp || r > 52) && (last > e9.at(-1) || nearReg)) {
        return { action:'BUY', reason:'Trendline up: LR slope>0 & bounce', ctx:{ type:'TREND', atr:atr14 } };
      }
      if (lrSlope < 0 && (trendDown || r < 48) && (last < e9.at(-1) || nearReg)) {
        return { action:'SELL', reason:'Trendline down: LR slope<0 & rejection', ctx:{ type:'TREND', atr:atr14 } };
      }
      return { action:'WAIT', reason:'Trendline unclear', ctx:{ type:'TREND', atr:atr14 } };
    }

    // 2) EMA Touch (9/50)
    if (name.includes('ema touch')) {
      const dist9 = Math.abs((last - e9.at(-1))/last);
      const near = dist9 < 0.0015;
      if (near && trendUp) return { action:'BUY', reason:'EMA9 touch within trend up', ctx:{ type:'EMA', ema9:e9.at(-1), ema50:e50.at(-1), atr:atr14 } };
      if (near && trendDown) return { action:'SELL', reason:'EMA9 touch within trend down', ctx:{ type:'EMA', ema9:e9.at(-1), ema50:e50.at(-1), atr:atr14 } };
      return { action:'WAIT', reason:'Not near EMA9 or trend weak', ctx:{ type:'EMA', ema9:e9.at(-1), ema50:e50.at(-1), atr:atr14 } };
    }

    // 3) ORB (Open Range Breakout) — works best on 5m/15m
    if (name.includes('orb') || name.includes('open range')) {
      const res = (() => { const tfm=tf.toLowerCase(); if (tfm==='5m') return 5; if (tfm==='15m') return 15; return null; })();
      if (!res) return { action:'WAIT', reason:'ORB prefers 5m/15m', ctx:{ type:'ORB' } };

      // compute UTC day open range (first 15m)
      const day = (ts)=> new Date(ts*1000).toISOString().slice(0,10);
      const curDay = day(t.at(-1));
      const idxs = t.map((x,i)=> ({i, d:day(x)})).filter(x=>x.d===curDay).map(x=>x.i);
      if (idxs.length < 4) return { action:'WAIT', reason:'Not enough session bars', ctx:{ type:'ORB' } };

      const firstBars = (res===5) ? idxs.slice(0,3) : idxs.slice(0,1);
      const orHigh = Math.max(...firstBars.map(i=>h[i]));
      const orLow  = Math.min(...firstBars.map(i=>l[i]));
      const brkUp  = last > orHigh * 1.0002;
      const brkDn  = last < orLow  * 0.9998;

      if (brkUp) return { action:'BUY', reason:'ORB breakout above range', ctx:{ type:'ORB', orHigh, orLow } };
      if (brkDn) return { action:'SELL', reason:'ORB breakdown below range', ctx:{ type:'ORB', orHigh, orLow } };
      return { action:'WAIT', reason:'Inside opening range', ctx:{ type:'ORB', orHigh, orLow } };
    }

    // 4) Support/Resistance (swing-based)
    if (name.includes('support') || name.includes('resistance')) {
      const shi = lastSwingHighIdx(h), sli = lastSwingLowIdx(l);
      const resistance = shi!=null ? h[shi] : null;
      const support = sli!=null ? l[sli] : null;
      if (trendUp && support && last > support*1.001) return { action:'BUY', reason:'Uptrend buy-the-dip near support', ctx:{ type:'S/R', support, resistance, atr:atr14 } };
      if (trendDown && resistance && last < resistance*0.999) return { action:'SELL', reason:'Downtrend sell-the-bounce near resistance', ctx:{ type:'S/R', support, resistance, atr:atr14 } };
      if (resistance && last > resistance*1.0015) return { action:'BUY', reason:'Breakout over resistance', ctx:{ type:'S/R', level:resistance, support, resistance, atr:atr14 } };
      if (support && last < support*0.9985) return { action:'SELL', reason:'Breakdown under support', ctx:{ type:'S/R', level:support, support, resistance, atr:atr14 } };
      return { action:'WAIT', reason:'No clear S/R edge', ctx:{ type:'S/R', support, resistance, atr:atr14 } };
    }

    // 5) Stoch + Williams %R
    if (name.includes('stoch') || name.includes('williams')) {
      const st = stoch(h,l,c,14,3,3);
      const wr = williamsR(h,l,c,14);
      const k = st.k.at(-1) ?? 50; const d = st.d.at(-1) ?? 50; const w = wr.at(-1) ?? -50;
      if (trendUp && k<35 && d<35 && w<-80) return { action:'BUY', reason:'Trend up + oversold oscillators', ctx:{ type:'OSC', atr:atr14 } };
      if (trendDown && k>65 && d>65 && w>-20) return { action:'SELL', reason:'Trend down + overbought oscillators', ctx:{ type:'OSC', atr:atr14 } };
      return { action:'WAIT', reason:'Oscillators neutral', ctx:{ type:'OSC', atr:atr14 } };
    }

    // 6) RSI + MACD
    if (name.includes('rsi') || name.includes('macd')) {
      if (trendUp && r>55 && macUp) return { action:'BUY', reason:'RSI>55 & MACD>signal in uptrend', ctx:{ type:'RSIMACD', atr:atr14 } };
      if (trendDown && r<45 && !macUp) return { action:'SELL', reason:'RSI<45 & MACD<signal in downtrend', ctx:{ type:'RSIMACD', atr:atr14 } };
      return { action:'WAIT', reason:'Mixed RSI/MACD', ctx:{ type:'RSIMACD', atr:atr14 } };
    }

    // 7) Break of Structure (BOS)
    if (name.includes('break of structure') || name.includes('bos')) {
      const shi = lastSwingHighIdx(h), sli = lastSwingLowIdx(l);
      const lastHigh = shi!=null ? h[shi] : null;
      const lastLow  = sli!=null ? l[sli] : null;
      if (trendUp && lastHigh && last > lastHigh*1.0008) return { action:'BUY', reason:'BOS: HH break', ctx:{ type:'BOS', level:lastHigh, atr:atr14 } };
      if (trendDown && lastLow && last < lastLow*0.9992) return { action:'SELL', reason:'BOS: LL break', ctx:{ type:'BOS', level:lastLow, atr:atr14 } };
      return { action:'WAIT', reason:'No BOS', ctx:{ type:'BOS', level:lastHigh||lastLow, atr:atr14 } };
    }

    // 8) Pullback Continuation
    if (name.includes('pullback')) {
      const near9 = Math.abs((last - e9.at(-1))/last) < 0.002;
      if (trendUp && near9 && macUp) return { action:'BUY', reason:'Pullback to EMA9 within uptrend', ctx:{ type:'PULLBACK', ema9:e9.at(-1), ema50:e50.at(-1), atr:atr14 } };
      if (trendDown && near9 && !macUp) return { action:'SELL', reason:'Pullback to EMA9 within downtrend', ctx:{ type:'PULLBACK', ema9:e9.at(-1), ema50:e50.at(-1), atr:atr14 } };
      return { action:'WAIT', reason:'No qualified pullback', ctx:{ type:'PULLBACK', ema9:e9.at(-1), ema50:e50.at(-1), atr:atr14 } };
    }

    // 9) Mean Reversion
    if (name.includes('mean reversion')) {
      const over = last > e9.at(-1)*1.004;
      const under = last < e9.at(-1)*0.996;
      if (over) return { action:'SELL', reason:'Above EMA9 — revert', ctx:{ type:'MEAN', atr:atr14 } };
      if (under) return { action:'BUY', reason:'Below EMA9 — revert', ctx:{ type:'MEAN', atr:atr14 } };
      return { action:'WAIT', reason:'Not stretched from EMA9', ctx:{ type:'MEAN', atr:atr14 } };
    }

    // Fallback generic
    const up = trendUp && (r>52) && macUp;
    const down = trendDown && (r<48) && !macUp;
    if (up) return { action:'BUY', reason:'Generic trend up', ctx:{ type:'GEN', atr:atr14 } };
    if (down) return { action:'SELL', reason:'Generic trend down', ctx:{ type:'GEN', atr:atr14 } };
    return { action:'WAIT', reason:'No edge', ctx:{ type:'GEN', atr:atr14 } };
  }

  try {
    const data = await getCandles(ticker, timeframe);
    if (!data.ok) throw new Error(data.error || 'Data error');

    const closes = data.c;
    const sig = strategyEngine(data, timeframe, strategy);
    const price = closes.at(-1);

    // Confidence: base on indicator alignment + recent range/trend
    const e9 = ema(9, closes), e50 = ema(50, closes);
    const trendStrength = Math.abs((e9.at(-1) - e50.at(-1)) / (price||1));
    const conf = clip((sig.action==='WAIT' ? 0.55 : 0.65 + Math.min(0.25, trendStrength*8)), 0.5, 0.92);
    sig.confidence = Number(conf.toFixed(2));

    const guide = entryExitFromStrategy(sig.action, price, timeframe, sig.ctx || {});

    const out = {
      ok:true,
      mode:'live-data',
      ticker, timeframe,
      summary: `${ticker.toUpperCase()} • ${timeframe} • ${strategy} — ${sig.action}.`,
      checklist: [
        `EMA9 ${e9.at(-1) > e50.at(-1) ? 'above' : 'below'} EMA50`,
        `Last ${price >= e9.at(-1) ? 'above' : 'below'} EMA9`,
        `5-bar slope ${price - closes.at(-6) > 0 ? 'up' : (price - closes.at(-6) < 0 ? 'down' : 'flat')}`
      ],
      signals: [{ action: sig.action, reason: sig.reason, confidence: sig.confidence, ttlSec:900 }],
      price,
      entryExit: guide,
      note: { finnhubSymbol: data.symbol, resolution: data.resolution }
    };

    if (alexaUrl && sig.action !== 'WAIT') {
      const text = `${ticker.toUpperCase()} ${timeframe}: ${sig.action}. ${sig.reason}. Entry ${guide.entry}. Stop ${guide.stop}. Target ${guide.tp1}.`;
      try { await fetch(alexaUrl, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text }) }); } catch {}
    }

    return res.status(200).json(out);

  } catch (e) {
    // Optional LLM fallback if OPENAI present
    if (process.env.OPENAI_API_KEY) {
      try {
        const prompt = `Return strict JSON (summary, checklist[3], signals[{action,reason,confidence,ttlSec=900}]). Ticker ${ticker}, timeframe ${timeframe}, strategy ${strategy}. Prefer WAIT if ambiguous.`;
        const r = await fetch('https://api.openai.com/v1/chat/completions',{
          method:'POST',
          headers:{'Authorization':`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},
          body:JSON.stringify({model:'gpt-4o-mini',temperature:0.2,messages:[
            {role:'system',content:'Return JSON only; concise and tradable.'},
            {role:'user',content:prompt}
          ]})
        });
        const j = await r.json();
        let raw = j?.choices?.[0]?.message?.content || '';
        raw = raw.trim().replace(/^```json\s*/i,'').replace(/```$/,'');
        let parsed; try { parsed = JSON.parse(raw); } catch { parsed = null; }
        if (parsed) {
          const sig = (parsed.signals && parsed.signals[0]) || { action:'WAIT', reason:'No signal', confidence:0.55, ttlSec:900 };
          const guide = entryExitFromStrategy(sig.action, 0, timeframe, { type:'LLM' });
          return res.status(200).json({ ok:true, mode:'live-llm', ...parsed, entryExit: guide, ticker, timeframe });
        }
      } catch {}
    }
    // Final safe fallback
    return res.status(200).json({
      ok:true, mode:'fallback',
      ticker, timeframe,
      summary:`Fallback analysis for ${ticker} (${timeframe}) — ${strategy}.`,
      checklist:['Trend check unavailable','Data fetch failed','Use conservative risk'],
      signals:[{action:'WAIT', reason:String(e?.message||'Error'), confidence:.55, ttlSec:900}]
    });
  }
}
