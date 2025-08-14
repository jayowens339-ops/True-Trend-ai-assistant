// overlay.js — attach-only overlay inside chart; draggable/resizable toolbar; styled lines + badges; per-symbol memory
(() => {
  let mounted=false, layer=null, panel=null, priceMap=null, curSymbol="SYM", perSymbol=true;

  const $n = (html) => { const d=document.createElement("div"); d.innerHTML=html.trim(); return d.firstChild; };

  function findChartRoot(){
    const cands = Array.from(document.querySelectorAll("div,section,main")).filter(el=>{
      const r=el.getBoundingClientRect(), s=getComputedStyle(el);
      return r.width>400 && r.height>300 && s.visibility!=="hidden" && s.display!=="none";
    });
    cands.sort((a,b)=>(b.clientWidth*b.clientHeight)-(a.clientWidth*a.clientHeight));
    return cands[0] || document.body;
  }
  function mapYAxis(root){
    const labels = Array.from(root.querySelectorAll("div,span")).filter(el=>/^[\$\d.,]+$/.test((el.textContent||"").trim()));
    if (labels.length<2) return null;
    const pts = labels.slice(0,10).map(el=>({ y: el.getBoundingClientRect().top + el.offsetHeight/2, p: parseFloat(el.textContent.replace(/[^0-9.]/g,'')) }));
    pts.sort((a,b)=>a.y-b.y);
    const a = (pts.at(-1).y - pts[0].y) / (pts.at(-1).p - pts[0].p || 1);
    const b = pts[0].y - a*pts[0].p;
    return { priceToY:(p)=> a*p + b - window.scrollY, yToPrice:(y)=> (y + window.scrollY - b)/a };
  }
  function savePos(){
    if (!panel) return;
    const key = perSymbol ? `tt_ui_${curSymbol}` : `tt_ui_site`;
    const data = { left: panel.style.left, top: panel.style.top, scale: panel.dataset.scale||"1" };
    try{ localStorage.setItem(key, JSON.stringify(data)); }catch{}
  }
  function loadPos(){
    const key = perSymbol ? `tt_ui_${curSymbol}` : `tt_ui_site`;
    try{
      const raw = localStorage.getItem(key); if(!raw) return;
      const d = JSON.parse(raw);
      if (d.left) panel.style.left=d.left;
      if (d.top) panel.style.top=d.top;
      if (d.scale){ panel.dataset.scale=d.scale; panel.style.transform=`scale(${d.scale})`; panel.style.transformOrigin="top left"; }
    }catch{}
  }

  function ensureLayer(){
    if (layer && document.body.contains(layer)) return;
    const root = findChartRoot();
    layer = document.createElement("div");
    Object.assign(layer.style,{ position:"absolute", inset:"0", pointerEvents:"none", zIndex:2147483600 });
    if (getComputedStyle(root).position==="static") root.style.position="relative";
    root.appendChild(layer);
    priceMap = mapYAxis(root);

    panel = $n(`<div style="position:absolute;top:8px;left:8px;pointer-events:auto;display:flex;align-items:center;gap:6px;background:rgba(10,13,22,.92);color:#eaeef5;border:1px solid #223;border-radius:10px;padding:6px 8px;font:12px system-ui,Segoe UI,Arial;z-index:2147483601">
      <b style="cursor:grab">TrueTrend</b>
      <button data-cmd="collapse" style="padding:4px 6px;border:0;border-radius:8px;cursor:pointer">▾</button>
      <button data-cmd="dock" style="padding:4px 6px;border:0;border-radius:8px;cursor:pointer">Dock</button>
      <button data-cmd="scale" style="padding:4px 6px;border:0;border-radius:8px;cursor:pointer">S</button>
      <button data-cmd="exit" style="padding:4px 6px;border:0;border-radius:8px;cursor:pointer;background:#f55757;color:#fff">Exit</button>
      <div id="tt-resize" style="width:10px;height:10px;background:#666;border-radius:2px;margin-left:6px;cursor:se-resize"></div>
    </div>`);
    layer.appendChild(panel);
    loadPos();

    // drag
    let dragging=false, offX=0, offY=0;
    panel.querySelector("b").addEventListener("mousedown", e=>{ dragging=true; offX=e.offsetX; offY=e.offsetY; e.preventDefault(); });
    window.addEventListener("mousemove", e=>{
      if(!dragging) return;
      const pr=layer.getBoundingClientRect();
      panel.style.left=Math.max(0,Math.min(e.clientX-pr.left-offX,pr.width-panel.offsetWidth))+"px";
      panel.style.top =Math.max(0,Math.min(e.clientY-pr.top -offY,pr.height-panel.offsetHeight))+"px";
    });
    window.addEventListener("mouseup", ()=>{ if(dragging){ dragging=false; savePos(); } });

    // resize
    let resizing=false, startW=0,startH=0,startX=0,startY=0;
    panel.querySelector("#tt-resize").addEventListener("mousedown", e=>{ resizing=true; startW=panel.offsetWidth; startH=panel.offsetHeight; startX=e.clientX; startY=e.clientY; e.preventDefault(); });
    window.addEventListener("mousemove", e=>{ if(!resizing) return; const dx=e.clientX-startX, dy=e.clientY-startY; panel.style.width=Math.max(180,startW+dx)+"px"; panel.style.height=Math.max(24,startH+dy)+"px"; });
    window.addEventListener("mouseup", ()=>{ if(resizing){ resizing=false; savePos(); } });

    panel.addEventListener("click", e=>{
      const cmd=e.target?.dataset?.cmd;
      if(cmd==="exit"){ destroy(); }
      if(cmd==="collapse"){ panel.classList.toggle("collapsed"); panel.style.height=panel.classList.contains("collapsed")?"24px":""; }
      if(cmd==="scale"){ const cur=Number(panel.dataset.scale||"1"); const nxt=cur==0.7?0.9:(cur==0.9?0.8:0.7); panel.dataset.scale=nxt; panel.style.transform=`scale(${nxt})`; panel.style.transformOrigin="top left"; savePos(); }
      if(cmd==="dock"){ const d=panel.dataset.dock; if(d==="top"){ panel.dataset.dock="bottom"; panel.style.top=""; panel.style.bottom="8px"; } else if(d==="bottom"){ panel.dataset.dock="free"; panel.style.bottom=""; panel.style.top="8px"; } else { panel.dataset.dock="top"; panel.style.top="8px"; } savePos(); }
    });
  }

  function destroy(){ mounted=false; if(layer?.parentElement) layer.parentElement.removeChild(layer); layer=null; panel=null; }
  function clearLines(){ layer && layer.querySelectorAll('[data-tt="line"]').forEach(el=>el.remove()); }
  function drawLine(label, price, kind){
    ensureLayer();
    const root=layer.getBoundingClientRect();
    const y = priceMap ? priceMap.priceToY(price) - root.top : (root.height*0.5);
    const line=document.createElement("div");
    Object.assign(line.style,{ position:"absolute", left:"0", width:"100%", top:`${y}px` });
    if (kind==="entry") line.style.borderTop="3px dotted #000";
    else if (kind==="tp") line.style.borderTop="3px dotted #1fc46b";
    else if (kind==="stop") line.style.borderTop="3px solid #f55757";
    else if (kind==="trail") line.style.borderTop="2px dashed #9bd1ff";
    line.dataset.tt="line";
    const tag=document.createElement("div");
    tag.textContent=label;
    Object.assign(tag.style,{ position:"absolute", right:"6px", top:"-10px", background:"#fff", color:"#000", padding:"2px 6px", borderRadius:"8px", fontSize:"12px", fontWeight:"700" });
    if (kind==="stop") tag.style.background="#f55757";
    if (kind==="tp") tag.style.background="#1fc46b";
    if (kind==="entry") tag.style.background="#bbb";
    if (kind==="trail") tag.style.background="#9bd1ff";
    line.appendChild(tag);
    layer.appendChild(line);
    return line;
  }
  function apply(pld){
    ensureLayer(); clearLines();
    const { entry, stopLoss, takeProfit, takeProfit2, trailingStop } = pld;
    if (entry!=null)       drawLine(`➜ ENTRY ${entry.toFixed(5)}`, entry, "entry");
    if (stopLoss!=null)    drawLine(`✖ STOP ${stopLoss.toFixed(5)}`, stopLoss, "stop");
    if (takeProfit!=null)  drawLine(`💰 TP1 ${takeProfit.toFixed(5)}`, takeProfit, "tp");
    if (takeProfit2!=null) drawLine(`💰 TP2 ${takeProfit2.toFixed(5)}`, takeProfit2, "tp");
    if (trailingStop!=null)drawLine(`↗ TRAIL ${trailingStop.toFixed(5)}`, trailingStop, "trail");
  }

  chrome.runtime.onMessage.addListener((msg, snd, send)=>{
    if (msg?.type==="TT_ATTACH"){ mounted=true; curSymbol=msg.symbol||"SYM"; perSymbol=!!msg.perSymbol; ensureLayer(); send&&send({ok:true}); }
    if (msg?.type==="TT_DETACH"){ destroy(); send&&send({ok:true}); }
    if (msg?.type==="TT_LEVELS" && mounted){ apply(msg.payload||{}); send&&send({ok:true}); }
  });
})();
