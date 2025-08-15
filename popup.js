(()=> {
  const $=s=>document.querySelector(s), out=$("#out");
  const symbol=$("#symbol"), timeframe=$("#timeframe"), htf=$("#htf"), strategy=$("#strategy"), voice=$("#voice");
  const risk=$("#risk"), kStop=$("#kStop"), kTp1=$("#kTp1"), kTp2=$("#kTp2"), kTrail=$("#kTrail"), customRisk=$("#customRisk");
  const polyKey=$("#polyKey"), tdKey=$("#tdKey"), fhKey=$("#fhKey");
  const visionProv=$("#visionProv"), gvAuth=$("#gvAuth"), gvKey=$("#gvKey"), gvJson=$("#gvJson"), oaiUrl=$("#oaiUrl"), oaiKey=$("#oaiKey"), oaiProject=$("#oaiProject");
  const yoloUrl=$("#yoloUrl"), yoloKey=$("#yoloKey");
  const streamOn=$("#streamOn"), streamTest=$("#streamTest");
  const attachBtn=$("#attach"), detachBtn=$("#detach"), analyzeBtn=$("#analyze"), visionBtn=$("#vision"), exitBtn=$("#exit"), visionTest=$("#visionTest");

  // baked defaults per your request
  const DEFAULTS={ poly:"jd8IhUkgfcFUNpIQgAyy4VB9CVgjZVUp",
                   td:"d6acbe072f1c4345bc37d1793ffae556",
                   fh:"d2b68fpr01qrj4ikj0n0d2b68fpr01qrj4ikj0ng",
                   gv:"22a7e678c612aa47f8d8fa9f0e26f3efc14d8ad3",
                   oai:{url:"https://api.openai.com/v1/chat/completions", key:"", project:""},
                   yolo:{url:"http://localhost:8000/infer", key:""} };

  const show = o => out.textContent = JSON.stringify(o,null,2);
  const speak = t => { try{ if(!voice.checked) return; const u=new SpeechSynthesisUtterance(t); speechSynthesis.cancel(); speechSynthesis.speak(u);}catch{} };

  // UI state
  chrome.storage.local.get(["cfg","keys","gvSa","yolo"], r=>{
    const cfg=r.cfg||{}, keys=r.keys||DEFAULTS, y=r.yolo||DEFAULTS.yolo;
    symbol.value=cfg.symbol||"AAPL"; timeframe.value=cfg.timeframe||"5min"; htf.value=cfg.htf||"15min";
    strategy.value=cfg.strategy||"router"; voice.checked=cfg.voice??true;
    risk.value=cfg.risk||"scalp"; if(risk.value==="custom") customRisk.style.display="grid";
    kStop.value=cfg.kStop??1.5; kTp1.value=cfg.kTp1??1.8; kTp2.value=cfg.kTp2??3.0; kTrail.value=cfg.kTrail??0.8;

    polyKey.value=keys.poly||DEFAULTS.poly; tdKey.value=keys.td||DEFAULTS.td; fhKey.value=keys.fh||DEFAULTS.fh;
    gvAuth.value=cfg.gvAuth||"apiKey";     gvKey.value=keys.gv||DEFAULTS.gv;
    oaiUrl.value=(keys.oai?.url)||DEFAULTS.oai.url; oaiKey.value=(keys.oai?.key)||""; oaiProject.value=(keys.oai?.project)||"";
    yoloUrl.value=y.url; yoloKey.value=y.key;
    streamOn.value=cfg.streamOn||"stocks";
  });

  [symbol,timeframe,htf,strategy,voice,gvAuth,streamOn].forEach(el=>el.addEventListener("change",persist));
  [kStop,kTp1,kTp2,kTrail,risk].forEach(el=>el.addEventListener("change",()=>{customRisk.style.display=risk.value==="custom"?"grid":"none";persist()}));
  [polyKey,tdKey,fhKey,gvKey,oaiUrl,oaiKey,oaiProject].forEach(el=>el.addEventListener("change",()=>chrome.storage.local.set({ keys:{ poly:polyKey.value.trim(), td:tdKey.value.trim(), fh:fhKey.value.trim(), gv:gvKey.value.trim(), oai:{url:oaiUrl.value.trim(),key:oaiKey.value.trim(),project:oaiProject.value.trim()} } })));
  [yoloUrl,yoloKey].forEach(el=>el.addEventListener("change",()=>chrome.storage.local.set({ yolo:{ url:yoloUrl.value.trim(), key:yoloKey.value.trim() } })));
  gvJson.addEventListener("change",async ()=>{ const f=gvJson.files?.[0]; if(!f) return; const txt=await f.text(); chrome.storage.local.set({ gvSa: txt }); show({ok:true, gvServiceAccountLoaded:true}); });

  function persist(){ chrome.storage.local.set({ cfg:{ symbol:symbol.value,timeframe:timeframe.value,htf:htf.value,strategy:strategy.value,voice:voice.checked, gvAuth:gvAuth.value, streamOn:streamOn.value,
    risk:risk.value, kStop:Number(kStop.value), kTp1:Number(kTp1.value), kTp2:Number(kTp2.value), kTrail:Number(kTrail.value) } }); }

  // Attach/Detach
  $("#attach").addEventListener("click", ()=> withTab(t=> send(t,{type:"TT_ATTACH",symbol:symbol.value,perSymbol:true})));
  $("#detach").addEventListener("click", ()=> withTab(t=> send(t,{type:"TT_DETACH"})));

  // Analyze (data-driven)
  $("#analyze").addEventListener("click", analyze);
  async function analyze(){
    try{
      const keys=(await get("keys")).keys||DEFAULTS;
      const prim=await seriesFor(symbol.value,timeframe.value,keys); const ser=prim.data;
      const base = strategy.value==="ema"?stratEMA(ser): strategy.value==="supertrend"?stratST(ser): strategy.value==="orb"?stratORB(ser): strategy.value==="bos"?stratBOS(ser): router(ser);
      let htfSig=null; if(htf.value){ try{ const hs=(await seriesFor(symbol.value,htf.value,keys)).data; htfSig=stratEMA(hs);}catch{} }
      const biased=regime(ser,base,htfSig); const A=base.atr||0.5; const plan=planFrom(biased.entry,biased.direction,A);
      withTab(t=>{ send(t,{type:"TT_ATTACH",symbol:symbol.value,perSymbol:true},()=> send(t,{type:"TT_LEVELS",payload:{direction:biased.direction,entry:biased.entry,...plan}})); });
      if(voice.checked) speak(`${biased.direction}. Entry ${biased.entry}. Stop ${plan.stopLoss}. TP1 ${plan.takeProfit}. TP2 ${plan.takeProfit2}. Trail ${plan.trailingStop}.`);
      show({ok:true,src:prim.src,strategy:base.name,entry:biased.entry,stop:plan.stopLoss,tp1:plan.takeProfit,tp2:plan.takeProfit2,trail:plan.trailingStop});
    }catch(e){ show({ok:false,error:String(e)}); }
  }

  // Vision providers
  $("#visionTest").addEventListener("click", async ()=>{
    if(visionProv.value==="google"){
      if(gvAuth.value==="apiKey"){
        const res=await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(gvKey.value.trim())}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({requests:[{image:{content:""},features:[{type:"TEXT_DETECTION"}]}]})});
        show({ok:res.status<400,provider:"google",auth:"apiKey",status:res.status});
      }else{
        const sa=(await get("gvSa")).gvSa; show({ok:!!sa,provider:"google",auth:"serviceAccountJson",loaded:!!sa});
      }
    } else {
      const headers={"Content-Type":"application/json","Authorization":"Bearer "+oaiKey.value.trim()}; if(oaiProject.value.trim()) headers["OpenAI-Project"]=oaiProject.value.trim();
      const r=await fetch(oaiUrl.value.trim(),{method:"POST",headers,body:JSON.stringify({model:"gpt-4o-mini",messages:[{role:"user",content:"ping"}],max_tokens:1})});
      show({ok:r.status<400,provider:"openai",status:r.status});
    }
  });

  $("#vision").addEventListener("click", ()=> {
    chrome.tabs.captureVisibleTab(null,{format:"jpeg",quality:80}, async dataUrl=>{
      if(!dataUrl) return show({ok:false,stage:"capture"});
      if(visionProv.value==="yolo"){
        const y=(await get("yolo")).yolo||{url:yoloUrl.value,key:yoloKey.value};
        const headers={"Content-Type":"application/json"}; if(y.key) headers["Authorization"]="Bearer "+y.key;
        const res=await fetch(y.url,{method:"POST",headers,body:JSON.stringify({image:dataUrl,return_plan:true,symbol:symbol.value,timeframe:timeframe.value})});
        const j=await res.json();
        if(j?.plan?.direction){ withTab(t=> send(t,{type:"TT_ATTACH",symbol:symbol.value,perSymbol:true},()=> send(t,{type:"TT_LEVELS",payload:j.plan})) ); show({ok:true,provider:"yolo",source:"polygon",plan:j.plan}); }
        else show({ok:true,provider:"yolo",detections:j?.detections||[],note:j?.note||"no plan"});
      } else if(visionProv.value==="google"){
        const req={requests:[{image:{content:dataUrl.split(',')[1]},features:[{type:"OBJECT_LOCALIZATION"},{type:"TEXT_DETECTION"}]}]};
        const res=await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(gvKey.value.trim())}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(req)});
        const j=await res.json();
        const text=j?.responses?.[0]?.fullTextAnnotation?.text?.toLowerCase()||"";
        const direction=(text.match(/sell/g)||[]).length>(text.match(/buy/g)||[]).length?"SELL":"BUY";
        const keys=(await get("keys")).keys||DEFAULTS; const prim=await seriesFor(symbol.value,timeframe.value,keys); const ser=prim.data; const entry=ser.at(-1)?.c||0; const A=atr(ser,14)||Math.abs(ser.at(-1).c-ser.at(-2).c)||0.5;
        const plan=planFrom(entry,direction,A);
        withTab(t=> send(t,{type:"TT_ATTACH",symbol:symbol.value,perSymbol:true},()=> send(t,{type:"TT_LEVELS",payload:{direction,entry,...plan}})));
        show({ok:true,provider:"google",objects:(j?.responses?.[0]?.localizedObjectAnnotations||[]).slice(0,5)});
      } else {
        const headers={"Content-Type":"application/json","Authorization":"Bearer "+oaiKey.value.trim()}; if(oaiProject.value.trim()) headers["OpenAI-Project"]=oaiProject.value.trim();
        const body={model:"gpt-4o-mini",response_format:{type:"json_object"},messages:[{role:"user",content:[{type:"text",text:"Analyze chart. Return JSON {direction:'BUY'|'SELL', entry:number, stopLoss:number, takeProfit:number}."},{type:"image_url",image_url:{url:dataUrl}}]}]};
        const res=await fetch(oaiUrl.value.trim(),{method:"POST",headers,body:JSON.stringify(body)}); const raw=await res.text(); let j; try{j=JSON.parse(raw);}catch{return show({ok:false,stage:"parse",raw:raw.slice(0,200)})}
        let p; try{ p = JSON.parse(j.choices[0].message.content) }catch{ return show({ok:false,stage:"content_parse"}); }
        const A=Math.abs(p.entry-p.stopLoss)/1.5||0.5; const tp2=p.direction==="BUY"? p.entry+3.0*A : p.entry-3.0*A; const trail=p.direction==="BUY"? p.entry+0.8*A : p.entry-0.8*A;
        withTab(t=> send(t,{type:"TT_ATTACH",symbol:symbol.value,perSymbol:true},()=> send(t,{type:"TT_LEVELS",payload:{direction:p.direction,entry:p.entry,stopLoss:p.stopLoss,takeProfit:p.takeProfit,takeProfit2:tp2,trailingStop:trail}})));
        show({ok:true,provider:"openai",payload:p});
      }
    });
  });

  // Data helpers + strategies + plan
  const fetchJSON=async u=>{ const r=await fetch(u); const t=await r.text(); try{return JSON.parse(t);}catch{return{_raw:t}} };
  async function getPolygon(sym, tf, key){
    const span=tf==="daily"?"1/day":tf==="60min"?"60/minute":tf==="15min"?"15/minute":tf==="5min"?"5/minute":"1/minute";
    const now=new Date(); const from=new Date(now.getTime()-1000*60*60*24*10);
    const f=from.toISOString().split("T")[0], to=now.toISOString().split("T")[0];
    const u=`https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/range/${span}/${f}/${to}?adjusted=true&sort=asc&limit=300&apiKey=${encodeURIComponent(key)}`;
    const j=await fetchJSON(u); if(j?.results?.length) return j.results.map(r=>({t:r.t/1000,o:r.o,h:r.h,l:r.l,c:r.c})); throw "polygon_failed";
  }
  async function getTD(sym, tf, key){
    const map={"1min":"1min","5min":"5min","15min":"15min","60min":"60min","daily":"1day"};
    const u=`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${map[tf]||"1day"}&outputsize=300&apikey=${encodeURIComponent(key)}`;
    const j=await fetchJSON(u); if(j?.values?.length) return j.values.map(v=>({o:+v.open,h:+v.high,l:+v.low,c:+v.close,t:Date.parse(v.datetime)/1000})).reverse(); throw "twelvedata_failed";
  }
  async function getFH(sym, tf, key){
    const now=Math.floor(Date.now()/1000), frm=now-60*60*24*7;
    const res={"1min":"1","5min":"5","15min":"15","60min":"60","daily":"D"}[tf]||"D";
    const u=`https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(sym)}&resolution=${res}&from=${frm}&to=${now}&token=${encodeURIComponent(key)}`;
    const jc=await fetchJSON(u); if(jc?.s==="ok" && Array.isArray(jc.c) && jc.c.length>1) return jc.c.map((c,i)=>({t:jc.t[i],o:jc.o?.[i]??c,h:jc.h?.[i]??c,l:jc.l?.[i]??c,c}));
    const q=`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(key)}`; const jq=await fetchJSON(q); if(jq?.c) return [{t:now,o:jq.o??jq.c,h:jq.h??jq.c,l:jq.l??jq.c,c:jq.c}]; throw "finnhub_failed";
  }
  async function seriesFor(sym, tf, keys){ try{ return { data: await getPolygon(sym, tf, keys.poly), src:"polygon" }; }
    catch{ try{ return { data: await getTD(sym, tf, keys.td), src:"twelvedata" }; } catch{ return { data: await getFH(sym, tf, keys.fh), src:"finnhub" }; } } }

  const ema=(v,p)=>{const k=2/(p+1);let prev=v[0]??0,out=[prev];for(let i=1;i<v.length;i++){const x=v[i];prev=x*k+prev*(1-k);out.push(prev)}return out};
  const atr=(s,n=14)=>{const trs=[];for(let i=1;i<s.length;i++){const a=s[i],b=s[i-1];trs.push(Math.max(a.h-a.l,Math.abs(a.h-b.c),Math.abs(a.l-b.c)))}const m=Math.min(n,trs.length)||1;let sum=0;for(let i=trs.length-m;i<trs.length;i++) sum+=trs[i];return sum/m};
  const slope=(s,n=10)=>{if(s.length<n+1)return 0;let acc=0;for(let i=s.length-n;i<s.length;i++) acc+=s[i].c-s[i-1].c;return acc/n};
  const hh=(s,lb=20)=>{let m=-Infinity;for(let i=Math.max(0,s.length-lb);i<s.length;i++) m=Math.max(m,s[i].h);return m};
  const ll=(s,lb=20)=>{let m= Infinity;for(let i=Math.max(0,s.length-lb);i<s.length;i++) m=Math.min(m,s[i].l);return m};
  const stratEMA=s=>{const c=s.map(b=>b.c),e9=ema(c,9),e21=ema(c,21),last=s.at(-1);return {name:"ema",direction:e9.at(-1)>=e21.at(-1)?"BUY":"SELL",entry:last.c,atr:atr(s,14)||0.5};};
  const stratST =s=>{const A=atr(s,10)||0.5,last=s.at(-1),mid=(last.h+last.l)/2,up=mid+3*A,dn=mid-3*A;const dir= last.c>=up?"BUY": last.c<=dn?"SELL": (slope(s,10)>=0?"BUY":"SELL");return {name:"supertrend",direction:dir,entry:last.c,atr:A};};
  const stratORB=s=>{const n=6,op=s.slice(0,Math.min(n,s.length)),H=Math.max(...op.map(b=>b.h)),L=Math.min(...op.map(b=>b.l)),last=s.at(-1);const dir= last.c>H?"BUY": last.c<L?"SELL": (slope(s,5)>=0?"BUY":"SELL");const A=atr(s,14)||0.5;return {name:"orb",direction:dir,entry:last.c,atr:A};};
  const stratBOS=s=>{const last=s.at(-1),prev=s.at(-2)||last,sH=hh(s,20),sL=ll(s,20);let dir="BUY"; if(last.c<sL&&prev.c>=sL) dir="SELL"; if(last.c>sH&&prev.c<=sH) dir="BUY"; const A=atr(s,14)||0.5; return {name:"bos",direction:dir,entry:last.c,atr:A};};
  const router=s=>{const list=[stratEMA(s),stratST(s),stratORB(s),stratBOS(s)],w={ema:0.35,supertrend:0.25,orb:0.20,bos:0.20};
    const score=list.reduce((a,x)=>a+({BUY:1,SELL:-1}[x.direction])*w[x.name],0), entry=s.at(-1).c, A=list.reduce((m,x)=>m+x.atr,0)/list.length;
    return {name:"router",direction:score>0?"BUY":score<0?"SELL":"FLAT",entry,atr:A,score,votes:{buy:list.filter(x=>x.direction==='BUY').length,sell:list.filter(x=>x.direction==='SELL').length}};};
  const regime=(s,base,htfSig)=>{const c=s.map(b=>b.c),e200=ema(c,200).at(-1)||base.entry,e50s=slope(s,20),h=htfSig?.direction;
    if(s.at(-1).c<e200&&e50s<0&&(!h||h==="SELL")) return {...base,direction:base.direction==="BUY"?"SELL":base.direction};
    if(s.at(-1).c>e200&&e50s>0&&(!h||h==="BUY")) return {...base,direction:base.direction==="SELL"?"BUY":base.direction};
    return base;};
  function kset(){ if(risk.value==="scalp") return {kS:1.2,k1:1.4,k2:2.4,kT:0.6}; if(risk.value==="swing") return {kS:1.8,k1:2.2,k2:3.8,kT:1.0};
    return {kS:Number(kStop.value||1.5),k1:Number(kTp1.value||1.8),k2:Number(kTp2.value||3.0),kT:Number(kTrail.value||0.8)}; }
  const planFrom=(entry,dir,A)=>{const {kS,k1,k2,kT}=kset(); return {stopLoss: dir==="BUY"?entry-kS*A:entry+kS*A, takeProfit: dir==="BUY"?entry+k1*A:entry-k1*A, takeProfit2: dir==="BUY"?entry+k2*A:entry-k2*A, trailingStop: dir==="BUY"?entry+kT*A:entry-kT*A};};

  // WebSocket streaming (stocks=AM, forex=CA)
  streamTest.addEventListener("click", startWS);
  let ws=null, wsTimer=null;
  function normalizeForex(sym){ if(/^C:[A-Z]{6}$/.test(sym)) return sym; if(/^[A-Z]{6}$/.test(sym)) return "C:"+sym; if(/^[A-Z]{3}\/[A-Z]{3}$/.test(sym)) return "C:"+sym.replace("/",""); return sym; }
  function startWS(){
    const mode=streamOn.value, key=polyKey.value.trim(); if(mode==="off"||!key) return show({ok:false,stream:false,reason:"off_or_no_key"});
    const isFx=mode==="forex", url=isFx? "wss://socket.polygon.io/forex" : "wss://socket.polygon.io/stocks";
    try{ ws&&ws.close(); }catch{}
    ws=new WebSocket(url);
    ws.onopen=()=>{ ws.send(JSON.stringify({action:"auth",params:key}));
      const sym = isFx? normalizeForex(symbol.value).replace("C:","").replace("X:","").replace("-","/"): symbol.value;
      const chan= (isFx? "CA." : "AM.") + sym; ws.send(JSON.stringify({action:"subscribe",params:chan})); show({ok:true,stream:true,sub:chan,url}); };
    ws.onmessage=(ev)=>{ try{ const data=JSON.parse(ev.data); const arr=Array.isArray(data)?data:[data]; const bars=arr.filter(m=>m.ev==="AM"||m.ev==="CA"); if(!bars.length) return;
        const last=bars.at(-1); const entry=last.c; const dir=(last.c-last.o)>=0?"BUY":"SELL"; const A=0.5; const p=planFrom(entry,dir,A);
        withTab(t=> send(t,{type:"TT_LEVELS",payload:{direction:dir,entry,...p}}));
      }catch{} };
    ws.onclose=()=>{ wsTimer && clearTimeout(wsTimer); wsTimer=setTimeout(()=>startWS(),2000); };
    ws.onerror=()=>{ try{ws.close();}catch{} };
  }

  // small helpers
  function withTab(fn){ chrome.tabs.query({active:true,currentWindow:true}, tabs=>tabs[0]&&fn(tabs[0].id)); }
  function send(tabId,msg,cb){ chrome.tabs.sendMessage(tabId,msg,cb); }
  function get(k){ return new Promise(r=> chrome.storage.local.get([].concat(k), r)); }
})();
