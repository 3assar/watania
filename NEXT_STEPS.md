# Phase 1 Handoff

## What’s Done

- Migrated the product catalog from Netlify Blobs into Supabase/Postgres.
- Applied the Phase 1 schema from `supabase/migrations/001_phase1_schema.sql`.
- Added the legacy `profiles` table for the old overrides blob.
- Updated `netlify/edge-functions/profiles.js` to read/write profiles from Supabase.
- Imported the product rows successfully into `products`.
- Set the Netlify site env vars for `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
- Verified the live `/api/profiles` endpoint returns data correctly.

## Current State

- The app now has a SQL-backed foundation in Supabase.
- The profiles endpoint is live on Netlify and working.
- The database schema is ready for Phase 1 app features.
- Duplicate `internal_code` rows are still present, but we agreed to leave cleanup for the UI later.

## What To Build Next

1. Work orders
   - Create an admin flow to generate and edit work orders.
   - Link each work order to a product, machine, quantity, due date, and colour plan.

2. Shift logs
   - Build the end-of-day entry screen for morning/night production.
   - Capture units produced, waste, notes, supervisor sign-off, and colour breakdown.

3. Printable sheets
   - Add a printable work-order sheet for the floor.
   - Include the fields needed for planning and sign-off.

4. HR reports
   - Surface the weekly worker output report.
   - Add waste analysis and order summary views.

5. Product cleanup UI
   - Build a simple admin screen to review duplicate `internal_code` entries.
   - Keep cleanup in the UI instead of doing a database batch fix.

## Useful Files

- `supabase/migrations/001_phase1_schema.sql`
- `netlify/edge-functions/profiles.js`
- `scripts/migrate_products.js`
- `scripts/verify_supabase.js`

## Recommended Order

1. Work orders
2. Shift logs
3. Printable sheets
4. HR reports
5. Duplicate cleanup UI
