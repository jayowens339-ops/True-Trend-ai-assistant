// popup.js — single-file logic: Owner bypass, Vision, data fallback, overlay injection
(function () {
  const $ = (s) => document.querySelector(s);
  const out = $("#output");
  const apiBase = $("#apiBase");
  const timeframe = $("#timeframe");
  const voice = $("#voice");
  const symbol = $("#symbol");
  const strategy = $("#strategy");
  const style = $("#style");
  const tradeType = $("#tradeType");
  const detectBtn = $("#detect");
  const saveKeysBtn = $("#saveKeys");
  const tdKeyInput = $("#tdKey");
  const fhKeyInput = $("#fhKey");
  const goBtn = $("#go");
  const visionBtn = $("#vision");
  const testBtn = $("#testVoice");
  const exitBtn = $("#exit");

  function show(o) { out.textContent = JSON.stringify(o, null, 2); }
  function speak(t) {
    try { if (!voice.checked) return;
      const u = new SpeechSynthesisUtterance(t);
      speechSynthesis.cancel(); speechSynthesis.speak(u);
    } catch (e) {}
  }

  chrome.storage.local.get(["tt_settings","td_api_key","fh_api_key"], (res) => {
    const s = res.tt_settings || {};
    apiBase.value = s.apiBase || "https://true-trend-ai-assistant.vercel.app";
    timeframe.value = s.timeframe || "5min";
    symbol.value = s.symbol || "AAPL";
    strategy.value = s.strategy || "EMA";
    style.value = s.style || "Day";
    tradeType.value = s.tradeType || "Day Trade";
    tdKeyInput.value = res.td_api_key || "";
    fhKeyInput.value = res.fh_api_key || "";
    show({ ok: true, owner: true, msg: "Owner build active. License bypassed." });
  });
  [apiBase, timeframe, voice, symbol, strategy, style, tradeType].forEach((el) => {
    el.addEventListener("change", () => {
      chrome.storage.local.set({
        tt_settings: {
          apiBase: apiBase.value, timeframe: timeframe.value, voice: voice.checked,
          symbol: symbol.value, strategy: strategy.value, style: style.value, tradeType: tradeType.value,
        },
      });
    });
  });
  saveKeysBtn.addEventListener("click", () => {
    chrome.storage.local.set({ td_api_key: tdKeyInput.value.trim(), fh_api_key: fhKeyInput.value.trim() },
      () => show({ ok: true, msg: "API keys saved" })
    );
  });
  testBtn.addEventListener("click", () => speak("TrueTrend voice check. You're good to go."));
  exitBtn.addEventListener("click", () => window.close());

  // Detect symbol from the active tab (TradingView / generic)
  detectBtn.addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0]; if (!tab) return;
      try {
        const url = new URL(tab.url || "http://x/");
        const tv = url.pathname.match(/symbol\/([A-Z0-9:._-]+)/i) || url.search.match(/symbol=([A-Z0-9:._-]+)/i);
        if (tv) { symbol.value = tv[1].split(":").pop().split(".")[0].toUpperCase(); return; }
        const tkn = (tab.title || "").match(/\b[A-Z]{1,5}\b/);
        if (tkn) symbol.value = tkn[0];
      } catch {}
    });
  });

  // ===== Data helpers =====
  async function fetchJSON(url) {
    const r = await fetch(url); const t = await r.text();
    try { return JSON.parse(t); } catch { return { _raw: t }; }
  }
  async function getTD(sym, tf, key) {
    if (!key) throw new Error("TWELVEDATA_KEY missing");
    const map = { "1min": "1min", "5min": "5min", "15min": "15min", "60min": "60min", "daily": "1day" };
    const u = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${map[tf]||"1day"}&outputsize=120&apikey=${encodeURIComponent(key)}`;
    const j = await fetchJSON(u);
    if (j && j.values && Array.isArray(j.values) && j.values.length) {
      return j.values.map(v => ({ h:+v.high, l:+v.low, c:+v.close, t:v.datetime })).reverse();
    }
    throw new Error("twelvedata_failed");
  }
  async function getFH(sym, tf, key) {
    if (!key) throw new Error("FINNHUB_KEY missing");
    const now = Math.floor(Date.now()/1000), from = now-60*60*24*7;
    const res = { "1min":"1","5min":"5","15min":"15","60min":"60","daily":"D" }[tf] || "D";
    const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(sym)}&resolution=${res}&from=${from}&to=${now}&token=${encodeURIComponent(key)}`;
    const jc = await fetchJSON(url);
    if (jc && jc.s === "ok" && Array.isArray(jc.c) && jc.c.length > 1) {
      return jc.c.map((c,i)=>({ t:jc.t[i], o:jc.o?.[i]??c, h:jc.h?.[i]??c, l:jc.l?.[i]??c, c }));
    }
    const q = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(key)}`;
    const jq = await fetchJSON(q);
    if (jq && jq.c) return [{ t: now, o: jq.o ?? jq.c, h: jq.h ?? jq.c, l: jq.l ?? jq.c, c: jq.c }];
    throw new Error("finnhub_failed");
  }
  function ema(vals, p){ const k=2/(p+1); let prev=vals[0]??0, out=[prev]; for(let i=1;i<vals.length;i++){ const v=vals[i]; prev=v*k+prev*(1-k); out.push(prev);} return out; }
  function atr(series, period=14){
    const trs=[]; for(let i=1;i<series.length;i++){ const a=series[i], b=series[i-1];
      trs.push(Math.max(a.h-a.l, Math.abs(a.h-b.c), Math.abs(a.l-b.c)));
    }
    const n=Math.min(period, trs.length)||1; let s=0; for(let i=trs.length-n;i<trs.length;i++) s+=trs[i]; return s/n;
  }
  function computeSignal(series, tradeType){
    const e9=ema(series.map(d=>d.c),9), e21=ema(series.map(d=>d.c),21);
    const last=series.at(-1); const direction=e9.at(-1)>=e21.at(-1)?"BUY":"SELL";
    const A=atr(series,14)||0.5; const mult=tradeType==="Scalp"?1.0:tradeType==="Swing"?2.0:1.5;
    const entry=last.c, stop=direction==="BUY"?entry-mult*A:entry+mult*A, tp=direction==="BUY"?entry+2*mult*A:entry-2*mult*A;
    return { direction, entry, stopLoss:stop, takeProfit:tp, atr:A };
  }

  // ===== Overlay injection (no separate files) =====
  async function injectOverlay(tabId, payload){
    const func = (payload) => {
      (function(){
        const old = document.getElementById("tt-owner-overlay"); if (old) old.remove();
        const box = document.createElement("div"); box.id = "tt-owner-overlay";
        Object.assign(box.style,{position:"fixed",top:"12px",right:"12px",zIndex:2147483647,background:"rgba(10,13,22,.92)",color:"#eaeef5",padding:"12px",border:"1px solid #223",borderRadius:"14px",fontFamily:"system-ui,Segoe UI,Arial,sans-serif",boxShadow:"0 10px 24px rgba(0,0,0,.45)",minWidth:"300px"});
        box.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
            <div style="font-weight:700">TrueTrend AI <span style="opacity:.7">(Owner)</span></div>
            <button id="tt-exit" style="background:#f55757;color:#fff;border:0;border-radius:10px;padding:6px 10px;font-weight:700;cursor:pointer">Exit</button>
          </div>
          <div style="margin-top:8px;font-size:13px;line-height:1.35">
            <div><b>${payload.direction}</b> | Entry <b>${payload.entry.toFixed(5)}</b></div>
            <div>Stop Loss <b>${payload.stopLoss.toFixed(5)}</b> • Take Profit <b>${payload.takeProfit.toFixed(5)}</b></div>
          </div>
        `;
        document.body.appendChild(box);
        document.querySelectorAll('[data-tt-line]').forEach(x=>x.remove());
        function line(label,price,color,yPct){
          const el=document.createElement("div");
          Object.assign(el.style,{position:"fixed",left:"0",width:"100vw",borderTop:`2px dashed ${color}`,top:`${yPct}%`,zIndex:2147483646,pointerEvents:"none"});
          el.setAttribute("data-tt-line","");
          const tag=document.createElement("div"); tag.textContent=`${label}: ${price.toFixed(5)}`;
          Object.assign(tag.style,{position:"absolute",right:"12px",top:"-10px",background:color,color:"#000",padding:"2px 6px",borderRadius:"8px",fontSize:"12px",fontWeight:"700"});
          el.appendChild(tag); document.body.appendChild(el);
        }
        line("ENTRY", payload.entry, payload.direction==="BUY"?"#1fc46b":"#e34a4a", 50);
        line("STOP", payload.stopLoss, "#f55757", 70);
        line("TP", payload.takeProfit, "#1fc46b", 30);
        document.getElementById("tt-exit").onclick = () => {
          document.getElementById("tt-owner-overlay")?.remove();
          document.querySelectorAll('[data-tt-line]').forEach(x=>x.remove());
        };
      })();
    };
    await chrome.scripting.executeScript({ target: { tabId }, func, args: [payload] });
  }

  // ===== Actions =====
  goBtn.addEventListener("click", async () => {
    try {
      const keys = await new Promise(r => chrome.storage.local.get(["td_api_key","fh_api_key"], r));
      let series, source;
      try { series = await getTD(symbol.value, timeframe.value, keys.td_api_key); source="twelvedata"; }
      catch { series = await getFH(symbol.value, timeframe.value, keys.fh_api_key); source="finnhub"; }
      const sig = computeSignal(series, tradeType.value);
      speak(`${sig.direction} on ${symbol.value}. Entry ${sig.entry}. Stop ${sig.stopLoss}. Target ${sig.takeProfit}.`);
      show({ ok: true, stage: "done", source, ...sig });
      chrome.tabs.query({active:true,currentWindow:true}, async tabs => { if (tabs[0]) await injectOverlay(tabs[0].id, sig); });
    } catch (e) {
      show({ ok: false, stage: "server", error: e.message || String(e) });
    }
  });

  visionBtn.addEventListener("click", async () => {
    try {
      // Capture as JPEG (smaller): avoids 413 payloads
      chrome.tabs.captureVisibleTab(null, { format: "jpeg", quality: 80 }, async (dataUrl) => {
        if (chrome.runtime.lastError || !dataUrl) {
          return show({ ok: false, stage: "capture", error: chrome.runtime.lastError?.message || "capture_failed" });
        }
        let raw;
        try {
          const r = await fetch(`${apiBase.value.replace(/\/$/,"")}/api/analyze`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-TT-Owner": "1" }, // Owner bypass
            body: JSON.stringify({
              image: dataUrl,
              options: {
                symbol: symbol.value,
                timeframe: timeframe.value,
                tradeType: tradeType.value,
                strategy: strategy.value,
                style: style.value,
                owner: true // Owner bypass
              }
            })
          });
          raw = await r.text();
          let j; try { j = JSON.parse(raw); } catch { return show({ ok:false, stage:"parse", error:"bad_json", raw: raw?.slice(0,400) }); }
          if (!j.ok) return show({ ok:false, stage:"server", ...j });
          if (j.speech) speak(j.speech);
          show({ stage:"done", ...j });
          chrome.tabs.query({active:true,currentWindow:true}, async tabs => {
            if (tabs[0]) await injectOverlay(tabs[0].id, { direction:j.direction, entry:j.entry, stopLoss:j.stopLoss, takeProfit:j.takeProfit });
          });
        } catch (err) {
          show({ ok: false, stage: "network", error: String(err) });
        }
      });
    } catch (e) {
      show({ ok: false, stage: "client", error: e.message || String(e) });
    }
  });
})();
