# Self-hosted driver verification model contract

Humsafar calls the model from the server after the driver uploads both images. The URL and shared key are server-only settings. The model must be hosted and operated by Humsafar; it must not forward either image to another service.

## Request

Humsafar sends one `multipart/form-data` POST to `DRIVER_VERIFICATION_MODEL_URL` with:

- `Authorization: Bearer <DRIVER_VERIFICATION_MODEL_KEY>`
- `countryCode`: `PK`
- `region`: `Sindh`
- `licence`: the uploaded licence image
- `selfie`: the uploaded selfie image

The model should return one JSON object and should not retain image bytes, face embeddings, or OCR transcripts after the request. Face comparison is 1:1 comparison of the licence portrait to the selfie. This contract does not claim liveness detection.

## Response

Return `application/json` with this shape:

```json
{
  "licenceExpiryDate": "2028-06-30",
  "expiryConfidence": 0.98,
  "faceMatchStatus": "match",
  "faceMatchScore": 97.4
}
```

- `licenceExpiryDate` is an ISO date (`YYYY-MM-DD`) or `null` if OCR could not read it.
- `expiryConfidence` is between `0` and `1`.
- `faceMatchStatus` is one of `match`, `no_match`, `no_face`, `multiple_faces`, or `uncertain`.
- `faceMatchScore` is between `0` and `100`, or `null` if there is no comparable face.

Humsafar auto-approves only if the date is valid and not expired, OCR confidence meets `DRIVER_VERIFICATION_OCR_MIN_CONFIDENCE`, and face status is `match` with a score at least `DRIVER_VERIFICATION_FACE_MIN_SCORE`. Every other result stays pending for admin review; the system does not automatically reject based on a mismatch or unreadable document. The default thresholds (0.90 OCR confidence and 95 face score) are starting values only and must be calibrated against representative Sindh licence/selfie samples before production.

Persist only the decision, expiry date, confidence, match status/score, reason code, and processing time. Do not return or persist a face embedding or the OCR transcript.

## Local configuration

Add the following to the ignored `.env.local` file (or the app's server secret store):

```dotenv
SUPABASE_SERVICE_ROLE_KEY=your-server-only-service-role-key
DRIVER_VERIFICATION_MODEL_URL=https://your-self-hosted-model.example/verify
DRIVER_VERIFICATION_MODEL_KEY=your-shared-secret
DRIVER_VERIFICATION_OCR_MIN_CONFIDENCE=0.90
DRIVER_VERIFICATION_FACE_MIN_SCORE=95
```

The service-role key, model URL, and model key must never use a `NEXT_PUBLIC_` prefix. Production model endpoints must use HTTPS. Until the model endpoint and service-role key are configured, applications remain pending for manual review.
