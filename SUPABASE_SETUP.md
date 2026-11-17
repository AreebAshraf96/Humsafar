# Supabase setup and release sequence

## Auth configuration

1. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in `.env.local` and the hosting environment. The latter accepts a public/publishable key or legacy anon key. Never use a service-role key in browser variables.
2. Keep email confirmation enabled. Configure production SMTP and the correct site URL.
3. Allow the app's `/auth` redirect URL. For the local review add `http://localhost:5174/auth` when testing email verification or password recovery. Existing-account password sign-in does not require a redirect-list change.
4. Login is required for the website, ride API and location search. Tokens are verified by Supabase Auth/the database; client-side visibility is not the authorization boundary.

## Database deployment (after demo approval)

For a new project, apply every file in `supabase/migrations` in filename order. For an existing project, apply only migrations not yet recorded in its migration history. The new migration is `202610070001_secure_carpool.sql`; it requires both earlier schema/notification migrations.

The new migration preserves existing profiles and rides, adds profile completion state, revokes both table and column grants from browser roles, and introduces verified, transactional RPCs. Mutations for a given ride lock that ride row, preventing approvals and seat reductions from racing. The user ID always comes from `auth.uid()`, never caller input.

Notification device rows are deduplicated by token (newest ownership retained), then a unique token constraint is installed. The app registers/unregisters devices using `humsafar_device` instead of direct table writes.

This migration is intended to ship with the website update. The old website's notification-registration call will not work once direct table writes are revoked. Use a coordinated maintenance window; take a database backup first. Do not re-enable the old permissive grants to roll back: repair forward or keep notifications disabled while rolling back the website.

The frontend now stores rides in Supabase. Historical D1 records are NOT copied by schema deployment. Export and reconcile existing D1 data first if it must remain visible; map every legacy user ID to an existing Supabase Auth user. Preserve D1 until migration and row counts are verified. There is no silent fallback to an empty D1 database.

## Push notifications

Set the browser's `NEXT_PUBLIC_FIREBASE_*` fields from `.env.example`. The service worker reads its public configuration from `/api/firebase-config`, so it cannot silently point at a different Firebase project.

Deploy `supabase/functions/send-humsafar-notification/index.ts` together with this change. It sends data-only messages containing the recipient ID. The service worker compares that ID to the locally active account before displaying anything. Logout clears that local association and visible alerts, unregisters the server subscription and deletes the FCM token. This requires the updated worker AND updated edge function; the old notification payload format auto-displays messages.

Keep `HUMSAFAR_NOTIFICATION_SECRET` identical in the website's server environment and the function secrets. Keep Firebase service-account credentials and the Supabase server key only in Edge Function secrets. See the existing function's configuration names. Never commit them.

Notifications use Worker `waitUntil()` with a bounded network timeout. This protects background work from immediate request termination but is not a durable retry queue. Failure does not roll back a successful booking. Test arrival on real iOS/Android browsers before enabling notifications for users.

The Edge Function uses Deno (`npm:` imports). Its types are excluded from the website tsconfig and should be checked with `deno check supabase/functions/send-humsafar-notification/index.ts` in the deployment environment.

## Review status

`npm run demo` uses your real Supabase Auth with isolated local PostgreSQL ride data. It does not apply these migrations, change your live project or send real notifications. Demo approval and deployment are separate from merging.

## Automated driver checks

Apply `20261015_driver_verification_automation.sql` after the original `20261015_driver_verification.sql` migration. The server integration contract is in `DRIVER_VERIFICATION_MODEL.md`. Humsafar sends the private licence and selfie to the configured self-hosted model endpoint; it never sends them to a model provider on your behalf. Configure `SUPABASE_SERVICE_ROLE_KEY`, `DRIVER_VERIFICATION_MODEL_URL`, and `DRIVER_VERIFICATION_MODEL_KEY` as server-only secrets. Do not add these to browser-prefixed variables or commit their values.

The automated service only compares the selfie with the licence portrait. Every application remains pending for an administrator to inspect the licence, manually check its expiry/details, and make the approval decision. Face similarity is advisory, not proof of identity or licence authenticity. The model endpoint must use HTTPS in production and must not retain uploaded images or face templates.

## November review fixes release

Deploy `202611170001_review_fixes.sql` with this website update. It restricts direct
profile-name lookup to verified chat participants, adds expiry/revocation review,
and excludes cancelled/completed rides from the upcoming-offer quota. No live
migration is applied by the local test commands.

Administrators must enter the licence expiry date from the document when approving.
Approval remains valid through that date in Pakistan time. Existing approvals with
no expiry cannot publish new rides until an administrator confirms their expiry
from retained documents, or the driver submits fresh documents. An administrator
can revoke an approval with a reason; its status becomes action-required and the
driver can submit again. Expired approvals can also resubmit. Decisions remain in
review history. The expiry date is retained after the 90-day image/comparison purge
so a retained approval cannot become indefinitely valid after its images are deleted.

`npm test` now covers chat pagination with tied timestamps, private profile lookup,
verification-result races, approval expiry/revocation, cancelled-ride quotas,
notification destinations and demo seed startup. The demo's synthetic driver is
approved only in its disposable database. Its smoke test uses placeholder settings
and makes no live service requests.

### Verification runtime guard

`202611170002_driver_verification_runtime.sql` adds an independent approval trigger
with a row lock. It prevents an older migration from restoring a status-only ride
check that ignores licence expiry. Apply this migration after the November review
fixes. `test-review-fixes.mjs` deliberately reinstalls the old trigger function and
verifies that the independent guard still blocks expired/revoked drivers.

### Pending-photo replacement and reviewer queue

`202611170003_verification_photo_retake.sql` allows applicants to upload a new
photo while a request is pending. The submit RPC accepts an optional expected
submission timestamp; replacement preserves the request ID and unchanged photo.
Both replacement and administrator review lock/check the current submission,
preventing stale updates from overwriting a decision or approving unseen photos.

The administrator queue supports a server-side status filter. Its default Pending
requests view refreshes every 20 seconds while visible; All applications includes
reviewed requests. Requests navigation is shown after a verified, server-side
check of the current account's administrator role. Backend authorization remains
enforced independently of navigation visibility.
