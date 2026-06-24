-- 003_revoke_anon_writes.sql
-- Date: 2026-06-24
-- Closes audit item C1 (TECHNICAL_AUDIT_v3.md §1.1).
--
-- Context: all application writes go through the /api/mutate Cloudflare Function,
-- which executes against Supabase with the SERVICE ROLE key. The anon key (public,
-- embedded in js/supabase.js) is only needed for direct SELECT reads. Yet anon still
-- held INSERT/UPDATE/DELETE on operational tables — verified 2026-06-24 by a live
-- DELETE /work_orders with only the anon key returning HTTP 204 (accepted).
--
-- This revokes write privileges from anon on every public table while keeping SELECT,
-- so the read path is unaffected and the proxy (service role) becomes the only write path.
-- Idempotent: REVOKE on an already-revoked privilege is a no-op.

-- Base tables
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM anon', r.tablename);
  END LOOP;
END $$;

-- Views (pg_tables does not include these; aggregate views are non-updatable anyway,
-- but revoke for hygiene so the anon role has zero write grants in public).
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT viewname FROM pg_views WHERE schemaname = 'public' LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM anon', r.viewname);
  END LOOP;
END $$;

-- Verification (should return ZERO rows after this runs):
-- SELECT table_name, privilege_type
-- FROM information_schema.role_table_grants
-- WHERE grantee = 'anon' AND table_schema = 'public'
--   AND privilege_type IN ('INSERT','UPDATE','DELETE');
