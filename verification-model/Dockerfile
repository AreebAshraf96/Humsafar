FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl tesseract-ocr tesseract-ocr-eng tesseract-ocr-urd \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./requirements.txt
RUN pip install -r requirements.txt

RUN mkdir -p models \
    && curl -fsSL https://github.com/opencv/opencv_zoo/raw/refs/heads/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx \
       -o models/face_detection_yunet_2023mar.onnx \
    && curl -fsSL https://github.com/opencv/opencv_zoo/raw/refs/heads/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx \
       -o models/face_recognition_sface_2021dec.onnx \
    && test "$(wc -c < models/face_detection_yunet_2023mar.onnx)" -gt 10000 \
    && test "$(wc -c < models/face_recognition_sface_2021dec.onnx)" -gt 1000000

COPY app.py ./app.py
RUN useradd --create-home --uid 10001 service && chown -R service:service /app
USER service

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
