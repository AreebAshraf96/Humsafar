import importlib.util
import sys
import io
from pathlib import Path
import asyncio

import cv2
import httpx
import numpy as np
from PIL import Image
import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
spec = importlib.util.spec_from_file_location("verification_service", ROOT / "app.py")
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)
KEY = "local-test-key-not-a-real-secret"
FIXTURES = ROOT.parent / "work/verification-fixtures"

def image_bytes(size=(100, 100), format="PNG"):
    data = io.BytesIO()
    Image.new("RGB", size, "white").save(data, format=format)
    return data.getvalue()

@pytest.fixture(scope="module")
def client():
    service.MODEL_KEY = KEY
    with TestClient(service.app) as client:
        yield client

def verify(client, licence=None, selfie=None, mime="image/png", key=KEY, **form):
    licence = image_bytes() if licence is None else licence
    selfie = image_bytes() if selfie is None else selfie
    return client.post("/verify", headers={"Authorization": "Bearer " + key}, files={"licence": ("licence.png", licence, mime), "selfie": ("selfie.png", selfie, mime)}, data=form)

def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}

@pytest.mark.parametrize("format,mime", [("PNG", "image/png"), ("JPEG", "image/jpeg"), ("WEBP", "image/webp")])
def test_supported_blank_images(client, format, mime):
    response = verify(client, image_bytes(format=format), image_bytes(format=format), mime=mime)
    assert response.status_code == 200
    assert response.json()["faceMatchStatus"] == "no_face"
    assert response.json()["faceMatchScore"] is None
    assert "documentChecks" in response.json()

@pytest.mark.parametrize("key", ["", "wrong-key", "wrong-key-with-nonascii-\u00e9"])
def test_wrong_key(client, key):
    # HTTP clients reject non-ASCII header strings; encoded bytes exercise the server path.
    files={"licence": ("a.png", image_bytes(), "image/png"), "selfie": ("b.png", image_bytes(), "image/png")}
    response=client.post("/verify", headers={b"authorization": ("Bearer "+key).encode()}, files=files)
    assert response.status_code == 401

def test_missing_auth(client):
    response=client.post("/verify", files={"licence": ("a.png", image_bytes(), "image/png"), "selfie": ("b.png", image_bytes(), "image/png")})
    assert response.status_code == 401

def test_missing_file(client):
    assert client.post("/verify", headers={"Authorization": "Bearer "+KEY}).status_code == 422

@pytest.mark.parametrize("form", [{"countryCode": "US"}, {"region": "Punjab"}])
def test_wrong_region(client, form):
    assert verify(client, **form).status_code == 400

@pytest.mark.parametrize("data,mime,status", [(b"not-an-image", "image/png", 400), (b"", "image/png", 413), (b"garbage", "application/pdf", 415), (b"x"*(5*1024*1024+1), "image/png", 413)])
def test_invalid_uploads(client, data, mime, status):
    assert verify(client, licence=data, mime=mime).status_code == status

def test_large_dimensions_rejected_before_convert(client):
    assert verify(client, licence=image_bytes((6001, 1))).status_code == 413

def test_same_face(client):
    face=(FIXTURES/"lena.jpg").read_bytes()
    response=verify(client, face, face, mime="image/jpeg")
    assert response.status_code == 200
    assert response.json()["faceMatchStatus"] == "match"
    assert response.json()["faceMatchScore"] > 0.99

@pytest.mark.parametrize("rotation", [90, 180, 270])
def test_rotated_selfie(client, rotation):
    face=(FIXTURES/"lena.jpg").read_bytes()
    with Image.open(io.BytesIO(face)) as image:
        rotated=io.BytesIO(); image.rotate(rotation, expand=True).save(rotated, format="JPEG")
    output=verify(client, face, rotated.getvalue(), mime="image/jpeg").json()
    assert output["faceMatchStatus"] == "match", output

def test_different_faces(client):
    output=verify(client,(FIXTURES/"lena.jpg").read_bytes(),(FIXTURES/"messi5.jpg").read_bytes(),mime="image/jpeg").json()
    assert output["faceMatchStatus"] == "no_match", output

def test_multiple_faces(client):
    face=Image.open(FIXTURES/"lena.jpg").convert("RGB")
    pair=Image.new("RGB",(1024,512)); pair.paste(face,(0,0));pair.paste(face,(512,0))
    raw=io.BytesIO();pair.save(raw,format="JPEG")
    output=verify(client,raw.getvalue(),(FIXTURES/"lena.jpg").read_bytes(),mime="image/jpeg").json()
    assert output["faceMatchStatus"] == "multiple_faces", output

def test_small_printed_portrait(client):
    face=Image.open(FIXTURES/"lena.jpg").convert("RGB").resize((180,180))
    card=Image.new("RGB",(900,550),"white");card.paste(face,(45,100))
    raw=io.BytesIO();card.save(raw,format="JPEG")
    output=verify(client,raw.getvalue(),(FIXTURES/"lena.jpg").read_bytes(),mime="image/jpeg").json()
    assert output["faceMatchStatus"] == "match", output

def test_concurrent_requests_do_not_mix_results(client):
    async def check():
        transport=httpx.ASGITransport(app=service.app)
        async with httpx.AsyncClient(transport=transport,base_url="http://test") as http:
            face=(FIXTURES/"lena.jpg").read_bytes()
            async def one(data):
                return await http.post("/verify",headers={"Authorization":"Bearer "+KEY},files={"licence":("a.jpg",face,"image/jpeg"),"selfie":("b.jpg",data,"image/jpeg")})
            responses=await asyncio.gather(one(face),one((FIXTURES/"messi5.jpg").read_bytes()),http.get("/health"))
            assert [r.status_code for r in responses] == [200,200,200]
            assert responses[0].json()["faceMatchStatus"] == "match"
            assert responses[1].json()["faceMatchStatus"] == "no_match"
    asyncio.run(check())

def test_missing_key_prevents_startup(monkeypatch):
    monkeypatch.setattr(service,"MODEL_KEY","")
    with pytest.raises(RuntimeError,match="must be set"): service.load_models()

def test_missing_models_prevents_startup(monkeypatch,tmp_path):
    monkeypatch.setattr(service,"YUNET_PATH",tmp_path/"missing.onnx")
    with pytest.raises(RuntimeError,match="missing"): service.load_models()

def test_invalid_threshold_prevents_startup(monkeypatch):
    monkeypatch.setattr(service,"FACE_MATCH_THRESHOLD",float("nan"))
    with pytest.raises(RuntimeError,match="thresholds"): service.load_models()

def test_opencv_failure_is_service_error(client,monkeypatch):
    def fail(*args): raise cv2.error("inference failure")
    monkeypatch.setattr(service,"face_check",fail)
    assert verify(client).status_code == 503
