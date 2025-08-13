const r = await fetch(`${apiBase.value.replace(/\/$/,'')}/api/analyze`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-TT-Owner": "1"          // <<< Owner bypass header
  },
  body: JSON.stringify({
    image: dataUrl,
    options: {
      symbol: symbol.value,
      timeframe: timeframe.value,
      tradeType: tradeType.value,
      strategy: strategy.value,
      style: style.value,
      owner: true              // <<< Owner bypass flag in body
    }
  })
});
