// api/analyze.js
export default async function handler(req, res) {
  if (req.method === "GET") {
    // Serve a tiny UI from the SAME endpoint
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>TrueTrend Live Analyze</title>
<style>
  body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial;background:#0b1220;color:#e6e9ef;margin:0;padding:32px}
  .card{max-width:720px;margin:0 auto;background:#111828;border:1px solid #1f2937;border-radius:16px;padding:24px;box-shadow:0 10px 30px rgba(0,0,0,.3)}
  h1{font-size:22px;margin:0 0 12px}
  .row{display:flex;gap:12px}
  input,select,button{height:44px;border-radius:10px;border:1px solid #2b3547;background:#0f172a;color:#e6e9ef;padding:0 12px;font-size:16px}
  input,select{flex:1}
  button{background:#22c55e;border-color:#22c55e;color:#04120a;cursor:pointer;font-weight:700;padding:0 18px}
  button:disabled{opacity:.6;cursor:not-allowed}
  #out{margin-top:16px;white-space:pre-wrap;background:#0b1220;border:1px solid #1f2937;border-radius:12px;padding:16px;font-family:ui-monospace,Menlo,Consolas,monospace}
  .muted{opacity:.75;font-size:14px;margin-top:8px}
</style>
</head>
<body>
  <div class="card">
    <h1>Try it live</h1>
    <div class="row">
      <input id="symbol" placeholder="AAPL, NVDA, SPY, OANDA:EUR_USD" value="AAPL" />
      <select id="tf">
        <option>Monthly</option>
        <option selected>Weekly</option>
        <option>Daily</option>
        <option>Hourly</option>
      </select>
      <button id="btn">Analyze</button>
    </div>
    <div class="muted">Example: AAPL, NVDA, SPY, <code>OANDA:EUR_USD</code>, <code>BINANCE:BTCUSDT</code></div>
    <div id="out">Ready.</div>
  </div>

<script>
const $ = (id)=>document.getElementById(id);
$("btn").addEventListener("click", async ()=>{
  const symbol = $("symbol").value.trim();
  const timeframe = $("tf").value;
  $("btn").disabled = true; $("out").textContent = "Analyzing...";
  try{
    const r = await fetch(location.pathname, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ symbol, timeframe })
    });
    const ct = r.headers.get("content-type") || "";
    const body = ct.includes("application/json") ? await r.json() : { raw: await r.text() };
    if(!r.ok || body.error){ throw new Error(body.message || body.raw || ("HTTP "+r.status)); }
    const q = body.quote || {};
    const change = (q.c != null && q.pc != null) ? (q.c - q.pc) : null;
    const pct = (change != null && q.pc) ? (change / q.pc * 100) : null;
    $("out").textContent =
      "Symbol: " + body.symbol + " (" + body.timeframe + ")\\n" +
      "Price:  " + q.c + "\\n" +
      "Open:   " + q.o + "  High: " + q.h + "  Low: " + q.l + "\\n" +
      "Prev:   " + q.pc + "\\n" +
      (pct!=null ? ("Change: " + change.toFixed(2) + " (" + pct.toFixed(2) + "%)\\n") : "") +
      "Unix t: " + q.t;
  }catch(err){
    $("out").textContent = "Error: " + err.message;
  }finally{
    $("btn").disabled = false;
  }
});
</script>
</body>
</html>`);
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", ["GET","POST"]);
    return res.status(405).json({ error: true, message: "Method not allowed" });
  }

  try {
    // Parse JSON body whether Vercel passed string or object
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { symbol, timeframe } = body;
    if (!symbol) return res.status(400).json({ error: true, message: "Missing symbol" });

    const finnhubKey = process.env.FINNHUB_API_KEY;
    if (!finnhubKey) return res.status(500).json({ error: true, message: "FINNHUB_API_KEY not set on server" });

    const url = \`https://finnhub.io/api/v1/quote?symbol=\${encodeURIComponent(symbol)}&token=\${encodeURIComponent(finnhubKey)}\`;
    const r = await fetch(url, { cache: "no-store" });
    const text = await r.text();

    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch { return res.status(r.status).json({ error: true, raw: text }); }

    if (!r.ok) return res.status(r.status).json({ error: true, ...data });

    // Success
    return res.status(200).json({
      ok: true,
      symbol,
      timeframe: timeframe || "Monthly",
      quote: data, // { c,h,l,o,pc,t,(dp,d) if available }
    });
  } catch (err) {
    console.error("analyze function error:", err);
    return res.status(500).json({ error: true, message: "Unexpected server error" });
  }
}

