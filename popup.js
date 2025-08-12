/* ============ OWNER BUILD FLAGS (baked) ============ */
const BUILD = 'owner';
const OWNER_TOKEN = 'Truetrendtrading4u!'; // your owner token

/* ============ SETTINGS ============ */
const API_BASE = 'https://true-trend-ai-assistant.vercel.app'; // change if you move your API
const ANALYZE_URL = `${API_BASE}/api/analyze`;

const qs = id => document.getElementById(id);
const $symbol = qs('symbol');
const $tf     = qs('tf');
const $strat  = qs('strategy');
const $go     = qs('btnGo');
const $vision = qs('btnVision');
const $attach = qs('btnAttach');
const $export = qs('btnExport');
const $clear  = qs('btnClear');
const $voice  = qs('voice');
const $exit   = qs('btnExit');
const $out    = qs('out');

function say(text){
  try{
    if (!$voice.checked) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text).replace(/\s+/g,' ').trim());
    speechSynthesis.speak(u);
  }catch{}
}
function log(o){ $out.value = typeof o === 'string' ? o : JSON.stringify(o,null,2); }

/* ============ API HELPERS ============ */
async function postAnalyze(body){
  const res = await fetch(ANALYZE_URL, {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'Authorization': `Bearer ${OWNER_TOKEN}` // owner bypass
    },
    body: JSON.stringify(body)
  });
  return res.json();
}

/* ============ ANALYZE + VISION ============ */
async function runAnalyze(kind){
  const payload = {
    ticker: ($symbol.value || '').trim(),
    timeframe: $tf.value,
    strategy: $strat.value
  };
  log(`Waiting for ${kind}…`);
  try{
    if (kind === 'vision'){
      // capture tab as dataURL png
      const tab = await chrome.tabs.query({active:true,currentWindow:true});
      if(!tab[0]) throw new Error('No active tab');
      const dataUrl = await chrome.tabs.captureVisibleTab({format:'png'});
      payload.image = dataUrl; // the API accepts { image: dataURL }
      payload.vision = true;
    }
    const j = await postAnalyze(payload);

    // pretty print + voice
    log(j);
    const s = j?.signals?.[0];
    const ex = j?.entryExit || {};
    if (s){
      say(`${s.action}. ${s.reason || ''}. Entry ${ex.entry || 'unknown'}. Stop ${ex.stop || 'unknown'}. Take profit ${ex.tp1 || ex.tp2 || 'unknown'}.`);
      // journal
      await appendJournal({
        time: new Date().toLocaleString(),
        ticker: payload.ticker || '(auto)',
        tf: payload.timeframe,
        strat: payload.strategy,
        action: s.action,
        price: j.price || '',
        entry: ex.entry||'',
        stop: ex.stop||'',
        tp1: ex.tp1||'',
        tp2: ex.tp2||'',
        why: s.reason||''
      });
    }
  }catch(e){
    log(`TypeError: ${e?.message || e}`);
  }
}

/* ============ JOURNAL ============ */
async function appendJournal(row){
  const key='ttai_journal';
  const { [key]:rows=[] } = await chrome.storage.local.get({ [key]:[] });
  rows.unshift(row);
  await chrome.storage.local.set({ [key]: rows.slice(0,2000) });
}
async function exportCSV(){
  const key='ttai_journal';
  const { [key]:rows=[] } = await chrome.storage.local.get({ [key]:[] });
  const header=['Time','Ticker','TF','Strategy','Action','Price','Entry','Stop','TP1','TP2','Why'];
  const csv=[header.join(','),...rows.map(r=>[
    r.time,r.ticker,r.tf,r.strat,r.action,r.price,r.entry,r.stop,r.tp1,r.tp2,(r.why||'').replace(/,/g,';')
  ].join(','))].join('\n');
  const blob=new Blob([csv],{type:'text/csv'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download='TrueTrend_Journal.csv'; a.click();
  URL.revokeObjectURL(url);
}

/* ============ OVERLAY (Attach) ============ */
function injectedOverlay(opts){
  if (window.__TTAI_OVERLAY__) return; window.__TTAI_OVERLAY__=true;

  const css=`
  #ttai-ov{all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;width:360px;background:#101735;color:#e9eeff;
    font-family:Inter,system-ui,Segoe UI,Roboto,sans-serif;border:1px solid #27306b;border-radius:12px;padding:12px;box-shadow:0 10px 30px rgba(0,0,0,.45)}
  #ttai-ov *{all:unset;display:revert}
  #ttai-ov .row{display:flex;gap:8px;align-items:center;margin-bottom:8px}
  #ttai-ov input,#ttai-ov select,#ttai-ov button{background:#0e1538;border:1px solid #28326e;color:#eaf0ff;border-radius:8px;height:34px;padding:0 8px}
  #ttai-ov button.go{background:#22c55e;color:#04220f;font-weight:800}
  #ttai-ov button.v{background:#a78bfa}
  #ttai-ov .mut{color:#9fb2e2;font-size:12px}
  #ttai-ov textarea{background:#0b1333;border:1px solid #27316c;border-radius:8px;width:100%;height:120px;color:#cfe1ff;padding:8px}
  #ttai-ov .x{margin-left:auto;cursor:pointer}
  `;
  const st=document.createElement('style'); st.textContent=css; document.head.appendChild(st);

  const box=document.createElement('div'); box.id='ttai-ov';
  box.innerHTML=`
    <div class="row">
      <strong>TrueTrend AI</strong>
      <span class="x" id="tt-exit">×</span>
    </div>
    <div class="row">
      <input id="tt-sym" placeholder="Symbol (auto)" style="flex:1">
      <select id="tt-tf"><option>5m</option><option>15m</option><option>1h</option><option>4h</option><option selected>Daily</option></select>
    </div>
    <div class="row">
      <select id="tt-str" style="flex:1">
        <option selected>Trendline</option><option>EMA Touch</option><option>ORB</option><option>Support/Resistance</option>
        <option>RSI + MACD</option><option>Break of Structure</option><option>Pullback Continuation</option><option>Mean Reversion</option><option>Stoch + Williams %R</option>
      </select>
      <button class="go" id="tt-go">Go</button>
      <button class="v" id="tt-vis">Vision</button>
    </div>
    <div class="mut" id="tt-st">Attached. Watching…</div>
    <textarea id="tt-out">Ready.</textarea>
  `;
  document.body.appendChild(box);

  const q = s => box.querySelector(s);
  const symEl=q('#tt-sym'), tfEl=q('#tt-tf'), strEl=q('#tt-str'), out=q('#tt-out'), st=q('#tt-st');

  async function ownerFetch(body){
    const r = await fetch('${ANALYZE_URL}', {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer ${OWNER_TOKEN}'},
      body: JSON.stringify(body)
    });
    return r.json();
  }
  async function analyzeVision(v){
    try{
      st.textContent='Analyzing…';
      const b={
        ticker:(symEl.value||'').trim(),
        timeframe:tfEl.value,
        strategy:strEl.value
      };
      if(v){
        b.vision=true;
        b.image = await new Promise((res,rej)=>{
          try{ chrome.runtime.sendMessage({fn:'capture'}, resp=> resp?.ok ? res(resp.dataUrl) : rej(new Error(resp?.error||'cap fail'))); }
          catch(e){ rej(e); }
        });
      }
      const j = await ownerFetch(b);
      out.value = JSON.stringify(j,null,2);
      const s=j?.signals?.[0];
      const ex=j?.entryExit||{};
      if(s){
        try{ speechSynthesis.cancel(); new SpeechSynthesisUtterance(); }catch{}
        if (${Boolean(true)} && '${BUILD}'==='owner') {
          try{
            const u = new SpeechSynthesisUtterance(`${s.action}. ${s.reason || ''}. Entry ${ex.entry||'unknown'}. Stop ${ex.stop||'unknown'}. Take profit ${ex.tp1||ex.tp2||'unknown'}.`);
            speechSynthesis.speak(u);
          }catch{}
        }
      }
      st.textContent='Watching…';
    }catch(e){
      out.value = 'TypeError: '+(e?.message||e);
      st.textContent='Error';
    }
  }
  q('#tt-go').addEventListener('click', ()=>analyzeVision(false));
  q('#tt-vis').addEventListener('click', ()=>analyzeVision(true));
  q('#tt-exit').addEventListener('click', ()=>{ box.remove(); window.__TTAI_OVERLAY__=false; });
}

$go.addEventListener('click', ()=>runAnalyze('analyze'));
$vision.addEventListener('click', ()=>runAnalyze('vision'));
$export.addEventListener('click', exportCSV);
$clear.addEventListener('click', async ()=>{
  await chrome.storage.local.set({ ttai_journal: [] });
  log('Journal cleared.');
});
$attach.addEventListener('click', async ()=>{
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab?.id){ log('No active tab'); return; }
  await chrome.scripting.executeScript({ target:{tabId:tab.id}, func: injectedOverlay, args:[{}] });
});
$exit.addEventListener('click', ()=> window.close());

/* capture helper for overlay (message relay) */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
  if(msg?.fn==='capture'){
    chrome.tabs.captureVisibleTab({format:'png'}, dataUrl=>{
      if(chrome.runtime.lastError){ sendResponse({ok:false,error:chrome.runtime.lastError.message}); }
      else { sendResponse({ok:true,dataUrl}); }
    });
    return true;
  }
});

/* restore last selections */
(async ()=>{
  const { _ttai_owner:{} = {} } = await chrome.storage.sync.get({_ttai_owner:{}});
  if (_ttai_owner.symbol) $symbol.value = _ttai_owner.symbol;
  if (_ttai_owner.tf) $tf.value = _ttai_owner.tf;
  if (_ttai_owner.strategy) $strat.value = _ttai_owner.strategy;
})();
['change','keyup'].forEach(ev=>{
  [$symbol,$tf,$strat].forEach(el=> el.addEventListener(ev, ()=>{
    chrome.storage.sync.set({_ttai_owner:{
      symbol:$symbol.value, tf:$tf.value, strategy:$strat.value
    }});
  }));
});
