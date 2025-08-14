(()=> {
  const $ = s => document.querySelector(s);
  const out=$("#out");
  const symbol=$("#symbol"), timeframe=$("#timeframe"), htf=$("#htf"), strategy=$("#strategy"), voice=$("#voice");
  const orbMode=$("#orbMode"), orbValue=$("#orbValue"), sessionOpen=$("#sessionOpen"), bosRetest=$("#bosRetest");
  const tdKey=$("#tdKey"), fhKey=$("#fhKey"), oaiUrl=$("#oaiUrl"), oaiKey=$("#oaiKey"), oaiProject=$("#oaiProject");
  const tickOverride=$("#tickOverride"), perSymbol=$("#perSymbol");
  const attachBtn=$("#attach"), detachBtn=$("#detach"), analyzeBtn=$("#analyze"), visionBtn=$("#vision"), detectBtn=$("#detect"), testVoice=$("#testVoice"), exitBtn=$("#exit"), visionTest=$("#visionTest");

  const show = (o)=> out.textContent = JSON.stringify(o,null,2);
  const speak = (t)=> { try{ if(!voice.checked) return; const u=new SpeechSynthesisUtterance(t); speechSynthesis.cancel(); speechSynthesis.speak(u);}catch{} };

  chrome.storage.local.get(["cfg","td","fh","oai"], r=>{
    const c=r.cfg||{};
    symbol.value=c.symbol||"AAPL"; timeframe.value=c.timeframe||"5min"; htf.value=c.htf||"15min"; strategy.value=c.strategy||"router"; voice.checked=c.voice??true;
    orbMode.value=c.orbMode||"minutes"; orbValue.value=c.orbValue||30; sessionOpen.value=c.sessionOpen||"08:30"; bosRetest.value=c.bosRetest||20;
    tdKey.value=r.td||""; fhKey.value=r.fh||"";
    const o=r.oai||{}; oaiUrl.value=o.url||"https://api.openai.com/v1/chat/completions"; oaiKey.value=o.key||""; oaiProject.value=o.project||"";
    tickOverride.value=c.tickOverride||""; perSymbol.checked=c.perSymbol??true;
  });
  [symbol,timeframe,htf,strategy,voice,orbMode,orbValue,sessionOpen,bosRetest,tickOverride,perSymbol].forEach(el=>el.addEventListener("change",()=>{
    chrome.storage.local.set({ cfg:{
      symbol:symbol.value,timeframe:timeframe.value,htf:htf.value,strategy:strategy.value,voice:voice.checked,
      orbMode:orbMode.value,orbValue:Number(orbValue.value||30),sessionOpen:sessionOpen.value,bosRetest:Number(bosRetest.value||20),
      tickOverride:tickOverride.value, perSymbol: perSymbol.checked
    }});
  }));
  [tdKey,fhKey,oaiUrl,oaiKey,oaiProject].forEach(el=>el.addEventListener("change",()=>{
    chrome.storage.local.set({ td:tdKey.value.trim(), fh:fhKey.value.trim(), oai:{ url:oaiUrl.value.trim(), key:oaiKey.value.trim(), project:oaiProject.value.trim() } });
  }));

  detectBtn.addEventListener("click", ()=>{
    chrome.tabs.query({active:true,currentWindow:true}, tabs=>{
      const tab=tabs[0]; if(!tab) return;
      try{
        const url=new URL(tab.url||"http://x/");
        const tv=url.pathname.match(/symbol\/([A-Z0-9:._-]+)/i) || url.search.match(/symbol=([A-Z0-9:._-]+)/i);
        if (tv){ symbol.value = tv[1].split(":").pop().split(".")[0].toUpperCase(); return; }
        const tkn=(tab.title||"").match(/\b[A-Z]{1,5}\b/); if (tkn) symbol.value=tkn[0];
      }catch{}
    });
  });

  // -------- Data helpers
  const fetchJSON = async (u)=>{ const r=await fetch(u); const t=await r.text(); try{ return JSON.parse(t);}catch{return{_raw:t}} };
  const getTD = async (sym, tf, key)=>{ const map={"1min":"1min","5min":"5min","15min":"15min","60min":"60min","daily":"1day"}; const u=`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${map[tf]||"1day"}&outputsize=300&apikey=${encodeURIComponent(key)}`; const j=await fetchJSON(u); if(j?.values?.length) return j.values.map(v=>({o:+v.open,h:+v.high,l:+v.low,c:+v.close,t:v.datetime})).reverse(); throw new Error("twelvedata_failed");};
  const getFH = async (sym, tf, key)=>{ const now=Math.floor(Date.now()/1000), frm=now-60*60*24*21; const res={"1min":"1","5min":"5","15min":"15","60min":"60","daily":"D"}[tf]||"D"; const u=`https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(sym)}&resolution=${res}&from=${frm}&to=${now}&token=${encodeURIComponent(key)}`; const jc=await fetchJSON(u); if(jc?.s==="ok" && Array.isArray(jc.c) && jc.c.length>1) return jc.c.map((c,i)=>({t:jc.t[i],o:jc.o?.[i]??c,h:jc.h?.[i]??c,l:jc.l?.[i]??c,c})); const q=`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(key)}`; const jq=await fetchJSON(q); if(jq?.c) return [{t:now,o:jq.o??jq.c,h:jq.h??jq.c,l:jq.l??jq.c,c:jq.c}]; throw new Error("finnhub_failed");};
  const seriesFor = async (sym, tf, keys)=>{ try{ return { data: await getTD(sym, tf, keys.td), src:"twelvedata" }; }catch{ return { data: await getFH(sym, tf, keys.fh), src:"finnhub" }; } };

  // -------- Indicators & strategies
  const ema=(vals,p)=>{ const k=2/(p+1); let prev=vals[0]??0,out=[prev]; for(let i=1;i<vals.length;i++){ const v=vals[i]; prev=v*k+prev*(1-k); out.push(prev);} return out; };
  const atr=(series,n=14)=>{ const trs=[]; for(let i=1;i<series.length;i++){ const a=series[i],b=series[i-1]; trs.push(Math.max(a.h-a.l, Math.abs(a.h-b.c), Math.abs(a.l-b.c))); } const m=Math.min(n,trs.length)||1; let s=0; for(let i=trs.length-m;i<trs.length;i++) s+=trs[i]; return s/m; };
  const slope=(series,n=10)=>{ if(series.length<n+1) return 0; let s=0; for(let i=series.length-n;i<series.length;i++) s+=series[i].c-series[i-1].c; return s/n; };
  const hh=(series,lb=20)=>{ let m=-Infinity; for(let i=Math.max(0,series.length-lb); i<series.length; i++) m=Math.max(m,series[i].h); return m; };
  const ll=(series,lb=20)=>{ let m= Infinity; for(let i=Math.max(0,series.length-lb); i<series.length; i++) m=Math.min(m,series[i].l); return m; };

  const stratEMA = (series)=>{ const closes=series.map(b=>b.c); const e9=ema(closes,9), e21=ema(closes,21); const last=series.at(-1); const A=atr(series,14)||0.5; return { name:"ema", direction:e9.at(-1)>=e21.at(-1)?"BUY":"SELL", entry:last.c, atr:A }; };
  const stratST  = (series)=>{ const A=atr(series,10)||0.5; const last=series.at(-1); const mid=(last.h+last.l)/2; const up=mid+3*A, dn=mid-3*A; const dir= last.c>=up?"BUY": last.c<=dn?"SELL": (slope(series,10)>=0?"BUY":"SELL"); return { name:"supertrend", direction:dir, entry:last.c, atr:A }; };
  const stratORB = (series)=>{ const n=6; const op=series.slice(0,Math.min(n,series.length)); const H=Math.max(...op.map(b=>b.h)); const L=Math.min(...op.map(b=>b.l)); const last=series.at(-1); const dir= last.c>H?"BUY": last.c<L?"SELL": (slope(series,5)>=0?"BUY":"SELL"); const A=atr(series,14)||0.5; return { name:"orb", direction:dir, entry:last.c, atr:A }; };
  const stratBOS = (series)=>{ const last=series.at(-1), prev=series.at(-2)||last; const swingH=hh(series,20), swingL=ll(series,20); let dir="BUY"; if(last.c<swingL && prev.c>=swingL) dir="SELL"; if(last.c>swingH && prev.c<=swingH) dir="BUY"; const A=atr(series,14)||0.5; return { name:"bos", direction:dir, entry:last.c, atr:A }; };

  const router = (series)=>{ const s=[stratEMA(series),stratST(series),stratORB(series),stratBOS(series)]; const buy=s.filter(x=>x.direction==="BUY").length, sell=s.length-buy; const entry=series.at(-1).c; const A=s.reduce((m,x)=>m+x.atr,0)/s.length; const dir= buy>sell?"BUY": sell>buy?"SELL": (slope(series,10)>=0?"BUY":"SELL"); return { name:"router", direction:dir, entry, atr:A, votes:{buy,sell} }; };
  const biasFilter = (series, base, htfSig)=>{ const closes=series.map(b=>b.c); const e200=ema(closes,200).at(-1)||base.entry; const e50s=slope(series,20); const htfDir=htfSig?.direction; if (series.at(-1).c<e200 && e50s<0 && (!htfDir || htfDir==="SELL")) return { ...base, direction:"SELL" }; if (series.at(-1).c>e200 && e50s>0 && (!htfDir || htfDir==="BUY")) return { ...base, direction:"BUY" }; return base; };
  const planFrom = (entry, dir, A)=>{ const mult=1.5; const stop=dir==="BUY"? entry- mult*A : entry+ mult*A; const tp1=dir==="BUY"? entry+1.8*A : entry-1.8*A; const tp2=dir==="BUY"? entry+3.0*A : entry-3.0*A; const trail=dir==="BUY"? entry+0.8*A : entry-0.8*A; return { stopLoss:stop, takeProfit:tp1, takeProfit2:tp2, trailingStop:trail }; };

  function sendLevels(tabId, payload){ chrome.tabs.sendMessage(tabId, { type:"TT_LEVELS", payload }); }

  // Breakeven after TP1 watcher (simple polling)
  let beTimer=null;
  async function startBreakeven(sym, dir, entry, tp1){
    if (beTimer) clearInterval(beTimer);
    const key = (await new Promise(r=>chrome.storage.local.get(["fh"], r))).fh || fhKey.value.trim();
    if (!key) return;
    beTimer = setInterval(async ()=>{
      try{
        const q = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(key)}`).then(r=>r.json());
        const px = Number(q.c||0); if(!px) return;
        if ((dir==="BUY" && px>=tp1) || (dir==="SELL" && px<=tp1)){
          chrome.tabs.query({active:true,currentWindow:true}, tabs=>{
            if(!tabs[0]) return;
            const tp2 = dir==="BUY" ? entry + (tp1-entry)*(3.0/1.8) : entry - (entry-tp1)*(3.0/1.8);
            sendLevels(tabs[0].id, { direction:dir, entry, stopLoss:entry, takeProfit:tp1, takeProfit2:tp2, trailingStop:entry });
          });
          clearInterval(beTimer); beTimer=null;
        }
      }catch{}
    }, 15000);
  }

  attachBtn.addEventListener("click", ()=> {
    chrome.tabs.query({active:true,currentWindow:true}, tabs=>{
      if(!tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, { type:"TT_ATTACH", symbol: symbol.value, perSymbol: perSymbol.checked }, resp=>show({ ok:true, action:"attached", resp }));
    });
  });
  detachBtn.addEventListener("click", ()=> {
    chrome.tabs.query({active:true,currentWindow:true}, tabs=>{
      if(!tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, { type:"TT_DETACH" }, resp=>show({ ok:true, action:"detached", resp }));
    });
  });

  analyzeBtn.addEventListener("click", async ()=>{
    try{
      const keys = await new Promise(r=>chrome.storage.local.get(["td","fh"], r));
      const prim = await seriesFor(symbol.value, timeframe.value, { td: keys.td || tdKey.value, fh: keys.fh || fhKey.value });
      const ser = prim.data;
      const base = strategy.value==="ema" ? stratEMA(ser)
                 : strategy.value==="supertrend" ? stratST(ser)
                 : strategy.value==="orb" ? stratORB(ser)
                 : strategy.value==="bos" ? stratBOS(ser)
                 : router(ser);
      let htfSig=null;
      if (htf.value){
        try{ const htfSer=(await seriesFor(symbol.value, htf.value, { td: keys.td || tdKey.value, fh: keys.fh || fhKey.value })).data; htfSig=stratEMA(htfSer); }catch{}
      }
      const biased = biasFilter(ser, base, htfSig);
      const A = base.atr || 0.5;
      const plan = planFrom(biased.entry, biased.direction, A);
      chrome.tabs.query({active:true,currentWindow:true}, tabs=>{
        if(!tabs[0]) return;
        chrome.tabs.sendMessage(tabs[0].id, { type:"TT_ATTACH", symbol: symbol.value, perSymbol: perSymbol.checked }, ()=>{
          sendLevels(tabs[0].id, { direction:biased.direction, entry:biased.entry, ...plan });
        });
      });
      startBreakeven(symbol.value, biased.direction, biased.entry, plan.takeProfit);
      if (voice.checked) speak(`${biased.direction}. Enter ${biased.entry}. Stop ${plan.stopLoss}. TP1 ${plan.takeProfit}. TP2 ${plan.takeProfit2}. Trail ${plan.trailingStop}. Breakeven after TP1.`);
      show({ ok:true, src:prim.src, strategy:base.name, votes: base.votes||null, htf: htfSig?.direction, entry:biased.entry, stop:plan.stopLoss, tp1:plan.takeProfit, tp2:plan.takeProfit2, trail:plan.trailingStop });
    }catch(e){ show({ ok:false, error:e.message||String(e) }); }
  });

  // Vision (OpenAI)
  visionTest.addEventListener("click", async ()=>{
    try{
      const headers = { "Content-Type":"application/json", "Authorization":"Bearer "+oaiKey.value.trim() };
      if (oaiProject.value.trim()) headers["OpenAI-Project"] = oaiProject.value.trim();
      const res = await fetch(oaiUrl.value.trim(), { method:"POST", headers, body: JSON.stringify({ model:"gpt-4o-mini", messages:[{role:"user",content:"ping"}], max_tokens:1 }) });
      show({ ok: res.status<400, status: res.status });
    }catch(err){ show({ ok:false, error:String(err) }); }
  });

  visionBtn.addEventListener("click", async ()=>{
    try{
      chrome.tabs.captureVisibleTab(null,{format:"jpeg",quality:80}, async (dataUrl)=>{
        if (chrome.runtime.lastError || !dataUrl) return show({ ok:false, stage:"capture", error: chrome.runtime.lastError?.message || "capture_failed" });
        const headers = { "Content-Type":"application/json", "Authorization":"Bearer "+oaiKey.value.trim() };
        if (oaiProject.value.trim()) headers["OpenAI-Project"] = oaiProject.value.trim();
        const body = JSON.stringify({
          model:"gpt-4o-mini", response_format:{type:"json_object"},
          messages:[{ role:"user", content:[
            {type:"text", text:"Analyze this trading chart image. Return strict JSON: {direction:'BUY'|'SELL', entry:number, stopLoss:number, takeProfit:number}."},
            {type:"image_url", image_url:{ url:dataUrl }}
          ]}]
        });
        const res = await fetch(oaiUrl.value.trim(), { method:"POST", headers, body });
        const raw = await res.text();
        let j; try{ j=JSON.parse(raw);}catch{ return show({ ok:false, stage:"parse", error:"bad_json", raw: raw.slice(0,400) }); }
        let p;
        if (j.choices && j.choices[0]?.message?.content){ try{ p=JSON.parse(j.choices[0].message.content); }catch{ return show({ ok:false, stage:"content_parse", sample:j.choices[0].message.content.slice(0,200) }); } }
        else if (j.direction) p=j; else return show({ ok:false, stage:"invalid_response", raw:j });
        const A = Math.abs(p.entry - p.stopLoss)/1.5 || 0.5;
        const tp2 = p.direction==="BUY" ? p.entry + 3.0*A : p.entry - 3.0*A;
        const trail = p.direction==="BUY" ? p.entry + 0.8*A : p.entry - 0.8*A;
        chrome.tabs.query({active:true,currentWindow:true}, tabs=>{
          if(!tabs[0]) return;
          chrome.tabs.sendMessage(tabs[0].id, { type:"TT_ATTACH", symbol: symbol.value, perSymbol: perSymbol.checked }, ()=>{
            sendLevels(tabs[0].id, { direction:p.direction, entry:p.entry, stopLoss:p.stopLoss, takeProfit:p.takeProfit, takeProfit2:tp2, trailingStop:trail });
          });
        });
        startBreakeven(symbol.value, p.direction, p.entry, p.takeProfit);
        if (voice.checked) speak(`${p.direction}. Enter ${p.entry}. Stop ${p.stopLoss}. TP1 ${p.takeProfit}. TP2 ${tp2}. Trail ${trail}. Breakeven after TP1.`);
        show({ ok:true, stage:"done", source:"vision", payload:p });
      });
    }catch(e){ show({ ok:false, stage:"vision", error:e.message||String(e) }); }
  });

  testVoice.addEventListener("click", ()=> speak("TrueTrend voice check."));
  exitBtn.addEventListener("click", ()=> window.close());
})();
