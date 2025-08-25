/* TrueTrend single-file patch v4.3.2.7
   What it does:
   - Ensures Timeframe dropdown has exactly:
     1 min, 5 min, 15 min, 30 min, 1 hour, 4 hours, Daily, Monthly
   - Adds ALL strategies INSIDE the existing Strategy selector (<select id="strategy">)
     under two optgroups: Stock Options, Futures & Forex
   - Auto-runs Analyze when a strategy is chosen

   How to use (easiest path):
   1) Open popup.js.
   2) Scroll to the very bottom of the file.
   3) Paste this entire block BELOW the last line and save.
   4) (Optional) bump the version in manifest.json so Chrome reloads.
   5) Reload the extension (or run the Windows launcher).
*/

(function(){
  const TIMEFRAMES = ["1 min","5 min","15 min","30 min","1 hour","4 hours","Daily","Monthly"];

  const STOCK_OPTIONS = [
    "Covered Call","Cash-Secured Put (CSP)","Wheel","Long Call","Long Put",
    "Debit Call Spread","Debit Put Spread","Credit Call Spread","Credit Put Spread",
    "Iron Condor","Iron Butterfly","Broken Wing Butterfly","Collar","Protective Put",
    "PMCC (LEAPS Covered Call)","Calendar","Diagonal","Straddle","Strangle",
    "Short Straddle","Short Strangle","Box Spread"
  ];

  const FUTURES_FOREX = [
    "EMA Trend (9/50)","RSI Divergence","MACD Cross","Bollinger Bounce",
    "Donchian/Turtle Breakout","Opening Range Breakout (ORB)","Support/Resistance",
    "Ichimoku Trend","Pivot Bounce","Fibonacci Pullback","Momentum (ROC)",
    "Mean Reversion","Range Scalping (M1/M5)","Swing (H4/D1)",
    "Heikin-Ashi Trend","ADR Breakout","Keltner Breakout","Carry Trade (FX)"
  ];

  function ensureTimeframes(){
    const sel = document.querySelector("#timeframe");
    if(!sel) return;
    // Remove non-canonical entries but keep a snapshot of current selection
    const current = (sel.value || sel.options[sel.selectedIndex]?.textContent || "").trim();
    // Clear then rebuild to be explicit
    while(sel.firstChild) sel.removeChild(sel.firstChild);
    TIMEFRAMES.forEach((label, i)=>{
      const opt = document.createElement("option");
      opt.textContent = label;
      opt.value = label;
      if ((!current && label==="5 min") || current === label) opt.selected = true;
      sel.appendChild(opt);
    });
    // Fire change so other code picks it up
    sel.dispatchEvent(new Event("input",{bubbles:true}));
    sel.dispatchEvent(new Event("change",{bubbles:true}));
  }

  function injectStrategies(){
    const sel = document.querySelector("#strategy");
    if(!sel) return;

    // Remove any previously injected groups to avoid duplicates
    Array.from(sel.querySelectorAll('optgroup[label="Stock Options"], optgroup[label="Futures & Forex"]')).forEach(g=>g.remove());

    const g1 = document.createElement("optgroup");
    g1.label = "Stock Options";
    STOCK_OPTIONS.forEach(name=>{
      const o = document.createElement("option");
      o.value = name;
      o.textContent = name;
      g1.appendChild(o);
    });

    const g2 = document.createElement("optgroup");
    g2.label = "Futures & Forex";
    FUTURES_FOREX.forEach(name=>{
      const o = document.createElement("option");
      o.value = name;
      o.textContent = name;
      g2.appendChild(o);
    });

    sel.appendChild(g1);
    sel.appendChild(g2);

    // Auto-Analyze when a strategy is selected
    if(!sel.dataset.ttAuto){
      sel.dataset.ttAuto = "1";
      const triggerAnalyze = ()=>{
        // Try to click a visible "Analyze" button first
        const btn = Array.from(document.querySelectorAll('button,[role="button"],.btn,.button'))
          .find(b => /analy[sz]e/i.test((b.textContent||"").trim()));
        if(btn){ btn.click(); return; }
        // Fallback: send a message to service worker
        const symbol = (document.querySelector("#symbol")||{}).value || "";
        const timeframe = (document.querySelector("#timeframe")||{}).value || "";
1 min
5 min
15 min
30 min
1 hour
4 hours
Daily
Monthly
        
Covered Call
Cash-Secured Put (CSP)
Wheel
Long Call
Long Put
Debit Call Spread
Debit Put Spread
Credit Call Spread
Credit Put Spread
Iron Condor
Iron Butterfly
Broken Wing Butterfly
Collar
Protective Put
PMCC (LEAPS Covered Call)
Calendar
Diagonal
Straddle
Strangle
Short Straddle
Short Strangle
Box Spread
EMA Trend (9/50)
RSI Divergence
MACD Cross
Bollinger Bounce
Donchian/Turtle Breakout
Opening Range Breakout (ORB)
Support/Resistance
Ichimoku Trend
Pivot Bounce
Fibonacci Pullback
Momentum (ROC)
Mean Reversion
Range Scalping (M1/M5)
Swing (H4/D1)
Heikin-Ashi Trend
ADR Breakout
Keltner Breakout
Carry Trade (FX)
try
Covered Call
Cash-Secured Put (CSP)
Wheel
Long Call
Long Put
Debit Call Spread
Debit Put Spread
Credit Call Spread
Credit Put Spread
Iron Condor
Iron Butterfly
Broken Wing Butterfly
Collar
Protective Put
PMCC (LEAPS Covered Call)
Calendar
Diagonal
Straddle
Strangle
Short Straddle
Short Strangle
Box Spread
EMA Trend (9/50)
RSI Divergence
MACD Cross
Bollinger Bounce
Donchian/Turtle Breakout
Opening Range Breakout (ORB)
Support/Resistance
Ichimoku Trend
Pivot Bounce
Fibonacci Pullback
Momentum (ROC)
Mean Reversion
Range Scalping (M1/M5)
Swing (H4/D1)
Heikin-Ashi Trend
ADR Breakout
Keltner Breakout
Carry Trade (FX)
 
Covered Call
Cash-Secured Put (CSP)
Wheel
Long Call
Long Put
Debit Call Spread
Debit Put Spread
Credit Call Spread
Credit Put Spread
Iron Condor
Iron Butterfly
Broken Wing Butterfly
Collar
Protective Put
PMCC (LEAPS Covered Call)
Calendar
Diagonal
Straddle
Strangle
Short Straddle
Short Strangle
Box Spread
EMA Trend (9/50)
RSI Divergence
MACD Cross
Bollinger Bounce
Donchian/Turtle Breakout
Opening Range Breakout (ORB)
Support/Resistance
Ichimoku Trend
Pivot Bounce
Fibonacci Pullback
Momentum (ROC)
Mean Reversion
Range Scalping (M1/M5)
Swing (H4/D1)
Heikin-Ashi Trend
ADR Breakout
Keltner Breakout
Carry Trade (FX)
{
Covered Call
Cash-Secured Put (CSP)
Wheel
Long Call
Long Put
Debit Call Spread
Debit Put Spread
Credit Call Spread
Credit Put Spread
Iron Condor
Iron Butterfly
Broken Wing Butterfly
Collar
Protective Put
PMCC (LEAPS Covered Call)
Calendar
Diagonal
Straddle
Strangle
Short Straddle
Short Strangle
Box Spread
EMA Trend (9/50)
RSI Divergence
MACD Cross
Bollinger Bounce
Donchian/Turtle Breakout
Opening Range Breakout (ORB)
Support/Resistance
Ichimoku Trend
Pivot Bounce
Fibonacci Pullback
Momentum (ROC)
Mean Reversion
Range Scalping (M1/M5)
Swing (H4/D1)
Heikin-Ashi Trend
ADR Breakout
Keltner Breakout
Carry Trade (FX)
 chrome.runtime.sendMessage({ cmd:"TT_ANALYZE", symbol, timeframe, strategy: sel.value }); } catch(e){ /* no-op */ }
1 min
5 min
15 min
30 min
1 hour
4 hours
Daily
Monthly
1 min
5 min
15 min
30 min
1 hour
4 hours
Daily
Monthly
1 min
5 min
15 min
30 min
1 hour
4 hours
Daily
Monthly
      };
      sel.addEventListener("change", triggerAnalyze, {capture:true, passive:true});
      sel.addEventListener("input",  triggerAnalyze, {capture:true, passive:true});
    }
  }

  function applyAll(){
    try{ ensureTimeframes(); }catch(e){}
    try{ injectStrategies(); }catch(e){}
  }

  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", applyAll);
  }else{
    applyAll();
  }
  // Re-apply shortly after to catch any late renders
  setTimeout(applyAll, 250);
  // And watch for re-renders
  const mo = new MutationObserver(()=>setTimeout(applyAll, 0));
  mo.observe(document.documentElement, {childList:true, subtree:true});
})();
