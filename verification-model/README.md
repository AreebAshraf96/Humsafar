# Humsafar private driver verification service

This service provides the `/verify` endpoint used by the Humsafar app. It runs OCR and 1:1 face comparison on the server that you operate and sends images to no model API. It does not retain OCR text or face embeddings after processing. The multipart framework may temporarily spool larger incoming uploads while handling a request; it does not store them as application records. It does not check liveness, prove that a licence is genuine, or guarantee identity.

## What it checks

- Tesseract OCR looks for a numeric or English month-name date near English or Urdu expiry labels on a Pakistan/Sindh licence. It returns no date when the result is ambiguous. Its confidence is an OCR engine score, not a probability.
- OpenCV YuNet checks image orientations and detects at a normalized image size to better handle close-up selfies and small printed licence portraits; OpenCV SFace aligns and compares exactly one face from each image. Extra or missing faces are sent for manual review. The returned score is cosine similarity (`-1` to `1`), not a percentage. A review band around the matching threshold reduces automatic decisions near the threshold.
- All uncertain cases remain pending for an administrator. The app should be calibrated with representative licence images before enabling automatic approval in production.

## Run on Windows for local development

From the Humsafar project folder, in PowerShell:

```powershell
cd verification-model
docker build --no-cache -t humsafar-verification .
$env:DRIVER_VERIFICATION_MODEL_KEY = "paste-a-long-random-secret-here"
docker run --rm -p 8000:8000 -e DRIVER_VERIFICATION_MODEL_KEY=$env:DRIVER_VERIFICATION_MODEL_KEY humsafar-verification
```

Docker Desktop must be installed and running. In a second PowerShell window, check the health route:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
```

It should return `status: ok`. Set the same secret in the Humsafar `.env.local`:

```dotenv
DRIVER_VERIFICATION_MODEL_URL=http://127.0.0.1:8000/verify
DRIVER_VERIFICATION_MODEL_KEY=the-same-long-random-secret
DRIVER_VERIFICATION_OCR_MIN_CONFIDENCE=0.90
DRIVER_VERIFICATION_FACE_MIN_SCORE=0.383
```

Restart `npm run dev` after changing `.env.local`. Keep both services running during local verification.

## Deploy with a Vercel-hosted Humsafar app

Do not put `localhost` or `127.0.0.1` in Vercel settings. Those addresses refer to the Vercel function machine, not your PC. Deploy this Docker service to a private server you control, put it behind HTTPS, restrict inbound access where practical, and use a long random bearer key. Then add the service's `https://.../verify` URL and the identical key in Vercel Project Settings → Environment Variables for the environments that need verification. Keep all three verification variables server-side (no `NEXT_PUBLIC_` prefix), redeploy, and confirm the server logs show no image contents or OCR text.

Use a private network connection between Vercel and the model server where your hosting setup supports it. Do not expose the unauthenticated service directly to the public internet. Keep `/health` free of secrets or personal data.

## Model files and licenses

The Docker build downloads YuNet and SFace ONNX files from the official OpenCV Zoo. YuNet files in that model directory use MIT; SFace files use Apache 2.0. Preserve the model licenses if redistributing the image. [YuNet model directory](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) · [SFace model directory](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface).

The OpenCV sample cosine threshold is a starting reference and is not validated for Sindh licence portraits and user selfies. Keep `DRIVER_VERIFICATION_FACE_MIN_SCORE` at or above the service threshold plus review margin, run a consented representative pilot, and have an administrator review all ambiguous cases before using auto-approval.
