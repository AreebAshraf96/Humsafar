# Self-hosted driver verification model contract

Humsafar calls the model from the server after the driver uploads both images. The URL and shared key are server-only settings. The model must be hosted and operated by Humsafar; it must not forward either image to another service. The model only compares faces; it does not extract licence text or check expiry.

## Request

Humsafar sends one `multipart/form-data` POST to `DRIVER_VERIFICATION_MODEL_URL` with:

- `Authorization: Bearer <DRIVER_VERIFICATION_MODEL_KEY>`
- `countryCode`: `PK`
- `region`: `Sindh`
- `licence`: the uploaded licence image
- `selfie`: the uploaded selfie image

The model should return one JSON object and should not retain image bytes or face embeddings after the request. Face comparison is 1:1 comparison of the licence portrait to the selfie. This contract does not claim liveness detection.

## Response

Return `application/json` with this shape:

```json
{
  "faceMatchStatus": "match",
  "faceMatchScore": 0.41
}
```

- `faceMatchStatus` is one of `match`, `no_match`, `no_face`, `multiple_faces`, or `uncertain`.
- `faceMatchScore` is the OpenCV SFace cosine similarity, normally between `-1` and `1`, or `null` if there is no comparable face. It is not a probability or percentage.

The face result is advisory only. Every application remains pending until an administrator visually checks the licence, including its expiry date, and reviews the face comparison. A match score is not a probability, identity proof, liveness result, or licence authenticity check. The default cosine threshold (0.383) is a starting point and must be calibrated against representative Sindh licence/selfie samples before use.

Persist only the review state, face match status/score, reason code, and processing time. Do not return or persist a face embedding or extracted licence text.

## Local configuration

Add the following to the ignored `.env.local` file (or the app's server secret store):

```dotenv
SUPABASE_SERVICE_ROLE_KEY=your-server-only-service-role-key
DRIVER_VERIFICATION_MODEL_URL=http://127.0.0.1:8000/verify
DRIVER_VERIFICATION_MODEL_KEY=your-shared-secret
DRIVER_VERIFICATION_FACE_MIN_SCORE=0.383
```

The included self-hosted service is in `verification-model/`. The local URL above is for development only. For Vercel production, deploy that service on a private server you control behind HTTPS and set `DRIVER_VERIFICATION_MODEL_URL` and the same `DRIVER_VERIFICATION_MODEL_KEY` in Vercel project environment variables. Do not use `localhost` in Vercel. The service-role key, model URL, and model key must never use a `NEXT_PUBLIC_` prefix. Until the model endpoint and service-role key are configured and reachable, applications remain pending for manual review.
