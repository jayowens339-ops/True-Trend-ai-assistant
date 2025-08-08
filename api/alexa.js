// /api/alexa.js
// Minimal Alexa-compatible response that reuses finance logic.

function cors(res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function analyze(symbol, timeframe='D'){
  const base = new URL(`${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : ''}/api/finance`, 'http://localhost');
  base.searchParams.set('symbol', symbol);
  base.searchParams.set('timeframe', timeframe);
  const r = await fetch(base.toString());
  if(!r.ok) throw new Error('finance endpoint error');
  return r.json();
}

function buildAlexaSpeech(text){
  return {
    version: '1.0',
    response: {
      outputSpeech: { type: 'PlainText', text },
      shouldEndSession: true
    }
  };
}

export default async function handler(req, res){
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try{
    let utterance = (req.method === 'POST' ? (req.body?.utterance || '') : (req.query?.utterance || '')).toString();
    if (!utterance) utterance = (req.query?.symbol || '').toString();

    // naive parsing for a symbol/commodity
    let symbol = (utterance.match(/[A-Za-z]{2,6}/g) || ['AAPL'])[0].toUpperCase();
    // common aliases
    if (symbol === 'GOLD') symbol = 'XAUUSD';
    if (symbol === 'SILVER') symbol = 'XAGUSD';
    if (symbol === 'OIL') symbol = 'USO'; // ETF proxy

    const data = await analyze(symbol);
    const dir = data?.signal?.direction;
    const reason = data?.signal?.reason || 'no reason available';
    let say;
    if (dir === 'long')  say = `${symbol} looks biased long. ${reason}. Last price ${data?.quote?.c ?? 'unknown'}.`;
    else if (dir === 'short') say = `${symbol} looks biased short. ${reason}. Last price ${data?.quote?.c ?? 'unknown'}.`;
    else say = `I am neutral on ${symbol}. ${reason}.`;

    return res.status(200).json(buildAlexaSpeech(say));
  }catch(err){
    return res.status(500).json(buildAlexaSpeech(`Sorry, I hit a snag: ${err.message}`));
  }
}
