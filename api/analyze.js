// /api/analyze.js
// Vercel serverless (Node/ESM) handler
// Environment: FINNHUB_API_KEY (set in Vercel -> Project -> Settings -> Environment Variables)

export const config = { runtime: "nodejs18.x" };

const API_KEY = process.env.FINNHUB_API_KEY;

// ---- utils ----
const RES_MAP = {
  "15m": "15",
  "30m": "30",
  "1h": "60",
  "4h": "240",
  "Daily": "D",
  "Weekly": "W",
  "Monthly": "M",
  "Hourly": "60"
};

const SEC_PER_RES = {
  "1":60, "5":300, "15":900, "30":1800, "60":3600,
  "240":14400, "D":86400, "W":604800, "M":2592000
};

// quick moving average helpers
function ema(values, period){
  const p = Number(period)||1;
  if(!Array.isArray(values) || values.length < p) return null;
  const k = 2/(p+1);
  let emaVal = values.slice(0, p).reduce((a,b)=>a+b,0)/p;
  for(let i=p;i<values.length;i++){
    emaVal = values[i]*k + emaVal*(1-k);
  }
  return emaVal;
}

function rsi(values, period=14){
  const p = Number(period)||14;
  if(values.length < p+1) return null;
  let gains=0, losses=0;
  for(let i=values.length-p;i<values.length;i++){
    const diff = values[i] - values[i-1];
    if(diff>=0) gains += diff; else losses += (-diff);
  }
  const avgG = gains/p, avgL = losses/p;
  if(avgL===0) return 100;
  const rs = avgG/avgL;
  return 100 - (100/(1+rs));
}

function macdHist(values){
  // macd line = ema12 - ema26, hist = macd - ema9(macd)
  if(values.length < 35) return null;
  const ema12 = ema(values,12);
  const ema26 = ema(values,26);
  if(ema12==null || ema26==null) return null;
  const macdLine = ema12 - ema26;
  // cheap approx: recompute EMA9 on suffix (not exact, but good enough for a demo)
  const macdSeries = [];
  // generate a tiny macd series from tail
  for(let i=values.length-35;i<values.length;i++){
    const e12 = ema(values.slice(0,i+1),12);
    const e26 = ema(values.slice(0,i+1),26);
    macdSeries.push((e12??0) - (e26??0));
  }
  const sig = ema(macdSeries,9) ?? 0;
  return macdLine - sig;
}

function resolveAssetType(sym){
  if(/^OANDA:|^FX:|^[A-Z]{6}=X$/.test(sym)) return "forex";
  if(/^BINANCE:|^COINBASE:|^KRAKEN:|^BITFINEX:/.test(sym)) return "crypto";
  return "stock";
}

async function fetchJSON(url){
  const r = await fetch(url);
  if(!r.ok) throw new Error("HTTP "+r.status+" for "+url);
  return r.json();
}

async function fetchQuote(symbol, kind){
  try{
    if(kind==="stock"){
      const q = await fetchJSON(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${API_KEY}`);
      return { c:q.c, o:q.o, h:q.h, l:q.l, pc:q.pc, t:q.t };
    }
    // for forex/crypto we pull the last candle instead of "quote"
    const c = await fetchCandlesSmart(symbol, "15m", 2); // short window
    if(c && c.c && c.c.length){
      const i = c.c.length-1;
      return { c:c.c[i], o:c.o[i], h:c.h[i], l:c.l[i], pc:c.c[i-1] ?? c.c[i], t:c.t[i] };
    }
  }catch(_e){}
  return { c:null,o:null,h:null,l:null,pc:null,t:null };
}

async function fetchCandlesSmart(symbol, timeframe, bars){
  const reso = RES_MAP[timeframe] || timeframe; // allow raw
  const kind = resolveAssetType(symbol);
  const base = kind === "crypto" ? "crypto" : (kind === "forex" ? "forex" : "stock");

  const now = Math.floor(Date.now()/1000);
  const span = SEC_PER_RES[reso] || 900;
  const from = now - Math.max(300, bars||400) * span;

  const makeUrl = (resolution) =>
    `https://finnhub.io/api/v1/${base}/candle?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${now}&token=${API_KEY}`;

  const tryRes = async (resolution) => {
    const j = await fetchJSON(makeUrl(resolution));
    if(j && j.s==="ok" && Array.isArray(j.c) && j.c.length) return j;
    return null;
  };

  // try requested
  let c = await tryRes(reso);
  if(c) return c;

  // fallback
  const alt = reso==="W" ? "D" :
              reso==="M" ? "W" :
              reso==="60" ? "30" :
              reso==="30" ? "15" :
              reso==="15" ? "5" : "D";
  c = await tryRes(alt);
  return c;
}

function basicSignalFromSeries(closeArr){
  if(!closeArr || closeArr.length < 50) return { action:"HOLD", confidence:0, entry:null, stop:null, targets:[], rationale:["insufficient_data"] };
  const ema9  = ema(closeArr,9);
  const ema50 = ema(closeArr,50);
  const rsi14 = rsi(closeArr,14);
  const hist  = macdHist(closeArr);
  const last  = closeArr[closeArr.length-1];

  let action="HOLD", conf=50, why=[];
  if(ema9!=null && ema50!=null && rsi14!=null && hist!=null){
    if(ema9>ema50 && rsi14>50 && hist>0){ action="BUY";  conf=70; why.push("ema9>ema50","rsi>50","macd_hist>0"); }
    else if(ema9<ema50 && rsi14<50 && hist<0){ action="SELL"; conf=70; why.push("ema9<ema50","rsi<50","macd_hist<0"); }
    else { action="HOLD"; conf=55; why.push("mixed_signals"); }
  } else {
    why.push("not_enough_bars");
  }

  const atr = atr14FromOHLC(closeArr); // placeholder target sizes
  const entry = last ?? null;
  const stop  = action==="BUY" ? (entry!=null ? entry - (atr||1)*1.5 : null)
                               : action==="SELL" ? (entry!=null ? entry + (atr||1)*1.5 : null)
                               : null;
  const targets = entry!=null ? [
    action==="BUY"  ? entry + (atr||1)*1.5 : action==="SELL" ? entry - (atr||1)*1.5 : null,
    action==="BUY"  ? entry + (atr||1)*2.5 : action==="SELL" ? entry - (atr||1)*2.5 : null
  ].filter(v=>v!=null) : [];

  return { action, confidence:conf, entry, stop, targets, best_strategy_now:"ema_rsi_macd", rationale:why };
}

// minimal ATR proxy from closes (very rough – okay for demo)
function atr14FromOHLC(closes){
  if(!closes || closes.length<15) return 1;
  const vols = [];
  for(let i=1;i<closes.length;i++){
    vols.push(Math.abs(closes[i]-closes[i-1]));
  }
  const last14 = vols.slice(-14);
  return last14.reduce((a,b)=>a+b,0)/Math.max(1,last14.length);
}

// ---- handler ----
export default async function handler(req, res){
  // GET banner
  if(req.method !== "POST"){
    return res
      .status(200)
      .setHeader("Content-Type","text/html; charset=utf-8")
      .send(`<html><head><meta charset="utf-8"><title>TrueTrend API</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial;background:#0b1220;color:#e6e9ef;padding:24px}</style></head>
<body><h1>TrueTrend API</h1><p>POST /api/analyze with {"symbol":"AAPL","timeframe":"15m","mode":"signal|backtest|voice","strategy":{...}}</p></body></html>`);
  }

  try{
    if(!API_KEY) return res.status(500).json({ error:true, message:"FINNHUB_API_KEY not set on server" });

    const { symbol, timeframe="15m", mode="signal", strategy } = await parseBody(req);

    if(!symbol) return res.status(400).json({ error:true, message:"Missing symbol" });

    // get quote (best-effort)
    const kind = resolveAssetType(symbol);
    const quote = await fetchQuote(symbol, kind);

    // get candles with fallback
    const candles = await fetchCandlesSmart(symbol, timeframe, 500);

    if(!candles){
      // graceful HOLD if provider has no data
      return res.status(200).json({
        error:false,
        note:"no_data from provider for this symbol/timeframe (tried fallback too)",
        quote,
        indicators:{},
        signal:{ action:"HOLD", confidence:0, entry:quote?.c ?? null, stop:null, targets:[], best_strategy_now:"insufficient_data", rationale:["no_data"] }
      });
    }

    // build simple indicators
    const closes = candles.c || [];
    const inds = {
      ema9: ema(closes,9),
      ema50: ema(closes,50),
      rsi14: rsi(closes,14),
      macd: { hist: macdHist(closes) }
    };

    // signal logic (basic) or evaluate strategy if provided
    let signal = basicSignalFromSeries(closes);

    // optional custom strategy passthrough: if you want to expand later
    const strategy_evaluation = strategy ? { rules: (strategy.rules||[]).map(r => ({ ...r, ok:false, left:null, right:null })) } : undefined;

    return res.status(200).json({ error:false, quote, indicators:inds, signal, strategy_evaluation });
  }catch(err){
    return res.status(200).json({ error:false, note:"internal_handled", message:String(err.message||err) });
  }
}

async function parseBody(req){
  if(req.body && typeof req.body === "object") return req.body;
  const raw = await readStream(req);
  try{ return JSON.parse(raw||"{}"); }catch(_e){ return {}; }
}
function readStream(req){
  return new Promise((resolve, reject)=>{
    let data=""; req.on("data", chunk=> data+=chunk); req.on("end", ()=> resolve(data)); req.on("error", reject);
  });
}
