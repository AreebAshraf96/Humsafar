# Driver licence verification test report

Tested on 17 November 2026 against the local app and its configured Humsafar
Supabase project. Real licence documents were not used. The live workflow used
labelled temporary accounts, public OpenCV sample photos and a card marked
"NOT A DRIVING LICENCE".

## Results

- All 11 application test suites passed, including 41 verification validation checks.
- All 41 real OpenCV/FastAPI/document tests passed.
- All 18 live browser/Supabase workflow checks passed.
- Production build passed.
- TypeScript and lint passed in the project checks.
- Python dependency check passed and downloaded model/fixture checksums matched.
- Supabase verification confirmed zero temporary test accounts, zero temporary
  rides, and an enabled independent licence-expiry guard after cleanup.

The live workflow covered unauthenticated access, malformed payloads, unapproved
ride creation, cross-account document paths, browser file selection/consent/upload,
persisted real-model results, duplicate submission, unauthorized administration,
requesting changes, resubmission, mandatory licence expiry, approval, revocation,
expired approval, ride publishing and retention purge. The administrator browser
was restricted to the specific test application to avoid opening other documents.

Detailed machine-readable results and screenshots are in ignored
`work/verification-results/`. Some screenshots use a deliberately old test
submission timestamp to put the synthetic fixture first in the review queue.

## Repairs made during testing

1. Installed an isolated, project-local Python environment and configured the local
   model endpoint and generated model secret. The user supplied the Supabase key
   directly in ignored `.env.local`; no secret was committed.
2. Fixed rotated images being accepted in the wrong orientation: the model now
   evaluates orientations and uses the strongest face detection before alignment.
3. Rejects oversized image dimensions before expensive decoding, handles invalid
   images and OpenCV failures, and runs inference off the event loop with a single
   inference slot protecting shared OpenCV model instances.
4. Added bounded/same-origin JSON validation, robust model-output/threshold
   validation and support for both legacy service-role and newer `sb_secret_` keys.
5. Added single-application administrator lookup, correct history timestamps and
   clearer fallback behavior when automated checking is unavailable.
6. Found the live ride trigger still used an older check that ignored licence
   expiry. Applied the independent guard in
   `supabase/migrations/202611170002_driver_verification_runtime.sql` to the linked
   Humsafar database and verified expiry/revocation through the live app.
7. Added repeatable setup/start/test commands, checksum-verified downloads,
   service tests, validation tests and the opt-in live/browser workflow.

## Run locally

In one PowerShell terminal from `C:\Users\hp\humsafar`:

```powershell
npm run verification:start
```

In a second terminal from the same folder:

```powershell
npm run dev
```

Open `http://localhost:5173/driver-verification`. An authorized reviewer uses
`http://localhost:5173/admin/driver-verifications` and must confirm the licence
expiry before approval. Face comparison never automatically approves an account.

For a fresh environment, run `npm run verification:setup` first. See
`verification-model/README.md` and `SUPABASE_SETUP.md` for configuration.

## Repeat checks

```powershell
npm test
npm run test:verification-model
npm run typecheck
npm run lint
npm run build
node --env-file=.env.local scripts/check-client-secrets.mjs
```

The opt-in live test additionally needs the local app/model, Supabase server key,
public sample fixtures and `playwright-core` under `work/verification-browser`:

```powershell
node --env-file=.env.local scripts/test-verification-live.mjs --live
```

These are functional and access-control checks. They do not establish accuracy on
representative Sindh licences, licence authenticity, government verification or
liveness. Human document review remains required. Docker was not running, so the
service was exercised directly with Python rather than inside a Docker container.
The build still emits its existing Leaflet image-resolution warnings; the Python
HTTP test client emits an upstream httpx deprecation warning.

## Camera and document-check extension

The November extension adds browser camera preview/capture and track cleanup,
permission-denied fallback, separate device-file selection and native mobile
camera input. A mobile-sized fake-camera browser run passed 15 live workflow
checks, including persisted advisory document-check reasons. Physical phone
provider lists remain controlled by the operating system/browser.

All 41 Python model/document tests passed, including real OCR on a clearly labelled
synthetic English document. Text checks cover labelled name/number/expiry fields,
conflicting and ambiguous dates, expiry in the past, missing labels and image
quality. No raw OCR transcript, printed full name or licence number is persisted
in automated result metadata. Existing pending applications can run these checks
without reuploading. Final driver approval/rejection remains an administrator's
decision; photo capture is not liveness or government licence authentication.

## Retake prompt and administrator Requests tab

The photo-retake extension passed 18 live browser/Supabase checks and the full
application suite, including partial-photo replacement and stale-review guards.
Unreadable licence details prompt a clearer photo while the request remains
pending. An applicant can replace only the licence photo and keep the existing
selfie, or replace both. Server outages offer retry rather than blaming a photo.

Administrator accounts now see Requests navigation on the main app and verification
pages, with Pending requests and All applications views. The pending queue refreshes
while visible. New submissions clear any stale reviewer expiry/reason inputs.
The migration `202611170003_verification_photo_retake.sql` was applied to the linked
Humsafar database. Temporary users, documents and rides from the test were removed.
