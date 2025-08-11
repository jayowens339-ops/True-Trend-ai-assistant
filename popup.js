// ---------- settings ----------
const defaults = {
  apiBase: 'https://true-trend-ai-assistant.vercel.app',
  timeframe: 'Daily',
  strategy: 'Trendline',
  voice: true,
  license: '' // owner or customer token
};
const $ = id => document.getElementById(id);

async function loadSettings() {
  const s = await chrome.storage.sync.get(defaults);
  $('apiBase').value = s.apiBase;
  $('tf').value = s.timeframe;
  $('str').value = s.strategy;
  $('voice').checked = s.voice;
  $('license').value = s.license || '';
  const rows = (await chrome.storage.local.get({ ttai_journal: [] })).ttai_journal;
  renderRows(rows);
  $('openApp').href = s.apiBase.replace(/\/$/, '') + '/app.html';
}
$('save').addEventListener('click', async () => {
  await chrome.storage.sync.set({
    apiBase: $('apiBase').value.replace(/\/$/, ''),
    timeframe: $('tf').value,
    strategy: $('str').value,
    voice: $('voice').checked,
    license: $('license').value.trim()
  });
  alert('Saved.');
});

// ---------- attach (inject overlay) ----------
$('attach').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  const opts = await chrome.storage.sync.get(defaults);
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: injectedOverlay,
    args: [opts]
  });
});

// ---------- journal controls ----------
function renderRows(rows) {
  const tb = document.querySelector('#tbl tbody');
  tb.innerHTML = rows.map(r => `<tr>
    <td>${r.time||''}</td><td>${r.ticker||''}</td><td>${r.tf||''}</td>
    <td>${r.strategy||''}</td><td>${r.action||''}</td><td>${r.price||''}</td>
  </tr>`).join('');
}
$('export').addEventListener('click', async () => {
  const rows = (await chrome.storage.local.get({ ttai_journal: [] })).ttai_journal;
  const header = ['Time','Ticker','TF','Strategy','Action','Price'];
  const csv = [header.join(','), ...rows.map(r => [r.time,r.ticker,r.tf,r.strategy,r.action,r.price||''].join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'TrueTrend_Journal.csv'; a.click();
  URL.revokeObjectURL(url);
});
$('clear').addEventListener('click', async () => {
  if (!confirm('Clear the journal?')) return;
  await chrome.storage.local.set({ ttai_journal: [] });
  renderRows([]);
});

loadSettings();

// ============ INJECTED CODE (runs on the page) ============
function injectedOverlay(opts) {
  if (window.__TTAI_OVERLAY__) return; window.__TTAI_OVERLAY__ = true;

  function guessSym() {
    const u = new URL(location.href);
    const sp = u.searchParams.get('symbol') || u.searchParams.get('ticker');
    if (sp) {
      const raw = decodeURIComponent(sp).toUpperCase();
      const m = raw.match(/(?:OTC(?:MKTS)?|PINK|OTCQB|OTCQX|GREY):([A-Z.\-]+)/i);
      if (m) return m[1].toUpperCase();
      return raw.replace(/[:_]/g,'').replace(/-.*/, '');
    }
    const m2 = location.pathname.match(/(?:OTC(?:MKTS)?|PINK|OTCQB|OTCQX|GREY):([A-Z.\-]+)/i);
    if (m2) return m2[1].toUpperCase();
    const m3 = location.pathname.match(/[A-Z]{2,6}(?:USDT|USD|JPY|GBP|EUR|CAD|AUD|CHF|F|Y)?/);
    if (m3) return m3[0].toUpperCase();
    const t1 = document.title.match(/(?:OTC(?:MKTS)?|PINK|OTCQB|OTCQX|GREY):([A-Z.\-]+)/i);
    if (t1) return t1[1].toUpperCase();
    const t2 = document.title.match(/[A-Z]{2,6}(?:USDT|USD|JPY|GBP|EUR|CAD|AUD|CHF|F|Y)?/);
    return t2 ? t2[0].toUpperCase() : '';
  }

  const css = `
    #ttai-ov{all:initial;position:fixed;z-index:2147483647;right:14px;bottom:14px;width:330px;
      font-family:Inter,system-ui,Segoe UI,Roboto,sans-serif;color:#e9eeff;background:#121935;
      border:1px solid #29336b;border-radius:12px;padding:10px;box-shadow:0 8px 28px rgba(0,0,0,.4)}
    #ttai-ov *{all:unset;display:revert}
    #ttai-ov .row{display:flex;gap:6px;align-items:center;margin-bottom:6px}
    #ttai-ov input,#ttai-ov select,#ttai-ov button{background:#0e1538;border:1px solid #29336b;color:#e9eeff;border-radius:8px;height:34px;padding:0 8px}
    #ttai-ov button{background:#22c55e;color:#04220f;font-weight:700;cursor:pointer}
    #ttai-ov .t{font-size:12px;color:#93a7d9;margin-top:4px}
    #ttai-ov .sig{font-weight:900;margin-top:6px}
    #ttai-ov .buy{color:#22c55e} #ttai-ov .sell{color:#ff7373}
    #ttai-ov .mut{color:#a9b7e2;font-size:11px}
    #ttai-ov .link{color:#cfe1ff;text-decoration:underline;cursor:pointer}
  `;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  const box = document.createElement('div'); box.id = 'ttai-ov';
  box.innerHTML = `
    <div class="row">
      <input id="tt-sym" placeholder="Symbol (AAPL, EURUSD, BTCUSDT, HMBL)" style="flex:1">
      <select id="tt-tf"><option>5m</option><option>15m</option><option>1h</option><option>4h</option><option>Daily</option></select>
      <button id="tt-go">Go</button>
    </div>
    <div class="row">
      <select id="tt-str">
        <option>Trendline</option><option>EMA Touch</option><option>ORB</option><option>Support/Resistance</option>
        <option>Stoch + Williams %R</option><option>RSI + MACD</option>
        <option>Break of Structure</option><option>Pullback Continuation</option><option>Mean Reversion</option>
      </select>
      <label class="mut"><input type="checkbox" id="tt-voice" ${opts.voice?'checked':''}> Voice</label>
      <span class="link" id="tt-hide">×</span>
    </div>
    <div class="t" id="tt-st">Attached. Watching…</div>
    <div id="tt-out" class="t"></div>
    <div id="tt-sig" class="sig"></div>
    <div class="t"><span class="link" id="tt-log">Log last</span></div>
  `;
  document.body.appendChild(box);

  const q = s => box.querySelector(s);
  const symEl = q('#tt-sym'), tfEl = q('#tt-tf'), strEl = q('#tt-str');
  const stEl = q('#tt-st'), outEl = q('#tt-out'), sigEl = q('#tt-sig');
  const voiceEl = q('#tt-voice');

  tfEl.value = opts.timeframe || 'Daily';
  strEl.value = opts.strategy || 'Trendline';

  function speak(text){try{if(!voiceEl.checked)return;speechSynthesis.cancel();speechSynthesis.speak(new SpeechSynthesisUtterance(text));}catch{}}

  async function logEntry(entry){
    try{
      const key='ttai_journal'; const data=await chrome.storage.local.get({[key]:[]});
      const rows=data[key]; rows.unshift(entry); await chrome.storage.local.set({[key]:rows.slice(0,2000)});
    }catch(e){}
  }

  async function run(){
    const API=(opts.apiBase||'https://true-trend-ai-assistant.vercel.app').replace(/\/$/,'')+'/api/analyze';
    stEl.textContent='Analyzing…';
    try{
      const res=await fetch(API,{
        method:'POST',
        headers:{
          'Content-Type':'application/json',
          'Authorization':'Bearer '+(opts.license||'')
        },
        body:JSON.stringify({ticker:symEl.value.trim()||'EURUSD',timeframe:tfEl.value,strategy:strEl.value})
      });
      const j=await res.json();
      if(!res.ok && (res.status===401||res.status===402)){
        outEl.textContent='License required. Purchase and paste your key in the popup.';
        stEl.textContent='Locked.'; return;
      }
      const s=(j.signals||[])[0]||null;
      outEl.textContent=(j.summary||'')+'  ['+(j.mode||'')+']';
      sigEl.textContent=s?`${s.action} — ${s.reason} (${Math.round((s.confidence||0)*100)}%)`:'';
      sigEl.className='sig '+(s?(s.action==='BUY'?'buy':'sell'):'');
      if(s){
        speak(`${s.action}. ${s.reason}`);
        await logEntry({time:new Date().toLocaleString(),ticker:symEl.value.toUpperCase(),tf:tfEl.value,strategy:strEl.value,action:s.action,price:j.price||'',notes:''});
        chrome.storage.sync.set({ timeframe: tfEl.value, strategy: strEl.value, voice: voiceEl.checked });
      }
    }catch(e){ outEl.textContent='Error. Try again.' }
    stEl.textContent='Watching…';
  }

  q('#tt-go').addEventListener('click', run);
  symEl.addEventListener('keydown', e=>{ if(e.key==='Enter') run(); });
  q('#tt-hide').addEventListener('click', ()=>{ box.remove(); window.__TTAI_OVERLAY__=false; });
  q('#tt-log').addEventListener('click', ()=>{ const action=(sigEl.textContent.split(' ')[0]||'').toUpperCase();
    logEntry({time:new Date().toLocaleString(),ticker:symEl.value.toUpperCase(),tf:tfEl.value,strategy:strEl.value,action,price:'',notes:''});
    stEl.textContent='Logged.'; setTimeout(()=>stEl.textContent='Watching…',800); });

  symEl.value = guessSym() || 'EURUSD';
  run();

  let href = location.href, tit = document.title;
  setInterval(()=>{ if(location.href!==href || document.title!==tit){ href=location.href; tit=document.title;
    const g=guessSym(); if(g && g!==symEl.value){ symEl.value=g; run(); } }}, 1500);
}
