FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .
ENV YOLO_MODEL=yolov8n.pt
ENV API_KEY=
ENV POLY_KEY=jd8IhUkgfcFUNpIQgAyy4VB9CVgjZVUp
ENV CONF=0.25
ENV IOU=0.45
EXPOSE 8000
CMD ["uvicorn","server:app","--host","0.0.0.0","--port","8000","--workers","1"]
