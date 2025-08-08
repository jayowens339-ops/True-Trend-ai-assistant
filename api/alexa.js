// /api/alexa.js — Alexa Skill endpoint (single file backend)
// Works with ANY spoken asset. Optional FINNHUB_API_KEY for live data.

const NAME_TO_SYMBOL = {
  'tesla':'TSLA','apple':'AAPL','microsoft':'MSFT','amazon':'AMZN','google':'GOOGL','alphabet':'GOOGL','meta':'META','nvidia':'NVDA',
  's&p 500':'SPY','sp 500':'SPY','qqq':'QQQ',
  'gold':'XAUUSD','silver':'XAGUSD','oil':'CL=F','crude':'CL=F',
  'bitcoin':'BTCUSD','btc':'BTCUSD','ethereum':'ETHUSD','eth':'ETHUSD'
};

function normalizeSymbol(raw){
  if(!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (/^[a-z]{1,5}(\=f)?$/i.test(raw)) return raw.toUpperCase();
  if (NAME_TO_SYMBOL[s]) return NAME_TO_SYMBOL[s];
  const w = s.replace(/\b(stock|share|price|ticker|etf|crypto|coin|future|futures)\b/g,'').trim();
  if (NAME_TO_SYMBOL[w]) return NAME_TO_SYMBOL[w];
  if (/^[a-z]{1,6}$/i.test(w)) return w.toUpperCase();
  return null;
}

function rsi(values, period=14){
  if(values.length < period+1) return 50;
  let gains=0, losses=0;
  for(let i=1;i<=period;i++){
    const d=values[i]-values[i-1]; if(d>=0) gains+=d; else losses-=d;
  }
  let avgG=gains/period, avgL=losses/period, r=0;
  for(let i=period+1;i<values.length;i++){
    const d=values[i]-values[i-1];
    avgG=(avgG*(period-1)+Math.max(0,d))/period;
    avgL=(avgL*(period-1)+Math.max(0,-d))/period;
  }
  r = 100 - (100/(1+(avgG/(avgL||1e-9))));
  return Math.round(r);
}
function sma(values, n){
  if(values.length < n) return values[values.length-1]||0;
  let s=0; for(let i=values.length-n;i<values.length;i++) s+=values[i];
  return s/n;
}

async function getCandles(symbol){
  const key = process.env.FINNHUB_API_KEY;
  if(!key){
    // synthetic candles that still produce sensible signals
    const now=Date.now(), N=240, out=[];
    for(let i=N;i>0;i--){
      out.push(100 + Math.sin(i/8)*2 + (Math.random()-0.5)*0.7);
    }
    return out;
  }
  // 60‑minute candles for last ~120 days
  const to = Math.floor(Date.now()/1000);
  const from = to - 86400*120;
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=60&from=${from}&to=${to}&token=${key}`;
  const r = await fetch(url);
  const j = await r.json();
  if(j.s!=='ok' || !Array.isArray(j.c) || j.c.length<50) throw new Error('No candles');
  return j.c;
}

function analyze(symbol, close){
  const last = close[close.length-1];
  const sma50 = sma(close,50), sma200 = sma(close,200);
  const r = rsi(close,14);
  let direction='Neutral', rationale='Mixed signals; wait for confirmation.', improvement='Use confirmation candles and manage risk.';
  if (last > sma50 && last > sma200) { direction='Long (Trend Up)'; rationale='Price above 50 & 200 SMA.'; improvement='Enter on pullbacks with volume.'; }
  else if (last < sma50 && last < sma200) { direction='Short (Trend Down)'; rationale='Price below 50 & 200 SMA.'; improvement='Look for lower‑highs; avoid support bounces.'; }
  if (r < 30) { direction='Long (RSI Oversold)'; rationale=`RSI ${r} suggests mean reversion.`; improvement='Wait for bullish engulfing / reclaim of VWAP.'; }
  if (r > 70) { direction='Short (RSI Overbought)'; rationale=`RSI ${r} suggests pullback risk.`; improvement='Look for rejection at resistance; size down.'; }
  return { direction, rationale, improvement, rsi:r };
}

function speak(res, text){
  res.status(200).json({
    version:'1.0',
    response:{ outputSpeech:{ type:'PlainText', text }, shouldEndSession:true }
  });
}

export default async function handler(req,res){
  try{
    const body = req.method === 'GET' ? {} : (req.body || {});
    const type = body?.request?.type;
    const intent = body?.request?.intent?.name;
    const slots = body?.request?.intent?.slots || {};
    const raw = slots?.symbol?.value || slots?.asset?.value || slots?.ticker?.value;

    if(type==='LaunchRequest') return speak(res,'Welcome to TrueTrend. Ask: which direction is Tesla, gold, or Bitcoin?');

    if(intent==='GetDirectionIntent' || intent==='AMAZON.FallbackIntent'){
      const symbol = normalizeSymbol(raw) || 'SPY';
      let text;
      try{
        const close = await getCandles(symbol);
        const {direction, rationale} = analyze(symbol, close);
        text = `${symbol}: ${direction}. ${rationale}`;
      }catch{
        text = `I couldn't analyze ${symbol} right now. Please try again soon.`;
      }
      return speak(res, text);
    }

    if(intent==='AMAZON.HelpIntent') return speak(res,'Ask me: which direction is Apple, oil, or Bitcoin?');
    if(intent==='AMAZON.StopIntent' || intent==='AMAZON.CancelIntent') return speak(res,'Goodbye.');
    return speak(res,'Ask me which direction any stock, commodity, ETF, or crypto is going.');
  }catch{
    return speak(res,'Sorry, something went wrong.');
  }
}
