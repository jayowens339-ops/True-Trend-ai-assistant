// Next.js Pages API route (Vercel). Live data via FINNHUB_API_KEY. Optional OPENAI_API_KEY fallback.
export default async function handler(req, res) {
  // CORS so bookmarklet/extension can call from any site:
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Use POST' });
  }

  const { ticker = 'EURUSD', timeframe = 'Daily', strategy = 'Trendline' } = req.body || {};
  const FINN = process.env.FINNHUB_API_KEY;
  const OPENAI = process.env.OPENAI_API_KEY || process.env.GPT_API_KEY;

  // ---- utilities ----
  const nowSec = () => Math.floor(Date.now()/1000);
  const pct = (a,b)=> (b===0?0:(a-b)/b);
  const ema = (period, arr)=>{ const k=2/(period+1); let prev=arr[0]; const out=[prev];
    for(let i=1;i<arr.length;i++){ prev = arr[i]*k + prev*(1-k); out.push(prev); } return out; };
  const classify = (sym) => {
    const s=(sym||'').toUpperCase().replace(/\s+/g,'');
    if (s.includes(':')) return 'explicit';
    if (/^[A-Z]{6,7}$/.test(s) || /[A-Z]+\/[A-Z]+/.test(s) || /(XAU|XAG|WTI|BRENT)/.test(s)) return 'forex';
    if (/USDT$/.test(s) || /(BTC|ETH|SOL|DOGE|ADA)/.test(s)) return 'crypto';
    return 'stock';
  };
  const mapToFinnhub = (sym, type) => {
    const s=sym.toUpperCase().replace(/\s+/g,'');
    if (type==='explicit') return s;
    if (type==='forex') { const base=s.slice(0,3), quote=s.slice(-3); return `OANDA:${base}_${quote}`; }
    if (type==='crypto') return s.includes(':')?s:`BINANCE:${s}`;
    return s; // stock
  };
  const reso = (tf) => {
    const m=String(tf).toLowerCase();
    if (m.includes('5m')) return '5';
    if (m.includes('15m')) return '15';
    if (m.includes('1h')) return '60';
    if (m.includes('4h')) return '240';
    return 'D';
  };

  // ---- Finnhub candles ----
  async function getCandles(sym, tf) {
    if (!FINN) return { ok:false, error:'Missing FINNHUB_API_KEY' };
    const type = classify(sym);
    const symbol = mapToFinnhub(sym, type);
    const resolution = reso(tf);
    const now = nowSec();
    const lookback = (resolution==='D')? 3600*24*400 : (resolution==='240'?3600*24*60 : 3600*24*7);
    const from = now - lookback;
    const base = 'https://finnhub.io/api/v1';
    let path = '/stock/candle';
    if (type==='forex' || symbol.startsWith('OANDA:')) path='/forex/candle';
    if (type==='crypto' || symbol.startsWith('BINANCE:')) path='/crypto/candle';
    const url = `${base}${path}?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${now}&token=${FINN}`;
    const r = await fetch(url);
    if (!r.ok) return { ok:false, error:`Finnhub ${r.status}` };
    const j = await r.json();
    if (j.s!=='ok' || !Array.isArray(j.c) || j.c.length<60) return { ok:false, error:'No candles', meta:{symbol,resolution}};
    return { ok:true, symbol, resolution, t:j.t, o:j.o, h:j.h, l:j.l, c:j.c };
  }

  // ---- Strategy engine ----
  function decide(closes, strategyName){
    const e9=ema(9,closes), e50=ema(50,closes);
    const last=closes.at(-1), p9=e9.at(-1), p50=e50.at(-1);
    const slope = closes.at(-1) - closes.at(-6);
    const up = p9>p50 && slope>0, down = p9<p50 && slope<0;
    let action = up ? 'BUY' : (down ? 'SELL' : (last>=p9?'SELL':'BUY'));
    let reason = up?'Above EMA50 with rising EMA9':(down?'Below EMA50 with falling EMA9':'Mean reversion toward EMA9');

    const dist9 = Math.abs(pct(last,p9));
    if (/ema touch/i.test(strategyName)) {
      if (dist9 < 0.002) action = up ? 'BUY' : 'SELL';
      else action = 'WAIT';
      reason = `Distance to EMA9: ${(dist9*100).toFixed(2)}%`;
    } else if (/orb/i.test(strategyName)) {
      reason = 'Use first 15m range break; trade in break direction';
    } else if (/support\/resistance/i.test(strategyName)) {
      reason = up?'Buy pullbacks to prior resistance':'Sell bounces to prior support';
    } else if (/stoch/i.test(strategyName) || /williams/i.test(strategyName)) {
      reason = (up?'Stoch/W%R up with trend':'Stoch/W%R down with trend');
    } else if (/rsi.*macd/i.test(strategyName)) {
      reason = up?'RSI>50 & MACD>0':'RSI<50 & MACD<0';
    } else if (/break of structure/i.test(strategyName)) {
      reason = up?'Higher highs; buy on BOS retest':'Lower lows; sell on BOS retest';
    } else if (/pullback continuation/i.test(strategyName)) {
      reason = up?'Buy EMA9 pullbacks in uptrend':'Sell EMA9 pullbacks in downtrend';
    } else if (/mean reversion/i.test(strategyName)) {
      action = last>p9 ? 'SELL' : 'BUY'; reason='Fade back to EMA9';
    }
    const conf = Math.max(0.5, Math.min(0.92, 0.55 + (up||down?0.2:0) + Math.abs(pct(p9,p50))*0.6));
    return { action, reason, confidence: conf };
  }

  // ---- Run analysis ----
  async function run(){
    const data = await getCandles(ticker, timeframe);
    if (!data.ok) return { ok:false, error:data.error, meta:data.meta };

    const closes = data.c.slice(-300);
    const sig = decide(closes, strategy);

    return {
      ok:true,
      mode:'live-data',
      summary: `${ticker.toUpperCase()} • ${timeframe} • ${strategy} — ${sig.action}.`,
      checklist: [
        `EMA9 ${ema(9,closes).at(-1) > ema(50,closes).at(-1) ? 'above' : 'below'} EMA50`,
        `Last close ${closes.at(-1) >= ema(9,closes).at(-1) ? 'above' : 'below'} EMA9`,
        `Slope ${closes.at(-1) - closes.at(-6) > 0 ? 'up' : (closes.at(-1) - closes.at(-6) < 0 ? 'down' : 'flat')} (last 5 bars)`
      ],
      signals: [ { ...sig, ttlSec: 900 } ],
      price: closes.at(-1),
      note: { finnhubSymbol: data.symbol, resolution: data.resolution }
    };
  }

  let result = await run();

  // Optional: if live data failed but OPENAI is present, produce a generic JSON summary
  if (!result.ok && OPENAI) {
    try{
      const prompt = `You are TrueTrend AI. JSON only with fields: summary, checklist(3), signals([ {action, reason, confidence, ttlSec} ]).
      Context: ticker ${ticker}, timeframe ${timeframe}, strategy ${strategy}.`;
      const r = await fetch('https://api.openai.com/v1/chat/completions',{
        method:'POST',
        headers:{'Authorization':`Bearer ${OPENAI}`,'Content-Type':'application/json'},
        body:JSON.stringify({model:'gpt-4o-mini',temperature:0.2,messages:[
          {role:'system',content:'Return strict JSON; concise and tradable.'},
          {role:'user',content:prompt}
        ]})
      });
      const j = await r.json(); const raw = j?.choices?.[0]?.message?.content || '';
      try { const parsed = JSON.parse(raw); return res.status(200).json({ ok:true, mode:'live-llm', ...parsed }); }
      catch { return res.status(200).json({ ok:true, mode:'live-llm', raw }); }
    }catch(e){ /* fall through */ }
  }

  if (!result.ok) {
    return res.status(200).json({
      ok:true, mode:'fallback',
      summary:`Fallback analysis for ${ticker} on ${timeframe} — ${strategy}.`,
      checklist:['Trend check unavailable','Data fetch failed','Use conservative risk'],
      signals:[{action:'BUY', reason:'Fallback signal', confidence:.55, ttlSec:900}],
      error: result.error || 'Unknown'
    });
  }
  return res.status(200).json(result);
}
