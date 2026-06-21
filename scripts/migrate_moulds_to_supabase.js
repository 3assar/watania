#!/usr/bin/env node
/**
 * migrate_moulds_to_supabase.js
 * Extracts the MOULDS[] array from index.html and inserts into Supabase moulds table.
 *
 * Usage:
 *   node --env-file=scripts/.env scripts/migrate_moulds_to_supabase.js
 *   node --env-file=scripts/.env scripts/migrate_moulds_to_supabase.js --dry-run
 *   node --env-file=scripts/.env scripts/migrate_moulds_to_supabase.js --clear
 *
 * Required env vars (already in scripts/.env):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir   = dirname(fileURLToPath(import.meta.url));
const ROOT    = join(__dir, '..');
const DRY_RUN = process.argv.includes('--dry-run');
const CLEAR   = process.argv.includes('--clear');
const CHUNK   = 100;

function env(name) {
  const v = process.env[name];
  if (!v) { console.error(`ERROR: ${name} is required`); process.exit(1); }
  return v;
}

const SUPABASE_URL = env('SUPABASE_URL');
const SUPABASE_KEY = env('SUPABASE_SERVICE_KEY');

// ── Extract MOULDS[] from index.html ─────────────────────────────────────────

function extractVar(html, varName) {
  const re   = new RegExp(`^\\s*const ${varName}\\s*=\\s*`);
  const line = html.split('\n').find(l => re.test(l));
  if (!line) throw new Error(`"const ${varName}" not found in index.html`);
  let raw = line.replace(re, '').trimEnd();
  if (raw.endsWith(';')) raw = raw.slice(0, -1);
  try { return JSON.parse(raw.trim()); }
  catch (e) { throw new Error(`JSON.parse failed for ${varName}: ${e.message}`); }
}

console.log('Reading index.html…');
const html   = readFileSync(join(ROOT, 'index.html'), 'utf8');
const MOULDS = extractVar(html, 'MOULDS');
console.log(`  MOULDS: ${MOULDS.length} entries`);

// ── Transform ─────────────────────────────────────────────────────────────────

function transform(mould, idx) {
  const machines = (mould.machines || [])
    .map(v => parseFloat(v))
    .filter(t => Number.isFinite(t) && t > 0);

  return {
    dp_idx:              idx,
    name_ar:             (mould.n || '').trim(),
    group_ar:            (mould.g || null),
    subgroup:            (mould.sg && mould.sg !== 'nan' ? mould.sg : null),
    mould_code:          (mould.mc || null),
    material_recipe:     (mould.mat || null),
    pieces_per_cycle:    parseInt(mould.pc, 10) || 1,
    cycle_time_sec:      mould.ct ? parseFloat(mould.ct) : null,
    compatible_machines: machines,
    colours:             Array.isArray(mould.colours) ? mould.colours : [],
    internal_id:         (mould.mid || null),
    product_id:          null,   // linked later through work order enrichment
    part_number:         1,
  };
}

const rows = MOULDS
  .map((m, i) => transform(m, i))
  .filter(r => r.name_ar.length > 0);

console.log(`  Rows to insert: ${rows.length}`);
if (DRY_RUN) {
  console.log('\n[DRY RUN] First 3 rows:');
  rows.slice(0, 3).forEach((r, i) => console.log(`  [${i}]`, JSON.stringify(r)));
  console.log('\n✓ Dry run complete.\n');
  process.exit(0);
}

// ── REST helpers ──────────────────────────────────────────────────────────────

const HEADERS = {
  apikey:          SUPABASE_KEY,
  Authorization:   `Bearer ${SUPABASE_KEY}`,
  'Content-Type':  'application/json',
  Prefer:          'return=minimal',
};

async function sbFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: HEADERS,
    ...opts,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${path}: ${body}`);
  }
  return res;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log('  AWP MOULDS → Supabase Migration');
  console.log('═'.repeat(60));

  // Check existing rows
  const countRes = await sbFetch('/moulds?select=id', {
    headers: { ...HEADERS, Prefer: 'count=exact' },
    method: 'HEAD',
  });
  const existing = parseInt(countRes.headers.get('content-range')?.split('/')[1] ?? '0', 10);
  console.log(`\n  Existing moulds in DB: ${existing}`);

  if (existing > 0) {
    if (CLEAR) {
      console.log('  Clearing existing rows (--clear)…');
      await sbFetch('/moulds?id=gte.0', { method: 'DELETE' });
      console.log('  ✓ Cleared');
    } else {
      console.error('  ✗ Table already has rows. Re-run with --clear to wipe first.');
      process.exit(1);
    }
  }

  // Insert in chunks
  let inserted = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    try {
      await sbFetch('/moulds', {
        method: 'POST',
        body: JSON.stringify(chunk),
      });
      inserted += chunk.length;
      process.stdout.write(`  Inserted ${inserted}/${rows.length}\r`);
    } catch (err) {
      console.error(`\n  ✗ Chunk ${i}–${i + chunk.length - 1}: ${err.message}`);
      // Retry row-by-row
      for (const row of chunk) {
        try {
          await sbFetch('/moulds', { method: 'POST', body: JSON.stringify([row]) });
          inserted++;
        } catch (rowErr) {
          errors.push({ name: row.name_ar, idx: row.dp_idx, error: rowErr.message });
          console.error(`    ✗ [${row.dp_idx}] "${row.name_ar}": ${rowErr.message}`);
        }
      }
    }
  }
  process.stdout.write('\n');

  // Verify
  const verifyRes = await sbFetch('/moulds?select=id', {
    headers: { ...HEADERS, Prefer: 'count=exact' },
    method: 'HEAD',
  });
  const dbCount = parseInt(verifyRes.headers.get('content-range')?.split('/')[1] ?? '0', 10);

  console.log('\n' + '─'.repeat(60));
  console.log('SUMMARY');
  console.log('─'.repeat(60));
  console.log(`  Source moulds : ${MOULDS.length}`);
  console.log(`  Rows built    : ${rows.length}`);
  console.log(`  Inserted OK   : ${inserted}`);
  console.log(`  Failed        : ${errors.length}`);
  console.log(`  DB total now  : ${dbCount}`);

  if (errors.length) {
    console.log('\nFailed rows:');
    errors.forEach(e => console.log(`  • [${e.idx}] "${e.name}": ${e.error}`));
  }

  console.log(errors.length === 0 ? '\n✓ Done!\n' : '\n⚠ Finished with errors.\n');
  if (errors.length) process.exit(1);
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
