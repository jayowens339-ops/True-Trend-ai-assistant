// /api/analyze.js  — Next.js/Vercel API route (Node runtime)
//
// POST JSON: { symbol: "NVDA", timeframe: "Daily"|"Weekly"|"4h"|"1h"|"15m", strategy: "trendline"|"cross"|"rsiReversal"|"breakout" }
// Returns: { quote, indicators, signal{action,confidence,reasons}, targets, voiceText }

export const config = { runtime: "nodejs" };

const UA = { "User-Agent": "TrueTrend/1.0 (+https://www.truetrendtrading.com)" };

export default async function handler(req, res) {
  // CORS (so index.html can call from anywhere during testing)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") return json(res, { error: true, message: "Use POST" }, 405);

  try {
    const body = await readJSON(req);
    const symbol = (body.symbol || "").trim();
    const timeframe = body.timeframe || "Daily";
    const strategy = body.strategy || "trendline";
    if (!symbol) return json(res, { error: true, message: "Missing symbol" }, 400);

    // 1) fetch candles from Yahoo
    const { interval, range, aggregate } = tfToYahoo(timeframe);
    const yahooSym = toYahoo(symbol);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=${range}&interval=${interval}`;
    const r = await fetch(url, { headers: UA });
    if (!r.ok) return json(res, { error: true, message: `Upstream ${r.status}` }, 502);
    const data = await r.json();
    const rt = data?.chart?.result?.[0];
    const q = rt?.indicators?.quote?.[0];
    if (!rt || !q || !Array.isArray(rt.timestamp)) return json(res, { error: true, message: "No data" }, 502);

    // 2) aggregate for 4h if needed
    let c = q.close, h = q.high, l = q.low, o = q.open, t = rt.timestamp;
    if (aggregate === 4) {
      const A = aggN({ c, h, l, o, t }, 4);
      c = A.c; h = A.h; l = A.l; o = A.o; t = A.t;
    }
    if (!c || c.length < 60) return json(res, { error: true, message: "Insufficient candles" }, 502);

    // 3) indicators
    const ema9 = ema(c, 9);
    const ema50 = ema(c, 50);
    const rsi14 = rsi(c, 14);
    const mac = macd(c);
    const last = c.at(-1), hi = h.at(-1), lo = l.at(-1), op = o.at(-1);

    // 4) optional higher-TF bias (for intraday)
    let htSlopeOK = true;
    if (["15m", "1h", "4h"].includes(timeframe)) {
      const u2 = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=6mo&interval=1d`;
      const r2 = await fetch(u2, { headers: UA });
      const d2 = await r2.json();
      const rc = d2?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
      if (rc.length > 50) {
        const e2 = ema(rc, 50);
        htSlopeOK = slope(e2, 6) >= 0; // up-bias
      }
    }

    // 5) decide signal
    const sig = decideSignal({ strategy, c, h, l, ema9, ema50, rsi14, mac, htSlopeOK });
    const tgt = targetsFromSignal(sig, last);
    const voiceText = buildVoice(symbol, timeframe, last, sig);

    // 6) respond
    return json(res, {
      error: false,
      quote: { c: num(last), h: num(hi), l: num(lo), o: num(op), t: rt.meta?.regularMarketTime || Math.floor(Date.now() / 1000) },
      indicators: { ema9: num(ema9.at(-1)), ema50: num(ema50.at(-1)), rsi14: num(rsi14.at(-1)), macd: { hist: num(mac.hist.at(-1)) } },
      signal: sig,
      targets: tgt,
      voiceText
    });
  } catch (e) {
    console.error(e);
    return json(res, { error: true, message: e.message || "Server error" }, 500);
  }
}

/* ---------------- Helpers ---------------- */

function toYahoo(sym) {
  // OANDA:EUR_USD -> EURUSD=X ; BTCUSD -> BTC-USD ; BINANCE:BTCUSDT -> BTC-USD
  if (/^OANDA:([A-Z]{3})_([A-Z]{3})$/.test(sym)) return RegExp.$1 + RegExp.$2 + "=X";
  if (/^BINANCE:([A-Z]+)USDT$/i.test(sym)) return RegExp.$1.toUpperCase() + "-USD";
  if (/^([A-Z]+)USD$/i.test(sym)) return RegExp.$1.toUpperCase() + "-USD";
  return sym;
}
function tfToYahoo(tf) {
  switch (tf) {
    case "15m": return { interval: "15m", range: "5d" };
    case "1h":  return { interval: "60m", range: "1mo" };
    case "4h":  return { interval: "60m", range: "3mo", aggregate: 4 };
    case "Weekly": return { interval: "1wk", range: "2y" };
    default: return { interval: "1d", range: "6mo" }; // Daily
  }
}
function aggN({ c, h, l, o, t }, n) {
  const C=[], H=[], L=[], O=[], T=[];
  for (let i=0; i<c.length; i+=n) {
    const segC = c.slice(i, i+n);
    if (segC.length < n) break;
    C.push(segC.at(-1));
    H.push(Math.max(...h.slice(i, i+n)));
    L.push(Math.min(...l.slice(i, i+n)));
    O.push(o[i]);
    T.push(t[i]);
  }
  return { c:C, h:H, l:L, o:O, t:T };
}
function ema(arr, period) {
  const k = 2 / (period + 1);
  let prev = arr[0];
  const out = [prev];
  for (let i=1;i<arr.length;i++) { const v = arr[i] * k + prev * (1 - k); out.push(v); prev = v; }
  return out;
}
function rsi(arr, p=14) {
  const out = Array(arr.length).fill(50);
  if (arr.length < p+1) return out;
  let gains=0, losses=0;
  for (let i=1;i<=p;i++){ const ch=arr[i]-arr[i-1]; if(ch>=0) gains+=ch; else losses-=ch; }
  let ag=gains/p, al=losses/p;
  out[p] = 100 - 100/(1 + (ag/(al||1e-9)));
  for (let i=p+1;i<arr.length;i++){
    const ch=arr[i]-arr[i-1], g=ch>0?ch:0, l=ch<0?-ch:0;
    ag=(ag*(p-1)+g)/p; al=(al*(p-1)+l)/p;
    out[i]=100 - 100/(1 + (ag/(al||1e-9)));
  }
  return out;
}
function macd(arr, fast=12, slow=26, sig=9) {
  const eF = ema(arr, fast), eS = ema(arr, slow);
  const line = eF.map((v,i)=> v - eS[i]);
  const signal = ema(line.slice(slow-1), sig);
  const hist = line.slice(slow-1).map((v,i)=> v - signal[i]);
  const pad = Array(arr.length - hist.length).fill(undefined);
  return { line: pad.concat(line.slice(slow-1)), signal: pad.concat(signal), hist: pad.concat(hist) };
}
function slope(arr, n=6) {
  const s = arr.slice(-n);
  if (s.length < 2) return 0;
  const f = s[0], l = s[s.length-1];
  return (l - f) / Math.max(Math.abs(f), 1e-9);
}
function decideSignal({ strategy, c, h, l, ema9, ema50, rsi14, mac, htSlopeOK }) {
  const i = c.length - 1;
  const price = c[i];
  const bull = ema9[i] > ema50[i];
  const emaSlope = slope(ema50, 6);
  const rsiV = rsi14[i];
  const macH = mac.hist.at(-1);
  const reasons = [];
  let action = "HOLD", conf = 50;

  if (strategy === "cross") {
    const up = ema9[i] > ema50[i] && ema9[i-1] <= ema50[i-1];
    const dn = ema9[i] < ema50[i] && ema9[i-1] >= ema50[i-1];
    if (up) { action = "BUY"; reasons.push("EMA9 crossed above EMA50"); }
    if (dn) { action = "SELL"; reasons.push("EMA9 crossed below EMA50"); }
    conf = Math.min(95, Math.abs(emaSlope)*300 + (up||dn?25:0) + (htSlopeOK?15:0) + (macH>0?10:0));
    if (!htSlopeOK && action === "BUY") { reasons.push("Higher timeframe not aligned"); conf -= 15; }
    if (htSlopeOK && action === "SELL") { reasons.push("Higher timeframe up, fade"); conf -= 15; }
  } else if (strategy === "rsiReversal") {
    if (rsiV < 32) { action = "BUY"; reasons.push("RSI near oversold"); }
    else if (rsiV > 68) { action = "SELL"; reasons.push("RSI near overbought"); }
    else reasons.push("RSI mid-range");
    conf = Math.min(92, (70 - Math.abs(50 - rsiV))*(-1) + 80 + (macH>0?8:0));
  } else if (strategy === "breakout") {
    const HH = Math.max(...h.slice(-20,-1));
    const LL = Math.min(...l.slice(-20,-1));
    if (price > HH) { action = "BUY"; reasons.push("Breaking 20-bar high"); }
    else if (price < LL) { action = "SELL"; reasons.push("Breaking 20-bar low"); }
    else reasons.push("Still inside range");
    conf = Math.min(90, (price>HH||price<LL?70:40) + (macH>0?6:0) + (bull?6:-2));
  } else { // trendline (default)
    if (emaSlope > 0 && price >= ema9[i]) { action = "BUY"; reasons.push("EMA50 slope up + above EMA9"); }
    else if (emaSlope < 0 && price <= ema9[i]) { action = "SELL"; reasons.push("EMA50 slope down + below EMA9"); }
    else reasons.push("No clean alignment");
    conf = Math.min(93, Math.abs(emaSlope)*400 + (macH>0?10:0) + (bull?8:-4) + (htSlopeOK?10:0));
  }

  conf = Math.max(5, Math.min(98, Math.round(conf)));
  if (action === "HOLD") reasons.push("No edge detected");
  return { action, confidence: conf, reasons };
}
function targetsFromSignal(sig, price) {
  if (sig.action === "BUY")  return { entry: num(price), stop: num(price*0.98), tp: num(price*1.03) };
  if (sig.action === "SELL") return { entry: num(price), stop: num(price*1.02), tp: num(price*0.97) };
  return {};
}
function buildVoice(symbol, tf, price, sig) {
  const mood = sig.confidence>80 ? "high confidence" : sig.confidence>60 ? "good confidence" : "low confidence";
  return `On ${symbol} ${tf}, price around ${num(price)}. Signal is ${sig.action.toLowerCase()} with ${sig.confidence} percent, ${mood}. Reasons: ${sig.reasons.slice(0,3).join("; ")}.`;
}
function num(n, d=4){ return (n!=null && !Number.isNaN(n)) ? Number(n.toFixed(d)) : n; }
function json(res, obj, code=200){ res.status(code).setHeader("content-type","application/json").end(JSON.stringify(obj)); }
function readJSON(req){ return new Promise((ok,err)=>{ let b=""; req.on("data",c=>b+=c); req.on("end",()=>{ try{ ok(b?JSON.parse(b):{}); }catch(e){ err(e); } }); }); }
