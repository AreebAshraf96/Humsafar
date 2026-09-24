# Humsafar — free private pilot

This is an owner-private pilot, not a public passenger service. No payment collection, subscriptions, paid map APIs or external paid services are configured.

## Implemented

- Pakistan-time date search, free-text departure/destination, and ordered intermediate-stop matching. Any Pakistan place name can be entered; there is no complete address directory, geocoding or road-route inference.
- One-time departures and a four-week repeating schedule. Every departure has independent capacity, bookings and trip state.
- Hosted ChatGPT authentication, profiles with optional self-described gender and optional Pakistan telephone number, server-owned records in D1.
- Seat requests and fare messages, driver approval/decline with replies, atomic capacity checks, seat capacity updates and pre-departure cancellation.
- Confirmed passenger display names and gender. Driver telephone and plate are disclosed to approved passengers. Requesting passengers disclose optional telephone to their driver.
- Driver journey progression: scheduled → on the way → arrived → started → ended. Pre-start cancellation supported.
- Explicit browser geolocation consent, driver-only updates, approved-passenger read access, timestamp/accuracy and stale-location indicator. Only the latest coordinate is stored; stopping sharing or ending/cancelling clears it.
- High-entropy trip links with hashed storage, expiry after 12 hours, owner revocation and immediate invalidation on trip end. Share payload excludes passenger profiles and phone numbers.
- In-page trip updates while My trips is open. No SMS, email, web-push or background notifications.

## Limits before a public launch

1. The Sites starter's supported authentication is ChatGPT sign-in. Regular email/password or phone OTP accounts are not implemented; choose and configure a supported public auth/hosting path before launching to customers.
2. The Site is owner-only. External trusted contacts cannot open its trip links while that access policy is in place. Do not claim anonymous sharing works end-to-end on this private deployment.
3. Browser tracking pauses under phone power management, lock/background states or lost connectivity. This is not a monitored emergency service. Real device field testing remains required.
4. No identity, licence, vehicle or gender verification is performed. No trust ratings or verification badges are invented.
5. OpenStreetMap is embedded with attribution. No API key required, but service availability and usage policies apply. Do not assume unlimited free production map capacity. OSM policy: https://operations.osmfoundation.org/policies/tiles/
6. Subscription billing is deliberately absent. Hosting costs and limits depend on the user's hosting/account arrangement; this source does not guarantee indefinite free operation.

## Validation

`node scripts/test-carpool.mjs` executes the actual API handler and domain logic against an isolated in-memory SQLite database with test identity injection. It never creates production records. Covers authorization, route direction, recurrence, booking capacity, cancellation, private location access, token expiry/revocation, terminal trip cleanup and cross-origin rejection.

`node node_modules/typescript/bin/tsc --noEmit` checks TypeScript. Build with the normal project build script. Local D1 migration state is ignored and not shipped; hosted migrations are schema-only.

Browser preview uses the starter's loopback-only mock ChatGPT identity. Local test data does not get included in the published database.
