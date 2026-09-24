# Karachi place-search pilot

## What changed

Passenger From/To and driver pickup/drop-off use searchable dropdowns. Selecting a suggestion opens a map to confirm the actual meeting point; clicking the map moves the pin. Manual map selection and consent-based device location work when a place is not searchable. A landmark name and the confirmed coordinates are saved with each ride.

New rides require both endpoints within the pilot rectangle: latitude 24.70–25.25, longitude 66.75–67.60. This is a service-area approximation, not an official Karachi administrative boundary. Old listings remain available in My trips but are not inferred or relabelled as Karachi rides.

Confirmed-location searches compare the driver's departure and arrival points with the passenger's choices using a 1 km straight-line radius at each end. They do not calculate walking distance, road distance, intermediate pickups or road-route compatibility. Text-only API searches retain the earlier ordered-stop matching for compatibility.

## Provider and observed coverage

Photon's public demo service supplies OpenStreetMap-derived suggestions. No API key or paid service was added. Four public searches were checked on 24 September 2026 with Pakistan and Karachi-area restrictions:

| Query | Observed result |
| --- | --- |
| Dolmen Mall | Multiple branches, parking and food-court results; street context distinguishes them. |
| I I Chundrigar Road | Street and office-building results. |
| Tooba Mosque | No result for that spelling. |
| Plot 23 DHA | Loose matches; did not establish an exact match for the requested plot. |

This trial does not establish complete building, mosque, office or plot coverage. Do not present approximate suggestions as verified addresses.

Provider documentation: https://github.com/komoot/photon and https://github.com/komoot/photon/blob/master/docs/api-v1.md

The public demo permits reasonable use, may throttle/ban extensive use, and offers no availability guarantee. This is appropriate only for a small trial. The client waits 600 ms after typing and cancels stale requests. The server validates/filters results, caches at most 128 queries for 15 minutes and limits uncached calls to one per second per running isolate. That is not a globally shared production quota. Before a wider launch, use a suitable hosted provider or self-hosted instance and shared rate limiting. Server-only `PHOTON_SEARCH_URL` can change the provider endpoint.

Typed search terms are sent to Photon through the server. Manual/GPS pin selection does not reverse-geocode against Photon. Map tiles are requested from OpenStreetMap with attribution; the area viewed is visible to that map provider. No user coordinates are written to source files.

## Database migration

`drizzle/0001_absurd_preak.sql` adds nullable `service_city`, `origin_point` and `destination_point` fields. It preserves all existing records. Apply this migration once on an existing local database after the initial migration. Fresh clones must apply both migrations in order.

## Verification

Run `node scripts/test-locations.mjs`, `node scripts/test-carpool.mjs`, the TypeScript check and the project build. The API regression test applies all schema migrations to an in-memory database and checks Karachi boundaries, persistence, nearby/far/reversed matching and unchanged booking authorization.
