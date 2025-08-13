// /api/analyze.js  — Twelve Data → Finnhub → Yahoo; plus Vision.
// Owner bypass via Authorization: Bearer <OWNER_TOKEN>.
// Works on Vercel/Node serverless.

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Use POST' });

  const OWNER = process.env.OWNER_TOKEN || '';
  const ENFORCE = String(process.env.ENFORCE_LICENSE||'1') !== '0';
  const TD_KEY = process.env.TWELVEDATA_API_KEY || '';
  const TD_EX  = process.env.TWELVEDATA_CRYPTO_EXCHANGE || 'Binance';
  const FINN   = process.env.FINNHUB_API_KEY || '';
  const OPENAI = process.env.OPENAI_API_KEY || '';

  // license (owner bypass)
  const bearer = ((req.headers.authorization||'').match(/^Bearer\s+(.+)/i)||[])[1] || '';
  if (ENFORCE && bearer !== OWNER) {
    return res.status(200).json({ ok:false, error:'license_required' });
  }

  // body
  const body = typeof req.body === 'object' ? req.body : await readJSON(req).catch(()=>({}));
  const { ticker='', timeframe='5m', strategy='Trendline', style='Day', image } = body;

  // Vision first if an image is provided
  if (image && OPENAI) {
    const v = await visionAnalyze({ image, ticker, timeframe, strategy, style, OPENAI });
    if (v.ok) return res.status(200).json(v);
    // fall through to data if vision fails
  }

  // LIVE DATA: Twelve Data → Finnhub → Yahoo
  let data = await getTwelveData(ticker, timeframe, TD_KEY, TD_EX);
  let vendor = 'twelvedata';
  if (!data.ok) {
    data = await getFinnhub(ticker, timeframe, FINN);
    vendor = 'finnhub';
  }
  if (!data.ok) {
    data = await getYahoo(ticker, timeframe);
    vendor = 'yahoo';
  }
  if (!data.ok) {
    return res.status(200).json(fallbackJson({ ticker, timeframe, strategy, error: data.error||'No data' }));
  }

  const { o,h,l,c } = data;
  if (!Array.isArray(c) || c.length < 100) {
    return res.status(200).json(fallbackJson({ ticker, timeframe, strategy, error:'Too few candles' }));
  }

  // signals + entries
  const sig = decide({ o,h,l,c, strategy, timeframe, style });
  const ex  = entryExit({ o,h,l,c, action:sig.action, style });

  const checklist = [
    `EMA9 ${EMA(9,c).at(-1) > EMA(50,c).at(-1) ? 'above' : 'below'} EMA50`,
    `Last close ${c.at(-1) >= EMA(9,c).at(-1) ? 'above' : 'below'} EMA9`,
    `Slope ${slope(c,5)>0?'up':slope(c,5)<0?'down':'flat'} (last 5 bars)`
  ];

  return res.status(200).json({
    ok: true,
    mode: vendor,
    vendor,
    ticker: (ticker||'UNKNOWN').toUpperCase(),
    timeframe,
    strategy,
    style,
    summary: `${(ticker||'UNKNOWN').toUpperCase()} on ${timeframe} — ${strategy}.`,
    checklist,
    signals: [{ action:sig.action, reason:sig.reason, confidence:sig.confidence, ttlSec:900 }],
    entryExit: ex,
    price: c.at(-1)
  });
}

/* ---------------- helpers ---------------- */
function readJSON(req){return new Promise((res,rej)=>{let d='';req.setEncoding('utf8');req.on('data',x=>d+=x);req.on('end',()=>{try{res(JSON.parse(d||'{}'))}catch(e){rej(e)}})})}
function fallbackJson({ ticker, timeframe, strategy, error }){
  return { ok:true, mode:'fallback', ticker, timeframe, strategy,
    summary:`Fallback for ${(ticker||'UNKNOWN')} on ${timeframe} — ${strategy}.`,
    checklist:['Trend check unavailable','Data fetch failed','Use conservative risk'],
    signals:[{action:'BUY',reason:'Fallback signal',confidence:0.55,ttlSec:900}],
    entryExit:{entry:'',stop:'',tp1:'',tp2:''}, error };
}

function normTF(tf){
  const s=String(tf).toLowerCase();
  if(s.includes('1m')) return { td:'1min', finn:'1', yint:'1m', yrange:'7d' };
  if(s.includes('5m')) return { td:'5min', finn:'5', yint:'5m', yrange:'60d' };
  if(s.includes('15m'))return { td:'15min',finn:'15',yint:'15m',yrange:'60d' };
  if(s.includes('1h')) return { td:'1h',  finn:'60',yint:'60m',yrange:'730d' };
  if(s.includes('4h')) return { td:'4h',  finn:'240',yint:'60m',yrange:'730d', build4h:true };
  return { td:'1day', finn:'D', yint:'1d', yrange:'10y' };
}

function classify(sym){
  const s=(sym||'').toUpperCase();
  if (!s) return 'unknown';
  if (s.includes(':')) return 'explicit';
  if (/^[A-Z]{6}$/.test(s)||/[A-Z]+\/[A-Z]+/.test(s)||(s.includes('XAU')||s.includes('XAG'))) return 'forex';
  if (/USDT$/.test(s)||/(BTC|ETH|SOL|ADA|DOGE)/.test(s)) return 'crypto';
  return 'stock';
}
function mapTD(sym, type, ex){
  let s=(sym||'').toUpperCase();
  if (type==='forex'){
    if (/^[A-Z]{6}$/.test(s)) s = s.slice(0,3)+'/'+s.slice(3);
    if (!s.includes('/')) s = s.replace(/[_:]/g,'/'); // EURUSD->EUR/USD
    return { symbol:s, params:{} };
  }
  if (type==='crypto'){
    if (/^[A-Z]{6,10}$/.test(s)) { const base=s.replace(/USDT|USD|USDC$/,''); s = base+'/USD'; }
    if (!s.includes('/')) s = s + '/USD';
    return { symbol:s, params:{ exchange:ex||'Binance' } };
  }
  return { symbol:s, params:{} }; // stock
}

/* ----- Data providers ----- */
async function getTwelveData(sym, tfRaw, key, exchange){
  if (!key) return { ok:false, error:'Missing TWELVEDATA_API_KEY' };
  const tf = normTF(tfRaw);
  const type = classify(sym);
  const { symbol, params } = mapTD(sym, type, exchange);
  if (!symbol) return { ok:false, error:'No symbol' };
  const qs = new URLSearchParams({ symbol, interval:tf.td, outputsize:'500', apikey:key, ...(params||{}) });
  const url = `https://api.twelvedata.com/time_series?${qs.toString()}`;
  const r = await safeFetch(url); if (!r.ok) return { ok:false, error:`TwelveData ${r.status}` };
  const j = await r.json();
  if (j.status==='error' || !Array.isArray(j.values)) return { ok:false, error:j?.message||'TwelveData error' };
  const vals = [...j.values].reverse(); // oldest→newest
  const t=[],o=[],h=[],l=[],c=[];
  for (const v of vals){ t.push(Math.floor(new Date(v.datetime).getTime()/1000)); o.push(+v.open); h.push(+v.high); l.push(+v.low); c.push(+v.close); }
  if (c.length<80) return { ok:false, error:'Too few candles' };
  return tf.build4h ? build4h({t,o,h,l,c}) : { ok:true, t,o,h,l,c };
}

async function getFinnhub(sym, tfRaw, key){
  if (!key) return { ok:false, error:'No Finnhub key' };
  const tf = normTF(tfRaw);
  const now = Math.floor(Date.now()/1000);
  const look = tf.finn==='D' ? 3600*24*400 : tf.finn==='240'?3600*24*60 : 3600*24*10;
  const from = now - look;
  const type = classify(sym);
  let symbol = (sym||'').toUpperCase();
  let path = '/stock/candle';
  if (type==='forex'){ symbol = `OANDA:${symbol.slice(0,3)}_${symbol.slice(-3)}`; path='/forex/candle'; }
  if (type==='crypto'){ if (!symbol.includes(':')) symbol = `BINANCE:${symbol}`; path='/crypto/candle'; }
  const url = `https://finnhub.io/api/v1${path}?symbol=${encodeURIComponent(symbol)}&resolution=${tf.finn}&from=${from}&to=${now}&token=${key}`;
  const r = await safeFetch(url); if (!r.ok) return { ok:false, error:`Finnhub ${r.status}` };
  const j = await r.json();
  if (j.s!=='ok' || !Array.isArray(j.c) || j.c.length<80) return { ok:false, error:'Finnhub no data' };
  const out = { ok:true, t:j.t, o:j.o, h:j.h, l:j.l, c:j.c };
  return tf.build4h ? build4h(out) : out;
}

async function getYahoo(sym, tfRaw){
  const tf = normTF(tfRaw);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${tf.yint}&range=${tf.yrange}`;
  const r = await safeFetch(url); if (!r.ok) return { ok:false, error:`Yahoo ${r.status}` };
  const j = await r.json();
  const R = j?.chart?.result?.[0]; const q = R?.indicators?.quote?.[0]; const ts=R?.timestamp;
  if (!q || !ts || !q.close) return { ok:false, error:'Yahoo no data' };
  const out = { ok:true, t:ts, o:q.open||[], h:q.high||[], l:q.low||[], c:q.close||[] };
  return tf.build4h ? build4h(out) : out;
}

function build4h(src){ // downsample 1h->4h
  const k=4, n=Math.floor(src.c.length/k); const t=[],o=[],h=[],l=[],c=[];
  for(let i=0;i<n;i++){const s=i*k,e=s+k; t.push(src.t[e-1]); o.push(src.o[s]); c.push(src.c[e-1]); h.push(Math.max(...src.h.slice(s,e))); l.push(Math.min(...src.l.slice(s,e))); }
  return { ok:true, t,o,h,l,c };
}

async function safeFetch(url, init){ try{ return await fetch(url, init); }catch{ return { ok:false, status:0, json:async()=>({}) }; } }

/* ----- Indicators & strategy ----- */
function EMA(p, arr){ const k=2/(p+1); const out=[]; let prev=arr.find(Number.isFinite); if(prev==null) return out; out.push(prev);
  for(let i=1;i<arr.length;i++){const v=Number.isFinite(arr[i])?arr[i]:out[out.length-1]; prev=v*k+prev*(1-k); out.push(prev);} return out;}
function slope(arr,b=5){ return (arr.at(-1)-arr.at(-1-b))||0; }
function RSI(period, arr){ let g=0,l=0; for(let i=1;i<=period;i++){const ch=arr[i]-arr[i-1]; if(ch>=0)g+=ch; else l-=ch;} g/=period; l/=period; const out=[100-100/(1+(g/(l||1e-9)))];
  for(let i=period+1;i<arr.length;i++){const ch=arr[i]-arr[i-1]; const G=ch>0?ch:0, L=ch<0?-ch:0; g=(g*(period-1)+G)/period; l=(l*(period-1)+L)/period; out.push(100-100/(1+(g/(l||1e-9)))) }
  while(out.length<arr.length) out.unshift(out[0]); return out; }
function MACD(arr,f=12,s=26,si=9){ const m=EMA(f,arr).map((v,i)=>v-(EMA(s,arr)[i]||v)); const sig=EMA(si,m); const hist=m.map((v,i)=>v-(sig[i]||0)); return {macd:m,signal:sig,hist}; }
function StochK(H,L,C,k=14){ const out=[]; for(let i=0;i<C.length;i++){const s=Math.max(0,i-k+1), e=i+1; const hh=Math.max(...H.slice(s,e)), ll=Math.min(...L.slice(s,e)); out.push(((C[i]-ll)/Math.max(1e-9,(hh-ll)))*100);} return out; }
function WilliamsR(H,L,C,look=14){ const out=[]; for(let i=0;i<C.length;i++){const s=Math.max(0,i-look+1), e=i+1; const hh=Math.max(...H.slice(s,e)), ll=Math.min(...L.slice(s,e)); out.push(-100*((hh-C[i])/Math.max(1e-9,(hh-ll)))); } return out; }
function swingLow(H,L,look=10){ let val=Infinity; for(let i=L.length-2;i>=Math.max(1,L.length-look-1);i--){ if(L[i]<L[i-1]&&L[i]<L[i+1]&&L[i]<val){val=L[i];} } return Number.isFinite(val)?val:L.at(-2); }
function swingHigh(H,L,look=10){ let val=-Infinity; for(let i=H.length-2;i>=Math.max(1,H.length-look-1);i--){ if(H[i]>H[i-1]&&H[i]>H[i+1]&&H[i]>val){val=H[i];} } return Number.isFinite(val)?val:H.at(-2); }

function decide({o,h,l,c,strategy,timeframe,style}){
  const e9=EMA(9,c), e50=EMA(50,c), last=c.at(-1), up=e9.at(-1)>e50.at(-1)&&slope(c,5)>0, down=e9.at(-1)<e50.at(-1)&&slope(c,5)<0;
  const name=String(strategy||'').toLowerCase(); let action='WAIT', reason='No setup', conf=0.55+Math.min(0.25,Math.abs((e9.at(-1)-e50.at(-1))/(e50.at(-1)||1e-9)));
  const rsi=RSI(14,c), st=StochK(h,l,c,14), wr=WilliamsR(h,l,c,14), macd=MACD(c); const dist9=Math.abs((last-(e9.at(-1)||last))/Math.max(1e-9,(e9.at(-1)||1)));

  if (name.includes('trendline')) {
    if (up) { action='BUY'; reason='Above EMA50 with rising EMA9'; }
    else if (down) { action='SELL'; reason='Below EMA50 with falling EMA9'; }
  } else if (name.includes('ema touch')) {
    if (dist9<0.003) { action = up?'BUY':'SELL'; reason=`Touching EMA9 (${(dist9*100).toFixed(2)}%)`; }
  } else if (name.includes('orb')) {
    const N=3; const hi=Math.max(...h.slice(-N-20,-20+N)), lo=Math.min(...l.slice(-N-20,-20+N));
    if (last>hi && up) { action='BUY'; reason='ORB breakout above opening range'; }
    else if (last<lo && down) { action='SELL'; reason='ORB breakdown below opening range'; }
  } else if (name.includes('support')||name.includes('resistance')) {
    const sup=swingLow(h,l,20), res=swingHigh(h,l,20);
    if (up && last>res) { action='BUY'; reason='Break and hold above resistance'; }
    else if (down && last<sup) { action='SELL'; reason='Break and hold below support'; }
  } else if (name.includes('stoch')||name.includes('williams')) {
    if (up && st.at(-1)>55 && wr.at(-1)>-45) { action='BUY'; reason='Momentum up (Stoch & W%R) with trend'; }
    else if (down && st.at(-1)<45 && wr.at(-1)<-55) { action='SELL'; reason='Momentum down (Stoch & W%R) with trend'; }
  } else if (name.includes('rsi') && name.includes('macd')) {
    if (up && rsi.at(-1)>50 && macd.macd.at(-1)>macd.signal.at(-1)) { action='BUY'; reason='RSI>50 & MACD>signal with trend'; }
    else if (down && rsi.at(-1)<50 && macd.macd.at(-1)<macd.signal.at(-1)) { action='SELL'; reason='RSI<50 & MACD<signal with trend'; }
  } else if (name.includes('break of structure')) {
    const hh=Math.max(...h.slice(-20,-10)), nh=Math.max(...h.slice(-10));
    const ll=Math.min(...l.slice(-20,-10)), nl=Math.min(...l.slice(-10));
    if (nh>hh && up) { action='BUY'; reason='Higher highs; BOS up'; }
    else if (nl<ll && down) { action='SELL'; reason='Lower lows; BOS down'; }
  } else if (name.includes('pullback continuation')) {
    const touch=(c.at(-2)<e9.at(-2) && c.at(-1)>e9.at(-1))||(c.at(-2)>e9.at(-2)&&c.at(-1)<e9.at(-1));
    if (up && touch) { action='BUY'; reason='Pullback to EMA9 then continuation'; }
    else if (down && touch) { action='SELL'; reason='Pullback to EMA9 then continuation'; }
  } else if (name.includes('mean reversion')) {
    action = (last>e9.at(-1))?'SELL':'BUY'; reason='Fade back to EMA9';
  } else {
    if (up) { action='BUY'; reason='Above EMA50 with rising EMA9'; }
    else if (down) { action='SELL'; reason='Below EMA50 with falling EMA9'; }
  }

  if (e9.at(-2)<=e50.at(-2) && e9.at(-1)>e50.at(-1) && action==='BUY') conf+=0.05;
  if (e9.at(-2)>=e50.at(-2) && e9.at(-1)<e50.at(-1) && action==='SELL') conf+=0.05;
  conf = Math.max(0.5, Math.min(0.92, conf));
  return { action, reason, confidence: conf };
}

function entryExit({o,h,l,c, action, style}){
  if (!action || action==='WAIT') return { entry:'', stop:'', tp1:'', tp2:'' };
  const riskMult = String(style).toLowerCase().startsWith('scalp')?0.6 : String(style).toLowerCase().startsWith('day')?1.0 : 1.5;
  const last=c.at(-1); let stop, rr=0;
  if (action==='BUY'){
    const sw = swingLow(h,l,12); stop = Math.min(sw, last*0.997);
    rr = Math.max((last-stop)||last*0.002, last*0.0015);
    return numFmt({ entry:last, stop, tp1:last+rr*riskMult, tp2:last+2*rr*riskMult });
  } else {
    const sw = swingHigh(h,l,12); stop = Math.max(sw, last*1.003);
    rr = Math.max((stop-last)||last*0.002, last*0.0015);
    return numFmt({ entry:last, stop, tp1:last-rr*riskMult, tp2:last-2*rr*riskMult });
  }
}
function numFmt(obj){ const k=Object.keys(obj); const out={}; for(const key of k){ out[key]=Number(obj[key]).toFixed(5).replace(/0+$/,'').replace(/\.$/,''); } return out; }

/* ----- Vision via OpenAI ----- */
async function visionAnalyze({ image, ticker, timeframe, strategy, style, OPENAI }){
  try{
    const prompt = `Return STRICT JSON with keys summary, checklist[3], signals[{action(BUY|SELL|WAIT),reason,confidence,ttlSec=900}], entryExit{entry,stop,tp1,tp2}. Context: ${ticker} ${timeframe} ${strategy} ${style}. If unclear, action=WAIT.`;
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST',
      headers:{'Authorization':`Bearer ${OPENAI}`,'Content-Type':'application/json'},
      body: JSON.stringify({
        model:'gpt-4o-mini',
        temperature:0.2,
        messages:[
          {role:'system',content:'Respond with strict JSON only.'},
          {role:'user',content:[{type:'text',text:prompt},{type:'image_url',image_url:{url:image}}]}
        ]
      })
    });
    const j = await r.json();
    const raw = j?.choices?.[0]?.message?.content?.trim() || '';
    let parsed=null; try{ parsed=JSON.parse(raw); }catch{}
    if(!parsed) return { ok:false, error:'Vision parse failed', raw };
    return { ok:true, mode:'vision-llm', ticker, timeframe, strategy, style, ...parsed };
  }catch(e){ return { ok:false, error:String(e?.message||e) }; }
}
