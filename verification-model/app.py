from __future__ import annotations

import hmac
import io
import os
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError

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
        face_status, face_score = face_check(licence_image, selfie_image)
        return {
            "faceMatchStatus": face_status,
            "faceMatchScore": face_score,
        }
    finally:
        # Drop references promptly; do not write images or face embeddings to disk.
        del licence_image, selfie_image
