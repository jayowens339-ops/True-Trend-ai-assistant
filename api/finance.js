// /api/finance.js
// Serverless endpoint for quotes + simple signal using Finnhub.
// GET /api/finance?symbol=AAPL&timeframe=D|60|15
// Response: { symbol, quote, signal, comment }

const FINNHUB = 'https://finnhub.io/api/v1';

function cors(res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res){
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try{
    const { symbol = 'AAPL', timeframe = 'D' } = req.query;
    const token = process.env.FINNHUB_API_KEY;
    if(!token) return res.status(500).json({ error: 'FINNHUB_API_KEY missing' });

    // 1) Quote
    const q = await fetch(`${FINNHUB}/quote?symbol=${encodeURIComponent(symbol)}&token=${token}`);
    if(!q.ok) throw new Error('quote fetch failed');
    const quote = await q.json(); // { c, h, l, o, pc, t }

    // 2) Candles
    const now = Math.floor(Date.now()/1000);
    const from = timeframe === 'D' ? now - 86400*200
              : timeframe === '60' ? now - 3600*500
              : now - 900*1000; // 15m fallback
    const resolution = timeframe === 'D' ? 'D' : timeframe; // 'D','60','15'
    const cRes = await fetch(`${FINNHUB}/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${now}&token=${token}`);
    const candles = await cRes.json(); // { s:'ok', c:[], h:[], l:[], o:[], t:[] }
    if(candles.s !== 'ok') throw new Error('no candle data');

    // 3) Simple signal: EMA cross + momentum
    const closes = candles.c || [];
    const ema = (arr,len)=>{
      const k = 2/(len+1);
      let ema=arr[0];
      for(let i=1;i<arr.length;i++) ema = arr[i]*k + ema*(1-k);
      return ema;
    };
    const last50  = closes.slice(-50);
    const last200 = closes.slice(-200);
    const ema50   = last50.length ? ema(last50, 20) : null;
    const ema200  = last200.length ? ema(last200, 50) : null;

    let direction='neutral', reason='Not enough data';
    if(ema50 && ema200){
      if (ema50 > ema200) { direction='long';  reason='Short EMA above long EMA'; }
      if (ema50 < ema200) { direction='short'; reason='Short EMA below long EMA'; }
    }

    // Momentum check using last 10 bars
    const last10 = closes.slice(-10);
    if(last10.length >= 2){
      const chg = (last10.at(-1) - last10[0]) / last10[0];
      if (chg > 0.02 && direction==='neutral') { direction='long';  reason='Recent momentum positive'; }
      if (chg < -0.02 && direction==='neutral'){ direction='short'; reason='Recent momentum negative'; }
    }

    const comment = `Timeframe ${resolution}. EMA(20/50) heuristic + momentum. This is an educational signal, not financial advice.`;

    return res.status(200).json({
      symbol: symbol.toUpperCase(),
      quote,
      signal: { direction, reason },
      comment
    });
  }catch(err){
    return res.status(500).json({ error: err.message });
  }
}
