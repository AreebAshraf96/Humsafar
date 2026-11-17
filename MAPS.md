# Maps and directions

The current checkout uses MapLibre GL JS with the OpenFreeMap Liberty style. No Google account or map API key is required. `NEXT_PUBLIC_MAP_STYLE` can point to another compatible style. The first map visit downloads the vector renderer; WebGL and network access are required. The framework launcher copies the installed vendor worker unchanged into a generated public asset to avoid Vite dev-worker HMR injection; this asset is ignored by Git and included in builds. A coordinate readout and external map link remain available if rendering fails.

Search still uses Photon, backed by OpenStreetMap. Replacing the renderer does not replace that geographic dataset or guarantee that neighbourhood names are correct. Search addresses no longer promote Photon's broad `district` field to a suburb. No address is reverse-inferred from the nearest place. Moving a selected pin clears the previous landmark and requires a new user-confirmed name. Ride matching continues to use the saved coordinates.

Ride details provide an explicit **Show road route and turns** action when confirmed endpoints are available. Before pickup (`enroute`), directions lead from the latest driver location to pickup; otherwise they lead to destination. If location sharing is off, directions start at the confirmed origin. Distance, estimated duration, PKT arrival time and maneuver instructions come from OSRM. The result is bound to the exact endpoints and disappears when they change. Directions are requested manually, not continuously polled.

The default public routing service is FOSSGIS: https://routing.openstreetmap.de/about.html . It allows light use, at most one request per second, attribution and identification. The proxy authenticates requests, validates Karachi coordinates, caches exact endpoint routes for 15 minutes and throttles calls within its process. **Deploy only one process for this small pilot.** Multiple replicas or significant usage require a shared rate limiter or your own OSRM-compatible service via `ROAD_ROUTING_URL`. Do not use the public endpoint for a fleet-scale tracking rollout. Coordinates requested for directions are transmitted to the routing operator. See its privacy policy.

These are suggested road routes and estimates without live traffic, not proof of the route actually travelled. Free public services do not guarantee uptime, current closures, accurate place names or traffic-aware arrivals. Shared-trip responses without confirmed endpoints display their available position only. The current database still stores only the latest driver position; historical journey recording, continuous navigation/rerouting, intermediate stop routing, and reliable native background GPS are not implemented by this change.

Sources:
- https://openfreemap.org/quick_start/
- https://github.com/hyperknot/openfreemap
- https://routing.openstreetmap.de/about.html

Validation: `npm test`, `npm run typecheck`, `npm run build`; focused ESLint for changed map/search/routing code. `scripts/test-road-route.mjs` covers provider geometry, maneuvers, endpoint validation, auth, caching, throttling, offline failure, and stale landmark regression. A live public-landmark routing request returned HTTP 200, 7,239.6 metres, 519 seconds, 167 geometry points and 16 steps. This is a connectivity check, not a claim that the estimate matches real traffic.

An isolated headless Edge browser check loaded the real OpenFreeMap style, exercised pin selection and confirmation, and verified a moved pin clears its old landmark and disables confirmation. App authentication/data were mocked. The initial browser run identified a Vite worker injection issue; the unchanged public worker fix passed the repeat check.
