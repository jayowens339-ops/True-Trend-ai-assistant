(()=> {
  const $=s=>document.querySelector(s), out=$("#out");
  const symbol=$("#symbol"), timeframe=$("#timeframe"), htf=$("#htf"), strategy=$("#strategy"), voice=$("#voice");
  const polyKey=$("#polyKey"), tdKey=$("#tdKey"), fhKey=$("#fhKey");
  const visionProv=$("#visionProv"), gvKey=$("#gvKey"), oaiUrl=$("#oaiUrl"), oaiKey=$("#oaiKey"), oaiProject=$("#oaiProject");
  const attachBtn=$("#attach"), detachBtn=$("#detach"), analyzeBtn=$("#analyze"), visionBtn=$("#vision"), detectBtn=$("#detect"), exitBtn=$("#exit"), visionTest=$("#visionTest");

  // === baked keys (per your request) ===
  const DEFAULTS = {
    poly: "jd8IhUkgfcFUNpIQgAyy4VB9CVgjZVUp",
    td:   "",
    fh:   "",
    gv:   "22a7e678c612aa47f8d8fa9f0e26f3efc14d8ad3",
    oai:  { url:"https://api.openai.com/v1/chat/completions", key:"", project:"" }
  };

  const show = o => out.textContent = JSON.stringify(o,null,2);
  const speak = t => { try{ if(!voice.checked) return; const u=new SpeechSynthesisUtterance(t); speechSynthesis.cancel(); speechSynthesis.speak(u);}catch{} };

  // load + seed defaults once
  chrome.storage.local.get(["cfg","keys"], r=>{
    const cfg=r.cfg||{};
    const keys=r.keys||DEFAULTS;
    symbol.value=cfg.symbol||"AAPL";
    timeframe.value=cfg.timeframe||"5min";
    htf.value=cfg.htf||"15min";
    strategy.value=cfg.strategy||"router";
    voice.checked=cfg.voice??true;

    polyKey.value=keys.poly||DEFAULTS.poly;
    tdKey.value=keys.td||DEFAULTS.td;
    fhKey.value=keys.fh||DEFAULTS.fh;
    visionProv.value=cfg.visionProv||"google";
    gvKey.value=keys.gv||DEFAULTS.gv;
    oaiUrl.value=(keys.oai?.url)||DEFAULTS.oai.url;
    oaiKey.value=(keys.oai?.key)||"";
    oaiProject.value=(keys.oai?.project)||"";

    chrome.storage.local.set({ keys:{ poly:polyKey.value, td:tdKey.value, fh:fhKey.value, gv:gvKey.value, oai:{url:oaiUrl.value,key:oaiKey.value,project:oaiProject.value} } });
  });

  [symbol,timeframe,htf,strategy,voice,visionProv].forEach(el=>el.addEventListener("change",()=>{
    chrome.storage.local.set({ cfg:{ symbol:symbol.value,timeframe:timeframe.value,htf:htf.value,strategy:strategy.value,voice:voice.checked,visionProv:visionProv.value } });
  }));
  [polyKey,tdKey,fhKey,gvKey,oaiUrl,oaiKey,oaiProject].forEach(el=>el.addEventListener("change",()=>{
    chrome.storage.local.set({ keys:{ poly:polyKey.value.trim(), td:tdKey.value.trim(), fh:fhKey.value.trim(), gv:gvKey.value.trim(), oai:{url:oaiUrl.value.trim(),key:oaiKey.value.trim(),project:oaiProject.value.trim()} } });
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

  // ======= Data helpers
  const fetchJSON = async u => { const r=await fetch(u); const t=await r.text(); try{ return JSON.parse(t);}catch{return{_raw:t}} };

  async function getPolygon(sym, tf, key){
    const span = tf==="daily" ? "1/day" : tf==="60min" ? "60/minute" : tf==="15min" ? "15/minute" : tf==="5min" ? "5/minute" : "1/minute";
    const now=new Date(); const from = new Date(now.getTime()-1000*60*60*24*10);
    const f=from.toISOString().split("T")[0], to=now.toISOString().split("T")[0];
    const u=`https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/range/${span}/${f}/${to}?adjusted=true&sort=asc&limit=300&apiKey=${encodeURIComponent(key)}`;
    const j=await fetchJSON(u);
    if(j?.results?.length) return j.results.map(r=>({t:r.t/1000,o:r.o,h:r.h,l:r.l,c:r.c}));
    throw new Error("polygon_failed");
  }
  async function getTD(sym, tf, key){
    const map={"1min":"1min","5min":"5min","15min":"15min","60min":"60min","daily":"1day"};
    const u=`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${map[tf]||"1day"}&outputsize=300&apikey=${encodeURIComponent(key)}`;
    const j=await fetchJSON(u);
    if(j?.values?.length) return j.values.map(v=>({o:+v.open,h:+v.high,l:+v.low,c:+v.close,t:Date.parse(v.datetime)/1000})).reverse();
    throw new Error("twelvedata_failed");
  }
  async function getFH(sym, tf, key){
    const now=Math.floor(Date.now()/1000), frm=now-60*60*24*7;
    const res={"1min":"1","5min":"5","15min":"15","60min":"60","daily":"D"}[tf]||"D";
    const u=`https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(sym)}&resolution=${res}&from=${frm}&to=${now}&token=${encodeURIComponent(key)}`;
    const jc=await fetchJSON(u);
    if(jc?.s==="ok" && Array.isArray(jc.c) && jc.c.length>1) return jc.c.map((c,i)=>({t:jc.t[i],o:jc.o?.[i]??c,h:jc.h?.[i]??c,l:jc.l?.[i]??c,c}));
    const q=`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(key)}`;
    const jq=await fetchJSON(q); if(jq?.c) return [{t:now,o:jq.o??jq.c,h:jq.h??jq.c,l:jq.l??jq.c,c:jq.c}];
    throw new Error("finnhub_failed");
  }
  async function seriesFor(sym, tf, keys){
    try { return { data: await getPolygon(sym, tf, keys.poly), src:"polygon" }; }
    catch { try { return { data: await getTD(sym, tf, keys.td), src:"twelvedata" }; }
           catch { return { data: await getFH(sym, tf, keys.fh), src:"finnhub" }; } }
  }

  // ======= Indicators / Strategies / Plan
  const ema=(vals,p)=>{const k=2/(p+1);let prev=vals[0]??0,out=[prev];for(let i=1;i<vals.length;i++){const v=vals[i];prev=v*k+prev*(1-k);out.push(prev)}return out};
  const atr=(series,n=14)=>{const trs=[];for(let i=1;i<series.length;i++){const a=series[i],b=series[i-1];trs.push(Math.max(a.h-a.l,Math.abs(a.h-b.c),Math.abs(a.l-b.c)))}const m=Math.min(n,trs.length)||1;let s=0;for(let i=trs.length-m;i<trs.length;i++)s+=trs[i];return s/m};
  const slope=(series,n=10)=>{if(series.length<n+1)return 0;let s=0;for(let i=series.length-n;i<series.length;i++)s+=series[i].c-series[i-1].c;return s/n};
  const hh=(s,lb=20)=>{let m=-Infinity;for(let i=Math.max(0,s.length-lb);i<s.length;i++)m=Math.max(m,s[i].h);return m};
  const ll=(s,lb=20)=>{let m= Infinity;for(let i=Math.max(0,s.length-lb);i<s.length;i++)m=Math.min(m,s[i].l);return m};

  const stratEMA = s => { const c=s.map(b=>b.c); const e9=ema(c,9), e21=ema(c,21); const last=s.at(-1); const A=atr(s,14)||0.5; return {name:"ema", direction:e9.at(-1)>=e21.at(-1)?"BUY":"SELL", entry:last.c, atr:A}; };
  const stratST  = s => { const A=atr(s,10)||0.5; const last=s.at(-1); const mid=(last.h+last.l)/2; const up=mid+3*A, dn=mid-3*A; const dir= last.c>=up?"BUY": last.c<=dn?"SELL": (slope(s,10)>=0?"BUY":"SELL"); return {name:"supertrend",direction:dir,entry:last.c,atr:A}; };
  const stratORB = s => { const n=6; const op=s.slice(0,Math.min(n,s.length)); const H=Math.max(...op.map(b=>b.h)); const L=Math.min(...op.map(b=>b.l)); const last=s.at(-1); const dir= last.c>H?"BUY": last.c<L?"SELL": (slope(s,5)>=0?"BUY":"SELL"); const A=atr(s,14)||0.5; return {name:"orb",direction:dir,entry:last.c,atr:A}; };
  const stratBOS = s => { const last=s.at(-1), prev=s.at(-2)||last; const swingH=hh(s,20), swingL=ll(s,20); let dir="BUY"; if(last.c<swingL && prev.c>=swingL) dir="SELL"; if(last.c>swingH && prev.c<=swingH) dir="BUY"; const A=atr(s,14)||0.5; return {name:"bos",direction:dir,entry:last.c,atr:A}; };

  const router = s => {
    const list=[stratEMA(s),stratST(s),stratORB(s),stratBOS(s)];
    const w={ema:0.35,supertrend:0.25,orb:0.20,bos:0.20};
    const score=list.reduce((acc,x)=>acc+({BUY:1,SELL:-1}[x.direction])*w[x.name],0);
    const entry=s.at(-1).c;
    const A=list.reduce((m,x)=>m+x.atr,0)/list.length;
    return {name:"router", direction:score>0?"BUY":score<0?"SELL":"FLAT", entry, atr:A, score, votes:{buy:list.filter(x=>x.direction==='BUY').length, sell:list.filter(x=>x.direction==='SELL').length}};
  };

  const biasFilter = (series, base, htfSig) => {
    const closes=series.map(b=>b.c);
    const e200=ema(closes,200).at(-1)||base.entry;
    const e50s=slope(series,20);
    const htfDir=htfSig?.direction;
    if(series.at(-1).c<e200 && e50s<0 && (!htfDir || htfDir==="SELL"))
      return {...base, direction: base.direction==="BUY"?"SELL":base.direction};
    if(series.at(-1).c>e200 && e50s>0 && (!htfDir || htfDir==="BUY"))
      return {...base, direction: base.direction==="SELL"?"BUY":base.direction};
    return base;
  };

  const planFrom = (entry, dir, A) => {
    const mult=1.5;
    const stop = dir==="BUY"? entry-mult*A : entry+mult*A;
    const tp1  = dir==="BUY"? entry+1.8*A : entry-1.8*A;
    const tp2  = dir==="BUY"? entry+3.0*A : entry-3.0*A;
    const trail= dir==="BUY"? entry+0.8*A : entry-0.8*A;
    return { stopLoss:stop, takeProfit:tp1, takeProfit2:tp2, trailingStop:trail };
  };

  function sendLevels(tabId, payload){ chrome.tabs.sendMessage(tabId, { type:"TT_LEVELS", payload }); }

  // Breakeven watcher (TP1 hit -> stop=entry)
  let beTimer=null;
  async function startBreakeven(sym, dir, entry, tp1){
    if (beTimer) clearInterval(beTimer);
    const key=(await new Promise(r=>chrome.storage.local.get(["keys"],r))).keys?.fh || fhKey.value.trim();
    if(!key) return;
    beTimer=setInterval(async ()=>{
      try{
        const q=await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(key)}`).then(r=>r.json());
        const px=Number(q.c||0); if(!px) return;
        if((dir==="BUY" && px>=tp1) || (dir==="SELL" && px<=tp1)){
          chrome.tabs.query({active:true,currentWindow:true}, tabs=>{
            if(!tabs[0]) return;
            const tp2 = dir==="BUY" ? entry + (tp1-entry)*(3.0/1.8) : entry - (entry-tp1)*(3.0/1.8);
            sendLevels(tabs[0].id,{direction:dir,entry,stopLoss:entry,takeProfit:tp1,takeProfit2:tp2,trailingStop:entry});
          });
          clearInterval(beTimer); beTimer=null;
        }
      }catch{}
    }, 15000);
  }

  attachBtn.addEventListener("click", ()=>{
    chrome.tabs.query({active:true,currentWindow:true}, tabs=>{
      if(!tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id,{type:"TT_ATTACH",symbol:symbol.value,perSymbol:true},resp=>show({ok:true,action:"attached",resp}));
    });
  });
  detachBtn.addEventListener("click", ()=>{
    chrome.tabs.query({active:true,currentWindow:true}, tabs=>{
      if(!tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id,{type:"TT_DETACH"},resp=>show({ok:true,action:"detached",resp}));
    });
  });

  analyzeBtn.addEventListener("click", async ()=>{
    try{
      const keys=(await new Promise(r=>chrome.storage.local.get(["keys"],r))).keys||{poly:polyKey.value,td:tdKey.value,fh:fhKey.value};
      const prim=await seriesFor(symbol.value,timeframe.value,keys);
      const ser=prim.data;
      const base = strategy.value==="ema" ? stratEMA(ser)
                 : strategy.value==="supertrend" ? stratST(ser)
                 : strategy.value==="orb" ? stratORB(ser)
                 : strategy.value==="bos" ? stratBOS(ser)
                 : router(ser);
      let htfSig=null;
      if(htf.value){ try{ const hs=(await seriesFor(symbol.value,htf.value,keys)).data; htfSig=stratEMA(hs); }catch{} }
      const biased=biasFilter(ser,base,htfSig);
      const A=base.atr||0.5;
      const plan=planFrom(biased.entry,biased.direction,A);

      chrome.tabs.query({active:true,currentWindow:true}, tabs=>{
        if(!tabs[0]) return;
        chrome.tabs.sendMessage(tabs[0].id,{type:"TT_ATTACH",symbol:symbol.value,perSymbol:true},()=>{
          sendLevels(tabs[0].id,{direction:biased.direction,entry:biased.entry,...plan});
        });
      });

      startBreakeven(symbol.value,biased.direction,biased.entry,plan.takeProfit);
      if(voice.checked) speak(`${biased.direction}. Enter ${biased.entry}. Stop ${plan.stopLoss}. TP1 ${plan.takeProfit}. TP2 ${plan.takeProfit2}. Trail ${plan.trailingStop}.`);
      show({ok:true,src:prim.src,strategy:base.name,score:base.score||null,votes:base.votes||null,htf:htfSig?.direction,entry:biased.entry,stop:plan.stopLoss,tp1:plan.takeProfit,tp2:plan.takeProfit2,trail:plan.trailingStop});
    }catch(e){ show({ok:false,error:e.message||String(e)}); }
  });

  // Vision tests
  visionTest.addEventListener("click", async ()=>{
    try{
      if(visionProv.value==="google"){
        const key=(await new Promise(r=>chrome.storage.local.get(["keys"],r))).keys?.gv || gvKey.value.trim();
        const res=await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(key)}`,{
          method:"POST",headers:{"Content-Type":"application/json"},
          body: JSON.stringify({requests:[{image:{content:""},features:[{type:"TEXT_DETECTION"}]}]})
        });
        show({ok:res.status<400,provider:"google",status:res.status});
      }else{
        const keys=(await new Promise(r=>chrome.storage.local.get(["keys"],r))).keys||{};
        const headers={"Content-Type":"application/json","Authorization":"Bearer "+(keys.oai?.key||oaiKey.value.trim())};
        if(keys.oai?.project||oaiProject.value.trim()) headers["OpenAI-Project"]=(keys.oai?.project||oaiProject.value.trim());
        const res=await fetch((keys.oai?.url||oaiUrl.value.trim()),{method:"POST",headers,body:JSON.stringify({model:"gpt-4o-mini",messages:[{role:"user",content:"ping"}],max_tokens:1})});
        show({ok:res.status<400,provider:"openai",status:res.status});
      }
    }catch(err){ show({ok:false,error:String(err)}); }
  });

  // Vision run
  visionBtn.addEventListener("click", async ()=>{
    try{
      chrome.tabs.captureVisibleTab(null,{format:"jpeg",quality:80}, async (dataUrl)=>{
        if(chrome.runtime.lastError||!dataUrl) return show({ok:false,stage:"capture",error:chrome.runtime.lastError?.message||"capture_failed"});
        if(visionProv.value==="google"){
          const key=(await new Promise(r=>chrome.storage.local.get(["keys"],r))).keys?.gv || gvKey.value.trim();
          const req={requests:[{image:{content:dataUrl.split(',')[1]},features:[{type:"TEXT_DETECTION"}]}]};
          const res=await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(key)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(req)});
          const j=await res.json();
          show({ok:true,provider:"google",vision:j?.responses?.[0]?.fullTextAnnotation?.text?.slice(0,200)||"(text detected)"});
        }else{
          const keys=(await new Promise(r=>chrome.storage.local.get(["keys"],r))).keys||{};
          const headers={"Content-Type":"application/json","Authorization":"Bearer "+(keys.oai?.key||oaiKey.value.trim())};
          if(keys.oai?.project||oaiProject.value.trim()) headers["OpenAI-Project"]=(keys.oai?.project||oaiProject.value.trim());
          const body=JSON.stringify({model:"gpt-4o-mini",response_format:{type:"json_object"},messages:[{role:"user",content:[{type:"text",text:"Analyze chart. Return JSON {direction:'BUY'|'SELL', entry:number, stopLoss:number, takeProfit:number}."},{type:"image_url",image_url:{url:dataUrl}}]}]});
          const res=await fetch((keys.oai?.url||oaiUrl.value.trim()),{method:"POST",headers,body});
          const raw=await res.text();
          let j; try{j=JSON.parse(raw);}catch{return show({ok:false,stage:"parse",error:"bad_json",raw:raw.slice(0,300)})}
          let p; if(j.choices && j.choices[0]?.message?.content){ try{p=JSON.parse(j.choices[0].message.content);}catch{return show({ok:false,stage:"content_parse",sample:j.choices[0].message.content.slice(0,200)})} }
          else if(j.direction) p=j; else return show({ok:false,stage:"invalid_response",raw:j});
          show({ok:true,provider:"openai",payload:p});
        }
      });
    }catch(e){ show({ok:false,stage:"vision",error:e.message||String(e)}); }
  });

  exitBtn.addEventListener("click", ()=> window.close());
})();
