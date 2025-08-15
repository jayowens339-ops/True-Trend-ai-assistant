// overlay.js — TradingView‑tuned attach + price map (vTV-1)
(() => {
  let mounted=false, layer=null, panel=null, priceMap=null, site="generic";

  // --- TradingView-specific root finder ---
  function findRoot(){
    // Detect TradingView
    if (location.hostname.includes("tradingview.com")) site="tradingview";

    if (site==="tradingview"){
      // 1) Try the main chart pane host (most stable parent)
      const paneHost = document.querySelector('[data-name="pane"], [class*="chart-container"], [class*="tv-chart-view__pane"]');
      if (paneHost) {
        const root = paneHost.closest('[class*="chart-container"]') || paneHost.closest('[class*="chart-wrap"]') || paneHost;
        if (root) return root;
      }
      // 2) Fallback to the largest visible container
    }
    // Generic fallback
    return [...document.querySelectorAll("div,section,main")]
      .filter(el=>{
        const r=el.getBoundingClientRect(), s=getComputedStyle(el);
        return r.width>400&&r.height>300&&s.visibility!=="hidden"&&s.display!=="none";
      })
      .sort((a,b)=>b.clientWidth*b.clientHeight-a.clientWidth*a.clientHeight)[0]||document.body;
  }

  // --- TradingView price scale mapping ---
  function mapYAxis(root){
    if (site==="tradingview"){
      // Get labels from the right price scale (works on light/dark themes)
      // Common selectors seen in production:
      //  - [class*="price-axis"], [class*="price-axis__side--right"]
      //  - [class*="price-scale"], [class*="price-axis-value"]
      const scale = root.querySelector('[class*="price-axis__right"], [class*="price-axis__side--right"], [class*="price-scale"], [class*="price-axis"]') || root;
      const labelNodes = [...scale.querySelectorAll('div, span')]
        .filter(el=>{
          const t=(el.textContent||'').trim();
          // Accept prices like 453.26, 1.08234, $453.26, 4,532.1 etc
          return /^[$€£]?\d{1,3}(?:[,\s]\d{3})*(?:\.\d+)?$/.test(t);
        });

      if (labelNodes.length>=2){
        const pts = labelNodes.slice(0,14).map(el=>{
          const rect = el.getBoundingClientRect();
          const txt  = (el.textContent||'').trim().replace(/[^\d.\-]/g,'');
          return { y: rect.top + rect.height/2, p: parseFloat(txt) };
        }).filter(p=>Number.isFinite(p.p));

        if (pts.length>=2){
          // Sort by Y (top -> bottom)
          pts.sort((a,b)=>a.y-b.y);
          // Linear map: y = a*price + b
          const dy = pts.at(-1).y - pts[0].y;
          const dp = pts.at(-1).p - pts[0].p || 1;
          const a  = dy / dp;
          const b  = pts[0].y - a*pts[0].p;
          return {
            priceToY:(price)=>{
              // relative to layer
              const yAbs = a*price + b;
              const rootBox = layer?.getBoundingClientRect?.() || { top: 0 };
              return yAbs - rootBox.top - window.scrollY;
            }
          };
        }
      }
    }

    // Generic fallback (non-TradingView)
    const labels=[...root.querySelectorAll("div,span")]
      .filter(el=>/^[\$\d.,]+$/.test((el.textContent||'').trim()));
    if(labels.length<2) return null;
    const pts=labels.slice(0,10).map(el=>{
      const r=el.getBoundingClientRect();
      const t=(el.textContent||'').trim().replace(/[^0-9.]/g,'');
      return { y:r.top+r.height/2, p:parseFloat(t)||0 };
    }).filter(p=>Number.isFinite(p.p));
    if(pts.length<2) return null;
    pts.sort((a,b)=>a.y-b.y);
    const a=(pts.at(-1).y-pts[0].y)/(pts.at(-1).p-pts[0].p||1);
    const b=pts[0].y-a*pts[0].p;
    return { priceToY:(p)=>a*p+b - (layer?.getBoundingClientRect?.().top||0) - window.scrollY };
  }

  function ensure(){
    if(layer && document.body.contains(layer)) return;
    const root=findRoot();
    if (!root) return;

    layer=document.createElement("div");
    Object.assign(layer.style,{
      position:"absolute", inset:"0", pointerEvents:"none", zIndex:2147483600
    });
    const cs=getComputedStyle(root);
    if(cs.position==="static") root.style.position="relative";
    root.appendChild(layer);

    priceMap=mapYAxis(root);

    panel=document.createElement("div");
    Object.assign(panel.style,{
      position:"absolute", top:"8px", left:"8px", pointerEvents:"auto",
      display:"flex", alignItems:"center", gap:"6px",
      background:"rgba(10,13,22,.92)", color:"#eaeef5",
      border:"1px solid #223", borderRadius:"10px", padding:"6px 8px",
      font:"12px system-ui,Segoe UI,Arial", zIndex:2147483601
    });
    panel.innerHTML=`<b style="cursor:grab">TrueTrend</b>
      <button data-cmd="collapse" style="padding:4px 6px;border:0;border-radius:8px;cursor:pointer">▾</button>
      <button data-cmd="scale"    style="padding:4px 6px;border:0;border-radius:8px;cursor:pointer">S</button>
      <button data-cmd="exit"     style="padding:4px 6px;border:0;border-radius:8px;cursor:pointer;background:#f55757;color:#fff">Exit</button>`;
    layer.appendChild(panel);

    // Drag
    let dragging=false, offX=0, offY=0;
    panel.querySelector("b").addEventListener("mousedown", e=>{dragging=true;offX=e.offsetX;offY=e.offsetY;e.preventDefault();});
    window.addEventListener("mousemove", e=>{
      if(!dragging) return;
      const pr=layer.getBoundingClientRect();
      panel.style.left=Math.max(0,Math.min(e.clientX-pr.left-offX,pr.width-panel.offsetWidth))+"px";
      panel.style.top =Math.max(0,Math.min(e.clientY-pr.top -offY,pr.height-panel.offsetHeight))+"px";
    });
    window.addEventListener("mouseup", ()=> dragging=false);

    panel.addEventListener("click", e=>{
      const cmd=e.target?.dataset?.cmd;
      if(cmd==="exit") destroy();
      if(cmd==="collapse"){ panel.classList.toggle("collapsed"); panel.style.height=panel.classList.contains("collapsed")?"24px":""; }
      if(cmd==="scale"){
        const s=panel.dataset.scale?Number(panel.dataset.scale):1.0;
        const nxt=s===0.7?0.9:(s===0.9?0.8:0.7);
        panel.dataset.scale=nxt; panel.style.transform=`scale(${nxt})`; panel.style.transformOrigin="top left";
      }
    });

    // React to TV redraws/layout changes
    new MutationObserver(()=>{
      const newRoot=findRoot();
      if (newRoot && !newRoot.contains(layer)){
        // reattach layer if TradingView re-mounted the pane
        try{ layer.remove(); }catch{}
        try{
          const cs=getComputedStyle(newRoot);
          if(cs.position==="static") newRoot.style.position="relative";
          newRoot.appendChild(layer);
        }catch{}
      }
      priceMap=mapYAxis(newRoot||root);
    }).observe(document.documentElement,{childList:true,subtree:true,attributes:true});

    addEventListener("resize", ()=> priceMap=mapYAxis(findRoot()));
    addEventListener("scroll", ()=> priceMap=mapYAxis(findRoot()));
  }

  function destroy(){ if(layer?.parentElement) layer.parentElement.removeChild(layer); layer=null; panel=null; mounted=false; }
  function clearLines(){ layer && layer.querySelectorAll('[data-tt="line"]').forEach(el=>el.remove()); }

  function draw(label, price, kind){
    ensure(); if(!layer) return;
    const rootBox=layer.getBoundingClientRect();
    const y = priceMap ? priceMap.priceToY(price) : (rootBox.height*0.5);
    const line=document.createElement("div");
    Object.assign(line.style,{position:"absolute",left:"0",width:"100%",top:`${y}px`});
    if(kind==="entry") line.style.borderTop="3px dotted #000";
    else if(kind==="tp") line.style.borderTop="3px dotted #1fc46b";
    else if(kind==="stop") line.style.borderTop="3px solid #f55757";
    else if(kind==="trail") line.style.borderTop="2px dashed #9bd1ff";
    line.dataset.tt="line";

    const tag=document.createElement("div"); tag.textContent=label;
    Object.assign(tag.style,{position:"absolute",right:"6px",top:"-10px",background:"#fff",color:"#000",
      padding:"2px 6px",borderRadius:"8px",fontSize:"12px",fontWeight:"700"});
    if(kind==="stop") tag.style.background="#f55757";
    if(kind==="tp")   tag.style.background="#1fc46b";
    if(kind==="entry")tag.style.background="#bbb";
    if(kind==="trail")tag.style.background="#9bd1ff";
    line.appendChild(tag); layer.appendChild(line);
  }

  function apply(p){ clearLines();
    const { entry, stopLoss, takeProfit, takeProfit2, trailingStop } = p||{};
    if (entry!=null)       draw(`➜ ENTRY ${Number(entry).toFixed(5)}`, entry, "entry");
    if (stopLoss!=null)    draw(`✖ STOP ${Number(stopLoss).toFixed(5)}`, stopLoss, "stop");
    if (takeProfit!=null)  draw(`💰 TP1 ${Number(takeProfit).toFixed(5)}`, takeProfit, "tp");
    if (takeProfit2!=null) draw(`💰 TP2 ${Number(takeProfit2).toFixed(5)}`, takeProfit2, "tp");
    if (trailingStop!=null)draw(`↗ TRAIL ${Number(trailingStop).toFixed(5)}`, trailingStop, "trail");
  }

  chrome.runtime.onMessage.addListener((msg,_,send)=>{
    if (msg?.type==="TT_ATTACH"){ mounted=true; ensure(); send&&send({ok:true}); }
    if (msg?.type==="TT_DETACH"){ destroy(); send&&send({ok:true}); }
    if (msg?.type==="TT_LEVELS" && mounted){ apply(msg.payload||{}); send&&send({ok:true}); }
  });
})();
