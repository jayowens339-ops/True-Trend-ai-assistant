// api/analyze.js
// One endpoint with modes:
//  - POST { symbol, timeframe, strategy?, mode:"signal"|"backtest"|"voice", bars? }
//  - GET  -> tiny UI
//
// Requires: FINNHUB_API_KEY set in Vercel

function mapTF(tf) {
  const m = { "1m":"1", "5m":"5", "15m":"15", "30m":"30", "1h":"60", "4h":"240", "1d":"D",
              "Hourly":"60","Daily":"D","Weekly":"W","Monthly":"M" };
  return m[tf] || "15";
}

// ---------------- Math & Indicators ----------------
const ema = (arr, p) => {
  if (!p || arr.length < p) return null;
  const k = 2/(p+1); let e = arr.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for (let i=p;i<arr.length;i++) e = arr[i]*k + e*(1-k);
  return e;
};
const emaSeries = (arr, p) => {
  const n = arr.length; const out = Array(n).fill(null);
  if (!p || n < p) return out;
  const k = 2/(p+1);
  let e = arr.slice(0,p).reduce((a,b)=>a+b,0)/p; out[p-1]=e;
  for (let i=p;i<n;i++){ e = arr[i]*k + e*(1-k); out[i]=e; }
  return out;
};
const rsi = (closes, period=14) => {
  if (closes.length < period+1) return null;
  let gains=0, losses=0;
  for (let i=1;i<=period;i++){ const d=closes[i]-closes[i-1]; if (d>=0) gains+=d; else losses-=d; }
  let avgG=gains/period, avgL=losses/period;
  for (let i=period+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    avgG = ((avgG*(period-1)) + Math.max(d,0))/period;
    avgL = ((avgL*(period-1)) + Math.max(-d,0))/period;
  }
  if (avgL === 0) return 100;
  const rs = avgG/avgL; return 100 - (100/(1+rs));
};
const macd = (closes) => {
  if (closes.length < 35) return { macd:null, signal:null, hist:null };
  const ema12s = emaSeries(closes,12);
  const ema26s = emaSeries(closes,26);
  const macdLine = closes.map((_,i)=> (ema12s[i]!=null && ema26s[i]!=null) ? (ema12s[i]-ema26s[i]) : null);
  const sigSeries = emaSeries(macdLine.map(v=> v==null?0:v),9);
  const i = closes.length-1;
  if (macdLine[i]==null || sigSeries[i]==null) return { macd:null, signal:null, hist:null };
  return { macd: macdLine[i], signal: sigSeries[i], hist: macdLine[i]-sigSeries[i] };
};
const stochK = (highs,lows,closes,period=14) => {
  if (highs.length < period) return null;
  const i=highs.length-1;
  const hh = Math.max(...highs.slice(-period));
  const ll = Math.min(...lows.slice(-period));
  if (hh===ll) return 50;
  return ((closes[i]-ll)/(hh-ll))*100;
};
const williamsR = (highs,lows,closes,period=14) => {
  if (highs.length < period) return null;
  const i=highs.length-1;
  const hh = Math.max(...highs.slice(-period));
  const ll = Math.min(...lows.slice(-period));
  if (hh===ll) return -50;
  return -100 * (hh - closes[i]) / (hh - ll);
};
const atr = (highs,lows,closes,period=14) => {
  if (closes.length < period+1) return null;
  const trs = [];
  for (let i=1;i<closes.length;i++){
    const tr = Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
    trs.push(tr);
  }
  let a = trs.slice(0,period).reduce((x,y)=>x+y,0)/period;
  for (let i=period;i<trs.length;i++) a = (a*(period-1) + trs[i]) / period;
  return a;
};
// quick regression line “trendline” proxy (last N)
const linreg = (arr, N=80) => {
  const n = Math.min(N, arr.length);
  if (n < 10) return null;
  const xs = Array.from({length:n}, (_,i)=>i+1);
  const ys = arr.slice(-n);
  const sx = xs.reduce((a,b)=>a+b,0), sy = ys.reduce((a,b)=>a+b,0);
  const sxy = xs.reduce((a,x,i)=>a + x*ys[i], 0);
  const sxx = xs.reduce((a,x)=>a + x*x, 0);
  const denom = (n*sxx - sx*sx);
  if (denom === 0) return null;
  const a = (n*sxy - sx*sy)/denom; const b = (sy - a*sx)/n;
  const yhat = a*n + b;
  return { a, b, yhat };
};

// -------------- Rule evaluation (latest) --------------
function parseRight(val, ctx){
  if (val == null) return null;
  if (typeof val === "number") return val;
  const s = String(val).trim();
  const num = Number(s);
  if (!Number.isNaN(num)) return num;
  const mEMA = s.match(/^EMA\((\d+)\)$/i); if (mEMA) return ema(ctx.closes, Number(mEMA[1]));
  const mMA  = s.match(/^MA\((\d+)\)$/i); if (mMA)  {
    const p = Number(mMA[1]); const arr = ctx.useVolumeMA ? ctx.volumes : ctx.closes;
    if (arr.length < p) return null; return arr.slice(-p).reduce((a,b)=>a+b,0)/p;
  }
  const mRSI = s.match(/^RSI\((\d+)\)$/i); if (mRSI) return rsi(ctx.closes, Number(mRSI[1]));
  const mATR = s.match(/^ATR\((\d+)\)$/i); if (mATR) return atr(ctx.highs, ctx.lows, ctx.closes, Number(mATR[1]));
  return null;
}
function evalRule(rule, ctx) {
  const op = (rule.op||"").trim();
  let left = null;
  const ind = (rule.ind||"").trim();
  const p = rule.param != null ? Number(rule.param) : null;
  switch (ind) {
    case "Price": left = ctx.closes.at(-1); break;
    case "EMA": left = ema(ctx.closes, p||9); break;
    case "RSI": left = rsi(ctx.closes, p||14); break;
    case "MACD_Hist": left = macd(ctx.closes).hist; break;
    case "StochK": left = stochK(ctx.highs, ctx.lows, ctx.closes, p||14); break;
    case "WilliamsR": left = williamsR(ctx.highs, ctx.lows, ctx.closes, p||14); break;
    case "Volume": left = ctx.volumes.at(-1); ctx.useVolumeMA = true; break;
    case "ATR": left = atr(ctx.highs, ctx.lows, ctx.closes, p||14); break;
    default: left = null;
  }
  const right = parseRight(rule.right, ctx);
  const prevClose = ctx.closes.at(-2);
  const prevEMA = p ? ema(ctx.closes.slice(0,-1), p) : null;
  const tol = (ctx.atr || atr(ctx.highs, ctx.lows, ctx.closes, 14) || 0) * 0.1;

  let ok = false;
  if (left == null) ok = false;
  else if (op === ">" ) ok = right != null && left >  right;
  else if (op === ">=") ok = right != null && left >= right;
  else if (op === "<" ) ok = right != null && left <  right;
  else if (op === "<=") ok = right != null && left <= right;
  else if (op === "crossesAbove") {
    const lPrev = (ind==="EMA" && prevEMA!=null) ? prevEMA : prevClose;
    ok = (lPrev != null && right != null && lPrev < right && left >= right);
  } else if (op === "crossesBelow") {
    const lPrev = (ind==="EMA" && prevEMA!=null) ? prevEMA : prevClose;
    ok = (lPrev != null && right != null && lPrev > right && left <= right);
  } else if (op === "touches") {
    if (right != null) ok = Math.abs(left - right) <= Math.max(tol, Math.abs(left)*0.001);
    else if (/Trendline/i.test(String(rule.right||""))) {
      const lr = linreg(ctx.closes, 80);
      if (lr) ok = Math.abs(ctx.closes.at(-1) - lr.yhat) <= Math.max(tol, Math.abs(ctx.closes.at(-1))*0.002);
    }
  }
  return { ...rule, left, right, ok };
}

// choose “best strategy now” heuristically
function pickBestStrategy(ctx, inds){
  const above50 = inds.rsi14!=null && inds.rsi14>50;
  const ema9 = inds.ema9, ema50 = inds.ema50;
  const trendUp = (ema50!=null && ctx.closes.at(-1) > ema50);
  const macdUp = inds.macdHist!=null && inds.macdHist>0;

  const scores = {
    "Trendline": 0,
    "EMA Touch": 0,
    "RSI + MACD": 0,
    "Support/Resistance": 0,
    "Break of Structure": 0,
    "Opening Range Breakout": 0
  };
  const lr = linreg(ctx.closes, 80);
  if (lr && Math.abs(ctx.closes.at(-1)-lr.yhat) < (inds.atr14||0)*0.2) scores["Trendline"] += 2;
  if (ema9 && Math.abs(ctx.closes.at(-1)-ema9) < (inds.atr14||0)*0.2) scores["EMA Touch"] += 2;
  if (trendUp) scores["EMA Touch"] += 1;
  if (above50) scores["RSI + MACD"] += 1;
  if (macdUp) scores["RSI + MACD"] += 1;
  if (inds.stochK!=null && (inds.stochK>85 || inds.stochK<15)) scores["Support/Resistance"] += 2;
  if (inds.wr!=null && (inds.wr<-80 || inds.wr>-20)) scores["Support/Resistance"] += 1;
  const last20h = Math.max(...ctx.highs.slice(-20)), last20l = Math.min(...ctx.lows.slice(-20));
  if (ctx.closes.at(-1) > last20h || ctx.closes.at(-1) < last20l) scores["Break of Structure"] += 2;
  const big = (inds.atr14 && (ctx.highs.at(-1)-ctx.lows.at(-1)) > 0.9*inds.atr14);
  if (["1m","5m","15m","30m","1h"].includes(ctx.reqTF) && big) scores["Opening Range Breakout"] += 1;

  let best = "EMA Touch", bestScore = -1;
  for (const [k,v] of Object.entries(scores)) if (v>bestScore){ best=k; bestScore=v; }
  return { best, scores };
}

// -------------- Fetch helpers --------------
async function fetchFinnhubJSON(url) {
  const r = await fetch(url, { cache:"no-store" });
  const t = await r.text();
  let data; try { data = t ? JSON.parse(t) : {}; } catch { data = { raw:t }; }
  return { ok:r.ok, status:r.status, data, text:t };
}
async function getCandles(symbol, res, from, to, key) {
  const isProvider = symbol.includes(":");
  let endpoint;
  if (isProvider) {
    const prov = symbol.split(":")[0].toUpperCase();
    const crypto = ["BINANCE","COINBASE","KRAKEN","BITSTAMP","BITFINEX","HUOBI","BYBIT"];
    const fx = ["OANDA","FXCM","FOREXCOM","SAXO","ICM","PEPPERSTONE","FXPRO"];
    if (crypto.includes(prov)) endpoint = "crypto/candle";
    else if (fx.includes(prov)) endpoint = "forex/candle";
    else endpoint = "forex/candle";
  } else {
    endpoint = "stock/candle";
  }
  const url = `https://finnhub.io/api/v1/${endpoint}?symbol=${encodeURIComponent(symbol)}&resolution=${encodeURIComponent(res)}&from=${from}&to=${to}&token=${encodeURIComponent(key)}`;
  return fetchFinnhubJSON(url);
}

// -------------- Backtest / paper engine --------------
function makeCtxAt(i, highs,lows,closes,opens,volumes, reqTF){
  const h=highs.slice(0,i+1), l=lows.slice(0,i+1), c=closes.slice(0,i+1), o=opens.slice(0,i+1), v=volumes.slice(0,i+1);
  return { highs:h, lows:l, closes:c, opens:o, volumes:v, atr:null, reqTF };
}
function signalFromSnapshot(ctx){
  const price = ctx.closes.at(-1);
  const ema50v = ema(ctx.closes,50), rsi14v = rsi(ctx.closes,14), m = macd(ctx.closes);
  const up = (ema50v!=null && price>ema50v) || (rsi14v!=null && rsi14v>50) || (m.hist!=null && m.hist>0);
  const down = (ema50v!=null && price<ema50v) || (rsi14v!=null && rsi14v<50) || (m.hist!=null && m.hist<0);
  if (up && !down) return "BUY";
  if (down && !up) return "SELL";
  return "HOLD";
}
function simulatePaper(highs,lows,closes,opens,volumes, timeframe, strategy, maxBars=400){
  const n = closes.length;
  const start = Math.max(60, n - maxBars); // leave warmup
  const trades = [];
  let pos = null; // { side, entry, stop, target1, target2, iEnter, reason }
  let equity = 0; const points = [{ i:start, equity }];

  for (let i=start; i<n; i++){
    const ctx = makeCtxAt(i, highs,lows,closes,opens,volumes, timeframe);
    ctx.atr = atr(ctx.highs, ctx.lows, ctx.closes, 14) || (ctx.closes.at(-1)*0.01);

    // evaluate custom strategy if provided
    let rulesOK = true, optScore = 0.5;
    if (strategy && Array.isArray(strategy.rules)){
      const results = strategy.rules.map(r => evalRule(r, { ...ctx }));
      const req = results.filter(r=> r.req), opt = results.filter(r=> !r.req);
      rulesOK = req.length ? req.every(r=> r.ok) : true;
      optScore = opt.length ? opt.filter(r=> r.ok).length/opt.length : 0.5;
    }

    const base = signalFromSnapshot(ctx);
    const side = (rulesOK && optScore>=0.5) ? base : "HOLD";

    // manage open position
    if (pos){
      // check stop/targets using current bar range
      const H = highs[i], L = lows[i], C = closes[i];
      if (pos.side==="BUY"){
        if (L <= pos.stop){ // stop hit first
          const pl = pos.stop - pos.entry; equity += pl; trades.push({ ...pos, exit:C, exitI:i, pl, exitReason:"Stop hit" }); pos=null;
        } else if (H >= pos.target2){
          const pl = pos.target2 - pos.entry; equity += pl; trades.push({ ...pos, exit:C, exitI:i, pl, exitReason:"Target2" }); pos=null;
        } else if (H >= pos.target1){
          // scale out half at T1, trail to BE
          pos.target1Hit = true;
        } else if (side==="SELL"){ // opposite signal exit
          const pl = C - pos.entry; equity += pl; trades.push({ ...pos, exit:C, exitI:i, pl, exitReason:"Opposite signal" }); pos=null;
        }
      } else if (pos.side==="SELL"){
        if (H >= pos.stop){
          const pl = pos.entry - pos.stop; equity += pl; trades.push({ ...pos, exit:C, exitI:i, pl, exitReason:"Stop hit" }); pos=null;
        } else if (L <= pos.target2){
          const pl = pos.entry - pos.target2; equity += pl; trades.push({ ...pos, exit:C, exitI:i, pl, exitReason:"Target2" }); pos=null;
        } else if (L <= pos.target1){
          pos.target1Hit = true;
        } else if (side==="BUY"){
          const pl = pos.entry - C; equity += pl; trades.push({ ...pos, exit:C, exitI:i, pl, exitReason:"Opposite signal" }); pos=null;
        }
      }
    }

    // open new position
    if (!pos && (side==="BUY" || side==="SELL")){
      const price = closes[i];
      const a = ctx.atr || (price*0.01);
      const entry = price;
      const stop = side==="BUY" ? (price - 1.2*a) : (price + 1.2*a);
      const target1 = side==="BUY" ? (price + (price - stop)) : (price - (stop - price));
      const target2 = side==="BUY" ? (price + 2*(price - stop)) : (price - 2*(stop - price));
      pos = { side, entry, stop, target1, target2, iEnter:i, reason: rulesOK ? "Rules met" : "Heuristic" };
    }

    points.push({ i, equity });
  }

  // close if still open at end
  if (pos){
    const C = closes.at(-1);
    const pl = pos.side==="BUY" ? (C - pos.entry) : (pos.entry - C);
    equity += pl; trades.push({ ...pos, exit:C, exitI:closes.length-1, pl, exitReason:"End of test" });
  }

  // stats
  const wins = trades.filter(t=> t.pl>0).length;
  const losses = trades.filter(t=> t.pl<=0).length;
  let maxDD = 0, peak=0, eq=0;
  const curve = []; for (let k=0;k<points.length;k++){ eq = points[k].equity; peak = Math.max(peak, eq); maxDD = Math.min(maxDD, eq - peak); curve.push(eq); }

  return {
    trades,
    summary: {
      total: trades.length,
      wins, losses,
      winrate: trades.length ? +(wins/trades.length*100).toFixed(2) : 0,
      net: +equity.toFixed(4),
      maxDrawdown: +maxDD.toFixed(4)
    },
    equity: curve
  };
}

// ---------------- Handler ----------------
export default async function handler(req, res) {
  if (req.method === "GET") {
    res.setHeader("Content-Type","text/html; charset=utf-8");
    return res.status(200).send(`<!doctype html><meta charset="utf-8"><title>Analyze</title>
      <style>body{font-family:system-ui;background:#0b1220;color:#e6e9ef;padding:24px}</style>
      <h1>TrueTrend API</h1>
      <p>POST /api/analyze with {"symbol":"AAPL","timeframe":"15m","mode":"signal|backtest|voice","strategy":{...}}</p>`);
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", ["GET","POST"]);
    return res.status(405).json({ error:true, message:"Method not allowed" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body||"{}") : (req.body||{});
    let { symbol, timeframe, strategy, mode, bars, alexa } = body;
    if (!symbol) return res.status(400).json({ error:true, message:"Missing symbol" });
    timeframe = timeframe || "15m";
    mode = mode || "signal";
    bars = Math.max(100, Math.min(Number(bars||400), 1000)); // cap

    const token = process.env.FINNHUB_API_KEY;
    if (!token) return res.status(500).json({ error:true, message:"FINNHUB_API_KEY not set on server" });

    // Quote
    const qUrl = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(token)}`;
    const qRes = await fetchFinnhubJSON(qUrl);
    if (!qRes.ok) return res.status(qRes.status).json({ error:true, message:qRes.data?.error || qRes.text || "Quote error" });
    const quote = qRes.data;

    // Candles
    const reso = mapTF(timeframe);
    const nowSec = Math.floor(Date.now()/1000);
    const width = { "1": 2*24*60*60, "5": 10*24*60*60, "15": 20*24*60*60, "30": 40*24*60*60, "60": 120*24*60*60, "240": 365*24*60*60, "D": 3*365*24*60*60, "W": 5*365*24*60*60, "M": 15*365*24*60*60 }[reso] || 20*24*60*60;
    const from = nowSec - width;
    const cRes = await getCandles(symbol, reso, from, nowSec, token);
    if (!cRes.ok || cRes.data?.s === "no_data") return res.status(502).json({ error:true, message:"No candle data", detail:cRes.data });
    const c = cRes.data;
    const highs = c.h || [], lows = c.l || [], closes = c.c || [], opens = c.o || [], volumes = c.v || [];
    if (closes.length < 60) return res.status(502).json({ error:true, message:"Insufficient candles" });

    // Indicators snapshot
    const ctx = { highs, lows, closes, opens, volumes, atr:null, reqTF: timeframe };
    const ema9 = ema(closes,9), ema50 = ema(closes,50), ema200 = ema(closes,200);
    const rsi14 = rsi(closes,14);
    const mac = macd(closes);
    const k = stochK(highs,lows,closes,14);
    const wr = williamsR(highs,lows,closes,14);
    const atr14 = atr(highs,lows,closes,14);
    ctx.atr = atr14;

    // strategy evaluation (latest)
    let evalResult = null;
    if (strategy && Array.isArray(strategy.rules)){
      const results = strategy.rules.map(rule => evalRule(rule, { ...ctx }));
      const required = results.filter(r=> r.req);
      const optional = results.filter(r=> !r.req);
      const reqOk = required.length ? required.every(r=> r.ok) : true;
      const optScore = optional.length ? optional.filter(r=> r.ok).length/optional.length : 0.5;
      evalResult = { name: strategy.name || "Custom Strategy", baseTF: strategy.baseTF || timeframe, rules: results, all_required_met: reqOk, optional_score: optScore };
    }

    // bias & best strategy
    const price = closes.at(-1);
    const biasUp = (ema50!=null && price>ema50) || (rsi14!=null && rsi14>50) || (mac.hist!=null && mac.hist>0);
    const biasDown = (ema50!=null && price<ema50) || (rsi14!=null && rsi14<50) || (mac.hist!=null && mac.hist<0);
    const best = pickBestStrategy(ctx, { ema9, ema50, rsi14, macdHist: mac.hist, stochK:k, wr, atr14 });

    // live signal
    const liveAction = biasUp && !biasDown ? "BUY" : biasDown && !biasUp ? "SELL" : "HOLD";
    let conf = 60;
    if (liveAction==="HOLD") conf = 50;
    if (evalResult){
      if (evalResult.all_required_met && evalResult.optional_score>=0.5) conf += 20;
      else if (!evalResult.all_required_met) conf -= 10;
    }
    conf = Math.max(0, Math.min(100, conf));
    const a = atr14 || (price*0.01);
    const entry = price, stop = liveAction==="BUY" ? (price - 1.2*a) : liveAction==="SELL" ? (price + 1.2*a) : null;
    const targets = stop!=null ? [ +(price + (price - stop)).toFixed(4), +(price + 2*(price - stop)).toFixed(4) ] : [];

    if (mode === "voice"){
      const action = liveAction==="HOLD" ? "no clear entry yet" : `${liveAction} around ${entry.toFixed(4)} with stop ${stop?.toFixed(4)} and targets ${targets.map(t=>t.toFixed? t.toFixed(4):t).join(" and ")}`;
      const speech = `For ${symbol} on ${timeframe}, ${action}. Confidence ${conf} percent. Best strategy now is ${best.best}.`;
      if (alexa) {
        return res.status(200).json({
          version: "1.0",
          response: { outputSpeech: { type: "PlainText", text: speech }, shouldEndSession: true }
        });
      }
      return res.status(200).json({ ok:true, speech, symbol, timeframe });
    }

    if (mode === "backtest"){
      const sim = simulatePaper(highs,lows,closes,opens,volumes,timeframe, strategy, bars);
      return res.status(200).json({
        ok:true, symbol, timeframe,
        summary: sim.summary,
        trades: sim.trades,
        equity: sim.equity
      });
    }

    // default: signal
    return res.status(200).json({
      ok:true,
      symbol, timeframe,
      quote,
      indicators: { ema9, ema50, ema200, rsi14, macd:mac, stochK:k, wr, atr14 },
      strategy_evaluation: evalResult,
      signal: {
        action: liveAction,
        confidence: conf,
        entry, stop, targets,
        best_strategy_now: best.best,
        scores: best.scores,
        rationale: [
          biasUp ? "Bullish bias (EMA/RSI/MACD)" : (biasDown ? "Bearish bias (EMA/RSI/MACD)" : "Mixed signals"),
          evalResult ? (evalResult.all_required_met ? "Custom rules satisfied" : "Custom required rules not all met") : "No custom rules"
        ]
      }
    });

  } catch (err) {
    console.error("analyze error:", err);
    return res.status(500).json({ error:true, message:"Unexpected server error" });
  }
}
