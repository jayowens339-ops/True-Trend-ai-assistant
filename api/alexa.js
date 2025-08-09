async function runEngine(symbol, resolution = '60') {
  const baseURL = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : `http://localhost:3000`;
  const r = await fetch(`${baseURL}/api/finance?symbol=${encodeURIComponent(symbol)}&resolution=${encodeURIComponent(resolution)}&limit=220`);
  return r.json();
}

export default async function handler(req, res) {
  try {
    // Simple GET preview: /api/alexa?symbol=NVDA
    if (req.method === 'GET') {
      const symbol = (req.query.symbol || 'NVDA').toUpperCase();
      const j = await runEngine(symbol);
      const speech = j.error
        ? `I couldn't analyze ${symbol}. ${j.error}`
        : `TrueTrend says ${symbol} is ${j.bias} with ${j.confidence} percent confidence. RSI ${Math.round(j.rsi || 0)}. Support ${fmt(j.levels?.support)}, resistance ${fmt(j.levels?.resistance)}.`;
      return res.status(200).json({ speech, data: j });
    }

    // Alexa skill POST
    const body = req.body || {};
    const intent = body?.request?.intent?.name;
    let symbol = (
      body?.request?.intent?.slots?.symbol?.value ||
      body?.request?.intent?.slots?.Symbol?.value ||
      'NVDA'
    ).toUpperCase();

    if (intent !== 'GetDirectionIntent') {
      const speech = 'Ask me for the direction by saying, what is the direction on NVDA?';
      return res.json(alexaResponse(speech));
    }

    const j = await runEngine(symbol);
    const speech = j.error
      ? `I couldn't analyze ${symbol}. ${j.error}`
      : `TrueTrend says ${symbol} is ${j.bias} with ${j.confidence} percent confidence. RSI ${Math.round(j.rsi || 0)}. Support ${fmt(j.levels?.support)}, resistance ${fmt(j.levels?.resistance)}.`;

    return res.json(alexaResponse(speech));
  } catch (e) {
    return res.json(alexaResponse('Something went wrong with TrueTrend.'));
  }
}

function fmt(x){ return (x==null||isNaN(x)) ? 'n A' : Number(x).toFixed(2); }
function alexaResponse(speech) {
  return {
    version: '1.0',
    response: {
      outputSpeech: { type: 'PlainText', text: speech },
      shouldEndSession: true
    }
  };
}
