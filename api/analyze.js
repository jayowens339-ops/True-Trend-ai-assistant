// /api/analyze.js
export const config = { runtime: 'nodejs' };

const Y = (s, p) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?${new URLSearchParams(p).toString()}`;

function ema(arr, period){
  const k = 2/(period+1);
  let prev = arr[0];
  const out = [prev];
  for(let i=1;i<arr.length;i++){
    const v = arr[i]*k + prev*(1-k);
    out.push(v); prev = v;
  }
  return out;
}
function rsi(arr, period=14){
  let gains=0, losses=0;
  for(let i=1;i<=period;i++){
    const ch = arr[i]-arr[i-1];
    if(ch>=0) gains+=ch; else losses-=ch;
  }
  let rs = gains/(losses||1e-9);
  const out=[...Array(period).fill(50), 100-100/(1+rs)];
  for(let i=period+1;i<arr.length;i++){
    const ch = arr[i]-arr[i-1];
    const g = ch>0?ch:0, l = ch<0?-ch:0;
    gains = (gains*(period-1)+g)/period;
    losses = (losses*(period-1)+l)/period;
    rs = gains/(losses||1e-9);
    out.push(100-100/(1+rs));
  }
  return out;
}
function macd(arr, fast=12, slow=26, sig=9){
  const emaF = ema(arr, fast), emaS = ema(arr, slow);
  const line = emaF.map((v,i)=> v - emaS[i]);
  const signal = ema(line.slice(slow-1), sig); // align
  const hist = line.slice(slow-1).map((v,i)=> v - signal[i]);
  // pad to same length as arr with undefineds
  const pad = Array(arr.length - hist.length).fill(undefined);
  return { line: pad.concat(hist.map((_,i)=>line[i+slow-1])), signal: pad.concat(signal), hist: pad.concat(hist) };
}

function tfToYahoo(tf){
  switch(tf){
    case '15m': return { interval:'15m', range:'5d' };
    case '1h':  return { interval:'60m', range:'1mo' };
    case '4h':  return { interval:'60m', range:'3mo', aggregate:4 }; // aggregate 4x 1h bars
    case 'Weekly': return { interval:'1wk', range:'2y' };
    default: return { interval:'1d', range:'6mo' }; // Daily
  }
}
function aggregateN(closes, highs, lows, opens, volumes, n){
  if(!n || n===1) return { c:closes, h:highs, l:lows, o:opens, v:volumes };
  const C=[],H=[],L=[],O=[],V=[];
  for(let i=0;i<closes.length;i+=n){
    const sliceC = closes.slice(i,i+n);
    if(sliceC.length<n) break;
    C.push(sliceC[sliceC.length-1]);
    H.push(Math.max(...highs.slice(i,i+n)));
    L.push(Math.min(...lows.slice(i,i+n)));
    O.push(opens[i]);
    V.push(volumes.slice(i,i+n).reduce((a,b)=>a+b,0));
  }
  return { c:C,h:H,l:L,o:O,v:V };
}

function slope(arr, n=5){ // simple slope over last n bars
  const a = arr.slice(-n);
  const first = a[0], last = a[a.length-1];
  return (last-first) / Math.max(Math.abs(first), 1e-9);
}

function fmt(n){ return (n!=null && !Number.isNaN(n)) ? Number(n.toFixed(4)) : n; }

export default async function handler(req,res){
  try{
    if(req.method!=='POST') return res.status(405).send('Method not allowed');
    const { symbol, timeframe='Daily', strategy='trendline' } = await readJSON(req);
    if(!symbol) return json(res,{ error:true, message:'Missing symbol' },400);

    const { interval, range, aggregate } = tfToYahoo(timeframe);
    const url = Y(symbol, { interval, range, includePrePost:'false' });

    const r = await fetch(url, { headers: { 'User-Agent':'Mozilla/5.0 TrueTrend' } });
    if(!r.ok) return json(res,{ error:true, message:`Upstream ${r.status}` },502);
    const data = await r.json();
    const rt = data?.chart?.result?.[0];
    if(!rt) return json(res,{ error:true, message:'No candle data', detail:data },502);

    const closes = rt.indicators?.quote?.[0]?.close || [];
    const highs  = rt.indicators?.quote?.[0]?.high  || [];
    const lows   = rt.indicators?.quote?.[0]?.low   || [];
    const opens  = rt.indicators?.quote?.[0]?.open  || [];
    const vols   = rt.indicators?.quote?.[0]?.volume|| [];
    if(closes.length<60) return json(res,{ error:true, message:'Insufficient candles' },502);

    // optional 4h aggregation from 1h bars
    const agg = aggregateN(closes, highs, lows, opens, vols, aggregate||1);
    const c = agg.c, h = agg.h, l = agg.l, o = agg.o, v = agg.v;

    const ema9  = ema(c,9);
    const ema50 = ema(c,50);
    const rsi14 = rsi(c,14);
    const mac   = macd(c);

    const last = c[c.length-1], hi=h[h.length-1], lo=l[l.length-1];
    const q = { c:last, h:hi, l:lo, o:o[o.length-1], t:rt.meta?.regularMarketTime || Date.now()/1000 };

    // Multi-TF filter: check higher timeframe slope (daily when intraday)
    let htSlopeOK = true;
    if(['15m','1h','4h'].includes(timeframe)){
      const u2 = Y(symbol, { interval:'1d', range:'6mo' });
      const r2 = await fetch(u2, { headers: { 'User-Agent':'Mozilla/5.0 TrueTrend' } });
      const d2 = await r2.json();
      const rc = d2?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
      if(rc.length>50){
        const e2 = ema(rc,50);
        htSlopeOK = slope(e2,6) >= 0; // up bias
      }
    }

    const sig = decideSignal({ strategy, c, h, l, ema9, ema50, rsi14, mac, htSlopeOK });
    const voiceText = buildVoice(symbol, timeframe, q.c, sig);

    json(res,{
      error:false,
      note: 'yahoo_chart',
      quote: { c:q.c, h:q.h, l:q.l, o:q.o, t:q.t },
      indicators: {
        ema9: fmt(ema9.at(-1)), ema50: fmt(ema50.at(-1)),
        rsi14: fmt(rsi14.at(-1)), macd: { hist: fmt(mac.hist.at(-1)) }
      },
      signal: sig,
      targets: targetsFromSignal(sig, q.c),
      voiceText
    });
  }catch(e){
    console.error(e);
    json(res,{ error:true, message:e.message||'Server error' },500);
  }
}

function decideSignal({ strategy, c, h, l, ema9, ema50, rsi14, mac, htSlopeOK }){
  const n=c.length-1, price=c[n];
  const bull = ema9[n]>ema50[n];
  const emaSlope = slope(ema50,6);
  const rsiV = rsi14[n];
  const macH = mac.hist[mac.hist.length-1];

  const reasons=[];
  let action='HOLD', conf=50;

  if(strategy==='cross'){
    const crossUp = ema9[n]>ema50[n] && ema9[n-1]<=ema50[n-1];
    const crossDn = ema9[n]<ema50[n] && ema9[n-1]>=ema50[n-1];
    if(crossUp){ action='BUY'; reasons.push('EMA9 crossed above EMA50'); }
    if(crossDn){ action='SELL'; reasons.push('EMA9 crossed below EMA50'); }
    conf = Math.min(95, Math.abs(emaSlope)*300 + (crossUp||crossDn?25:0) + (htSlopeOK?15:0) + (macH>0?10:0));
    if(!htSlopeOK && action==='BUY') { reasons.push('Higher timeframe not aligned'); conf-=15; }
    if(htSlopeOK && action==='SELL'){ reasons.push('Higher timeframe up, fade'); conf-=15; }
  }
  else if(strategy==='rsiReversal'){
    if(rsiV<32){ action='BUY'; reasons.push('RSI near oversold'); }
    else if(rsiV>68){ action='SELL'; reasons.push('RSI near overbought'); }
    else reasons.push('RSI mid-range');
    conf = Math.min(92, (70-Math.abs(50-rsiV))*(-1)+80 + (macH>0?8:0));
  }
  else if(strategy==='breakout'){
    const HH = Math.max(...h.slice(-20,-1));
    const LL = Math.min(...l.slice(-20,-1));
    if(price>HH){ action='BUY'; reasons.push('Breaking 20-bar high'); }
    else if(price<LL){ action='SELL'; reasons.push('Breaking 20-bar low'); }
    else reasons.push('Still inside range');
    conf = Math.min(90, (price>HH||price<LL?70:40) + (macH>0?6:0) + (bull?6:-2));
  }
  else { // trendline
    if(emaSlope>0 && price>=ema9[n]){ action='BUY'; reasons.push('EMA50 slope up + above EMA9'); }
    else if(emaSlope<0 && price<=ema9[n]){ action='SELL'; reasons.push('EMA50 slope down + below EMA9'); }
    else reasons.push('No clean alignment');
    conf = Math.min(93, Math.abs(emaSlope)*400 + (macH>0?10:0) + (bull?8:-4) + (htSlopeOK?10:0));
  }

  conf = Math.max(5, Math.min(98, Math.round(conf)));
  if(action==='HOLD') reasons.push('No edge detected');
  return { action, confidence: conf, reasons };
}

function targetsFromSignal(sig, price){
  if(sig.action==='BUY')  return { entry: price, stop: price*0.98, tp: price*1.03 };
  if(sig.action==='SELL') return { entry: price, stop: price*1.02, tp: price*0.97 };
  return { };
}

function buildVoice(symbol, tf, price, sig){
  const act = sig.action==='BUY' ? 'buy' : sig.action==='SELL' ? 'sell' : 'hold';
  const mood = sig.confidence>80 ? 'high confidence' : sig.confidence>60 ? 'good confidence' : 'low confidence';
  return `On ${symbol} ${tf}, price around ${price.toFixed(2)}. Signal is ${act} with ${Math.round(sig.confidence)} percent, ${mood}. `+
         `Reasons: ${sig.reasons.slice(0,3).join('; ')}.`;
}

function json(res,obj,code=200){ res.status(code).setHeader('content-type','application/json').end(JSON.stringify(obj)); }
function readJSON(req){ return new Promise((resolve,reject)=>{ let b=''; req.on('data',c=>b+=c); req.on('end',()=>{ try{resolve(b?JSON.parse(b):{});}catch(e){reject(e);} }); }); }
