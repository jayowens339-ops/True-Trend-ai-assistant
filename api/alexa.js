// /api/alexa.js
// Minimal voice webhook that fetches our finance analysis and returns speech.
// Works as: 
//  - GET /api/alexa?symbol=NVDA (simple test)
//  - POST Alexa JSON with intent GetDirectionIntent { symbol }

const alexaResponse = (text, shouldEndSession = true) => ({
  version: '1.0',
  response: {
    outputSpeech: { type: 'PlainText', text },
    shouldEndSession
  }
});

export default async function handler(req, res) {
  try {
    // Allow simple test via GET
    if (req.method === 'GET') {
      const symbol = (req.query.symbol || 'NVDA').toUpperCase();
      const data = await fetch(`${originFromReq(req)}/api/finance?symbol=${encodeURIComponent(symbol)}&resolution=60&days=5`).then(r => r.json());
      const speech = buildSpeech(symbol, data);
      res.setHeader('Cache-Control', 's-maxage=30');
      return res.status(200).json({ speech, data });
    }

    // Alexa POST
    if (req.method === 'POST') {
      const body = req.body || (await readBody(req));
      const intentName = body?.request?.intent?.name;
      let symbol = (
        body?.request?.intent?.slots?.symbol?.value ||
        body?.request?.intent?.slots?.Symbol?.value ||
        'NVDA'
      ).toUpperCase();

      if (intentName !== 'GetDirectionIntent') {
        return res.status(200).json(
          alexaResponse("Try asking: what's the direction on NVDA?")
        );
      }

      const data = await fetch(`${originFromReq(req)}/api/finance?symbol=${encodeURIComponent(symbol)}&resolution=60&days=5`).then(r => r.json());
      const speech = buildSpeech(symbol, data);
      res.setHeader('Cache-Control', 's-maxage=30');
      return res.status(200).json(alexaResponse(speech));
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end('Method Not Allowed');
  } catch (e) {
    console.error(e);
    return res.status(200).json(alexaResponse('Sorry, the service is temporarily unavailable.'));
  }
}

function buildSpeech(symbol, data) {
  if (data?.error) return `I couldn't analyze ${symbol} right now.`;

  const bias = data?.bias || 'neutral';
  const conf = data?.confidence ? `${data.confidence}%` : 'unknown confidence';
  const supp = data?.levels?.support;
  const res = data?.levels?.resistance;
  const rsi = data?.rsi;

  let biasLine = `The current bias on ${symbol} is ${bias}`;
  if (bias !== 'neutral' && data?.confidence) biasLine += ` with ${conf} confidence`;

  const levels = (supp && res)
    ? ` Key support is near ${supp}, and resistance around ${res}.`
    : '';

  const rsiLine = (typeof rsi === 'number')
    ? ` RSI is ${rsi}.`
    : '';

  const tips = (bias === 'long')
    ? ' Pullback buys toward support are favored while the trend holds.'
    : (bias === 'short')
      ? ' Rally fades toward resistance are favored while the trend remains weak.'
      : ' The trend is mixed; wait for a clearer break above resistance or below support.';

  return (biasLine + '.' + levels + rsiLine + tips)
    .replace(/\s+/g, ' ')
    .trim();
}

// util — extract origin for internal call (works on Vercel)
function originFromReq(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
