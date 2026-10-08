# Humsafar project notes

Current implementation and setup are documented in `README.md` and `SUPABASE_SETUP.md`.

The initial September prototype used ChatGPT authentication and Cloudflare D1. Those are historical choices, not the current login or ride-storage architecture. Its legacy D1 schema remains available for data recovery; do not discard existing records during cutover.

The October review branch uses verified Supabase accounts, requires login before entering the website and secures ride data behind transactional PostgreSQL RPCs. Review changes in the local demo before merging or applying production migrations.

Still requiring operational verification before public launch:

- Apply the reviewed migration and updated notification function to the intended Supabase project in a coordinated release; reconcile any historical D1 records.
- Test signup confirmation, password recovery and delivery limits with production SMTP and redirect settings.
- Test GPS interruption and notifications on real Android and iOS devices.
- Perform hosted multi-connection capacity tests and backup/restore verification.
- Choose a supported place-search provider or self-hosted instance before increasing traffic. No source guarantees every Karachi building or plot; confirmed map pins remain the fallback.
- The current match is proximity to pickup/drop-off endpoints (1 km), not an inferred road route.

There are no platform charges, payment collection or subscriptions in this pilot. Fares are agreed directly between travellers. Optional self-described gender is not identity verification, and location sharing is not an emergency-response service.
