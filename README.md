# Humsafar — Karachi carpool pilot

Humsafar lets signed-in travellers offer rides, request seats, approve passengers, agree fares directly and share an active trip. There are no subscriptions or platform payments yet.

## Current architecture

- React/Vinext on Cloudflare Workers.
- Supabase Auth for verified email accounts and password recovery.
- Supabase PostgreSQL for profiles, rides, bookings, private contacts, trip shares and notification subscriptions.
- The `humsafar_api` database function verifies the authenticated user and performs booking/capacity/lifecycle mutations in a transaction under a shared ride lock. Browser roles cannot read or modify the underlying ride tables directly.
- Photon/OpenStreetMap search and Leaflet maps. Both endpoints must be confirmed with a pin. Matching uses a 1 km radius around each endpoint; it is not road-route intersection matching or a complete building directory.
- Firebase pushes are data-only, attached to the Worker lifetime and suppressed on devices after logout. They are an extra convenience; the in-app trip state remains authoritative.

## Install and run

Requires Node 22.13 or later (Node 24 recommended).

```powershell
npm ci
# Copy .env.example to .env.local and enter your project configuration.
npm run dev
```

Apply the SQL migrations and deploy the notification function as described in `SUPABASE_SETUP.md` before using real ride storage. Never place service-role credentials in `NEXT_PUBLIC_` variables.

## Review demo (before merging)

```powershell
npm run demo
```

Open http://localhost:5174. Use an existing, email-verified Humsafar account from your configured Supabase project. The home page first opens sign-in. A successful login unlocks the website.

The banner identifies this as a review demo. Authentication is real; rides use disposable, in-memory PostgreSQL on your computer, seeded with clearly labelled sample rides. Saving profiles, requesting seats and offering rides here does not modify your real ride tables or send notifications. Stop the process to discard the demo data. Ports 5174 and 54329 must be available. The internal database gateway listens on loopback and verifies each incoming bearer token with Supabase Auth. It does not accept fabricated identities or store passwords/tokens.

The preview RPC override is accepted only in development and only for localhost requests. Production always calls Supabase. Do not deploy `scripts/demo.mjs` or set preview environment variables in production.

## Checks

```powershell
npm test
npm run typecheck
npm run build
```

The tests execute the actual PostgreSQL migrations using PGlite and cover direct-grant bypasses, unverified users, ownership, last-seat approvals, live-location visibility, expired/revoked shares, terminal trip cleanup, notification ownership and API authentication. PGlite serializes its connection; this is not a multi-connection load test. The code uses PostgreSQL row locks for cross-connection seat safety; run a hosted concurrency smoke test before release.

## Operational boundaries

All ride browsing and shared-trip viewing require sign-in. A shared link is preserved through login and still requires a valid, unexpired token. Its holder sees only the shared trip details, not contact numbers or a passenger list.

Web location updates can pause when the phone locks or the browser is backgrounded. The app shows the age of the last received location. This website is not an emergency service.

Legacy `drizzle/`, `db/` and `lib/store.ts` files are retained only for recovering/exporting old D1 records. The running ride API no longer imports them. This change does not automatically copy historical D1 data into Supabase. Preserve a D1 export and map legacy profile IDs to real Supabase user IDs before cutover; do not retire D1 until records are reconciled.
