/* ================================
   TrueTrend popup.js — Universal (v4.3.3.5+)
   - Attach-first Analyze
   - Debounced auto-Analyze on strategy change
   - 8 timeframes
   - Two strategy groups (Stock Options, Futures & Forex)
   - License Activate/Verify (Lemon Squeezy via Vercel)
   ================================ */

/* ---------- tiny helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const on = (el, ev, fn, opts) => el && el.addEventListener(ev, fn, opts);
const debounce = (fn, ms = 200) => {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

// Send a message to the active tab (content script)
function withTab(cb) {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs && tabs[0]) cb(tabs[0].id, tabs[0]);
    });
  } catch (e) { /* ignore */ }
}

// Storage helpers
const store = {
  async get(keys) { return chrome.storage?.local?.get?.(keys) || {}; },
  async set(obj) { try { return chrome.storage?.local?.set?.(obj); } catch { } }
};

/* ---------- constants & presets ---------- */
const TIMEFRAMES = ["1 min", "5 min", "15 min", "30 min", "1 hour", "4 hours", "Daily", "Monthly"];

const STOCK_OPTIONS = [
  "Covered Call","Cash-Secured Put (CSP)","Wheel","Long Call","Long Put",
  "Debit Call Spread","Debit Put Spread","Credit Call Spread","Credit Put Spread",
  "Iron Condor","Iron Butterfly","Broken Wing Butterfly","Collar","Protective Put",
  "PMCC (LEAPS Covered Call)","Calendar","Diagonal","Straddle","Strangle",
  "Short Straddle","Short Strangle","Box Spread"
];

const FUTURES_FOREX = [
  "EMA Trend (9/50)","RSI Divergence","MACD Cross","Bollinger Bounce",
  "Donchian/Turtle Breakout","Opening Range Breakout (ORB)","Support/Resistance",
  "Ichimoku Trend","Pivot Bounce","Fibonacci Pullback","Momentum (ROC)",
  "Mean Reversion","Range Scalping (M1/M5)","Swing (H4/D1)",
  "Heikin-Ashi Trend","ADR Breakout","Keltner Breakout","Carry Trade (FX)"
];

/* ---------- UI setup ---------- */
function makeOption(label) {
  const o = document.createElement("option");
  o.value = label;
  o.textContent = label;
  // readable in dark popups
  o.style.color = "#111827";
  o.style.backgroundColor = "#ffffff";
  return o;
}

async function populateTimeframes() {
  const sel = $("#timeframe");
  if (!sel) return;
  // remember previous
  const saved = (await store.get(["tt_timeframe"]))?.tt_timeframe;
  const current = (sel.value || sel.options[sel.selectedIndex]?.textContent || saved || "").trim();

  // clear & fill
  while (sel.firstChild) sel.removeChild(sel.firstChild);
  TIMEFRAMES.forEach(tf => {
    const o = makeOption(tf);
    if ((!current && tf === "5 min") || current === tf) o.selected = true;
    sel.appendChild(o);
  });

  sel.addEventListener("change", () => store.set({ tt_timeframe: sel.value }));
}

async function populateStrategies() {
  const sel = $("#strategy");
  if (!sel) return;

  while (sel.firstChild) sel.removeChild(sel.firstChild);

  const g1 = document.createElement("optgroup");
  g1.label = "Stock Options";
  STOCK_OPTIONS.forEach(n => g1.appendChild(makeOption(n)));

  const g2 = document.createElement("optgroup");
  g2.label = "Futures & Forex";
  FUTURES_FOREX.forEach(n => g2.appendChild(makeOption(n)));

  // visibility in dark UI
  g1.style.color = "#334155";
  g1.style.backgroundColor = "#ffffff";
  g2.style.color = "#334155";
  g2.style.backgroundColor = "#ffffff";

  sel.appendChild(g1);
  sel.appendChild(g2);

  // persist selection
  const saved = (await store.get(["tt_strategy"]))?.tt_strategy;
  if (saved) sel.value = saved;
  on(sel, "change", () => store.set({ tt_strategy: sel.value }));

  // auto-analyze on pick (debounced)
  const trigger = debounce(() => attachThenAnalyze(), 220);
  on(sel, "change", trigger, { capture: true });
  on(sel, "input", trigger, { capture: true });
}

/* ---------- attach + analyze ---------- */
function getInputs() {
  const symbol = ($("#symbol") || {}).value || "";        // optional
  const timeframe = ($("#timeframe") || {}).value || "";  // one of TIMEFRAMES
  const strategy = ($("#strategy") || {}).value || "";    // from groups
  return { symbol, timeframe, strategy };
}

function attachToActiveTab(cb) {
  withTab(tabId => {
    try {
      chrome.tabs.sendMessage(tabId, { type: "TT_ATTACH" }, () => {
        // ignore response—content may be missing on some pages before permissions
        (cb || function () { })();
      });
    } catch { (cb || function () { })(); }
  });
}

function sendAnalyze() {
  const payload = { cmd: "TT_ANALYZE", ...getInputs() };
  try { chrome.runtime.sendMessage(payload); } catch { /* ignore */ }
}

function attachThenAnalyze() {
  attachToActiveTab(() => sendAnalyze());
}

/* ---------- wiring buttons (if present) ---------- */
function wireButtons() {
  const btnAttach = $("#attach");
  const btnAnalyze = $("#analyze");

  on(btnAttach, "click", () => attachToActiveTab(), { capture: true });
  on(btnAnalyze, "click", () => attachThenAnalyze(), { capture: true });
}

/* ---------- init ---------- */
async function init() {
  // Make dropdowns readable in dark themes (safety net if HTML lacks styles)
  const style = document.createElement("style");
  style.textContent = `
    #strategy, #timeframe { color:#e5e7eb; background:#0b1220; }
    #strategy option, #timeframe option { color:#111827; background:#fff; }
    #strategy optgroup, #timeframe optgroup { color:#334155; background:#fff; font-weight:600; }
    select { outline: none; }
  `;
  document.head.appendChild(style);

  await populateTimeframes();
  await populateStrategies();
  wireButtons();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

/* =======================================================================
   LICENSE BUNDLE (Lemon Squeezy via Vercel) — single place to edit API_BASE
   - Adds Account section (Activate)
   - Verifies license and exposes entitlements
   - Gating helper: TrueTrendGate(feature, onAllow)
   ======================================================================= */
(() => {
  if (window.__tt_license_bundle__) return; window.__tt_license_bundle__ = true;

  // TODO: SET THIS to your Vercel URL (base path only, no trailing slash)
  // Example: "https://your-app.vercel.app/api/license"
  const API_BASE = "https://YOUR-APP.vercel.app/api/license";

  async function api(path, body) {
    try {
      const r = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {})
      });
      return await r.json();
    } catch {
      return { ok: false, reason: "network" };
    }
  }

  // Inject minimal Account UI without touching HTML
  function injectAccountUI() {
    // short-circuit if it's already there
    if ($("#tt-account")) return;

    const css = document.createElement("style");
    css.textContent = `
      #tt-account{margin-top:12px;padding:12px;border-radius:10px;background:#0b1220;border:1px solid #1e293b}
      #tt-account h3{margin:0 0 8px;font-size:14px;color:#e5e7eb}
      #tt-account .row{display:flex;gap:8px;align-items:center}
      #tt-licenseKey{flex:1;padding:8px 10px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#e5e7eb}
      #tt-btnActivate{padding:8px 12px;border-radius:8px;border:0;background:#22c55e;color:#0b1220;font-weight:600;cursor:pointer}
      #tt-plan{margin-top:8px;font-size:12px;opacity:.9;color:#cbd5e1}
    `;
    document.head.appendChild(css);

    const wrap = document.createElement("section");
    wrap.id = "tt-account";
    wrap.innerHTML = `
      <h3>Account</h3>
      <div class="row">
        <input id="tt-licenseKey" placeholder="Paste license key"/>
        <button id="tt-btnActivate">Activate</button>
      </div>
      <div id="tt-plan">Plan: —</div>
    `;

    // insert near bottom; fallback to body
    const holder = $("#account") || $("#out") || document.body;
    holder.appendChild(wrap);
  }

  const state = { entitlements: {} };

  async function verifyAndRender() {
    const { tt_licenseKey: licenseKey, tt_instanceId: instanceId } =
      await chrome.storage.sync.get(["tt_licenseKey", "tt_instanceId"]);

    const planEl = $("#tt-plan");
    if (!planEl) return;

    if (!licenseKey) { planEl.textContent = "Plan: (not activated)"; return; }

    const res = await api("/verify", { licenseKey, instanceId });
    if (!res?.ok) { planEl.textContent = "Plan: invalid"; return; }

    state.entitlements = res.entitlements || {};
    planEl.textContent = `Plan: ${res.plan}${res.expires ? " · renews " + new Date(res.expires).toLocaleDateString() : ""}`;
  }

  async function activate() {
    const keyEl = $("#tt-licenseKey");
    if (!keyEl) return;
    const licenseKey = (keyEl.value || "").trim();
    if (!licenseKey) return;

    const instanceId = crypto.randomUUID();

    const res = await api("/activate", { licenseKey, instanceId, instanceName: "TrueTrend" });
    if (!res?.ok) { alert("Activation failed. Check your key and try again."); return; }

    await chrome.storage.sync.set({ tt_licenseKey: licenseKey, tt_instanceId: res.instanceId || instanceId });
    await verifyAndRender();
  }

  // Gate helper for PRO/FOUNDER-only features (call before running advanced features)
  window.TrueTrendGate = function (feature, onAllow) {
    if (state.entitlements?.[feature]) return onAllow && onAllow();
    // Not entitled → open pricing
    try { window.open("https://truetrend.ai/pricing", "_blank"); } catch { }
  };

  // Init license UI/bindings
  document.addEventListener("DOMContentLoaded", () => {
    injectAccountUI();
    const btn = $("#tt-btnActivate");
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = "1";
      btn.addEventListener("click", activate, { capture: true });
    }
    verifyAndRender();
  });
})();
