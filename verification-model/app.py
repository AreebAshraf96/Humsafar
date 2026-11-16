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
from PIL import Image, ImageOps, UnidentifiedImageError
from pytesseract import Output

ROOT = Path(__file__).resolve().parent
MODEL_DIR = ROOT / "models"
YUNET_PATH = MODEL_DIR / "face_detection_yunet_2023mar.onnx"
SFACE_PATH = MODEL_DIR / "face_recognition_sface_2021dec.onnx"
MAX_IMAGE_BYTES = 5 * 1024 * 1024
FACE_DETECTION_MAX_SIDE = 960
FACE_DETECTION_SCORE = 0.70
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
    face_detector = cv2.FaceDetectorYN.create(str(YUNET_PATH), "", (320, 320), FACE_DETECTION_SCORE, 0.3, 5000)
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
            image = ImageOps.exif_transpose(image)
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
    saw_multiple_faces = False
    for rotation in (None, cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_180, cv2.ROTATE_90_COUNTERCLOCKWISE):
        oriented = image if rotation is None else cv2.rotate(image, rotation)
        height, width = oriented.shape[:2]
        scale = min(1.0, FACE_DETECTION_MAX_SIDE / max(height, width))
        if scale < 1.0:
            detect_width = max(1, int(round(width * scale)))
            detect_height = max(1, int(round(height * scale)))
            detection_image = cv2.resize(oriented, (detect_width, detect_height), interpolation=cv2.INTER_AREA)
        else:
            detection_image = oriented
            detect_width, detect_height = width, height

        face_detector.setInputSize((detect_width, detect_height))
        _, faces = face_detector.detect(detection_image)
        if faces is None or len(faces) == 0:
            continue
        if len(faces) > 1:
            saw_multiple_faces = True
            continue

        # Detect at a normalized size so very large selfies and tiny printed
        # licence portraits both fall within YuNet's useful face-size range,
        # then map the box and landmarks back for SFace alignment.
        face = faces[0].copy()
        scale_x = width / detect_width
        scale_y = height / detect_height
        face[0] *= scale_x
        face[1] *= scale_y
        face[2] *= scale_x
        face[3] *= scale_y
        for point in range(4, 14, 2):
            face[point] *= scale_x
            face[point + 1] *= scale_y
        try:
            aligned = face_recognizer.alignCrop(oriented, face)
            feature = face_recognizer.feature(aligned)
            if feature is not None and np.isfinite(feature).all():
                return feature, None
        except cv2.error:
            continue

    return None, "multiple_faces" if saw_multiple_faces else "no_face"


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


MONTH_PATTERN = r"jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?"
DATE_PATTERN = re.compile(
    rf"(?<!\d)(?:(?P<day>\d{{1,2}})[./\s-]+(?P<month>\d{{1,2}}|{MONTH_PATTERN})[./,\s-]+(?P<year>\d{{4}})|"
    rf"(?P<iso_year>\d{{4}})[./-](?P<iso_month>\d{{1,2}}|{MONTH_PATTERN})[./-](?P<iso_day>\d{{1,2}}))(?!\d)",
    re.I,
)
EXPIRY_LABEL = re.compile(r"expiry|expires|exp\.?|valid\s*(?:until|till|upto)|\bvalidity\b|تاریخ\s*(?:میعاد|اختتام)|میعاد|اختتام", re.I)


def parse_date(match: re.Match[str]) -> date | None:
    try:
        if match.group("iso_year"):
            year = int(match.group("iso_year"))
            month_text = match.group("iso_month")
            day = int(match.group("iso_day"))
        else:
            day = int(match.group("day"))
            month_text = match.group("month")
            year = int(match.group("year"))
        month_names = {
            "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
            "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
        }
        month = int(month_text) if month_text.isdigit() else month_names[month_text[:3].lower()]
        return date(year, month, day)
    except (TypeError, ValueError):
        return None


def read_expiry(image: np.ndarray) -> tuple[str | None, float | None]:
    # Keep OCR text and confidence values in request memory only; neither is returned or logged.
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    enlarged = cv2.resize(gray, None, fx=1.7, fy=1.7, interpolation=cv2.INTER_CUBIC)
    data = pytesseract.image_to_data(enlarged, lang="eng+urd", config="--psm 6", output_type=Output.DICT)
    lines: dict[tuple[int, int, int, int], list[dict[str, object]]] = {}
    for index, raw_token in enumerate(data["text"]):
        token = raw_token.strip()
        if not token:
            continue
        line_key = tuple(int(data[key][index]) for key in ("page_num", "block_num", "par_num", "line_num"))
        lines.setdefault(line_key, []).append({
            "text": token,
            "confidence": float(data["conf"][index]),
            "left": int(data["left"][index]),
            "top": int(data["top"][index]),
            "width": int(data["width"][index]),
            "height": int(data["height"][index]),
        })

    def geometry(start: int, end: int, segments: list[tuple[int, int, dict[str, object]]]) -> dict[str, float] | None:
        words = [word for word_start, word_end, word in segments if word_start < end and word_end > start]
        if not words:
            return None
        left = min(int(word["left"]) for word in words)
        top = min(int(word["top"]) for word in words)
        right = max(int(word["left"]) + int(word["width"]) for word in words)
        bottom = max(int(word["top"]) + int(word["height"]) for word in words)
        confidence = min(float(word["confidence"]) for word in words if float(word["confidence"]) >= 0) if any(
            float(word["confidence"]) >= 0 for word in words
        ) else -1.0
        return {
            "x": (left + right) / 2, "y": (top + bottom) / 2,
            "width": right - left, "height": bottom - top, "confidence": confidence,
        }

    date_candidates: list[tuple[date, dict[str, float]]] = []
    expiry_labels: list[dict[str, float]] = []
    for words in lines.values():
        line_text = ""
        segments: list[tuple[int, int, dict[str, object]]] = []
        for word in words:
            if line_text:
                line_text += " "
            start = len(line_text)
            line_text += str(word["text"])
            segments.append((start, len(line_text), word))

        for match in DATE_PATTERN.finditer(line_text):
            parsed = parse_date(match)
            box = geometry(match.start(), match.end(), segments)
            if parsed and box and box["confidence"] >= 0:
                date_candidates.append((parsed, box))
        for match in EXPIRY_LABEL.finditer(line_text):
            box = geometry(match.start(), match.end(), segments)
            if box:
                expiry_labels.append(box)

    if not date_candidates or not expiry_labels:
        return None, None

    # Pair the expiry label with the closest date in image coordinates. This
    # keeps a nearby issue date from being mistaken for (or making ambiguous)
    # the separate Valid Upto date on Sindh licence layouts.
    paired: list[tuple[date, dict[str, float], float]] = []
    max_dx = max(enlarged.shape[1] * 0.08, 180)
    max_dy = max(enlarged.shape[0] * 0.12, 180)
    for parsed, date_box in date_candidates:
        nearby_labels = []
        for label_box in expiry_labels:
            dx = abs(date_box["x"] - label_box["x"])
            dy = date_box["y"] - label_box["y"]
            if dx <= max_dx and -max(date_box["height"], label_box["height"]) <= dy <= max_dy:
                distance = dx / max_dx + max(0.0, dy) / max_dy
                nearby_labels.append(distance)
        if nearby_labels:
            paired.append((parsed, date_box, min(nearby_labels)))

    if not paired:
        return None, None
    paired.sort(key=lambda item: item[2])
    if len(paired) > 1 and abs(paired[0][2] - paired[1][2]) < 0.15:
        return None, None
    parsed, box, _ = paired[0]
    # Tesseract's engine confidence is a heuristic, not a probability of legal validity.
    confidence = box["confidence"] / 100.0
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
