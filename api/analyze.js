// /api/analyze.js — Vercel serverless (Node 18+)
// Requires env var: FINNHUB_API_KEY

export const config = { runtime: "nodejs18.x" };
const API_KEY = process.env.FINNHUB_API_KEY;

// ------- small utils -------
const RES_MAP = {
  "15m": "15", "30m": "30", "1h": "60", "4h": "240",
  "Daily": "D", "Weekly": "W", "Monthly": "M", "Hourly": "60"
};
const SEC_PER_RES = { "1":60,"5":300,"15":900,"30":1800,"60":3600,"240":14400,"D":86400,"W":604800,"M":2592000 };

function resolveAssetType(sym){
  if(/^OANDA:|^FX:|^[A-Z]{6}=X$/.test(sym)) return "forex";
  if(/^BINANCE:|^COINBASE:|^KRAKEN:|^BITFINEX:/.test(sym)) return "crypto";
  return "stock";
}
async function jfetch(url){ const r = await fetch(url); if(!r.ok) throw new Error("HTTP "+r.status); return r.json(); }

async function fetchQuote(symbol, kind){
  try{
    if(kind==="stock"){
      const q = await jfetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${API_KEY}`);
      return { c:q.c, o:q.o, h:q.h, l:q.l, pc:q.pc, t:q.t };
    }
    const c = await fetchCandlesSmart(symbol, "15m", 2); // last 2 candles
    if(c && c.c && c.c.length){
      const i = c.c.length-1;
      return { c:c.c[i], o:c.o[i], h:c.h[i], l:c.l[i], pc:c.c[i-1] ?? c.c[i], t:c.t[i] };
    }
  }catch(_e){}
  return { c:null,o:null,h:null,l:null,pc:null,t:null };
}

async function fetchCandlesSmart(symbol, timeframe, bars){
  const reso = RES_MAP[timeframe] || timeframe;
  const kind = resolveAssetType(symbol);
  const base = kind==="crypto" ? "crypto" : (kind==="forex" ? "forex" : "stock");

  const now = Math.floor(Date.now()/1000);
  const span = SEC_PER_RES[reso] || 900;
  const from = now - Math.max(400, bars||400)*span;

  const makeUrl = r => `https://finnhub.io/api/v1/${base}/candle?symbol=${encodeURIComponent(symbol)}&resolution=${r}&from=${from}&to=${now}&token=${API_KEY}`;
  const tryOne = async r => { const j = await jfetch(makeUrl(r)); return j && j.s==="ok" && Array.isArray(j.c) && j.c.length ? j : null; };

  let c = await tryOne(reso);
  if(c) return c;

  const alt = reso==="W"?"D" : reso==="M"?"W" : reso==="60"?"30" : reso==="30"?"15" : reso==="15"?"5" : "D";
  c = await tryOne(alt);
  return c; // may be null
}

// indicators (simple)
function ema(arr,p){ p=Number(p)||1; if(!arr||arr.length<p) return null; const k=2/(p+1); let e=arr.slice(0,p).reduce((a,b)=>a+b,0)/p; for(let i=p;i<arr.length;i++) e=arr[i]*k+e*(1-k); return e; }
function rsi(arr,p=14){ if(!arr||arr.length<p+1) return null; let g=0,l=0; for(let i=arr.length-p;i<arr.length;i++){ const d=arr[i]-arr[i-1]; if(d>=0) g+=d; else l+=-d; } const ag=g/p, al=l/p; if(al===0) return 100; const rs=ag/al; return 100-(100/(1+rs)); }
function macdHist(arr){ if(!arr||arr.length<35) return null; const e12=ema(arr,12), e26=ema(arr,26); if(e12==null||e26==null) return null; const macdLine=e12-e26; const series=[]; for(let i=arr.length-35;i<arr.length;i++){ const a=ema(arr.slice(0,i+1),12)??0; const b=ema(arr.slice(0,i+1),26)??0; series.push(a-b); } const signal=ema(series,9)??0; return macdLine-signal; }
function atrProxy(closes){ if(!closes||closes.length<15) return 1; const v=[]; for(let i=1;i<closes.length;i++) v.push(Math.abs(closes[i]-closes[i-1])); const s=v.slice(-14).reduce((a,b)=>a+b,0); return s/Math.max(1,Math.min(14,v.length)); }

function deriveSignal(closes){
  if(!closes||closes.length<50) return { action:"HOLD", confidence:0, entry:null, stop:null, targets:[], best_strategy_now:"insufficient_data", rationale:["insufficient_bars"] };
  const last = closes[closes.length-1];
  const s = { action:"HOLD", confidence:55, entry:last, stop:null, targets:[], best_strategy_now:"ema_rsi_macd", rationale:[] };
  const e9=ema(closes,9), e50=ema(closes,50), r=rsi(closes,14), h=macdHist(closes);
  if(e9!=null&&e50!=null&&r!=null&&h!=null){
    if(e9>e50 && r>50 && h>0){ s.action="BUY"; s.confidence=70; s.rationale=["ema9>ema50","rsi>50","macd_hist>0"]; }
    else if(e9<e50 && r<50 && h<0){ s.action="SELL"; s.confidence=70; s.rationale=["ema9<ema50","rsi<50","macd_hist<0"]; }
  }
  const atr=atrProxy(closes);
  if(s.action==="BUY"){ s.stop = last - atr*1.5; s.targets=[ last + atr*1.5, last + atr*2.5 ]; }
  if(s.action==="SELL"){ s.stop = last + atr*1.5; s.targets=[ last - atr*1.5, last - atr*2.5 ]; }
  return s;
}

// ------- handler -------
export default async function handler(req,res){
  if(req.method!=="POST"){
    return res
      .status(200)
      .setHeader("Content-Type","text/html; charset=utf-8")
      .send(`<html><head><meta charset="utf-8"><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial;background:#0b1220;color:#e6e9ef;padding:24px}</style><title>TrueTrend API</title></head><body><h1>TrueTrend API</h1><p>POST /api/analyze with {"symbol":"AAPL","timeframe":"15m","mode":"signal|backtest|voice","strategy":{...}}</p></body></html>`);
  }

  try{
    if(!API_KEY) return res.status(500).json({ error:true, message:"FINNHUB_API_KEY not set on server" });
    const body = await readJSON(req);
    const symbol = (body.symbol||"").trim();
    const timeframe = body.timeframe || "15m";
    if(!symbol) return res.status(400).json({ error:true, message:"Missing symbol" });

    const kind = resolveAssetType(symbol);
    const quote = await fetchQuote(symbol, kind);
    const candles = await fetchCandlesSmart(symbol, timeframe, 500);

    if(!candles){
      return res.status(200).json({
        error:false,
        note:"no_data from provider for this symbol/timeframe (tried fallback too)",
        quote,
        indicators:{},
        signal:{ action:"HOLD", confidence:0, entry:quote?.c ?? null, stop:null, targets:[], best_strategy_now:"insufficient_data", rationale:["no_data"] }
      });
    }

    const closes = candles.c || [];
    const indicators = { ema9:ema(closes,9), ema50:ema(closes,50), rsi14:rsi(closes,14), macd:{ hist: macdHist(closes) } };
    const signal = deriveSignal(closes);

    return res.status(200).json({ error:false, quote, indicators, signal });
  }catch(err){
    return res.status(200).json({ error:false, note:"internal_handled", message:String(err.message||err) });
  }
}

function readJSON(req){
  if(req.body && typeof req.body==="object") return Promise.resolve(req.body);
  return new Promise((resolve,reject)=>{
    let data=""; req.on("data",c=>data+=c); req.on("end",()=>{ try{ resolve(JSON.parse(data||"{}")); }catch{ resolve({}); } }); req.on("error",reject);
  });
}
