import base64, io, os, time, requests
from typing import List, Optional, Tuple
from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image
from ultralytics import YOLO
from datetime import datetime, timedelta, timezone

MODEL_PATH = os.getenv("YOLO_MODEL", "yolov8n.pt")
API_KEY    = os.getenv("API_KEY", "")  # optional bearer
POLY_KEY   = os.getenv("POLY_KEY", "jd8IhUkgfcFUNpIQgAyy4VB9CVgjZVUp")
CONF       = float(os.getenv("CONF", "0.25"))
IOU        = float(os.getenv("IOU", "0.45"))
POLY_BASE  = "https://api.polygon.io"

model = YOLO(MODEL_PATH)

app = FastAPI(title="TrueTrend YOLO+Polygon", version="2.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

class InferRequest(BaseModel):
    image: str              # data URL (base64)
    return_plan: bool = True
    symbol: Optional[str] = None
    timeframe: Optional[str] = "5min"

class Detection(BaseModel):
    label: str
    conf: float
    xyxy: Tuple[float,float,float,float]

class Plan(BaseModel):
    direction: str
    entry: float
    stopLoss: float
    takeProfit: float
    takeProfit2: Optional[float] = None
    trailingStop: Optional[float] = None

class InferResponse(BaseModel):
    ok: bool
    duration_ms: int
    plan: Optional[Plan] = None
    detections: Optional[list] = None
    note: Optional[str] = None

def _auth(auth_header: Optional[str]):
    if not API_KEY: return
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer")
    if auth_header.split(" ",1)[1].strip() != API_KEY:
        raise HTTPException(status_code=403, detail="Invalid token")

def _data_url_to_pil(data_url: str) -> Image.Image:
    b64 = data_url.split(",",1)[1]
    return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")

def _span(tf: str):
    tf=(tf or "").lower()
    if tf in ("1min","1m","1"): return ("1","minute")
    if tf in ("5min","5m","5"): return ("5","minute")
    if tf in ("15min","15m","15"): return ("15","minute")
    if tf in ("60min","60m","1h"): return ("60","minute")
    return ("1","day")

def _series(symbol: str, timeframe: str, days=7):
    if not POLY_KEY: raise RuntimeError("POLY_KEY not set")
    mult, span = _span(timeframe)
    now = datetime.now(timezone.utc)
    start = (now - timedelta(days=days)).date().isoformat()
    end   = now.date().isoformat()
    url = f"{POLY_BASE}/v2/aggs/ticker/{symbol}/range/{mult}/{span}/{start}/{end}?adjusted=true&sort=asc&limit=50000&apiKey={POLY_KEY}"
    r = requests.get(url, timeout=15); r.raise_for_status()
    j = r.json()
    if not j.get("results"):
        raise RuntimeError(f"polygon empty for {symbol}")
    return [{"t":row["t"]//1000,"o":row["o"],"h":row["h"],"l":row["l"],"c":row["c"]} for row in j["results"]]

def _atr(series, n=14):
    if len(series)<2: return 0.0
    trs=[]
    for i in range(1,len(series)):
        a,b=series[i],series[i-1]
        trs.append(max(a["h"]-a["l"], abs(a["h"]-b["c"]), abs(a["l"]-b["c"])))
    n=min(n,len(trs))
    return sum(trs[-n:])/max(1,n)

def _dets(results):
    out=[]; names=results.names
    for r in results:
        if r.boxes is None: continue
        for b in r.boxes:
            x1,y1,x2,y2 = map(float, b.xyxy[0].tolist())
            conf=float(b.conf[0].item()) if hasattr(b,"conf") else 0.0
            cls=int(b.cls[0].item()) if hasattr(b,"cls") else -1
            out.append({"label": names.get(cls,str(cls)), "conf": conf, "xyxy": [x1,y1,x2,y2]})
    return out

def _direction(dets: list) -> str:
    up = sum(d["conf"] for d in dets if d["label"] in {"arrow_up","buy","bull_signal","candle_green"})
    dn = sum(d["conf"] for d in dets if d["label"] in {"arrow_down","sell","bear_signal","candle_red"})
    if up>dn*1.2: return "BUY"
    if dn>up*1.2: return "SELL"
    return "BUY" if up>=dn else "SELL"

def _plan(symbol: str, timeframe: str, direction: str) -> Plan:
    s=_series(symbol, timeframe); last=s[-1]; A=_atr(s,14) or max(0.01, s[-1]["c"]*0.004)
    entry=float(last["c"]); kS=1.5; k1=1.8; k2=3.0; kT=0.8
    stop = entry-kS*A if direction=="BUY" else entry+kS*A
    tp1  = entry+k1*A if direction=="BUY" else entry-k1*A
    tp2  = entry+k2*A if direction=="BUY" else entry-k2*A
    trail= entry+kT*A if direction=="BUY" else entry-kT*A
    return Plan(direction=direction, entry=entry, stopLoss=stop, takeProfit=tp1, takeProfit2=tp2, trailingStop=trail)

@app.get("/health")
def health(): return {"ok":True,"model":MODEL_PATH}

@app.post("/infer", response_model=InferResponse)
def infer(payload: InferRequest, authorization: Optional[str]=Header(None)):
    _auth(authorization); t0=time.time()
    try: img=_data_url_to_pil(payload.image)
    except Exception as e: raise HTTPException(status_code=400, detail=f"Bad image: {e}")
    results=model.predict(img, conf=CONF, iou=IOU, verbose=False)
    dets=_dets(results)
    if not payload.return_plan:
        return {"ok":True,"duration_ms":int((time.time()-t0)*1000),"detections":dets}
    direction=_direction(dets)
    try:
        plan=_plan(payload.symbol, payload.timeframe or "5min", direction) if payload.symbol else None
    except Exception:
        plan=None
    if not plan:
        # graceful fallback (no symbol or polygon failure)
        entry=100.0; risk=0.5; kS=1.5; k1=1.8; k2=3.0; kT=0.8
        plan=Plan(direction=direction, entry=entry,
                  stopLoss=entry-kS*risk if direction=="BUY" else entry+kS*risk,
                  takeProfit=entry+k1*risk if direction=="BUY" else entry-k1*risk,
                  takeProfit2=entry+k2*risk if direction=="BUY" else entry-k2*risk,
                  trailingStop=entry+kT*risk if direction=="BUY" else entry-kT*risk)
    return {"ok":True,"duration_ms":int((time.time()-t0)*1000),"plan":plan, "detections":dets}
