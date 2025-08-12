// api/analyze.js — TrueTrend AI unified endpoint (CommonJS for Vercel Functions, Node 18+)

const OWNER = process.env.OWNER_TOKEN || 'Truetrendtrading4u!';
const ENFORCE = (process.env.ENFORCE_LICENSE || '1') !== '0'; // set 0 to skip license gate
const ALLOWLIST = (process.env.LICENSE_ALLOWLIST || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const FINN = process.env.FINNHUB_API_KEY || '';
const OPENAI = process.env.OPENAI_API_KEY || process.env.GPT_API_KEY || '';

const nowSec = () => Math.floor(Date.now() / 1000);
const pct = (a,b)=> (b===0?0:(a-b)/b);
const ema = (period, arr)=>{
  if (!arr?.length) return [];
  const k = 2/(period+1);
  let prev = arr[0];
  const out = [prev];
  for (let i=1; i<arr.length; i++) { prev = arr[i]*k + prev*(1-k); out.push(prev); }
  return out;
};
const classify = (sym) => {
  const s=(sym||'').toUpperCase().replace(/\s+/g,'');
  if (!s) return 'unknown';
  if (s.includes(':')) return 'explicit';
  if (/^[A-Z]{6,7}$/.test(s) || /[A-Z]+\/[A-Z]+/.test(s) || /(XAU|XAG|WTI|BRENT)/.test(s)) return 'forex';
  if (/USDT$/.test(s) || /(BTC|ETH|SOL|DOGE|ADA|XRP|BNB)/.test(s)) return 'crypto';
  if (/(F$|Y$|\.[A-Z]{1,2}$)/.test(s)) return 'otc';
  return 'stock';
};
const mapToFinnhub = (sym, type) => {
  const s = sym.toUpperCase().replace(/\s+/g,'');
  if (type==='explicit') return s;
  if (type==='forex') { const base=s.slice(0,3), quote=s.slice(-3); return `OANDA:${base}_${quote}`; }
  if (type==='crypto') return s.includes(':') ? s : `BINANCE:${s}`;
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
const tfRisk = (tf) => ({'5m':0.0015,'15m':0.0025,'1h':0.004,'4h':0.006,'daily':0.01})[String(tf).toLowerCase()] || 0.004;
const entryExitFromSignal = (action, price, tf) => {
  const p = Number(price||0);
  if (!p || !/BUY|SELL|WAIT/.test(action||'')) return { entry:'', stop:'', tp1:'', tp2:'' };
  const r = tfRisk(tf), buf = r*0.5;
  if (action==='BUY') {
    return {
      entry: `Break above ${(p*(1+buf)).toFixed(4)} or pullback near ${(p*(1-buf)).toFixed(4)}`,
      stop: `Protect below ${(p*(1-r)).toFixed(4)}`,
      tp1:  `Take profit near ${(p*(1+r*1.5)).toFixed(4)}`,
      tp2:  `Stretch target ${(p*(1+r*3)).toFixed(4)}`
    };
  } else if (action==='SELL') {
    return {
      entry: `Break below ${(p*(1-buf)).toFixed(4)} or pullback near ${(p*(1+buf)).toFixed(4)}`,
      stop: `Protect above ${(p*(1+r)).toFixed(4)}`,
      tp1:  `Take profit near ${(p*(1-r*1.5)).toFixed(4)}`,
      tp2:  `Stretch target ${(p*(1-r*3)).toFixed(4)}`
    };
  }
  return { entry:`WAIT — re-run when price moves ±${(p*r).toFixed(4)}`, stop:'', tp1:'', tp2:'' };
};

function decide(closes, strategyName){
  const e9=ema(9,closes), e50=ema(50,closes);
  const last=closes.at(-1), p9=e9.at(-1), p50=e50.at(-1);
  const slope = last - closes.at(-6);
  const up = p9>p50 && slope>0, down = p9<p50 && slope<0;

  let action = up ? 'BUY' : (down ? 'SELL' : (last>=p9?'SELL':'BUY'));
  let reason = up?'Above EMA50 with rising EMA9':(down?'Below EMA50 with falling EMA9':'Mean reversion toward EMA9');

  const dist9 = Math.abs(pct(last,p9));
  const name = String(strategyName||'').toLowerCase();

  if (name.includes('ema touch')) {
    if (dist9 < 0.002) action = up ? 'BUY' : 'SELL';
    else action = 'WAIT';
    reason = `Distance to EMA9: ${(dist9*100).toFixed(2)}%`;
  } else if (name.includes('orb')) {
    reason = 'Open Range Breakout: trade first-range break in trend direction';
  } else if (name.includes('support/resistance') || name.includes('support') || name.includes('resistance')) {
    reason = up?'Buy pullbacks to prior resistance':'Sell bounces to prior support';
  } else if (name.includes('stoch') || name.includes('williams')) {
    reason = up?'Stoch/W%R momentum with uptrend':'Stoch/W%R momentum with downtrend';
  } else if (name.includes('rsi') && name.includes('macd')) {
    reason = up?'RSI>50 & MACD>0':'RSI<50 & MACD<0';
  } else if (name.includes('break of structure')) {
    reason = up?'Higher highs; buy BOS retest':'Lower lows; sell BOS retest';
  } else if (name.includes('pullback continuation')) {
    reason = up?'Buy EMA9 pullbacks in uptrend':'Sell EMA9 pullbacks in downtrend';
  } else if (name.includes('mean reversion')) {
    action = last>p9 ? 'SELL' : 'BUY'; reason='Fade back to EMA9';
  } else {
    reason = up ? 'Higher swing structure + EMA alignment' : (down ? 'Lower swing structure + EMA alignment' : reason);
  }

  const conf = Math.max(0.5, Math.min(0.92, 0.55 + (up||down?0.2:0) + Math.abs(pct(p9,p50))*0.6));
  return { action, reason, confidence: conf };
}

async function getCandles(sym, tf) {
  if (!FINN) return { ok:false, error:'Missing FINNHUB_API_KEY' };
  const type = classify(sym);
  const symbol = mapToFinnhub(sym, type);
  const resolution = reso(tf);
  const now = nowSec();
  const lookback = (resolution==='D')? 3600*24*400 : (resolution==='240'?3600*24*60 : 3600*24*14);
  const from = now - lookback;
  const base = 'https://finnhub.io/api/v1';
  let path = '/stock/candle';
  if (type==='forex' || String(symbol).startsWith('OANDA:')) path='/forex/candle';
  if (type==='crypto' || String(symbol).startsWith('BINANCE:')) path='/crypto/candle';

  try {
    const url = `${base}${path}?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${now}&token=${FINN}`;
    const r = await fetch(url);
    if (!r.ok) return { ok:false, error:`Finnhub ${r.status}` };
    const j = await r.json();
    if (j.s!=='ok' || !Array.isArray(j.c) || j.c.length<60) return { ok:false, error:'No candles', meta:{symbol,resolution} };
    return { ok:true, symbol, resolution, t:j.t, o:j.o, h:j.h, l:j.l, c:j.c };
  } catch (e) {
    return { ok:false, error:'Finnhub network', meta:{message:String(e)} };
  }
}

async function visionAnalyze(imageDataURL, context) {
  if (!OPENAI) return { ok:false, error:'Missing OPENAI_API_KEY' };
  try {
    const prompt = `
You are TrueTrend AI. Return STRICT JSON:
{{ "summary": string, "checklist": [string,string,string], "signals":[{{"action":"BUY|SELL|WAIT","reason":string,"confidence":0.0-1.0,"ttlSec":900}}] }}
Context: ticker ${context.ticker||''}, timeframe ${context.timeframe||''}, strategy ${context.strategy||''}.
Focus on one clear action with a tradable reason. Keep it concise.`;
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST',
      headers:{'Authorization':`Bearer ${OPENAI}`,'Content-Type':'application/json'},
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role:'system', content:'Respond with STRICT JSON only. No prose.' },
          { role:'user', content: [
              { type:'text', text: prompt },
              { type:'image_url', image_url: { url: imageDataURL } }
            ] }
        ]
      })
    });
    const j = await r.json();
    const raw = j?.choices?.[0]?.message?.content || '';
    let parsed;
    try { parsed = JSON.parse(raw); } catch {
      const m = raw.match(/\{[\s\S]*\}$/);
      parsed = m ? JSON.parse(m[0]) : null;
    }
    if (!parsed) return { ok:false, error:'Vision parse' };
    return { ok:true, mode:'vision-llm', ...parsed };
  } catch (e) {
    return { ok:false, error:'Vision error', meta:String(e) };
  }
}

async function announce(alexaUrl, auth, text) {
  if (!alexaUrl || !text) return;
  try {
    await fetch(alexaUrl, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', ...(auth?{Authorization:`Bearer ${auth}`}:{}) },
      body: JSON.stringify({ text })
    });
  } catch {}
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok:false, error:'Use POST' });
  }

  // body
  const body = typeof req.body === 'string' ? (req.body ? JSON.parse(req.body) : {}) : (req.body || {});
  const {
    ticker = '',
    timeframe = 'Daily',
    strategy = 'Trendline',
    imageDataURL = '',
    alexaUrl = ''
  } = body;

  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

  // License gate
  if (ENFORCE) {
    const ok = auth && (auth === OWNER || ALLOWLIST.includes(auth));
    if (!ok) {
      return res.status(auth ? 401 : 402).json({ ok:false, error:'license_required' });
    }
  }

  // 1) Vision path
  if (imageDataURL) {
    const v = await visionAnalyze(imageDataURL, { ticker, timeframe, strategy });
    if (v.ok) {
      const s = v.signals?.[0] || null;
      const ex = s ? entryExitFromSignal(s.action, 0, timeframe) : null;
      await announce(alexaUrl, auth, s ? `${ticker} ${timeframe}: ${s.action} — ${s.reason}` : v.summary);
      return res.status(200).json({
        ok:true,
        mode: v.mode || 'vision-llm',
        ticker, timeframe, strategy,
        summary: v.summary,
        checklist: v.checklist || [],
        signals: v.signals || [],
        entryExit: ex
      });
    }
    // else fall through to live-data path
  }

  // 2) Live-data path
  let data = { ok:false, error:'No data' };
  if (ticker) data = await getCandles(ticker, timeframe);

  if (data.ok) {
    const closes = data.c.slice(-300);
    const sig = decide(closes, strategy);
    const ex = entryExitFromSignal(sig.action, closes.at(-1), timeframe);
    await announce(alexaUrl, auth, `${ticker} ${timeframe}: ${sig.action} — ${sig.reason}. Entry ${ex.entry}. Stop ${ex.stop}.`);
    return res.status(200).json({
      ok:true,
      mode:'live-data',
      ticker, timeframe, strategy,
      summary: `${(ticker||'').toUpperCase()} • ${timeframe} • ${strategy} — ${sig.action}.`,
      checklist: [
        `EMA9 ${ema(9,closes).at(-1) > ema(50,closes).at(-1) ? 'above' : 'below'} EMA50`,
        `Last close ${closes.at(-1) >= ema(9,closes).at(-1) ? 'above' : 'below'} EMA9`,
        `Slope ${closes.at(-1) - closes.at(-6) > 0 ? 'up' : (closes.at(-1) - closes.at(-6) < 0 ? 'down' : 'flat')} (last 5 bars)`
      ],
      signals: [ { ...sig, ttlSec: 900 } ],
      entryExit: ex,
      price: closes.at(-1),
      note: { finnhubSymbol: data.symbol, resolution: data.resolution }
    });
  }

  // 3) LLM fallback
  if (OPENAI) {
    try {
      const prompt = `You are TrueTrend AI. JSON only with fields: summary, checklist(3), signals([{action,reason,confidence,ttlSec}]).
Context: ticker ${ticker||''}, timeframe ${timeframe}, strategy ${strategy}.`;
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method:'POST',
        headers:{'Authorization':`Bearer ${OPENAI}`,'Content-Type':'application/json'},
        body: JSON.stringify({ model:'gpt-4o-mini', temperature:0.2, messages:[
          { role:'system', content:'Return strict JSON; concise and tradable.' },
          { role:'user', content: prompt }
        ]})
      });
      const j = await r.json();
      const raw = j?.choices?.[0]?.message?.content || '';
      let parsed; try { parsed = JSON.parse(raw); } catch { parsed = null; }
      if (parsed) {
        const s = parsed.signals?.[0] || null;
        const ex = s ? entryExitFromSignal(s.action, 0, timeframe) : null;
        return res.status(200).json({ ok:true, mode:'live-llm', ticker, timeframe, strategy, ...parsed, entryExit: ex });
      }
    } catch {}
  }

  // 4) Hard fallback
  return res.status(200).json({
    ok:true, mode:'fallback',
    ticker, timeframe, strategy,
    summary:`Fallback for ${ticker||'UNKNOWN'} on ${timeframe} — ${strategy}.`,
    checklist:['Trend check unavailable','Data fetch failed','Use conservative risk'],
    signals:[{action:'BUY', reason:'Fallback signal', confidence:.55, ttlSec:900}],
    entryExit: entryExitFromSignal('BUY', 0, timeframe),
    error: data.error || 'Unknown'
  });
};
