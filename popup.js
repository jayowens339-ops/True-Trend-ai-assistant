/* popup.js — TrueTrend AI (Owner build, single file, draggable overlay) */
"use strict";

// >>> YOUR OWNER TOKEN (must match Vercel OWNER_LICENSE) <<<
const OWNER_EMBEDDED = "Truetrendtrading4u!";

// Defaults for popup settings
const DEFAULTS = {
  apiBase: "https://true-trend-ai-assistant.vercel.app",
  timeframe: "Daily",
  strategy: "Trendline",
  voice: true
};

const $ = (id) => document.getElementById(id);

// ---------- POPUP (settings + journal) ----------
async function loadSettings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  $("apiBase").value = s.apiBase;
  $("tf").value = s.timeframe;
  $("str").value = s.strategy;
  $("voice").checked = !!s.voice;
  $("openApp").href = s.apiBase.replace(/\/$/,"") + "/app.html";
  const rows = (await chrome.storage.local.get({ ttai_journal: [] })).ttai_journal;
  renderRows(rows);
}
document.addEventListener("DOMContentLoaded", () => {
  loadSettings();
  $("save").addEventListener("click", async () => {
    await chrome.storage.sync.set({
      apiBase: $("apiBase").value.replace(/\/$/,""),
      timeframe: $("tf").value,
      strategy: $("str").value,
      voice: $("voice").checked
    });
    alert("Saved.");
  });
  $("attach").addEventListener("click", attachToPage);
  $("export").addEventListener("click", exportCSV);
  $("clear").addEventListener("click", clearJournal);
});

function renderRows(rows) {
  const tb = document.querySelector("#tbl tbody");
  tb.innerHTML = rows.map(r => `<tr>
    <td>${r.time||""}</td><td>${r.ticker||""}</td><td>${r.tf||""}</td>
    <td>${r.strategy||""}</td><td>${r.action||""}</td><td>${r.price||""}</td>
  </tr>`).join("");
}
async function exportCSV(){
  const rows = (await chrome.storage.local.get({ ttai_journal: [] })).ttai_journal;
  const header = ["Time","Ticker","TF","Strategy","Action","Price"];
  const csv = [header.join(","), ...rows.map(r => [r.time,r.ticker,r.tf,r.strategy,r.action,r.price||""].join(","))].join("\n");
  const blob = new Blob([csv], { type:"text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = "TrueTrend_Journal.csv"; a.click();
  URL.revokeObjectURL(url);
}
async function clearJournal(){ if(!confirm("Clear the journal?")) return; await chrome.storage.local.set({ ttai_journal: [] }); renderRows([]); }

async function attachToPage(){
  const [tab] = await chrome.tabs.query({ active:true, currentWindow:true });
  if (!tab?.id) return;
  const opts = await chrome.storage.sync.get(DEFAULTS);
  opts.ownerToken = OWNER_EMBEDDED;
  opts.apiBase = (opts.apiBase || DEFAULTS.apiBase).replace(/\/$/, "");
  await chrome.scripting.executeScript({ target:{ tabId:tab.id }, func: injectedOverlay, args:[opts] });
}

// ============ INJECTED OVERLAY ============
function injectedOverlay(opts){
  if (window.__TTAI_OVERLAY__) return; window.__TTAI_OVERLAY__ = true;

  const css = `#ttai-ov{position:fixed;right:14px;bottom:14px;width:330px;z-index:2147483647;
    font-family:Inter,system-ui,Segoe UI,Roboto,sans-serif;color:#e9eeff;background:#121935;border:1px solid #29336b;
    border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.4);user-select:none}
    #ttai-ov .head{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid #29336b;cursor:move;font-weight:700;background:#0f1733;border-top-left-radius:12px;border-top-right-radius:12px}
    #ttai-ov .close{cursor:pointer;padding:0 6px;font-size:18px;line-height:1}
    #ttai-ov .row{display:flex;gap:6px;align-items:center;padding:10px}
    #ttai-ov input,#ttai-ov select,#ttai-ov button{height:34px;border-radius:8px;border:1px solid #29336b;background:#0e1538;color:#e9eeff;padding:0 8px}
    #ttai-ov button{background:#22c55e;color:#04220f;font-weight:700;cursor:pointer}
    #ttai-ov .t{font-size:12px;color:#93a7d9;padding:0 10px 10px}
    #ttai-ov .sig{font-weight:900;padding:0 10px 8px}
    #ttai-ov .buy{color:#22c55e}#ttai-ov .sell{color:#ff7373}
    #ttai-ov .mut{color:#a9b7e2;font-size:11px}
    #ttai-ov .link{color:#cfe1ff;text-decoration:underline;cursor:pointer}
    #ttai-ov .foot{display:flex;gap:8px;align-items:center;padding:0 10px 10px}`;
  const st=document.createElement("style"); st.textContent=css; document.documentElement.appendChild(st);

  const box=document.createElement("div"); box.id="ttai-ov";
  box.innerHTML = `
    <div class="head" id="tt-head"><span>TrueTrend AI</span><span class="close" id="tt-close">×</span></div>
    <div class="row">
      <input id="tt-sym" placeholder="Symbol (EURUSD, AAPL, BTCUSDT)" style="flex:1">
      <select id="tt-tf"><option>5m</option><option>15m</option><option>1h</option><option>4h</option><option>Daily</option></select>
      <button id="tt-go">Go</button>
    </div>
    <div class="row">
      <select id="tt-str" style="flex:1">
        <option>Trendline</option><option>EMA Touch</option><option>ORB</option><option>Support/Resistance</option>
        <option>Stoch + Williams %R</option><option>RSI + MACD</option><option>Break of Structure</option>
        <option>Pullback Continuation</option><option>Mean Reversion</option>
      </select>
      <label class="mut" style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" id="tt-voice" style="width:16px;height:16px"> Voice
      </label>
      <button id="tt-test" title="Test voice">🔊 Test</button>
    </div>
    <div class="t" id="tt-st">Attached. Watching…</div>
    <div id="tt-out" class="t"></div>
    <div id="tt-sig" class="sig"></div>
    <div class="foot"><span class="link" id="tt-log">Log last</span><span class="mut" id="tt-err"></span></div>`;
  document.documentElement.appendChild(box);

  const q = s=>box.querySelector(s);
  const head=q("#tt-head"), symEl=q("#tt-sym"), tfEl=q("#tt-tf"), strEl=q("#tt-str"), voiceEl=q("#tt-voice");
  const stEl=q("#tt-st"), outEl=q("#tt-out"), sigEl=q("#tt-sig"), errEl=q("#tt-err");

  tfEl.value = "Daily"; strEl.value = "Trendline"; voiceEl.checked = true;
  symEl.value = guessSym() || "EURUSD";

  // drag by the top bar
  let dragging=false,sx=0,sy=0,startLeft=0,startTop=0;
  head.addEventListener("mousedown",e=>{dragging=true;const r=box.getBoundingClientRect();startLeft=r.left;startTop=r.top;sx=e.clientX;sy=e.clientY;
    box.style.left=r.left+"px";box.style.top=r.top+"px";box.style.right="auto";box.style.bottom="auto";e.preventDefault();});
  window.addEventListener("mousemove",e=>{if(!dragging)return;const r=box.getBoundingClientRect();const dx=e.clientX-sx,dy=e.clientY-sy;
    const W=innerWidth,H=innerHeight;const left=Math.min(Math.max(0,startLeft+dx),W-r.width);const top=Math.min(Math.max(0,startTop+dy),H-r.height);
    box.style.left=left+"px";box.style.top=top+"px";});
  window.addEventListener("mouseup",()=>{dragging=false;});

  function speak(text){ try{ if(!voiceEl.checked) return; speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(text)); }catch{} }

  function guessSym(){
    const u=new URL(location.href);
    const sp=u.searchParams.get("symbol")||u.searchParams.get("ticker");
    if(sp){
      const raw=decodeURIComponent(sp).toUpperCase();
      const m=raw.match(/(?:OTC(?:MKTS)?|PINK|OTCQB|OTCQX|GREY):([A-Z.\-]+)/i);
      if(m) return m[1].toUpperCase();
      return raw.replace(/[:_]/g,"").replace(/-.*/,"");
    }
    const m2=location.pathname.match(/(?:OTC(?:MKTS)?|PINK|OTCQB|OTCQX|GREY):([A-Z.\-]+)/i); if(m2) return m2[1].toUpperCase();
    const m3=location.pathname.match(/[A-Z]{2,6}(?:USDT|USD|JPY|GBP|EUR|CAD|AUD|CHF|F|Y)?/); if(m3) return m3[0].toUpperCase();
    const t1=document.title.match(/(?:OTC(?:MKTS)?|PINK|OTCQB|OTCQX|GREY):([A-Z.\-]+)/i); if(t1) return t1[1].toUpperCase();
    const t2=document.title.match(/[A-Z]{2,6}(?:USDT|USD|JPY|GBP|EUR|CAD|AUD|CHF|F|Y)?/); return t2 ? t2[0].toUpperCase() : "";
  }

  async function logEntry(entry){
    try{
      const key="ttai_journal";
      const data=await chrome.storage.local.get({ [key]: [] });
      const rows=data[key]; rows.unshift(entry);
      await chrome.storage.local.set({ [key]: rows.slice(0,2000) });
    }catch{}
  }

  async function run(){
    const API=(opts.apiBase||"https://true-trend-ai-assistant.vercel.app").replace(/\/$/,"")+"/api/analyze";
    stEl.textContent="Analyzing…"; errEl.textContent="";
    try{
      const headers={"Content-Type":"application/json","Authorization":"Bearer "+opts.ownerToken};
      const res=await fetch(API,{
        method:"POST",
        headers,
        body:JSON.stringify({ ticker:symEl.value.trim()||"EURUSD", timeframe:tfEl.value, strategy:strEl.value })
      });
      const j=await res.json().catch(()=>({}));

      if(!res.ok && (res.status===401 || res.status===402)){
        stEl.textContent="Locked.";
        outEl.textContent="Owner token invalid or missing.";
        errEl.textContent="Check token / Vercel OWNER_LICENSE.";
        return;
      }

      const s=(j.signals&&j.signals[0])||null;
      outEl.textContent=(j.summary||"")+(j.mode?` [${j.mode}]`:"");
      sigEl.textContent=s?`${s.action} — ${s.reason} (${Math.round((s.confidence||0)*100)}%)`:"";
      sigEl.className="sig "+(s?(s.action==="BUY"?"buy":"sell"):"");

      if(s){
        speak(`${s.action}. ${s.reason}`);
        await logEntry({
          time: new Date().toLocaleString(),
          ticker: symEl.value.toUpperCase(),
          tf: tfEl.value, strategy: strEl.value,
          action: s.action, price: j.price || "", notes: ""
        });
      }
    }catch(e){
      outEl.textContent="Error. Try again.";
      errEl.textContent=(e && e.message) ? e.message : "Network/permissions";
    }
    stEl.textContent="Watching…";
  }

  q("#tt-go").addEventListener("click", run);
  symEl.addEventListener("keydown", e => { if (e.key === "Enter") run(); });
  q("#tt-test").addEventListener("click", () => speak("Voice is working."));
  q("#tt-close").addEventListener("click", () => { box.remove(); window.__TTAI_OVERLAY__ = false; });

  run();

  // auto-refresh when the page changes symbol/title
  let href=location.href,tit=document.title;
  setInterval(()=>{
    if(location.href!==href || document.title!==tit){
      href=location.href; tit=document.title;
      const g=guessSym(); if(g && g!==symEl.value){ symEl.value=g; run(); }
    }
  },1500);
}
