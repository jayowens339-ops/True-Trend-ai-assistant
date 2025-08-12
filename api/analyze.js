// api/analyze.js
// TrueTrend AI — strict strategy engine (9 strategies) + optional Vision.
// Env: OWNER_TOKEN, ENFORCE_LICENSE=1, FINNHUB_API_KEY, OPENAI_API_KEY (optional), LICENSE_ALLOWLIST
// Works on Vercel Pages API (Node), or any Node serverless that passes (req,res).

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Use POST' });
  }

  // ---- license gate ----
  try {
    const ENF = (process.env.ENFORCE_LICENSE || '1') === '1';
    if (ENF) {
      const auth = String(req.headers.authorization || '');
      const token = (auth.startsWith('Bearer ') ? auth.slice(7) : '').trim();
      const owner = (process.env.OWNER_TOKEN || '').trim();
      const allow = (process.env.LICENSE_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean);
      const ok = (owner && token === owner) || (token && allow.includes(token));
      if (!ok) return res.status(401).json({ ok:false, error:'license_required' });
    }
  } catch (e) { return res.status(500).json({ ok:false, error:'license_check_failed' }); }

  // ---- payload ----
  const {
    ticker = '',            // optional — if omitted, Vision can handle chart-only
    timeframe = 'Daily',
    strategy = 'Trendline',
    imageDataURL = ''       // optional — when present we run Vision
  } = (req.body || {});

  // ---- utils ----
  const clamp = (x,a,b)=> Math.max(a, Math.min(b, x));
  const pct = (a,b)=> (b===0?0:(a-b)/b);
  const nowSec = ()=> Math.floor(Date.now()/1000);
  const tfReso = (tf)=>{
    const m = String(tf).toLowerCase();
    if (m.includes('5m')) return { finnhub:'5',  ms:5*60*1000 };
    if (m.includes('15m'))return { finnhub:'15', ms:15*60*1000 };
    if (m.includes('1h')) return { finnhub:'60', ms:60*60*1000 };
    if (m.includes('4h')) return { finnhub:'240',ms:4*60*60*1000 };
    return { finnhub:'D', ms:24*60*60*1000 };
  };

  // indicators
  const SMA = (p,arr)=>{ const out=[]; let sum=0; for(let i=0;i<arr.length;i++){ sum+=arr[i]; if(i>=p) sum-=arr[i-p]; out.push(i>=p-1?sum/p:arr[i]); } return out; };
  const EMA = (p,arr)=>{ const k=2/(p+1); let prev=arr[0]; const out=[prev]; for(let i=1;i<arr.length;i++){ prev=arr[i]*k + prev*(1-k); out.push(prev);} return out; };
  const RSI = (p,arr)=>{
    let gains=0,losses=0;
    for(let i=1;i<=p;i++){ const d=arr[i]-arr[i-1]; if(d>=0) gains+=d; else losses-=d; }
    let rs=gains/(losses||1e-9); const out=[...Array(p).fill(50), 100-100/(1+rs)];
    for(let i=p+1;i<arr.length;i++){
      const d=arr[i]-arr[i-1];
      const g = d>0 ? d : 0, l = d<0 ? -d : 0;
      gains = (gains*(p-1)+g)/p; losses=(losses*(p-1)+l)/p;
      rs = gains/(losses||1e-9); out.push(100-100/(1+rs));
    }
    return out;
  };
  const MACD = (arr, fast=12, slow=26, sig=9)=>{
    const emaF=EMA(fast,arr), emaS=EMA(slow,arr);
    const macd = emaF.map((v,i)=> v - emaS[i]);
    const signal = EMA(sig, macd);
    const hist = macd.map((v,i)=> v - signal[i]);
    return { macd, signal, hist };
  };
  const Stoch = (h,l,c, kP=14, dP=3)=>{
    const k=[], d=[];
    for(let i=0;i<c.length;i++){
      const a=Math.max(0,i-kP+1), b=i+1;
      const hh = Math.max(...h.slice(a,b));
      const ll = Math.min(...l.slice(a,b));
      const K = (hh===ll) ? 50 : ((c[i]-ll)/(hh-ll))*100;
      k.push(K);
      if(i<kP-1) d.push(50); else {
        const s = k.slice(i-dP+1,i+1).reduce((x,y)=>x+y,0)/dP;
        d.push(s);
      }
    }
    return { k, d };
  };
  const WilliamsR = (h,l,c, p=14)=>{
    const out=[];
    for(let i=0;i<c.length;i++){
      const a=Math.max(0,i-p+1), b=i+1;
      const hh=Math.max(...h.slice(a,b)), ll=Math.min(...l.slice(a,b));
      const w = (hh===ll) ? -50 : ((hh - c[i])/(hh-ll))*100 * -1; // normalize to [-100..0] -> map to [-100..0]
      out.push(w);
    }
    return out;
  };
  const ATR = (h,l,c, p=14)=>{
    const tr=[h[0]-l[0]];
    for(let i=1;i<c.length;i++){
      tr.push(Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1])));
    }
    return EMA(p,tr);
  };
  const slope = (series, n=5)=> series.length>n ? (series.at(-1)-series.at(-1-n))/n : 0;

  // swings for SR + BOS
  function swingHigh(h, l, i, w=2){ for(let k=1;k<=w;k++){ if(h[i] <= h[i-k] || h[i] <= h[i+k]) return false; } return true; }
  function swingLow (h, l, i, w=2){ for(let k=1;k<=w;k++){ if(l[i] >= l[i-k] || l[i] >= l[i+k]) return false; } return true; }
  function recentLevels(h,l, look=80){
    const highs=[], lows=[];
    const W=2;
    for(let i=W;i<Math.min(h.length- W, look);i++){
      const idx=h.length-1 - i;
      if (idx<=W || idx>=h.length-W) continue;
      if (swingHigh(h,l,idx,W)) highs.push({px:h[idx], idx});
      if (swingLow (h,l,idx,W)) lows .push({px:l[idx], idx});
    }
    // deduplicate (cluster ~0.2% of price)
    function cluster(levels){
      const out=[];
      levels.sort((a,b)=>a.px-b.px);
      const tol = (levels.length? levels[levels.length-1].px : 1) * 0.002;
      for (const lv of levels){
        const last = out[out.length-1];
        if (!last || Math.abs(last.px - lv.px) > tol) out.push(lv);
        else last.px = (last.px + lv.px)/2;
      }
      return out.slice(0,8);
    }
    return { highs: cluster(highs), lows: cluster(lows) };
  }

  // ---- FINNHUB fetch (if ticker given) ----
  async function fetchCandles(sym, tf) {
    const token = process.env.FINNHUB_API_KEY;
    if (!token) return { ok:false, error:'no_finnhub_key' };
    const { finnhub } = tfReso(tf);
    const now = nowSec();
    const lookback = (finnhub==='D')? 3600*24*500 : (finnhub==='240'?3600*24*90 : 3600*24*10);
    const from = now - lookback;
    // classify symbol
    const s = (sym||'').toUpperCase().trim();
    let path = '/stock/candle', symbol = s;
    if (/[:]/.test(s)) symbol = s;
    else if (/^[A-Z]{6,7}$/.test(s) || /[A-Z]+\/[A-Z]+/.test(s) || /(XAU|XAG|WTI|BRENT)/.test(s)) { // forex-ish
      const base=s.slice(0,3), quote=s.slice(-3);
      symbol = `OANDA:${base}_${quote}`; path='/forex/candle';
    } else if (/USDT$/.test(s) || /(BTC|ETH|SOL|DOGE|ADA)/.test(s)) {
      symbol = s.includes(':')? s : `BINANCE:${s}`; path='/crypto/candle';
    }
    const url = `https://finnhub.io/api/v1${path}?symbol=${encodeURIComponent(symbol)}&resolution=${finnhub}&from=${from}&to=${now}&token=${token}`;
    const r = await fetch(url);
    if (!r.ok) return { ok:false, error:`finnhub_${r.status}` };
    const j = await r.json();
    if (j.s!=='ok' || !Array.isArray(j.c) || j.c.length < 100) return { ok:false, error:'no_candles' };
    return { ok:true, t:j.t, o:j.o, h:j.h, l:j.l, c:j.c, v:j.v||[], symbol, resolution:finnhub };
  }

  // ---- Strategy implementations (strict) ----
  function engineStrict({o,h,l,c,v}, tf, strat) {
    const n = c.length;
    const e9 = EMA(9,c), e20=EMA(20,c), e50=EMA(50,c), e200=EMA(200,c);
    const rsi = RSI(14,c);
    const macd = MACD(c);
    const stoch = Stoch(h,l,c,14,3);
    const wr = WilliamsR(h,l,c,14);
    const atr = ATR(h,l,c,14);
    const last = n-1;

    const trendUp = e50[last] > e200[last] && slope(c,10) > 0;
    const trendDn = e50[last] < e200[last] && slope(c,10) < 0;

    // helpers
    const lastSwing = (type='low')=>{
      for (let i=n-3;i>=3;i--){
        if (type==='low' && swingLow(h,l,i,2)) return {px:l[i], idx:i};
        if (type==='high'&& swingHigh(h,l,i,2))return {px:h[i], idx:i};
      }
      return {px:c[last], idx:last-1};
    };
    const levels = recentLevels(h,l,120);

    // 1) Trendline (approx: channel via HH/HL or LL/LH + slope filter)
    function trendline(){
      if (trendUp && c[last] > e20[last] && c[last] > e50[last]) {
        const pullback = c[last-1] < e9[last-1] && c[last] > e9[last];
        if (pullback) {
          const sw = lastSwing('low'); const st = sw.px - 0.5*atr[last];
          const tp = c[last] + Math.max(1.5*atr[last], Math.abs(c[last]-st)*1.5);
          return {action:'BUY', why:'Uptrend (EMA50>EMA200), pullback reclaimed EMA9', entry:c[last].toFixed(5), stop:st.toFixed(5), tp:tp.toFixed(5)};
        }
      }
      if (trendDn && c[last] < e20[last] && c[last] < e50[last]) {
        const pullup = c[last-1] > e9[last-1] && c[last] < e9[last];
        if (pullup) {
          const sw = lastSwing('high'); const st = sw.px + 0.5*atr[last];
          const tp = c[last] - Math.max(1.5*atr[last], Math.abs(st-c[last])*1.5);
          return {action:'SELL', why:'Downtrend (EMA50<EMA200), pullback rejected at EMA9', entry:c[last].toFixed(5), stop:st.toFixed(5), tp:tp.toFixed(5)};
        }
      }
      return {action:'WAIT', why:'No clean trend pullback with reclaim/reject at EMA9'};
    }

    // 2) EMA Touch (trend filter + touch/close reclaim)
    function emaTouch(){
      if (trendUp && Math.abs(pct(c[last], e20[last])) < 0.003 && c[last] > e9[last]) {
        const st = Math.min(e20[last], lastSwing('low').px) - 0.5*atr[last];
        const tp = c[last] + Math.max(1.5*atr[last], Math.abs(c[last]-st)*1.5);
        return {action:'BUY', why:'Touch to EMA20 in uptrend + close above EMA9', entry:c[last].toFixed(5), stop:st.toFixed(5), tp:tp.toFixed(5)};
      }
      if (trendDn && Math.abs(pct(c[last], e20[last])) < 0.003 && c[last] < e9[last]) {
        const st = Math.max(e20[last], lastSwing('high').px) + 0.5*atr[last];
        const tp = c[last] - Math.max(1.5*atr[last], Math.abs(st-c[last])*1.5);
        return {action:'SELL', why:'Touch to EMA20 in downtrend + close below EMA9', entry:c[last].toFixed(5), stop:st.toFixed(5), tp:tp.toFixed(5)};
      }
      return {action:'WAIT', why:'No clean EMA20 touch with reclaim/reject'};
    }

    // 3) ORB (Open Range Breakout) — only for <=15m
    function orb(){
      const m = String(tf).toLowerCase();
      if (!(m.includes('5m') || m.includes('15m'))) return {action:'WAIT', why:'ORB only active on 5m/15m'};
      // Use first 3 bars of current (UTC) day as opening range
      const ts = new Date(); const dayStart = Date.UTC(ts.getUTCFullYear(), ts.getUTCMonth(), ts.getUTCDate(), 0,0,0,0);
      let idx0 = 0; while (idx0 < n && ( (new Date(o[idx0].ts||0)).getTime() || 0) < dayStart ) idx0++;
      // Finnhub arrays don't carry ts per bar here; approximate with last N bars:
      const bars = (m.includes('5m')? 3 : 1); // 15m: first 1 bar, 5m: first 3 bars
      const start = Math.max(0, n - 100); // fallback window
      const orh = Math.max(...h.slice(start, start+bars));
      const orl = Math.min(...l.slice(start, start+bars));
      const brokeUp   = c[last] > orh && c[last-1] <= orh;
      const brokeDown = c[last] < orl && c[last-1] >= orl;
      const volOK = v && v.length ? v[last] > (SMA(20, v).at(-1) || 0) : true;
      if (brokeUp && volOK) {
        const st = orl; const tp = c[last] + Math.max(1.5*atr[last], (c[last]-orl)*1.2);
        return {action:'BUY', why:`ORB up: break above opening range high${v.length? ' with volume':''}`, entry:c[last].toFixed(5), stop:st.toFixed(5), tp:tp.toFixed(5)};
      }
      if (brokeDown && volOK) {
        const st = orh; const tp = c[last] - Math.max(1.5*atr[last], (orh-c[last])*1.2);
        return {action:'SELL', why:`ORB down: break below opening range low${v.length? ' with volume':''}`, entry:c[last].toFixed(5), stop:st.toFixed(5), tp:tp.toFixed(5)};
      }
      return {action:'WAIT', why:'No valid opening-range breakout'};
    }

    // 4) Support/Resistance (bounce or break-retest)
    function sr(){
      const near = (px)=> Math.abs(pct(c[last], px)) < 0.0035;
      for (const R of levels.highs){
        if (near(R.px) && trendDn && c[last] < e9[last]) {
          const st = R.px + 0.5*atr[last], tp=c[last]-Math.max(1.5*atr[last], Math.abs(st-c[last])*1.2);
          return {action:'SELL', why:'Rejection at resistance with downtrend filter', entry:c[last].toFixed(5), stop:st.toFixed(5), tp:tp.toFixed(5)};
        }
      }
      for (const S of levels.lows){
        if (near(S.px) && trendUp && c[last] > e9[last]) {
          const st = S.px - 0.5*atr[last], tp=c[last]+Math.max(1.5*atr[last], Math.abs(c[last]-st)*1.2);
          return {action:'BUY', why:'Bounce at support with uptrend filter', entry:c[last].toFixed(5), stop:st.toFixed(5), tp:tp.toFixed(5)};
        }
      }
      return {action:'WAIT', why:'No actionable SR bounce/reject near level'};
    }

    // 5) Stoch + Williams %R (with trend filter)
    function stochWr(){
      const up = trendUp && stoch.k[last] > stoch.d[last] && stoch.k[last] < 60 && wr[last] > -50;
      const dn = trendDn && stoch.k[last] < stoch.d[last] && stoch.k[last] > 40 && wr[last] < -50;
      if (up) {
        const st = lastSwing('low').px - 0.5*atr[last], tp=c[last]+Math.max(1.5*atr[last], Math.abs(c[last]-st)*1.2);
        return {action:'BUY', why:'Stoch K>D + W%R improving within uptrend', entry:c[last].toFixed(5), stop:st.toFixed(5), tp:tp.toFixed(5)};
      }
      if (dn) {
        const st = lastSwing('high').px + 0.5*atr[last], tp=c[last]-Math.max(1.5*atr[last], Math.abs(st-c[last])*1.2);
        return {action:'SELL', why:'Stoch K<D + W%R weakening within downtrend', entry:c[last].toFixed(5), stop:st.toFixed(5), tp:tp.toFixed(5)};
      }
      return {action:'WAIT', why:'Oscillators not aligned with trend'};
    }

    // 6) RSI + MACD align
    function rsiMacd(){
      const up = rsi[last] > 50 && macd.macd[last] > macd.signal[last] && macd.macd[last] > 0;
      const dn = rsi[last] < 50 && macd.macd[last] < macd.signal[last] && macd.macd[last] < 0;
      if (up) {
        const st = lastSwing('low').px - 0.5*atr[last], tp=c[last]+Math.max(1.5*atr[last], Math.abs(c[last]-st)*1.2);
        return {action:'BUY', why:'RSI>50 and MACD>signal (>0)', entry:c[last].toFixed(5), stop:st.toFixed(5), tp:tp.toFixed(5)};
      }
      if (dn) {
        const st = lastSwing('high').px + 0.5*atr[last], tp=c[last]-Math.max(1.5*atr[last], Math.abs(st-c[last])*1.2);
        return {action:'SELL', why:'RSI<50 and MACD<signal (<0)', entry:c[last].toFixed(5), stop:st.toFixed(5), tp:tp.toFixed(5)};
      }
      return {action:'WAIT', why:'RSI/MACD not aligned'};
    }

    // 7) Break of Structure (BOS): last close breaks last swing high/low with trend
    function bos(){
      const sh = lastSwing('high'), sl = lastSwing('low');
      const brokeUp   = trendUp && c[last] > sh.px && c[last-1] <= sh.px;
      const brokeDown = trendDn && c[last] < sl.px && c[last-1] >= sl.px;
      if (brokeUp) {
        const st = sl.px - 0.5*atr[last], tp = c[last] + Math.max(1.5*atr[last], Math.abs(c[last]-st)*1.2);
        return {action:'BUY', why:'BOS: close above prior swing high within uptrend', entry:c[last].toFixed(5), stop:st.toFixed(5), tp:tp.toFixed(5)};
      }
      if (brokeDown) {
        const st = sh.px + 0.5*atr[last], tp = c[last] - Math.max(1.5*atr[last], Math.abs(st-c[last])*1.2);
        return {action:'SELL', why:'BOS: close below prior swing low within downtrend', entry:c[last].toFixed(5), stop:st.toFixed(5), tp:tp.toFixed(5)};
      }
      return {action:'WAIT', why:'No structure break at last bar'};
    }

    // 8) Pullback Continuation: trend + pullback to EMA20 then reclaim/reject
    function pullback(){
      if (trendUp && c[last-1] < e20[last-1] && c[last] > e20[last]) {
        const st = lastSwing('low').px - 0.5*atr[last], tp=c[last]+Math.max(1.5*atr[last], Math.abs(c[last]-st)*1.2);
        return {action:'BUY', why:'Uptrend pullback to EMA20 then reclaim', entry:c[last].toFixed(5), stop:st.toFixed(5), tp:tp.toFixed(5)};
      }
      if (trendDn && c[last-1] > e20[last-1] && c[last] < e20[last]) {
        const st = lastSwing('high').px + 0.5*atr[last], tp=c[last]-Math.max(1.5*atr[last], Math.abs(st-c[last])*1.2);
        return {action:'SELL', why:'Downtrend pullback to EMA20 then reject', entry:c[last].toFixed(5), stop:st.toFixed(5), tp:tp.toFixed(5)};
      }
      return {action:'WAIT', why:'No pullback reclaim/reject at EMA20'};
    }

    // 9) Mean Reversion: far from EMA20 + flat trend (no strong EMA50/200)
    function meanRev(){
      const dist = Math.abs(pct(c[last], e20[last]));
      const flat = Math.abs(pct(e50[last], e200[last])) < 0.001 && Math.abs(slope(c,20)) < (c[last]*0.0008);
      if (flat && dist > 0.01) {
        if (c[last] > e20[last]) {
          const st = h[last] + 0.25*atr[last]; // conservative stop above extreme
          const tp = e20[last];
          return {action:'SELL', why:'Flat regime + price stretched above EMA20 (revert lower)', entry:c[last].toFixed(5), stop:st.toFixed(5), tp:tp.toFixed(5)};
        } else {
          const st = l[last] - 0.25*atr[last];
          const tp = e20[last];
          return {action:'BUY', why:'Flat regime + price stretched below EMA20 (revert higher)', entry:c[last].toFixed(5), stop:st.toFixed(5), tp:tp.toFixed(5)};
        }
      }
      return {action:'WAIT', why:'Not stretched in flat regime'};
    }

    const map = {
      'trendline': trendline,
      'ema touch': emaTouch,
      'orb': orb,
      'support/resistance': sr,
      'stoch + williams %r': stochWr,
      'rsi + macd': rsiMacd,
      'break of structure': bos,
      'pullback continuation': pullback,
      'mean reversion': meanRev
    };
    const key = String(strat).toLowerCase();
    const fn = map[key] || trendline;
    const r = fn();

    // confidence heuristic (only if not WAIT)
    let conf = 0.55;
    if (r.action==='BUY' || r.action==='SELL') {
      const trendBoost = (trendUp || trendDn) ? 0.12 : 0;
      const distBoost  = clamp(Math.abs(pct(e20[last], e50[last]))*3, 0, 0.18);
      conf = clamp(0.58 + trendBoost + distBoost, 0.6, 0.9);
    }

    const summary = `${(ticker||'VISION').toUpperCase()} • ${timeframe} • ${strategy} — ${r.action}`;
    return {
      action: r.action,
      why: r.why,
      entryExit: { entry:r.entry||'', exit:r.exit||'', stop:r.stop||'', tp:r.tp||'' },
      confidence: conf,
      summary
    };
  }

  // ---- Vision (optional, strict JSON) ----
  async function visionRead(imgB64, tf, strat) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return { ok:false, error:'no_openai_key' };
    const prompt = `
You are TrueTrend Strategy Checker. Analyze the chart image strictly for the selected strategy: "${strat}" on timeframe "${tf}".
Return STRONG signals only when criteria TRULY match. Otherwise return action=WAIT and explain why.
Output strict JSON with:
{ "action":"BUY|SELL|WAIT", "reason":"why decision", "entry":"", "exit":"", "stop":"", "tp":"" }.
Rules:
- ORB: confirm price closing outside the opening range; otherwise WAIT.
- Support/Resistance: confirm touch/rejection or break-retest at a visible level; otherwise WAIT.
- RSI+MACD: both aligned (RSI>50 & MACD>0 for buy, <50 & <0 for sell); otherwise WAIT.
- Stoch+W%R: Stoch cross in trend direction and W%R confirms momentum; otherwise WAIT.
- Break of Structure: last close breaks last swing high/low with follow-through; otherwise WAIT.
- Pullback Continuation: clear trend and reclaim/reject at EMA zone; otherwise WAIT.
- Trendline: valid channel/line touch + reaction in trend; otherwise WAIT.
- Mean Reversion: extended distance from mean with revert signal; otherwise WAIT.
If levels are unclear, choose WAIT and state the missing confirmation.
    `.trim();

    const body = {
      model: "gpt-4o-mini",
      temperature: 0.1,
      messages: [
        { role: "system", content: "Return only valid JSON. Be conservative. No advice—just pattern detection." },
        { role: "user", content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imgB64 } }
        ]}
      ]
    };

    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method:'POST',
        headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/json'},
        body: JSON.stringify(body)
      });
      const j = await r.json();
      const raw = j?.choices?.[0]?.message?.content || '';
      let parsed=null; try { parsed = JSON.parse(raw); } catch { /* ignore */ }
      if (!parsed) return { ok:true, visionOnly:true, action:'WAIT', reason:'Vision could not extract a strict signal', entry:'', exit:'', stop:'', tp:'' };
      return { ok:true, visionOnly:true, ...parsed };
    } catch(e){ return { ok:false, error:String(e) }; }
  }

  // ---- Run pipeline ----
  try {
    let market = null;
    if (ticker) {
      const candles = await fetchCandles(ticker, timeframe);
      if (candles.ok) market = candles;
    }

    // If they sent a screenshot, use Vision first (conservative), then confirm with data (if available).
    let vision = null;
    if (imageDataURL) {
      vision = await visionRead(imageDataURL, timeframe, strategy);
    }

    // If we have market data, apply strict engine:
    let strict = null;
    if (market?.ok) {
      strict = engineStrict(market, timeframe, strategy);
    }

    // Decision merge:
    // - If both present: require agreement or fallback to WAIT with explanation.
    // - If only strict present: use it.
    // - If only vision present: use it (may be WAIT).
    let final = null;
    if (vision && strict) {
      if (vision.action === 'WAIT' && (strict.action==='BUY'||strict.action==='SELL')) {
        final = strict; final.summary += ' (data-confirmed)'; final.mode='live-data';
      } else if (strict.action==='WAIT' && (vision.action==='BUY'||vision.action==='SELL')) {
        // data veto: be safe
        final = { ...strict, action:'WAIT', summary: strict.summary.replace(/ — .+$/, ' — WAIT'), mode:'data-veto', why: 'Data check did not confirm the chart signal' };
      } else if (vision.action === strict.action) {
        final = { ...strict, mode:'vision+data', why: strict.why + ' | Vision: ' + (vision.reason||'') };
      } else {
        final = { ...strict, action:'WAIT', mode:'disagree', summary: strict.summary.replace(/ — .+$/, ' — WAIT'), why:'Vision and data disagree' };
      }
    } else if (strict) {
      final = { ...strict, mode:'live-data' };
    } else if (vision) {
      final = {
        ok:true,
        mode: 'vision-only',
        summary: `${(ticker||'VISION').toUpperCase()} • ${timeframe} • ${strategy} — ${vision.action}`,
        signals: [{ action: vision.action, reason: vision.reason||'', confidence: (vision.action==='WAIT'?0.0:0.6), ttlSec: 900 }],
        entryExit: { entry:vision.entry||'', exit:vision.exit||'', stop:vision.stop||'', tp:vision.tp||'' }
      };
      return res.status(200).json(final);
    } else {
      // nothing to analyze
      return res.status(200).json({
        ok:true, mode:'fallback',
        summary:`${(ticker||'VISION').toUpperCase()} • ${timeframe} • ${strategy} — WAIT`,
        signals:[{action:'WAIT',reason:'No market data or image provided',confidence:0.0,ttlSec:900}],
        entryExit:{entry:'',exit:'',stop:'',tp:''}
      });
    }

    // format final response
    const result = {
      ok:true,
      mode: final.mode || 'live-data',
      summary: final.summary,
      checklist: [
        `Engine: ${final.mode || 'live-data'}`,
        `Why: ${final.why || ''}`.trim(),
        `TF: ${timeframe} | Strat: ${strategy}`
      ],
      signals: [{ action: final.action, reason: final.why || '', confidence: final.confidence || 0.6, ttlSec: 900 }],
      entryExit: final.entryExit || { entry:'', exit:'', stop:'', tp:'' },
      price: market?.c?.at?.(-1) || null,
      note: market ? { symbol: market.symbol, resolution: market.resolution } : { symbol: ticker||'vision-only' }
    };
    return res.status(200).json(result);

  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
}
