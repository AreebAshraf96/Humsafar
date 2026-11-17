# Self-hosted verification service contract

The website sends uploaded images to Humsafar's own model service. It performs
advisory face comparison, local OCR and photo-quality checks. It does not query a
government registry, establish authenticity or decide driver eligibility.

## Request

`POST /verify`, multipart form with a server-only bearer model key:

- `licence`: JPEG, PNG or WebP, at most 5 MB.
- `selfie`: JPEG, PNG or WebP, at most 5 MB.
- `countryCode`: PK; `region`: Sindh.
- `declaredName`: optional full name supplied by the applicant, at most 100 characters.

No raw image, full OCR transcript, licence number or printed name is returned.
The name supplied is compared only as text and is not proof of identity.

## Response

```json
{
  "faceMatchStatus": "match",
  "faceMatchScore": 0.8,
  "documentChecks": {
    "state": "review_required",
    "expiryDate": "2030-12-31",
    "expiryStatus": "valid",
    "nameStatus": "consistent",
    "licenceNumberPresent": true,
    "reasons": ["Printed expiry appears current; a reviewer must confirm it."]
  }
}
```

Face status is match, no_match, no_face, multiple_faces or uncertain. Its score is
cosine similarity, not a probability. It never automatically approves/rejects a
driver. A camera photo is not a liveness check.

Document state is review_required or unavailable. Expiry status is valid, expired,
ambiguous or unreadable. Name status is consistent, different, unreadable or
not_provided. Only confident labelled English fields are parsed. Dates with
conflicting values or ambiguous day/month ordering require human confirmation.
Birth and issue dates are not substituted for expiry. Quality checks flag small,
blurry, underexposed or blank/overexposed images with descriptive reasons.

The website whitelists and bounds metadata before saving automated results. Raw
OCR text, names, numbers, addresses, birth dates and embeddings are not persisted
in those results. Original documents remain in the existing private bucket.
Automated metadata follows the existing document/comparison purge lifecycle.
The separate administrator-confirmed expiry remains available to enforce approval
validity after image retention ends.

## Deployment

Use `npm run verification:setup` and `npm run verification:start` for local setup.
The ignored `.env.local` needs a Supabase server key, model URL and model key.
Local model URL is `http://127.0.0.1:8000/verify`; production requires an HTTPS
endpoint on a server operated by Humsafar. Never use NEXT_PUBLIC_ for server keys.
See `verification-model/README.md` for commands and provider/camera limitations.
