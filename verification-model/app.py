from __future__ import annotations

import hmac
import io
import os
import re
from datetime import date
from pathlib import Path

import cv2
import numpy as np
import pytesseract
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError
from pytesseract import Output

ROOT = Path(__file__).resolve().parent
MODEL_DIR = ROOT / "models"
YUNET_PATH = MODEL_DIR / "face_detection_yunet_2023mar.onnx"
SFACE_PATH = MODEL_DIR / "face_recognition_sface_2021dec.onnx"
MAX_IMAGE_BYTES = 5 * 1024 * 1024
FACE_MATCH_THRESHOLD = float(os.getenv("MODEL_FACE_MATCH_THRESHOLD", "0.363"))
FACE_REVIEW_MARGIN = float(os.getenv("MODEL_FACE_REVIEW_MARGIN", "0.02"))
MODEL_KEY = os.getenv("DRIVER_VERIFICATION_MODEL_KEY", "")

app = FastAPI(title="Humsafar private driver verification", docs_url=None, redoc_url=None)
face_detector = None
face_recognizer = None


@app.on_event("startup")
def load_models() -> None:
    global face_detector, face_recognizer
    if not MODEL_KEY:
        raise RuntimeError("DRIVER_VERIFICATION_MODEL_KEY must be set")
    if not YUNET_PATH.is_file() or not SFACE_PATH.is_file():
        raise RuntimeError("Face model files are missing; see verification-model/README.md")
    face_detector = cv2.FaceDetectorYN.create(str(YUNET_PATH), "", (320, 320), 0.8, 0.3, 5000)
    face_recognizer = cv2.FaceRecognizerSF.create(str(SFACE_PATH), "")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok" if face_detector is not None and face_recognizer is not None else "starting"}


async def read_image(upload: UploadFile) -> np.ndarray:
    if upload.content_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(status_code=415, detail="Upload a JPEG, PNG, or WebP image")
    raw = await upload.read(MAX_IMAGE_BYTES + 1)
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Each image must be 5 MB or smaller")
    try:
        with Image.open(io.BytesIO(raw)) as image:
            image = image.convert("RGB")
            if image.width > 6000 or image.height > 6000:
                raise HTTPException(status_code=413, detail="Image dimensions are too large")
            return cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)
    except (UnidentifiedImageError, OSError, ValueError):
        raise HTTPException(status_code=400, detail="Could not read the uploaded image") from None
    finally:
        raw = b""


def detect_face(image: np.ndarray) -> tuple[np.ndarray | None, str | None]:
    assert face_detector is not None and face_recognizer is not None
    height, width = image.shape[:2]
    face_detector.setInputSize((width, height))
    _, faces = face_detector.detect(image)
    if faces is None or len(faces) == 0:
        return None, "no_face"
    if len(faces) > 1:
        return None, "multiple_faces"
    aligned = face_recognizer.alignCrop(image, faces[0])
    return face_recognizer.feature(aligned), None


def face_check(licence: np.ndarray, selfie: np.ndarray) -> tuple[str, float | None]:
    licence_feature, licence_error = detect_face(licence)
    selfie_feature, selfie_error = detect_face(selfie)
    if licence_error:
        return licence_error, None
    if selfie_error:
        return selfie_error, None
    assert face_recognizer is not None and licence_feature is not None and selfie_feature is not None
    similarity = float(face_recognizer.match(licence_feature, selfie_feature, cv2.FaceRecognizerSF_FR_COSINE))
    if not np.isfinite(similarity):
        return "uncertain", None
    if similarity >= FACE_MATCH_THRESHOLD + FACE_REVIEW_MARGIN:
        return "match", round(similarity, 6)
    if similarity < FACE_MATCH_THRESHOLD - FACE_REVIEW_MARGIN:
        return "no_match", round(similarity, 6)
    return "uncertain", round(similarity, 6)


DATE_PATTERN = re.compile(r"(?<!\d)(\d{1,2})[./-](\d{1,2})[./-](\d{4})|(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?!\d)")
EXPIRY_LABEL = re.compile(r"expiry|expires|exp\.?|valid\s*(?:until|till|upto)|\bvalidity\b|تاریخ\s*(?:میعاد|اختتام)|میعاد|اختتام", re.I)


def parse_date(match: re.Match[str]) -> date | None:
    try:
        if match.group(1):
            return date(int(match.group(3)), int(match.group(2)), int(match.group(1)))
        return date(int(match.group(4)), int(match.group(5)), int(match.group(6)))
    except (TypeError, ValueError):
        return None


def read_expiry(image: np.ndarray) -> tuple[str | None, float | None]:
    # Keep OCR text and confidence values in request memory only; neither is returned or logged.
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    enlarged = cv2.resize(gray, None, fx=1.7, fy=1.7, interpolation=cv2.INTER_CUBIC)
    data = pytesseract.image_to_data(enlarged, lang="eng+urd", config="--psm 6", output_type=Output.DICT)
    tokens = [token.strip() for token in data["text"]]
    text = " ".join(token for token in tokens if token)
    matches = list(DATE_PATTERN.finditer(text))
    if not matches:
        return None, None
    # Only accept a date near an expiry/valid-until label; do not mistake issue date or DOB for expiry.
    labelled = []
    for match in matches:
        parsed = parse_date(match)
        if not parsed:
            continue
        left = max(0, match.start() - 45)
        right = min(len(text), match.end() + 45)
        if EXPIRY_LABEL.search(text[left:right]):
            labelled.append((match, parsed))
    if len(labelled) != 1:
        return None, None
    match, parsed = labelled[0]
    date_tokens = []
    offset = 0
    for token, confidence in zip(data["text"], data["conf"]):
        if not token.strip():
            continue
        start = text.find(token.strip(), offset)
        if start < 0:
            start = offset
        end = start + len(token.strip())
        offset = end + 1
        try:
            value = float(confidence)
        except (TypeError, ValueError):
            continue
        if value >= 0 and start < match.end() and end > match.start():
            date_tokens.append(value)
    if not date_tokens:
        return None, None
    # Tesseract's engine confidence is a heuristic, not a probability of legal validity.
    confidence = min(date_tokens) / 100.0
    return parsed.isoformat(), round(max(0.0, min(confidence, 1.0)), 4)


@app.post("/verify")
async def verify(
    licence: UploadFile = File(...),
    selfie: UploadFile = File(...),
    countryCode: str = Form("PK"),
    region: str = Form("Sindh"),
    authorization: str | None = Header(default=None),
) -> dict[str, object]:
    expected = f"Bearer {MODEL_KEY}"
    if not MODEL_KEY or not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")
    if countryCode != "PK" or region.lower() != "sindh":
        raise HTTPException(status_code=400, detail="Only Pakistan/Sindh licence checks are configured")

    licence_image = await read_image(licence)
    selfie_image = await read_image(selfie)
    try:
        expiry, expiry_confidence = read_expiry(licence_image)
        face_status, face_score = face_check(licence_image, selfie_image)
        return {
            "licenceExpiryDate": expiry,
            "expiryConfidence": expiry_confidence,
            "faceMatchStatus": face_status,
            "faceMatchScore": face_score,
        }
    except pytesseract.TesseractNotFoundError:
        raise HTTPException(status_code=503, detail="OCR engine is not installed") from None
    finally:
        # Drop references promptly; do not write images, OCR text, or face embeddings to disk.
        del licence_image, selfie_image
