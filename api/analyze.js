// TrueTrend AI — Strict 9-strategy Engine (consensus-gated, symmetric BUY/SELL) + Vision merge
// Drop-in for /api/analyze on Vercel/Pages (Node). If you use Express, tell me and I’ll give that variant.

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

  // License gate
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

  // Payload
  const { ticker = '', timeframe = 'Daily', strategy = 'Trendline', imageDataURL = '' } = (req.body || {});

  // ---------- utils & indicators ----------
  const clamp = (x,a,b)=> Math.max(a, Math.min(b, x));
  const pct = (a,b)=> (b===0?0:(a-b)/b);
  const nowSec = ()=> Math.floor(Date.now()/1000);
  const toDayUTC = (t)=> { const d=new Date(t*1000); return Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),0,0,0)/1000; };
  const tfReso = (tf)=>{
    const m = String(tf).toLowerCase();
    if (m.includes('5m')) return { finnhub:'5',  ms:5*60*1000,  barsOpen:3 };
    if (m.includes('15m'))return { finnhub:'15', ms:15*60*1000, barsOpen:1 };
    if (m.includes('1h')) return { finnhub:'60', ms:60*60*1000, barsOpen:1 };
    if (m.includes('4h')) return { finnhub:'240',ms:4*60*60*1000,barsOpen:1 };
    return { finnhub:'D', ms:24*60*60*1000, barsOpen:1 };
  };

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
      const w = (hh===ll) ? -50 : -100 * (hh - c[i]) / (hh - ll); // [-100..0]
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
  function swingHigh(h, l, i, w=2){ for(let k=1;k<=w;k++){ if(h[i] <= h[i-k] || h[i] <= h[i+k]) return false; } return true; }
  function swingLow (h, l, i, w=2){ for(let k=1;k<=w;k++){ if(l[i] >= l[i-k] || l[i] >= l[i+k]) return false; } return true; }
  function lastSwing(h,l,type='low'){ for(let i=h.length-3;i>=3;i--){ if(type==='low' && swingLow(h,l,i,2)) return {px:l[i], idx:i}; if(type==='high' && swingHigh(h,l,i,2)) return {px:h[i], idx:i}; } return null; }
  function recentLevels(h,l, look=120){
    const highs=[], lows=[]; const W=2;
    for(let i=W;i<h.length-W;i++){
      if (swingHigh(h,l,i,W)) highs.push({px:h[i],idx:i});
      if (swingLow (h,l,i,W)) lows .push({px:l[i],idx:i});
    }
    const cluster = (arr)=>{
      arr.sort((a,b)=>a.px-b.px); const out=[];
      const tol = (arr.length? arr[arr.length-1].px : 1) * 0.002;
      for (const lv of arr){
        const last = out[out.length-1];
        if (!last || Math.abs(last.px - lv.px) > tol) out.push(lv);
        else last.px = (last.px + lv.px)/2;
      }
      return out.slice(-8); // recent clusters
    };
    return { highs: cluster(highs), lows: cluster(lows) };
  }

  // ---------- data fetch ----------
  async function fetchCandles(sym, tf) {
    const token = process.env.FINNHUB_API_KEY;
    if (!token || !sym) return { ok:false, error:'no_data' };
    const { finnhub } = tfReso(tf);
    const now = nowSec();
    const lookback = (finnhub==='D')? 3600*24*500 : (finnhub==='240'?3600*24*120 : 3600*24*10);
    const from = now - lookback;

    // map symbol
    const s = (sym||'').toUpperCase().trim();
    let path = '/stock/candle', symbol = s;
    if (/[:]/.test(s)) symbol = s;
    else if (/^[A-Z]{6,7}$/.test(s) || /[A-Z]+\/[A-Z]+/.test(s) || /(XAU|XAG|WTI|BRENT)/.test(s)) { // forex style
      const base=s.slice(0,3), quote=s.slice(-3);
      symbol = `OANDA:${base}_${quote}`; path='/forex/candle';
    } else if (/USDT$/.test(s) || /(BTC|ETH|SOL|DOGE|ADA)/.test(s)) {
      symbol = s.includes(':')? s : `BINANCE:${s}`; path='/crypto/candle';
    }

    const url = `https://finnhub.io/api/v1${path}?symbol=${encodeURIComponent(symbol)}&resolution=${finnhub}&from=${from}&to=${now}&token=${token}`;
    const r = await fetch(url);
    if (!r.ok) return { ok:false, error:`finnhub_${r.status}` };
    const j = await r.json();
    if (j.s!=='ok' || !Array.isArray(j.c) || j.c.length < 120) return { ok:false, error:'no_candles' };
    return { ok:true, t:j.t, o:j.o, h:j.h, l:j.l, c:j.c, v:j.v||[], symbol, resolution:finnhub };
  }

  // ---------- strategy engine (strict + symmetric) ----------
  function strictEngine(M, tf, strat, sym='') {
    const { t,o,h,l,c,v } = M; const n=c.length, last=n-1;
    const e9=EMA(9,c), e20=EMA(20,c), e50=EMA(50,c), e200=EMA(200,c);
    const rsi=RSI(14,c), macd=MACD(c), atr=ATR(h,l,c,14);
    const stoch=Stoch(h,l,c,14,3), wr=WilliamsR(h,l,c,14);
    const trendUp = e50[last] > e200[last] && slope(c,10) > 0;
    const trendDn = e50[last] < e200[last] && slope(c,10) < 0;
    const levels = recentLevels(h,l,120);

    // helper: risk checks / consensus
    function rrOK(entry, stop, tp){
      const risk = Math.abs(entry - stop); const reward = Math.abs(tp - entry);
      return risk > 0 && (reward / risk) >= 1.2;
    }
    function momentumAlign(action){
      if (action==='BUY'){
        const macd3 = macd.hist.slice(-3).reduce((x,y)=>x+y,0)/3;
        return (rsi[last] > 55) && (macd.macd[last] > macd.signal[last]) && macd3 > 0;
      }
      if (action==='SELL'){
        const macd3 = macd.hist.slice(-3).reduce((x,y)=>x+y,0)/3;
        return (rsi[last] < 45) && (macd.macd[last] < macd.signal[last]) && macd3 < 0;
      }
      return false;
    }

    function pack(action, why, entry, stop, tp, patternOK, volOK=true){
      const momOK = momentumAlign(action);
      const riskOK = (entry && stop && tp) ? rrOK(+entry,+stop,+tp) : false;
      const pass = (action==='BUY'||action==='SELL') && patternOK && momOK && riskOK && volOK;
      return {
        action: pass ? action : 'WAIT',
        why: pass ? why : (!patternOK ? 'Pattern not confirmed' : !momOK ? 'Momentum disagrees' : !riskOK ? 'Risk/Reward < 1.2' : !volOK ? 'Volume insufficient' : 'Not confirmed'),
        entryExit: { entry: entry||'', stop: stop||'', tp: tp||'', exit:'' }
      };
    }

    // swings
    const swLow  = lastSwing(h,l,'low')  || {px:l[last-1],idx:last-1};
    const swHigh = lastSwing(h,l,'high') || {px:h[last-1],idx:last-1};

    // --- Strategies ---
    function trendline(){
      if (trendUp && c[last] > e20[last] && c[last] > e50[last]) {
        const pullback = c[last-1] < e9[last-1] && c[last] > e9[last];
        if (pullback) {
          const stop = Math.min(swLow.px, e20[last]) - 0.5*atr[last];
          const tp   = c[last] + Math.max(1.5*atr[last], Math.abs(c[last]-stop)*1.3);
          return pack('BUY','Uptrend + EMA9 reclaim after pullback', c[last].toFixed(5), stop.toFixed(5), tp.toFixed(5), true);
        }
      }
      if (trendDn && c[last] < e20[last] && c[last] < e50[last]) {
        const pullup = c[last-1] > e9[last-1] && c[last] < e9[last];
        if (pullup) {
          const stop = Math.max(swHigh.px, e20[last]) + 0.5*atr[last];
          const tp   = c[last] - Math.max(1.5*atr[last], Math.abs(stop-c[last])*1.3);
          return pack('SELL','Downtrend + EMA9 reject after pullback', c[last].toFixed(5), stop.toFixed(5), tp.toFixed(5), true);
        }
      }
      return pack('WAIT','No clean trend pullback with reclaim/reject', '', '', '', false);
    }

    function emaTouch(){
      if (trendUp && Math.abs(pct(c[last], e20[last])) < 0.003 && c[last] > e9[last]) {
        const stop = Math.min(swLow.px, e20[last]) - 0.5*atr[last];
        const tp   = c[last] + Math.max(1.5*atr[last], Math.abs(c[last]-stop)*1.3);
        return pack('BUY','Touch to EMA20 in uptrend + close above EMA9', c[last].toFixed(5), stop.toFixed(5), tp.toFixed(5), true);
      }
      if (trendDn && Math.abs(pct(c[last], e20[last])) < 0.003 && c[last] < e9[last]) {
        const stop = Math.max(swHigh.px, e20[last]) + 0.5*atr[last];
        const tp   = c[last] - Math.max(1.5*atr[last], Math.abs(stop-c[last])*1.3);
        return pack('SELL','Touch to EMA20 in downtrend + close below EMA9', c[last].toFixed(5), stop.toFixed(5), tp.toFixed(5), true);
      }
      return pack('WAIT','No clean EMA20 touch with reclaim/reject','', '', '', false);
    }

    function orb(){
      const { finnhub, barsOpen } = tfReso(tf);
      if (!(finnhub==='5' || finnhub==='15')) return pack('WAIT','ORB only active on 5m/15m','', '', '', false);
      // compute opening range from first bars of current UTC day using t[]
      const dayStart = toDayUTC(t[last]);
      const firstIdx = t.findIndex(x => x >= dayStart);
      if (firstIdx < 0 || last-firstIdx < barsOpen+2) return pack('WAIT','Not enough bars for opening range','', '', '', false);
      const orH = Math.max(...h.slice(firstIdx, firstIdx+barsOpen));
      const orL = Math.min(...l.slice(firstIdx, firstIdx+barsOpen));
      const closeUp   = c[last] > orH && c[last-1] > orH;   // confirm held outside
      const closeDown = c[last] < orL && c[last-1] < orL;
      const volOK = v && v.length ? v[last] > (SMA(20,v).at(-1) || 0) : true;

      if (closeUp && volOK) {
        const stop = orL; const tp = c[last] + Math.max(1.5*atr[last], (c[last]-orL)*1.2);
        return pack('BUY',`ORB UP: 2 closes above opening range high${v.length?' with volume':''}`, c[last].toFixed(5), stop.toFixed(5), tp.toFixed(5), true, volOK);
      }
      if (closeDown && volOK) {
        const stop = orH; const tp = c[last] - Math.max(1.5*atr[last], (orH-c[last])*1.2);
        return pack('SELL',`ORB DOWN: 2 closes below opening range low${v.length?' with volume':''}`, c[last].toFixed(5), stop.toFixed(5), tp.toFixed(5), true, volOK);
      }
      return pack('WAIT','No valid opening-range breakout','', '', '', false);
    }

    function sr(){
      const near = (px)=> Math.abs(pct(c[last], px)) < 0.0035;
      const hasRejection = (idx, level, sell=true)=>{
        // long upper wick for SELL or long lower wick for BUY near level
        const body = Math.abs(c[idx]-o[idx]);
        const upW  = h[idx] - Math.max(c[idx], o[idx]);
        const dnW  = Math.min(c[idx], o[idx]) - l[idx];
        if (sell) return (h[idx]-level)>=0 && upW > body*0.6;
        return (level-l[idx])>=0 && dnW > body*0.6;
      };
      for (const R of levels.highs){
        if (near(R.px) && trendDn && c[last] < e9[last] && hasRejection(last, R.px, true)) {
          const stop = R.px + 0.5*atr[last], tp=c[last]-Math.max(1.5*atr[last], Math.abs(stop-c[last])*1.2);
          return pack('SELL','Rejection at resistance (wick) with downtrend filter', c[last].toFixed(5), stop.toFixed(5), tp.toFixed(5), true);
        }
      }
      for (const S of levels.lows){
        if (near(S.px) && trendUp && c[last] > e9[last] && hasRejection(last, S.px, false)) {
          const stop = S.px - 0.5*atr[last], tp=c[last]+Math.max(1.5*atr[last], Math.abs(c[last]-stop)*1.2);
          return pack('BUY','Bounce at support (wick) with uptrend filter', c[last].toFixed(5), stop.toFixed(5), tp.toFixed(5), true);
        }
      }
      return pack('WAIT','No actionable SR bounce/reject near level','', '', '', false);
    }

    function stochWr(){
      const up = trendUp && stoch.k[last] > stoch.d[last] && stoch.k[last] < 60 && wr[last] > -50;
      const dn = trendDn && stoch.k[last] < stoch.d[last] && stoch.k[last] > 40 && wr[last] < -50;
      if (up) {
        const stop = swLow.px - 0.5*atr[last], tp=c[last]+Math.max(1.5*atr[last], Math.abs(c[last]-stop)*1.2);
        return pack('BUY','Stoch K>D + W%R improving within uptrend', c[last].toFixed(5), stop.toFixed(5), tp.toFixed(5), true);
      }
      if (dn) {
        const stop = swHigh.px + 0.5*atr[last], tp=c[last]-Math.max(1.5*atr[last], Math.abs(stop-c[last])*1.2);
        return pack('SELL','Stoch K<D + W%R weakening within downtrend', c[last].toFixed(5), stop.toFixed(5), tp.toFixed(5), true);
      }
      return pack('WAIT','Oscillators not aligned with trend','', '', '', false);
    }

    function rsiMacd(){
      const up = rsi[last] > 55 && macd.macd[last] > macd.signal[last] && macd.hist.slice(-3).every(x=>x>0);
      const dn = rsi[last] < 45 && macd.macd[last] < macd.signal[last] && macd.hist.slice(-3).every(x=>x<0);
      if (up) {
        const stop = swLow.px - 0.5*atr[last], tp=c[last]+Math.max(1.5*atr[last], Math.abs(c[last]-stop)*1.2);
        return pack('BUY','RSI>55 and MACD>signal with positive hist', c[last].toFixed(5), stop.toFixed(5), tp.toFixed(5), true);
      }
      if (dn) {
        const stop = swHigh.px + 0.5*atr[last], tp=c[last]-Math.max(1.5*atr[last], Math.abs(stop-c[last])*1.2);
        return pack('SELL','RSI<45 and MACD<signal with negative hist', c[last].toFixed(5), stop.toFixed(5), tp.toFixed(5), true);
      }
      return pack('WAIT','RSI/MACD not aligned strongly','', '', '', false);
    }

    function bos(){
      const sh = swHigh, sl = swLow;
      const brokeUp   = trendUp && c[last] > sh.px && c[last-1] <= sh.px;
      const brokeDown = trendDn && c[last] < sl.px && c[last-1] >= sl.px;
      if (brokeUp) {
        const stop = sl.px - 0.5*atr[last], tp = c[last] + Math.max(1.5*atr[last], Math.abs(c[last]-stop)*1.2);
        return pack('BUY','BOS: close above prior swing high within uptrend', c[last].toFixed(5), stop.toFixed(5), tp.toFixed(5), true);
      }
      if (brokeDown) {
        const stop = sh.px + 0.5*atr[last], tp = c[last] - Math.max(1.5*atr[last], Math.abs(stop-c[last])*1.2);
        return pack('SELL','BOS: close below prior swing low within downtrend', c[last].toFixed(5), stop.toFixed(5), tp.toFixed(5), true);
      }
      return pack('WAIT','No structure break at last bar','', '', '', false);
    }

    function pullback(){
      if (trendUp && c[last-1] < e20[last-1] && c[last] > e20[last]) {
        const stop = swLow.px - 0.5*atr[last], tp=c[last]+Math.max(1.5*atr[last], Math.abs(c[last]-stop)*1.2);
        return pack('BUY','Uptrend pullback to EMA20 then reclaim', c[last].toFixed(5), stop.toFixed(5), tp.toFixed(5), true);
      }
      if (trendDn && c[last-1] > e20[last-1] && c[last] < e20[last]) {
        const stop = swHigh.px + 0.5*atr[last], tp=c[last]-Math.max(1.5*atr[last], Math.abs(stop-c[last])*1.2);
        return pack('SELL','Downtrend pullback to EMA20 then reject', c[last].toFixed(5), stop.toFixed(5), tp.toFixed(5), true);
      }
      return pack('WAIT','No pullback reclaim/reject at EMA20','', '', '', false);
    }

    function meanRev(){
      const dist = Math.abs(pct(c[last], e20[last]));
      const flat = Math.abs(pct(e50[last], e200[last])) < 0.001 && Math.abs(slope(c,20)) < (Math.abs(c[last])*0.0008);
      if (flat && dist > 0.01) {
        if (c[last] > e20[last]) {
          const stop = h[last] + 0.25*atr[last], tp = e20[last];
          return pack('SELL','Flat regime + stretched above mean → revert', c[last].toFixed(5), stop.toFixed(5), tp.toFixed(5), true);
        } else {
          const stop = l[last] - 0.25*atr[last], tp = e20[last];
          return pack('BUY','Flat regime + stretched below mean → revert', c[last].toFixed(5), stop.toFixed(5), tp.toFixed(5), true);
        }
      }
      return pack('WAIT','Not stretched in flat regime','', '', '', false);
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
    const fn = map[String(strat).toLowerCase()] || trendline;
    const r  = fn();

    // Confidence: only for non-WAIT
    let conf = 0.0;
    if (r.action !== 'WAIT') {
      const trendBoost = (trendUp || trendDn) ? 0.12 : 0;
      const distBoost  = clamp(Math.abs(pct(e20[last], e50[last]))*3, 0, 0.18);
      conf = clamp(0.6 + trendBoost + distBoost, 0.6, 0.9);
    }

    const summary = `${(sym||'VISION').toUpperCase()} • ${timeframe} • ${strategy} — ${r.action}`;
    return { summary, action:r.action, why:r.why, entryExit:r.entryExit, confidence:conf };
  }

  // ---------- Vision ----------
  async function visionRead(imgB64, tf, strat) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return { ok:false, error:'no_openai_key' };
    const body = {
      model: "gpt-4o-mini",
      temperature: 0.1,
      messages: [
        { role: "system", content: "Return strict JSON only. Be conservative; if uncertain, action: WAIT with reason." },
        { role: "user", content: [
          { type: "text", text: `Analyze the chart image for "${strat}" on "${tf}". Output JSON: {"action":"BUY|SELL|WAIT","reason":"...","entry":"","exit":"","stop":"","tp":""}. Only return BUY/SELL when criteria are clearly present; else WAIT.` },
          { type: "image_url", image_url: { url: imgB64 } }
        ]}
      ]
    };
    try{
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method:'POST',
        headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/json'},
        body: JSON.stringify(body)
      });
      const j = await r.json();
      const raw = j?.choices?.[0]?.message?.content || '';
      let parsed=null; try{ parsed=JSON.parse(raw); }catch{}
      if (!parsed) return { ok:true, action:'WAIT', reason:'Vision could not parse', entry:'', exit:'', stop:'', tp:'' };
      return { ok:true, ...parsed };
    }catch(e){ return { ok:false, error:String(e) }; }
  }

  // ---------- run ----------
  try {
    // optional data
    const market = ticker ? await fetchCandles(ticker, timeframe) : null;

    // vision first (screenshot)
    const vis = imageDataURL ? await visionRead(imageDataURL, timeframe, strategy) : null;

    // strict engine (data)
    const strict = (market && market.ok) ? strictEngine(market, timeframe, strategy, ticker) : null;

    // Merge policy to kill false signals:
    // - If BOTH exist: require SAME action (BUY/SELL). Else → WAIT.
    // - If ONLY one exists: require it to be BUY/SELL? We choose **WAIT** unless it's strict (data) — vision-only can still act, but conservative:
    //   You can flip this to require both (even stricter) by changing the branches below.
    let final = { action:'WAIT', why:'No sources' };
    let mode  = 'fallback';

    if (vis && strict) {
      if (vis.action==='WAIT' && (strict.action==='BUY'||strict.action==='SELL')) {
        // vision unsure, data confident → still WAIT to avoid over-trading
        final = { ...strict, action:'WAIT', why:'Vision did not confirm' }; mode='data-veto';
      } else if ((strict.action==='WAIT') && (vis.action==='BUY'||vis.action==='SELL')) {
        final = { ...strict, action:'WAIT', why:'Data did not confirm' }; mode='data-veto';
      } else if (vis.action === strict.action && (vis.action==='BUY'||vis.action==='SELL')) {
        final = { ...strict, why: strict.why + ' | Vision: ' + (vis.reason||'') }; mode='vision+data';
      } else {
        final = { ...(strict||{}), action:'WAIT', why:'Vision and data disagree' }; mode='disagree';
      }
    } else if (strict) {
      // Data only → allowed
      final = strict; mode='live-data';
    } else if (vis) {
      // Vision only → conservative: only act if BUY/SELL and includes entry/stop/tp
      const hasLevels = vis.entry && vis.stop && vis.tp;
      if ((vis.action==='BUY'||vis.action==='SELL') && hasLevels) {
        final = {
          summary: `${(ticker||'VISION').toUpperCase()} • ${timeframe} • ${strategy} — ${vis.action}`,
          action: vis.action, why: vis.reason||'Vision pattern', entryExit:{ entry:vis.entry, exit:vis.exit||'', stop:vis.stop, tp:vis.tp },
          confidence: 0.6
        };
        mode='vision-only';
      } else {
        final = { action:'WAIT', why: vis.reason || 'Vision not confident', entryExit:{entry:'',exit:'',stop:'',tp:''}, summary:`${(ticker||'VISION').toUpperCase()} • ${timeframe} • ${strategy} — WAIT` };
        mode='vision-only';
      }
    } else {
      return res.status(200).json({
        ok:true, mode:'no-input',
        summary:`${(ticker||'VISION').toUpperCase()} • ${timeframe} • ${strategy} — WAIT`,
        signals:[{action:'WAIT',reason:'No screenshot or ticker provided',confidence:0,ttlSec:900}],
        entryExit:{entry:'',exit:'',stop:'',tp:''}
      });
    }

    const resp = {
      ok:true,
      mode,
      summary: final.summary || `${(ticker||'VISION').toUpperCase()} • ${timeframe} • ${strategy} — ${final.action}`,
      checklist: [
        `Policy: consensus gating`,
        `Why: ${final.why || ''}`.trim(),
        `TF: ${timeframe} | Strat: ${strategy}`
      ],
      signals: [{ action: final.action, reason: final.why || '', confidence: final.confidence || 0.0, ttlSec: 900 }],
      entryExit: final.entryExit || { entry:'', exit:'', stop:'', tp:'' },
      price: (market && market.c && market.c.at ? market.c.at(-1) : null),
      note: market?.symbol ? { symbol: market.symbol, resolution: market.resolution } : { symbol: ticker || 'vision-only' }
    };
    return res.status(200).json(resp);
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
}
