// api/analyze.js
// Production-safe, single-file Vision endpoint.
// - Owner bypass (header X-TT-Owner: 1 OR body.options.owner === true)
// - 12MB body limit for base64 images
// - Twelve Data (primary) -> Finnhub (fallback)
// - Always returns VALID JSON with {ok, direction, entry, stopLoss, takeProfit, speech, ...}
// - No external deps

export const config = {
  api: {
    bodyParser: { sizeLimit: "12mb" },
  },
};

export default async function handler(req, res) {
  // ---- CORS & preflight ----
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-TT-Owner");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(200).json({ ok: false, error: "method_not_allowed", expected: "POST" });
  }

  try {
    const body = await readBodyJSON(req);
    const { image, options = {} } = body || {};

    const ownerHeader = req.headers["x-tt-owner"];
    const owner = options.owner === true || ownerHeader === "1";
    const symbol    = (options.symbol || "AAPL").toUpperCase();
    const timeframe = options.timeframe || "daily"; // 1min,5min,15min,60min,daily
    const tradeType = options.tradeType || "Day Trade";
    const strategy  = options.strategy  || "Trendline";
    const style     = options.style     || "Day";

    const TD_KEY = options.tdKey || process.env.TWELVEDATA_KEY || "";
    const FH_KEY = options.fhKey || process.env.FINNHUB_KEY || "";

    // Diagnostics: image size (bytes of base64 payload)
    const receivedBytes = image && typeof image === "string" ? image.length : 0;

    // Optional: your Vision model
    // If you later return precise levels from Vision, fill `visionResult`.
    let visionResult = null;
    if (image && typeof image === "string" && image.startsWith("data:image/")) {
      try {
        // TODO: call your model; set visionResult = { direction, entry, stopLoss, takeProfit }
        // Keep null for deterministic server behavior until your model is wired up.
      } catch (e) {
        // ignore and fall back to market data
      }
    }

    // Owner bypass: never reject with license errors
    // If you have middleware doing license checks, exempt Owner calls there as well.
    if (!owner) {
      // If you *do* want non-owner enforcement, you could return:
      // return res.status(200).json({ ok: false, error: "license_required" });
    }

    // Market data (TD primary -> FH fallback) only if Vision not providing levels
    let series = null, source = null, diag = {};
    if (!visionResult) {
      try {
        series = await getTwelveDataSeries(symbol, timeframe, TD_KEY);
        source = "twelvedata";
      } catch (e) {
        diag.td_error = String(e?.message || e);
        try {
          series = await getFinnhubSeries(symbol, timeframe, FH_KEY);
          source = "finnhub";
        } catch (e2) {
          diag.fh_error = String(e2?.message || e2);
        }
      }
    }

    // Compute signal
    let signal;
    if (isValidVision(visionResult)) {
      signal = normalizeSignal(visionResult);
      source = "vision";
    } else if (Array.isArray(series) && series.length >= 2) {
      signal = computeSignalFromSeries(series, tradeType);
    } else {
      return res.status(200).json({
        ok: false,
        error: "data_unavailable",
        reason: "Both Twelve Data and Finnhub failed or returned insufficient data.",
        receivedBytes,
        diag,
      });
    }

    const speech = buildSpeech(signal, { symbol, tradeType });

    return res.status(200).json({
      ok: true,
      owner: !!owner,
      symbol,
      timeframe,
      tradeType,
      strategy,
      style,
      source,
      receivedBytes,
      ...signal,
      speech,
      diag,
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

/* ============================ Helpers ============================ */

async function readBodyJSON(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function isValidVision(v) {
  return v &&
    (v.direction === "BUY" || v.direction === "SELL") &&
    Number.isFinite(+v.entry) &&
    Number.isFinite(+v.stopLoss) &&
    Number.isFinite(+v.takeProfit);
}
function normalizeSignal(x) {
  return {
    direction: x.direction,
    entry: +x.entry,
    stopLoss: +x.stopLoss,
    takeProfit: +x.takeProfit,
  };
}
function buildSpeech(sig, { symbol, tradeType }) {
  const { direction, entry, stopLoss, takeProfit } = sig;
  return `${direction} ${tradeType} on ${symbol}. Entry ${fmt(entry)}. Stop loss ${fmt(stopLoss)}. Take profit ${fmt(takeProfit)}.`;
}
function fmt(n){ return Number(n).toFixed(5).replace(/\.?0+$/, ""); }

/* -------------------- Data Fetchers -------------------- */

async function fetchJSON(url) {
  const r = await fetch(url);
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { return { _raw: txt }; }
}

async function getTwelveDataSeries(symbol, tf, key) {
  if (!key) throw new Error("TWELVEDATA_KEY missing");
  const map = { "1min":"1min","5min":"5min","15min":"15min","60min":"60min","daily":"1day" };
  const interval = map[tf] || "1day";
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=120&apikey=${encodeURIComponent(key)}`;
  const j = await fetchJSON(url);
  if (!j || j.status === "error") throw new Error(j?.message || "TD error");
  const vals = Array.isArray(j.values) ? j.values : [];
  if (!vals.length) throw new Error("TD no values");
  return vals.map(v => ({ t:v.datetime, o:+v.open, h:+v.high, l:+v.low, c:+v.close })).reverse();
}

async function getFinnhubSeries(symbol, tf, key) {
  if (!key) throw new Error("FINNHUB_KEY missing");
  const now = Math.floor(Date.now()/1000), from = now - 60*60*24*7;
  const resMap = { "1min":"1","5min":"5","15min":"15","60min":"60","daily":"D" };
  const reso = resMap[tf] || "D";
  const candles = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=${reso}&from=${from}&to=${now}&token=${encodeURIComponent(key)}`;
  const jc = await fetchJSON(candles);
  if (jc && jc.s === "ok" && Array.isArray(jc.c) && jc.c.length > 1) {
    return jc.c.map((c,i)=>({ t:jc.t[i], o:jc.o?.[i]??c, h:jc.h?.[i]??c, l:jc.l?.[i]??c, c }));
  }
  const quote = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`;
  const jq = await fetchJSON(quote);
  if (jq && jq.c) return [{ t: now, o: jq.o ?? jq.c, h: jq.h ?? jq.c, l: jq.l ?? jq.c, c: jq.c }];
  throw new Error("Finnhub no data");
}

/* -------------------- Signal Logic -------------------- */

function computeSignalFromSeries(series, tradeType) {
  const closes = series.map(d => d.c);
  const e9  = ema(closes, 9);
  const e21 = ema(closes, 21);
  const last = series.at(-1);
  const direction = e9.at(-1) >= e21.at(-1) ? "BUY" : "SELL";
  const A = atr(series, 14) || 0.5;
  const mult = tradeType === "Scalp" ? 1.0 : tradeType === "Swing" ? 2.0 : 1.5;
  const entry = last.c;
  const stopLoss   = direction === "BUY" ? entry - mult*A : entry + mult*A;
  const takeProfit = direction === "BUY" ? entry + 2*mult*A : entry - 2*mult*A;
  return { direction, entry, stopLoss, takeProfit, atr: A, ema9: e9.at(-1), ema21: e21.at(-1) };
}
function ema(vals, p){ const k=2/(p+1); let prev=vals[0]??0, out=[prev]; for(let i=1;i<vals.length;i++){ const v=vals[i]; prev=v*k+prev*(1-k); out.push(prev);} return out;}
function atr(series, period=14){
  const trs = [];
  for (let i=1;i<series.length;i++){
    const a=series[i], b=series[i-1];
    trs.push(Math.max(a.h-a.l, Math.abs(a.h-b.c), Math.abs(a.l-b.c)));
  }
  if (!trs.length) return 0;
  const n = Math.min(period, trs.length);
  let s = 0; for (let i=trs.length-n;i<trs.length;i++) s += trs[i];
  return s / n;
}
