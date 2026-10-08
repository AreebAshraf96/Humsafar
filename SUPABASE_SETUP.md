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
