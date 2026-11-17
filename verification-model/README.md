# Humsafar private driver verification service

This service provides the `/verify` endpoint used by the Humsafar app. It performs 1:1 face comparison on the server that you operate and sends images to no model API. It does not retain face embeddings after processing. The multipart framework may temporarily spool larger incoming uploads while handling a request; it does not store them as application records. It does not check liveness, prove that a licence is genuine, or guarantee identity.

## What it checks

- OpenCV YuNet checks image orientations and detects at a normalized image size to better handle close-up selfies and small printed licence portraits; OpenCV SFace aligns and compares exactly one face from each image. Extra or missing faces are sent for manual review. The returned score is cosine similarity (`-1` to `1`), not a percentage. A review band around the matching threshold reduces automatic decisions near the threshold.
- The face comparison is advisory. Every application stays pending until an administrator checks the licence expiry and details and makes a decision.

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
DRIVER_VERIFICATION_FACE_MIN_SCORE=0.383
```

Restart `npm run dev` after changing `.env.local`. Keep both services running during local verification.

## Deploy with a Vercel-hosted Humsafar app

Do not put `localhost` or `127.0.0.1` in Vercel settings. Those addresses refer to the Vercel function machine, not your PC. Deploy this Docker service to a private server you control, put it behind HTTPS, restrict inbound access where practical, and use a long random bearer key. Then add the service's `https://.../verify` URL and the identical key in Vercel Project Settings → Environment Variables for the environments that need verification. Keep the model URL and model key server-side (no `NEXT_PUBLIC_` prefix), redeploy, and confirm the server logs show no image contents.

Use a private network connection between Vercel and the model server where your hosting setup supports it. Do not expose the unauthenticated service directly to the public internet. Keep `/health` free of secrets or personal data.

## Model files and licenses

The Docker build downloads YuNet and SFace ONNX files from the official OpenCV Zoo. YuNet files in that model directory use MIT; SFace files use Apache 2.0. Preserve the model licenses if redistributing the image. [YuNet model directory](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) · [SFace model directory](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface).

The OpenCV sample cosine threshold is a starting reference and is not validated for Sindh licence portraits and user selfies. Keep `DRIVER_VERIFICATION_FACE_MIN_SCORE` at or above the service threshold plus review margin and have an administrator review every application.
