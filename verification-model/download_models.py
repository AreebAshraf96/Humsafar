"""Download official test/model assets; verify model content before using it."""
from __future__ import annotations
import argparse
import hashlib
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parent
ASSETS = [
    (ROOT / "models/face_detection_yunet_2023mar.onnx", "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx", "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"),
    (ROOT / "models/face_recognition_sface_2021dec.onnx", "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx", "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79"),
]
FIXTURES = [
    (ROOT.parent / "work/verification-fixtures/lena.jpg", "https://raw.githubusercontent.com/opencv/opencv/master/samples/data/lena.jpg", "7de7ed51a1594fff247f4cae2301eceacf5313d6011e37b4a4c8733f7bb72c07"),
    (ROOT.parent / "work/verification-fixtures/messi5.jpg", "https://raw.githubusercontent.com/opencv/opencv/master/samples/data/messi5.jpg", "1d570e49654e84c7a943918537bd9e5e1ef82920152e147c834006e235be97c9"),
]

def download(path: Path, url: str, digest: str) -> None:
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == digest:
        print(f"Verified {path.name}", flush=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "Humsafar-local-model-setup"})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read(50 * 1024 * 1024 + 1)
    if hashlib.sha256(data).hexdigest() != digest:
        raise RuntimeError(f"Checksum mismatch for {path.name}; no model was installed")
    path.write_bytes(data)
    print(f"Installed {path.name}", flush=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--test-fixtures", action="store_true")
    args = parser.parse_args()
    for asset in ASSETS + (FIXTURES if args.test_fixtures else []):
        download(*asset)

    if args.test_fixtures:
        from PIL import Image, ImageDraw
        card = Image.new("RGB", (900, 550), "white")
        with Image.open(ROOT.parent / "work/verification-fixtures/lena.jpg") as portrait:
            card.paste(portrait.convert("RGB").resize((180, 180)), (45, 100))
        drawing = ImageDraw.Draw(card)
        drawing.text((280, 100), "AUTOMATED TEST IMAGE", fill="black")
        drawing.text((280, 150), "NOT A DRIVING LICENCE", fill="black")
        card.save(ROOT.parent / "work/verification-fixtures/test-card.png")
        print("Prepared labelled synthetic test card", flush=True)
