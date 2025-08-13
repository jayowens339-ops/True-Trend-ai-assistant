// api/analyze.js
// Single-file, production-safe analyze route (Vercel/Node).
// - Vision input supported (image base64), but signal is computed server-side from market data
// - Twelve Data (primary) -> Finnhub (fallback)
// - Always returns VALID JSON with entry/stop/takeProfit + speech
// - No external deps

export default async function handler(req, res) {
  // ---- CORS (for local dev / browser calls) ----
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  if (req.method !== "POST") {
    return res
      .status(200)
      .json({ ok: false, error: "method_not_allowed", expected: "POST" });
  }

  try {
    // ---- Parse body safely (always aim to return JSON) ----
    const body = await readBodyJSON(req);
    const { image, options = {} } = body || {};
    const {
      symbol = "AAPL",
      timeframe = "daily",            // 1min,5min,15min,60min,daily
      tradeType = "Day Trade",        // Scalp | Day Trade | Swing
      strategy = "Trendline",
      style = "Day",
      tdKey: tdKeyOverride,
      fhKey: fhKeyOverride,
    } = options;

    // Keys from env or override (per-request)
    const TD_KEY = tdKeyOverride || process.env.TWELVEDATA_KEY || "";
    const FH_KEY = fhKeyOverride || process.env.FINNHUB_KEY || "";

    // ---- Step 1: (Optional) Vision hook (placeholder) ----
    // You can plug your vision model here. If vision returns precise levels,
    // we’ll use them; otherwise we compute from market data.
    // The structure to return from vision if you implement it:
    // { direction: "BUY"|"SELL", entry: Number, stopLoss: Number, takeProfit: Number }
    let vision = null;
    try {
      if (image && typeof image === "string" && image.startsWith("data:image/")) {
        // TODO: Call your model here and fill `vision`.
        // Leaving as null keeps behavior deterministic (no randoms / no errors).
      }
    } catch (e) {
      // ignore vision errors; we’ll fall back to market data cleanly.
    }

    // ---- Step 2: Market data (TD primary -> Finnhub fallback) ----
    let series = null;
    let source = null;
    let diag = {};

    if (!vision) {
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

    // ---- Step 3: Compute signal ----
    let signal;
    if (vision && isValidVision(signalShape(vision))) {
      signal = signalShape(vision);
      source = "vision";
    } else if (Array.isArray(series) && series.length >= 2) {
      signal = computeSignalFromSeries(series, tradeType);
    } else {
      // If both data sources failed, still return JSON with a helpful error.
      return res.status(200).json({
        ok: false,
        error: "data_unavailable",
        reason: "Both Twelve Data and Finnhub failed or returned insufficient data.",
        diag,
      });
    }

    // ---- Step 4: Build voice line + response ----
    const speech = buildSpeech(signal, { symbol, tradeType });
    return res.status(200).json({
      ok: true,
      symbol,
      timeframe,
      tradeType,
      strategy,
      style,
      source,
      ...signal,
      speech,
      diag,
    });
  } catch (e) {
    // Never leak non-JSON; always respond with JSON
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

/* ============================ Helpers ============================ */

async function readBodyJSON(req) {
  // Vercel provides req.body parsed when content-type=application/json.
  // If it's already parsed, return it; otherwise, read raw and parse defensively.
  if (req.body && typeof req.body === "object") return req.body;

  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // If non-JSON hits the endpoint, normalize shape to avoid throwing.
    return {};
  }
}

function isValidVision(v) {
  return (
    v &&
    (v.direction === "BUY" || v.direction === "SELL") &&
    isFinite(v.entry) &&
    isFinite(v.stopLoss) &&
    isFinite(v.takeProfit)
  );
}
function signalShape(x) {
  return {
    direction: x.direction,
    entry: Number(x.entry),
    stopLoss: Number(x.stopLoss),
    takeProfit: Number(x.takeProfit),
  };
}

function buildSpeech(sig, { symbol, tradeType }) {
  const { direction, entry, stopLoss, takeProfit } = sig;
  return `${direction} ${tradeType} on ${symbol}. Entry ${round(entry)}. Stop loss ${round(
    stopLoss
  )}. Take profit ${round(takeProfit)}.`;
}

function round(n) {
  // keep enough precision for stocks/forex/crypto generically
  return Number(n).toFixed(5).replace(/\.?0+$/, "");
}

/* -------------------- Data Fetchers -------------------- */

async function getTwelveDataSeries(symbol, tf, key) {
  if (!key) throw new Error("TWELVEDATA_KEY missing");
  const map = { "1min": "1min", "5min": "5min", "15min": "15min", "60min": "60min", daily: "1day" };
  const interval = map[tf] || "1day";
  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${interval}&outputsize=120&apikey=${encodeURIComponent(key)}`;
  const j = await fetchJSON(url);
  if (!j || j.status === "error") throw new Error(j?.message || "TD error");
  const vals = Array.isArray(j.values) ? j.values : [];
  if (!vals.length) throw new Error("TD no values");
  // Normalize OHLC from newest->oldest => oldest->newest
  return vals
    .map(v => ({
      t: v.datetime,
      o: +v.open,
      h: +v.high,
      l: +v.low,
      c: +v.close,
    }))
    .reverse();
}

async function getFinnhubSeries(symbol, tf, key) {
  if (!key) throw new Error("FINNHUB_KEY missing");
  // Finnhub candle endpoint gives series, but free plans may be limited.
  // We'll try candles first; if it fails, we fallback to quote-only (not ideal for ATR).
  const now = Math.floor(Date.now() / 1000);
  const from = now - 60 * 60 * 24 * 7; // ~1 week
  const resMap = { "1min": "1", "5min": "5", "15min": "15", "60min": "60", daily: "D" };
  const resolution = resMap[tf] || "D";

  const candlesURL =
    `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}` +
    `&resolution=${resolution}&from=${from}&to=${now}&token=${encodeURIComponent(key)}`;
  const jc = await fetchJSON(candlesURL);
  if (jc && jc.s === "ok" && Array.isArray(jc.c) && jc.c.length > 1) {
    return jc.c.map((c, i) => ({
      t: jc.t[i],
      o: jc.o?.[i] ?? c,
      h: jc.h?.[i] ?? c,
      l: jc.l?.[i] ?? c,
      c,
    }));
  }

  // Fallback to /quote (single bar) if candles are unavailable
  const qURL =
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(
      key
    )}`;
  const jq = await fetchJSON(qURL);
  if (jq && jq.c) {
    return [
      {
        t: now,
        o: jq.o ?? jq.c,
        h: jq.h ?? jq.c,
        l: jq.l ?? jq.c,
        c: jq.c,
      },
    ];
  }
  throw new Error("Finnhub no data");
}

/* -------------------- Signal Logic -------------------- */

function computeSignalFromSeries(series, tradeType) {
  // Basic, consistent signal: EMA(9) vs EMA(21) for direction + ATR(14) for risk
  const e9 = ema(series.map(d => d.c), 9);
  const e21 = ema(series.map(d => d.c), 21);
  const last = series[series.length - 1];
  const direction = (e9[e9.length - 1] >= e21[e21.length - 1]) ? "BUY" : "SELL";
  const A = atr(series, 14) || 0.5;

  const mult = tradeType === "Scalp" ? 1.0 : tradeType === "Swing" ? 2.0 : 1.5;
  const entry = last.c;
  const stopLoss = direction === "BUY" ? entry - mult * A : entry + mult * A;
  const takeProfit = direction === "BUY" ? entry + 2 * mult * A : entry - 2 * mult * A;

  return { direction, entry, stopLoss, takeProfit, atr: A, ema9: e9.at(-1), ema21: e21.at(-1) };
}

function ema(values, period) {
  const k = 2 / (period + 1);
  let prev = values[0] ?? 0;
  const out = [prev];
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    prev = v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function atr(series, period = 14) {
  // True Range = max(H-L, |H-prevC|, |L-prevC|)
  const trs = [];
  for (let i = 1; i < series.length; i++) {
    const cur = series[i], prev = series[i - 1];
    const tr = Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c));
    trs.push(tr);
  }
  if (!trs.length) return 0;
  if (trs.length <= period) return avg(trs);
  // SMA of last `period`
  return avg(trs.slice(-period));
}

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

async function fetchJSON(url) {
  const r = await fetch(url);
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    // Normalize any HTML/text errors into an object so we never throw JSON parse errors
    return { _raw: text };
  }
}
