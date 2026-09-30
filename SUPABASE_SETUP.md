# Supabase setup

## Authentication

1. Create or open a Supabase project and copy its Project URL and publishable (or legacy anon) key.
2. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in the local environment and deployment environment. `.env.example` shows the names; do not put a service-role key in browser-exposed variables.
3. In Supabase **Authentication → URL Configuration**, set the site URL to the deployed origin and add `<origin>/auth` as a redirect URL.
4. Keep email confirmation enabled in **Authentication → Providers → Email**. Configure SMTP before production so verification and password recovery email can be delivered reliably.
5. Run `supabase/migrations/202609280001_humsafar_schema.sql` in the Supabase SQL Editor (or with the Supabase CLI). It creates profiles, private profile contacts, rides, bookings, and share-link tables with foreign keys, indexes, and RLS.

The `/auth` page supports signup with email confirmation, sign-in, password recovery, and password replacement. API routes validate the bearer access token against Supabase Auth and reject accounts that have not confirmed their email. The browser stores the session locally and refreshes expiring access tokens.

## Current ride-data backend

The supplied app's ride API is built around Cloudflare D1 and still reads/writes its ride, booking, profile, and share records through the existing `DB` binding. The migration above provisions equivalent Supabase tables, but provisioning these tables alone does not move the existing D1 queries to PostgREST. To run ride data entirely in Supabase, the D1 repository in `app/api/carpool/route.ts` must also be migrated and the D1 binding removed from the hosting configuration. No Supabase project credentials were included with the ZIP, so this source tree cannot apply the migration to a live project.
