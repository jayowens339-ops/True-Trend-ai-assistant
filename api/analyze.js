// Vercel serverless (Node 18+)
export const runtime = 'nodejs';
const API_KEY = process.env.FINNHUB_API_KEY; // optional now (we'll fall back to Yahoo)

// ---------- helpers ----------
const RES_MAP = {
  '15m':'15','30m':'30','1h':'60','4h':'240','Daily':'D','Weekly':'W','Monthly':'M'
};
const SEC_PER_RES = { '1':60,'5':300,'15':900,'30':1800,'60':3600,'240':14400,'D':86400,'W':604800,'M':2592000 };

function assetType(sym){
  if (/^OANDA:|^FX:|^[A-Z]{6}=X$/.test(sym)) return 'forex';
  if (/^BINANCE:|^COINBASE:|^KRAKEN:|^BITFINEX:/.test(sym)) return 'crypto';
  return 'stock';
}

// --- Yahoo mapping ---
function toYahooSymbol(sym){
  // OANDA:EUR_USD -> EURUSD=X
  const fx = sym.match(/^OANDA:([A-Z]{3})_([A-Z]{3})$/);
  if (fx) return `${fx[1]}${fx[2]}=X`;
  // BINANCE:BTCUSDT -> BTC-USD (simple, widely supported)
  const cx = sym.match(/^BINANCE:([A-Z]+)USDT$/);
  if (cx) return `${cx[1]}-USD`;
  // plain stocks keep as-is (AAPL, NVDA, SPY, …)
  return sym;
}

function yahooIntervalRange(tf){
  switch(tf){
    case '15m': return { interval:'15m', range:'5d' };
    case '30m': return { interval:'30m', range:'1mo' };
    case '1h' : return { interval:'1h' , range:'1mo' };
    case '4h' : return { interval:'1h' , range:'3mo' }; // Yahoo lacks 4h; use 1h
    case 'Daily': return { interval:'1d', range:'1y' };
    case 'Weekly': return { interval:'1wk', range:'5y' };
    case 'Monthly': return { interval:'1mo', range:'10y' };
    default: return { interval:'1d', range:'1y' };
  }
}

// --- math helpers ---
function ema(a,p){p=+p||1; if(!a||a.length<p) return null; const k=2/(p+1); let e=a.slice(0,p).reduce((x,y)=>x+y,0)/p; for(let i=p;i<a.length;i++) e=a[i]*k+e*(1-k); return e;}
function rsi(a,p=14){if(!a||a.length<p+1) return null; let g=0,l=0; for(let i=a.length-p;i<a.length;i++){const d=a[i]-a[i-1]; if(d>=0) g+=d; else l+=-d;} const ag=g/p, al=l/p; if(al===0) return 100; const rs=ag/al; return 100-(100/(1+rs));}
function macdHist(a){ if(!a||a.length<35) return null; const e12=ema(a,12), e26=ema(a,26); if(e12==null||e26==null) return null; const macd=e12-e26; const s=[]; for(let i=a.length-35;i<a.length;i++){const x=ema(a.slice(0,i+1),12)||0; const y=ema(a.slice(0,i+1),26)||0; s.push(x-y);} const sig=ema(s,9)||0; return macd-sig;}
function atrProxy(c){ if(!c||c.length<15) return 1; const v=[]; for(let i=1;i<c.length;i++) v.push(Math.abs(c[i]-c[i-1])); const t=v.slice(-14).reduce((x,y)=>x+y,0); return t/Math.max(1,Math.min(14,v.length)); }

function makeSignal(closes){
  if(!closes || closes.length<50)
    return { action:'HOLD', confidence:0, entry:null, stop:null, targets:[], best_strategy_now:'insufficient_data', rationale:['insufficient_bars'] };
  const last = closes[closes.length-1];
  const e9=ema(closes,9), e50=ema(closes,50), r=rsi(closes,14), h=macdHist(closes);
  let action='HOLD', conf=55, why=[];
  if(e9!=null&&e50!=null&&r!=null&&h!=null){
    if(e9>e50 && r>50 && h>0){ action='BUY'; conf=70; why=['ema9>ema50','rsi>50','macd_hist>0']; }
    else if(e9<e50 && r<50 && h<0){ action='SELL'; conf=70; why=['ema9<ema50','rsi<50','macd_hist<0']; }
    else { why=['mixed']; }
  }else why=['not_enough_ind'];
  const atr=atrProxy(closes);
  const stop = action==='BUY' ? last-atr*1.5 : action==='SELL' ? last+atr*1.5 : null;
  const targets = action==='BUY' ? [last+atr*1.5,last+atr*2.5] : action==='SELL' ? [last-atr*1.5,last-atr*2.5] : [];
  return { action, confidence:conf, entry:last, stop, targets, best_strategy_now:'ema_rsi_macd', rationale:why };
}

async function safeJSON(url){
  const r = await fetch(url);
  if(!r.ok) return { ok:false, status:r.status };
  return { ok:true, json: await r.json() };
}

// ---------- DATA PROVIDERS ----------

// Finnhub candles (with one fallback resolution); returns { c,o,h,l,t, s:'ok' } or null
async function finnhubCandles(symbol, timeframe){
  if(!API_KEY) return null;
  const base = assetType(symbol)==='crypto' ? 'crypto' : (assetType(symbol)==='forex' ? 'forex' : 'stock');
  const reso = RES_MAP[timeframe] || timeframe;
  const now = Math.floor(Date.now()/1000);
  const span = SEC_PER_RES[reso] || 900;
  const from = now - 500*span;

  const make = r => `https://finnhub.io/api/v1/${base}/candle?symbol=${encodeURIComponent(symbol)}&resolution=${r}&from=${from}&to=${now}&token=${API_KEY}`;
  const tryOne = async r => {
    const { ok, json, status } = await safeJSON(make(r));
    if(!ok){ if(status===401||status===403) throw Object.assign(new Error('no_access'),{code:status}); return null; }
    if(json && json.s==='ok' && Array.isArray(json.c) && json.c.length) return json;
    if(json && json.s==='no_data') return null;
    return null;
  };

  let c = await tryOne(reso); if(c) return c;
  const alt = reso==='W'?'D' : reso==='M'?'W' : reso==='60'?'30' : reso==='30'?'15' : reso==='15'?'5' : 'D';
  return await tryOne(alt);
}

// Yahoo candles; returns { t,c,o,h,l, s:'ok' } or null
async function yahooCandles(symbol, timeframe){
  const y = toYahooSymbol(symbol);
  const { interval, range } = yahooIntervalRange(timeframe);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?range=${range}&interval=${interval}`;
  const { ok, json } = await safeJSON(url);
  if(!ok) return null;
  const r = json?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  if(!r || !q || !Array.isArray(r.timestamp) || !Array.isArray(q.close)) return null;
  return { t:r.timestamp, c:q.close, o:q.open, h:q.high, l:q.low, s:'ok' };
}

// Quote (Finnhub -> Yahoo fallback)
async function fetchQuote(symbol){
  try{
    if(API_KEY && assetType(symbol)==='stock'){
      const { ok, json } = await safeJSON(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${API_KEY}`);
      if(ok && json && json.c!=null) return { c:json.c, o:json.o, h:json.h, l:json.l, pc:json.pc, t:json.t };
    }
  }catch(_e){}
  // Yahoo fallback
  const y = toYahooSymbol(symbol);
  const { ok, json } = await safeJSON(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(y)}`);
  const r = json?.quoteResponse?.result?.[0];
  if(r) return {
    c:r.regularMarketPrice ?? null,
    o:r.regularMarketOpen ?? null,
    h:r.regularMarketDayHigh ?? null,
    l:r.regularMarketDayLow ?? null,
    pc:r.regularMarketPreviousClose ?? null,
    t:Math.floor(Date.now()/1000)
  };
  return { c:null,o:null,h:null,l:null,pc:null,t:null };
}

// ---------- HTTP HANDLER ----------
export default async function handler(req, res){
  if(req.method!=='POST'){
    return res
      .status(200)
      .setHeader('Content-Type','text/html; charset=utf-8')
      .send(`<html><head><meta charset="utf-8"><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial;background:#0b1220;color:#e6e9ef;padding:24px}</style><title>TrueTrend API</title></head><body><h1>TrueTrend API</h1><p>POST /api/analyze with {"symbol":"AAPL","timeframe":"15m"}</p></body></html>`);
  }

  try{
    const body = await readJSON(req);
    const symbol = (body.symbol||'').trim();
    const timeframe = body.timeframe || '15m';
    if(!symbol) return res.status(400).json({ error:true, message:'Missing symbol' });

    // 1) quote (best-effort)
    const quote = await fetchQuote(symbol);

    // 2) candles: Finnhub -> Yahoo
    let candles = null, note = '';
    try{
      candles = await finnhubCandles(symbol, timeframe);
    }catch(e){
      if(e && e.message==='no_access') note = 'provider_access_denied';
    }
    if(!candles){
      const y = await yahooCandles(symbol, timeframe);
      if(y) { candles = y; note = note ? (note + ', finnhub_no_data_fallback_yahoo') : 'finnhub_no_data_fallback_yahoo'; }
    }

    if(!candles){
      return res.status(200).json({
        error:false,
        note: note || 'no_data_all_providers',
        quote,
        indicators:{},
        signal:{ action:'HOLD', confidence:0, entry:quote?.c ?? null, stop:null, targets:[], best_strategy_now:'insufficient_data', rationale:['no_data'] }
      });
    }

    const closes = candles.c || [];
    const indicators = {
      ema9: ema(closes,9),
      ema50: ema(closes,50),
      rsi14: rsi(closes,14),
      macd: { hist: macdHist(closes) }
    };
    const signal = makeSignal(closes);

    return res.status(200).json({ error:false, note, quote, indicators, signal });
  }catch(err){
    return res.status(200).json({ error:false, note:'internal_handled', message:String(err.message||err) });
  }
}

// ---------- body parsing ----------
function readJSON(req){
  if(req.body && typeof req.body==='object') return Promise.resolve(req.body);
  return new Promise((resolve,reject)=>{
    let d=''; req.on('data',c=>d+=c); req.on('end',()=>{ try{ resolve(JSON.parse(d||'{}')); }catch{ resolve({}); } }); req.on('error',reject);
  });
}
