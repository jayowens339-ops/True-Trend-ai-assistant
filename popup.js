/* TrueTrend popup.js — owner build (no license gate)
   - Adds 1m timeframe
   - Always shows/speaks Action + Entry/Stop/TP1/TP2
   - If backend doesn't supply levels, derives them locally
*/

(() => {
  // ---- helpers -------------------------------------------------------------
  const qs = (id) => document.getElementById(id);
  const say = (text) => {
    try {
      const voiceOn = qs('tt-voice')?.checked;
      if (!voiceOn) return;
      speechSynthesis.cancel();
      speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    } catch {}
  };

  // Timeframe risk bands for local fallback sizing (rough ATR-ish %)
  const TF_RISK = {
    '1m': 0.0012,     // ~0.12%
    '5m': 0.0018,     // ~0.18%
    '15m': 0.003,     // ~0.30%
    '1h': 0.006,      // ~0.60%
    '4h': 0.012,      // ~1.20%
    'Daily': 0.02     // ~2.00%
  };

  // Derive levels if API didn't give us numbers
  function deriveLevelsFromPrice(action, px, timeframe) {
    const r = TF_RISK[timeframe] || 0.006; // default 0.6%
    if (!px || !Number.isFinite(+px)) {
      return { entry: '', stop: '', tp1: '', tp2: '' };
    }
    const p = +px;
    if ((action || '').toUpperCase() === 'SELL') {
      return {
        entry: p.toFixed(5),
        stop: (p * (1 + r)).toFixed(5),
        tp1:  (p * (1 - 1.5*r)).toFixed(5),
        tp2:  (p * (1 - 3.0*r)).toFixed(5),
      };
    }
    // BUY default
    return {
      entry: p.toFixed(5),
      stop: (p * (1 - r)).toFixed(5),
      tp1:  (p * (1 + 1.5*r)).toFixed(5),
      tp2:  (p * (1 + 3.0*r)).toFixed(5),
    };
  }

  function formatOutput(j) {
    const s = (j.signals && j.signals[0]) || {};
    // prefer API entryExit; fall back to derived from price
    const ex = j.entryExit && (j.entryExit.entry || j.entryExit.stop || j.entryExit.tp1 || j.entryExit.tp2)
      ? j.entryExit
      : deriveLevelsFromPrice(s.action, j.price, j.timeframe);

    const lines = [];
    if (s.action) lines.push(`Action: ${s.action}`);
    if (s.reason) lines.push(`Why: ${s.reason}`);
    if (j.price)   lines.push(`Last: ${(+j.price).toFixed(5)}`);
    if (ex.entry || ex.stop || ex.tp1 || ex.tp2) {
      lines.push(`Entry: ${ex.entry || ''}`);
      lines.push(`Stop:  ${ex.stop  || ''}`);
      lines.push(`TP1:   ${ex.tp1   || ''}`);
      lines.push(`TP2:   ${ex.tp2   || ''}`);
    }
    if (j.error) lines.push(`Error: ${j.error}`);
    return { text: lines.join('\n'), ex, s };
  }

  async function postJSON(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body),
    });
    return await r.json();
  }

  async function capturePngDataUrl() {
    return new Promise((resolve, reject) => {
      try {
        chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(dataUrl);
        });
      } catch (e) { reject(e); }
    });
  }

  // ---- UI wiring -----------------------------------------------------------
  // Build overlay HTML once
  const html = `
  <div id="tt-wrap" style="all:initial; position:fixed; right:16px; bottom:16px; width:380px; z-index:2147483647; font-family:Inter,system-ui,Segoe UI,Roboto,sans-serif;">
    <style>
      #tt-card{background:#0b1020;color:#e8eeff;border:1px solid #1f2754;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.45);padding:12px}
      #tt-card h2{margin:0 0 8px;font-size:16px}
      .row{display:flex;gap:8px;align-items:center;margin-top:8px}
      .fld{flex:1;background:#0e1538;border:1px solid #24306a;color:#eaf0ff;border-radius:8px;height:36px;padding:0 10px}
      .btn{background:#22c55e;border:none;color:#06200f;font-weight:800;border-radius:8px;height:36px;padding:0 14px;cursor:pointer}
      .btn.sec{background:#a98bff;color:#0d0c1f}
      .btn.danger{background:#ef4444;color:#fff}
      .out{background:#0e1538;border:1px solid #24306a;color:#cfe3ff;border-radius:8px;min-height:170px;padding:10px;white-space:pre-wrap}
      label.small{font-size:12px;color:#9eb0df;display:flex;gap:6px;align-items:center;user-select:none}
    </style>
    <div id="tt-card">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">TrueTrend AI</h2>
        <label class="small"><input type="checkbox" id="tt-voice" checked> Voice</label>
      </div>
      <div class="row">
        <input id="tt-symbol" class="fld" placeholder="Symbol (auto)">
        <select id="tt-tf" class="fld" style="max-width:120px">
          <option>1m</option>
          <option selected>5m</option>
          <option>15m</option>
          <option>1h</option>
          <option>4h</option>
          <option>Daily</option>
        </select>
      </div>
      <div class="row">
        <select id="tt-strat" class="fld">
          <option selected>Trendline</option>
          <option>EMA Touch</option>
          <option>ORB</option>
          <option>Support/Resistance</option>
          <option>RSI + MACD</option>
          <option>Stoch + Williams %R</option>
          <option>Break of Structure</option>
          <option>Pullback Continuation</option>
          <option>Mean Reversion</option>
        </select>
        <button id="tt-go" class="btn">Go</button>
        <button id="tt-vision" class="btn sec">Vision</button>
        <button id="tt-exit" class="btn danger">Exit</button>
      </div>
      <div class="row">
        <div id="tt-out" class="out">Ready.</div>
      </div>
    </div>
  </div>`;
  const wrap = document.createElement('div'); wrap.innerHTML = html;
  document.body.appendChild(wrap);

  const apiBaseDefault = 'https://true-trend-ai-assistant.vercel.app';
  // Persist basic prefs
  const store = {
    get: async () => (await chrome.storage.sync.get({
      apiBase: apiBaseDefault, timeframe:'5m', strategy:'Trendline', voice:true
    })),
    set: async (o) => chrome.storage.sync.set(o)
  };

  // load saved prefs
  (async () => {
    const s = await store.get();
    qs('tt-tf').value = s.timeframe;
    qs('tt-strat').value = s.strategy;
    qs('tt-voice').checked = !!s.voice;
  })();

  // glue
  const outEl = qs('tt-out');

  function setOut(txt) { outEl.textContent = txt; }
  function appendOut(txt) { outEl.textContent = (outEl.textContent ? outEl.textContent + '\n' : '') + txt; }

  async function runAnalyze(useVision) {
    try {
      const s = await store.get();
      const api = (s.apiBase || apiBaseDefault).replace(/\/$/,'');
      const symbol = qs('tt-symbol').value.trim();
      const body = {
        ticker: symbol || '',        // backend can auto-detect
        timeframe: qs('tt-tf').value,
        strategy: qs('tt-strat').value
      };

      setOut(useVision ? 'Capturing chart…' : 'Analyzing…');

      if (useVision) {
        const dataUrl = await capturePngDataUrl();
        const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
        body.image = b64;
      }

      const j = await postJSON(`${api}/api/analyze`, body);
      const {text, ex, s: sig} = formatOutput(j);

      setOut(text);

      // speak an actionable sentence
      if (sig.action) {
        const phrase = `${sig.action}. ${sig.reason || ''} ` +
          (ex.entry ? `Entry ${ex.entry}. ` : '') +
          (ex.stop  ? `Stop ${ex.stop}. ` : '') +
          (ex.tp1   ? `Take profit one ${ex.tp1}. ` : '') +
          (ex.tp2   ? `Take profit two ${ex.tp2}.` : '');
        say(phrase);
      }
      // persist last choices
      store.set({ timeframe: qs('tt-tf').value, strategy: qs('tt-strat').value, voice: qs('tt-voice').checked });

    } catch (e) {
      setOut(`TypeError: ${e.message || e.toString()}`);
    }
  }

  // events
  qs('tt-go').addEventListener('click', () => runAnalyze(false));
  qs('tt-vision').addEventListener('click', () => runAnalyze(true));
  qs('tt-exit').addEventListener('click', () => {
    try { document.getElementById('tt-wrap').remove(); } catch {}
  });

  // optional: Enter to run
  qs('tt-symbol').addEventListener('keydown', (e) => { if (e.key === 'Enter') runAnalyze(false); });

})();
