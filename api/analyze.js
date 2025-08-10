// pages/api/analyze.js
export const config = { runtime: "nodejs" };

const UA = { "User-Agent": "TrueTrend/1.0 (+truetrend)" };

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return json(res, { error: true, message: "Use POST" }, 405);

  try {
    const { symbol = "", timeframe = "Daily", strategy = "trendline" } = await readJSON(req);
    const sym = symbol.trim();
    if (!sym) return json(res, { error: true, message: "Missing symbol" }, 400);

    const { interval, range, aggregate } = tfToYahoo(timeframe);
    const ysym = toYahoo(sym);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ysym)}?range=${range}&interval=${interval}`;
    const r = await fetch(url, { headers: UA });
    if (!r.ok) return json(res, { error: true, message: `Upstream ${r.status}` }, 502);
    const data = await r.json();
    const rt = data?.chart?.result?.[0];
    const q = rt?.indicators?.quote?.[0];
    if (!rt || !q || !Array.isArray(rt.timestamp)) return json(res, { error: true, message: "No data" }, 502);

    // aggregate 4h from 1h if requested
    let c = q.close, h = q.high, l = q.low, o = q.open, t = rt.timestamp;
    if (aggregate === 4) ({ c, h, l, o, t } = aggN({ c, h, l, o, t }, 4));
    if (!c || c.length < 60) return json(res, { error: true, message: "Insufficient candles" }, 502);

    // indicators (lightweight)
    const ema9 = ema(c, 9), ema50 = ema(c, 50), rsi14 = rsi(c, 14), macH = macdHist(c);
    const last = c.at(-1), hi = h.at(-1), lo = l.at(-1), op = o.at(-1);

    // higher-TF bias for intraday
    let htSlopeOK = true;
    if (["15m","1h","4h"].includes(timeframe)) {
      const r2 = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ysym)}?range=6mo&interval=1d`, { headers: UA });
      const d2 = await r2.json();
      const rc = d2?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
      if (rc.length > 50) htSlopeOK = slope(ema(rc,50),6) >= 0;
    }

    const sig = decide(strategy, c, h, l, ema9, ema50, rsi14, macH, htSlopeOK);
    const tgt = targets(sig, last);
    const voiceText = voice(sym, timeframe, last, sig);

    // small CDN cache to keep things snappy
    res.setHeader("Cache-Control", "public, s-maxage=20, stale-while-revalidate=40");
    return json(res, {
      error:false,
      quote:{ c:fix(last), h:fix(hi), l:fix(lo), o:fix(op), t: rt.meta?.regularMarketTime || Math.floor(Date.now()/1000) },
      indicators:{ ema9:fix(ema9.at(-1)), ema50:fix(ema50.at(-1)), rsi14:fix(rsi14.at(-1)), macd:{hist:fix(macH.at(-1))} },
      signal:sig, targets:tgt, voiceText
    });
  } catch (e) {
    console.error(e);
    return json(res, { error:true, message:e.message||"Server error" }, 500);
  }
}

/* ---------- helpers ---------- */
function toYahoo(sym){
  if(/^OANDA:([A-Z]{3})_([A-Z]{3})$/.test(sym)) return RegExp.$1+RegExp.$2+'=X';
  if(/^BINANCE:([A-Z]+)USDT$/i.test(sym)) return RegExp.$1.toUpperCase()+'-USD';
  if(/^([A-Z]+)USD$/i.test(sym)) return RegExp.$1.toUpperCase()+'-USD';
  return sym;
}
function tfToYahoo(tf){
  switch(tf){
    case "15m": return { interval:"15m", range:"5d" };
    case "1h":  return { interval:"60m", range:"1mo" };
    case "4h":  return { interval:"60m", range:"3mo", aggregate:4 };
    case "Weekly": return { interval:"1wk", range:"2y" };
    default: return { interval:"1d", range:"6mo" };
  }
}
function aggN({c,h,l,o,t},n){ const C=[],H=[],L=[],O=[],T=[]; for(let i=0;i<c.length;i+=n){ const seg=c.slice(i,i+n); if(seg.length<n) break; C.push(seg.at(-1)); H.push(Math.max(...h.slice(i,i+n))); L.push(Math.min(...l.slice(i,i+n))); O.push(o[i]); T.push(t[i]) } return {c:C,h:H,l:L,o:O,t:T} }
function ema(a,p){ if(!a.length) return []; const k=2/(p+1); let e=a[0]; return a.map((v,i)=> e = i? v*k + e*(1-k) : v); }
function rsi(a,p=14){ if(a.length<p+1) return Array(a.length).fill(50); let g=0,lo=0; for(let i=1;i<=p;i++){const d=a[i]-a[i-1]; if(d>=0)g+=d; else lo-=d} let ag=g/p, al=lo/p; const out=[...Array(p).fill(50), 100-100/(1+(ag/(al||1e-9)))]; for(let i=p+1;i<a.length;i++){const d=a[i]-a[i-1]; const G=d>0?d:0, L=d<0?-d:0; ag=(ag*(p-1)+G)/p; al=(al*(p-1)+L)/p; out.push(100-100/(1+(ag/(al||1e-9))))} return out; }
function macdHist(a){ const e12=ema(a,12), e26=ema(a,26), line=e12.map((v,i)=>v-(e26[i]||v)), sig=ema(line,9); return line.map((v,i)=>v-(sig[i]||0)); }
function slope(a,n=6){ const s=a.slice(-n); if(s.length<2) return 0; return (s.at(-1)-s[0]) / Math.max(Math.abs(s[0]),1e-9) }
function decide(strategy, c,h,l, ema9,ema50, rsi14, macH, ht){
  const n=c.length-1, price=c[n], bull=ema9[n]>ema50[n], emaS=slope(ema50,6), r=rsi14[n], m=macH[n];
  const reasons=[]; let action="HOLD", conf=50;
  if(strategy==="cross"){ const up=ema9[n]>ema50[n]&&ema9[n-1]<=ema50[n-1], dn=ema9[n]<ema50[n]&&ema9[n-1]>=ema50[n-1];
    if(up){action="BUY"; reasons.push("EMA9 crossed above EMA50")} if(dn){action="SELL"; reasons.push("EMA9 crossed below EMA50")}
    conf=Math.min(95, Math.abs(emaS)*300 + (up||dn?25:0) + (ht?15:0) + (m>0?10:0));
    if(!ht && action==="BUY"){reasons.push("Higher timeframe not aligned"); conf-=15}
    if(ht && action==="SELL"){reasons.push("Higher timeframe up, fade"); conf-=15}
  } else if(strategy==="rsiReversal"){ if(r<32){action="BUY"; reasons.push("RSI near oversold")} else if(r>68){action="SELL"; reasons.push("RSI near overbought")} else reasons.push("RSI mid-range");
    conf=Math.min(92, (70-Math.abs(50-r))*(-1)+80 + (m>0?8:0))
  } else if(strategy==="breakout"){ const HH=Math.max(...h.slice(-20,-1)), LL=Math.min(...l.slice(-20,-1));
    if(price>HH){action="BUY"; reasons.push("Breaking 20-bar high")} else if(price<LL){action="SELL"; reasons.push("Breaking 20-bar low")} else reasons.push("Still inside range");
    conf=Math.min(90, (price>HH||price<LL?70:40) + (m>0?6:0) + (bull?6:-2))
  } else { // trendline
    if(emaS>0 && price>=ema9[n]){action="BUY"; reasons.push("EMA50 slope up + above EMA9")}
    else if(emaS<0 && price<=ema9[n]){action="SELL"; reasons.push("EMA50 slope down + below EMA9")}
    else reasons.push("No clean alignment");
    conf=Math.min(93, Math.abs(emaS)*400 + (m>0?10:0) + (bull?8:-4) + (ht?10:0))
  }
  conf=Math.max(5,Math.min(98,Math.round(conf))); if(action==="HOLD") reasons.push("No edge detected");
  return { action, confidence: conf, reasons };
}
function targets(sig, price){ if(sig.action==="BUY") return {entry:fix(price), stop:fix(price*0.98), tp:fix(price*1.03)}; if(sig.action==="SELL") return {entry:fix(price), stop:fix(price*1.02), tp:fix(price*0.97)}; return {} }
function voice(symbol, tf, price, sig){ const mood=sig.confidence>80?'high confidence':sig.confidence>60?'good confidence':'low confidence'; return `On ${symbol} ${tf}, price around ${fix(price)}. Signal is ${sig.action.toLowerCase()} with ${sig.confidence} percent, ${mood}. Reasons: ${sig.reasons.slice(0,3).join('; ')}.` }
function fix(n,d=4){ return (n!=null && !Number.isNaN(n)) ? Number(n.toFixed(d)) : n }
function json(res,obj,code=200){ res.status(code).setHeader("content-type","application/json").end(JSON.stringify(obj)) }
function readJSON(req){ return new Promise((ok,err)=>{ let b=""; req.on("data",c=>b+=c); req.on("end",()=>{ try{ok(b?JSON.parse(b):{})}catch(e){err(e)} }) }) }
