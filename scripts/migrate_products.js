#!/usr/bin/env node
/**
 * migrate_products.js
 * Migrates the 437 AWP products from Netlify Blobs into supabase.products.
 *
 * What it does:
 *  1. Parses PRODUCTS / BARCODES / MOULDS out of index.html
 *  2. Fetches profile overrides from the Netlify Blobs API
 *  3. Transforms each product into the Supabase schema
 *  4. Inserts in chunks with per-row error reporting
 *  5. Verifies the final DB count matches
 *
 * Setup (run once):
 *   npm install @supabase/supabase-js
 *   cp scripts/.env.example scripts/.env   # then fill in values
 *
 * Usage:
 *   node --env-file=scripts/.env scripts/migrate_products.js
 *   node --env-file=scripts/.env scripts/migrate_products.js --dry-run
 *   node --env-file=scripts/.env scripts/migrate_products.js --clear   # wipe table first
 *
 * Required env vars:
 *   SUPABASE_URL            https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY    eyJ...  (service-role key — bypasses RLS)
 *   NETLIFY_PROFILES_URL    https://your-site.netlify.app/api/profiles
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createClient } from '@supabase/supabase-js';

const __dir    = dirname(fileURLToPath(import.meta.url));
const ROOT     = join(__dir, '..');
const DRY_RUN  = process.argv.includes('--dry-run');
const CLEAR    = process.argv.includes('--clear');
const EXPECTED = 437;
const CHUNK    = 50;

// ── CONFIG ──────────────────────────────────────────────────────────────

function env(name) {
  const v = process.env[name];
  if (!v) { console.error(`ERROR: ${name} env var is required`); process.exit(1); }
  return v;
}

const SUPABASE_URL  = env('SUPABASE_URL');
const SUPABASE_KEY  = env('SUPABASE_SERVICE_KEY');
const NETLIFY_URL   = env('NETLIFY_PROFILES_URL');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── EXTRACT DATA FROM index.html ─────────────────────────────────────────
// Each data variable is declared as a single long line:  const FOO = <json>;

function extractVar(html, varName) {
  const line = html.split('\n').find(l => {
    const t = l.trimStart();
    return t.startsWith(`const ${varName}`) || t.startsWith(`const ${varName} `);
  });
  if (!line) throw new Error(`"const ${varName}" not found in index.html`);

  const eqIdx = line.indexOf(' = ');
  if (eqIdx === -1) throw new Error(`No " = " in ${varName} declaration`);

  let raw = line.substring(eqIdx + 3).trimEnd();
  if (raw.endsWith(';')) raw = raw.slice(0, -1);
  raw = raw.trim();

  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`JSON.parse failed for ${varName}: ${e.message}\n  (first 120 chars: ${raw.substring(0, 120)})`);
  }
}

console.log('Reading index.html…');
const html     = readFileSync(join(ROOT, 'index.html'), 'utf8');
const PRODUCTS = extractVar(html, 'PRODUCTS');
const BARCODES = extractVar(html, 'BARCODES');
const MOULDS   = extractVar(html, 'MOULDS');

console.log(`  PRODUCTS : ${PRODUCTS.length}`);
console.log(`  BARCODES : ${Object.keys(BARCODES).length} entries`);
console.log(`  MOULDS   : ${MOULDS.length} entries`);

// ── MATCHING MAPS (mirrors app logic exactly) ─────────────────────────────

// Barcode match: product English name → Arabic barcode key in BARCODES
const EN_AR_BARCODE_MAP = [
  [/filo basin/i,                   ['طشت فيلو 1','طشت فيلو2','طشت فيلو3','طشت فيلو4']],
  [/lina basin/i,                   ['طشت لينا 1','طشت لينا 2','طشت لينا 3','طشت لينا 4']],
  [/rotana basin/i,                 ['طشت روتانا 5']],
  [/filo magour/i,                  ['ماجور فيلو1','ماجور فيلو2','ماجور فيلو3','ماجور فيلو4']],
  [/lina magour/i,                  ['ماجور لينا 1','ماجور لينا 2','ماجور لينا 3','ماجور لينا 4']],
  [/rotana magour/i,                ['ماجور روتانا 5']],
  [/nancy bucket/i,                 ['جردل نانسى بالغطاء']],
  [/kimo bucket/i,                  ['جردل كيمو']],
  [/daloaa bucket/i,                ['جردل دلوعه ستانلس']],
  [/royal bucket/i,                 ['جردل رويال']],
  [/turkey bucket|turkish bucket/i, ['جردل تركى']],
  [/tornado bucket/i,               ['جردل تورنيدو']],
  [/japanese bucket/i,              ['جردل سامسونج']],
  [/samsung bucket/i,               ['جردل سامسونج']],
  [/french bucket/i,                ['جردل فرنساوى استانلس']],
  [/automatic bucket/i,             ['جردل اتوماتيك استانلس']],
  [/super spin/i,                   ['جردل سوبر سبين']],
  [/super clean/i,                  ['جردل سوبر كلين']],
  [/lina bucket/i,                  ['جردل لينا']],
  [/rocky dust bin/i,               ['زبالة روكى']],
  [/loaloaa dust bin/i,             ['زبالة لؤلؤه']],
  [/grand dust bin/i,               ['زبالة جراند']],
  [/magy dustbin/i,                 ['زبالة ماجى1']],
  [/dream dustbin/i,                ['زبالة دريم 1']],
  [/toofy dustbin 1/i,              ['زباله توفي 1']],
  [/toofy dustbin 2/i,              ['زباله توفي 2']],
  [/toofy dustbin 3/i,              ['زباله توفي 3']],
  [/tokyo dustbin/i,                ['زبالة طوكيو 1']],
  [/ratan 3 bin/i,                  ['زبالة راتان3']],
  [/ratan 2 bin/i,                  ['زبالة راتان2']],
  [/ratan 1 bin/i,                  ['زبالة راتان1']],
  [/new rocka/i,                    ['زبالة نيو روكا']],
  [/grand rocka/i,                  ['زباله جراند روكا']],
];

// Mould auto-match: product English name → Arabic mould name in MOULDS[].n
const EN_AR_MOULD_MAP = [
  [/filo basin/i,                   ['طشت فيلو 1','طشت فيلو2','طشت فيلو3','طشت فيلو4']],
  [/lina basin/i,                   ['طشت لينا 1','طشت لينا 2','طشت لينا 3','طشت لينا 4']],
  [/nancy bucket/i,                 ['جسم جردل نانسي']],
  [/kimo bucket/i,                  ['جسم جردل كيمو']],
  [/daloaa bucket/i,                ['جسم جردل دلوعة']],
  [/royal bucket/i,                 ['جسم جردل رويال']],
  [/japanese bucket/i,              ['جسم جردل ياباني']],
  [/tornado bucket/i,               ['جسم جردل تورنيدو ']],
  [/automatic bucket/i,             ['جسم جردل اوتوماتيك']],
  [/super spin/i,                   ['جسم جردل سوبر سبين']],
  [/turkish bucket|turkey bucket/i, ['جسم جردل تركي ']],
];

// ── MATCH FUNCTIONS ──────────────────────────────────────────────────────

function findBarcode(product, profile) {
  // 1. Manually linked Arabic name stored in profile
  if (profile._arName && BARCODES[profile._arName]) {
    const d = BARCODES[profile._arName];
    return { barcode: d.bc?.[0] ?? null, internal_code: d.codes?.[0] ?? null };
  }
  // 2. Auto-match by English product name
  for (const [re, arNames] of EN_AR_BARCODE_MAP) {
    if (re.test(product.en)) {
      for (const ar of arNames) {
        if (BARCODES[ar]) {
          const d = BARCODES[ar];
          return { barcode: d.bc?.[0] ?? null, internal_code: d.codes?.[0] ?? null };
        }
      }
    }
  }
  return { barcode: null, internal_code: null };
}

function findMould(product, profile) {
  // 1. Explicitly linked mould index saved in profile
  if (profile._dpIdx !== undefined && profile._dpIdx !== null) {
    return MOULDS[profile._dpIdx] ?? null;
  }
  // 2. Auto-match by English product name
  for (const [re, arNames] of EN_AR_MOULD_MAP) {
    if (re.test(product.en)) {
      for (const ar of arNames) {
        const m = MOULDS.find(x => x.n === ar);
        if (m) return m;
      }
    }
  }
  return null;
}

// ── TRANSFORM ────────────────────────────────────────────────────────────

function transform(product, profile) {
  const { barcode, internal_code } = findBarcode(product, profile);
  const mould = findMould(product, profile);

  const tonnages = mould
    ? mould.machines.map(v => parseFloat(v)).filter(t => Number.isFinite(t) && t > 0)
    : [];

  return {
    // Primary key (preserve original product id)
    id:                  product.id,
    // Identity
    name:                (profile._enName  || product.en).trim(),
    barcode:             barcode,
    internal_code:       internal_code,

    // Classification
    category:            (profile._catOverride || product.cat).trim(),
    subcategory:         (profile._subOverride || product.sub || '').trim() || null,

    // Physical specs — not yet captured in source data
    weight_g:            null,
    dimensions_json:     null,

    // Moulding specs — from MOULDS row when matched
    cycle_time_sec:      mould ? (Math.round(parseFloat(mould.ct)) || null) : null,
    shot_weight_g:       null,
    pcs_per_cycle:       mould ? (parseInt(mould.pc, 10) || 1) : 1,
    machine_min_tonnage: tonnages.length ? Math.min(...tonnages) : null,
    machine_max_tonnage: tonnages.length ? Math.max(...tonnages) : null,

    bom_json:            [],
  };
}

// ── MAIN ─────────────────────────────────────────────────────────────────

async function main() {
  const divider = '─'.repeat(60);
  console.log('\n' + '═'.repeat(60));
  console.log('  AWP Products → Supabase Migration');
  if (DRY_RUN) console.log('  *** DRY RUN — no writes to database ***');
  console.log('═'.repeat(60));

  // ── STEP 1: Fetch Netlify Blobs profiles ─────────────────────────────
  console.log(`\n[1/5] Fetching profiles from Netlify Blobs`);
  console.log(`      ${NETLIFY_URL}`);

  let profiles = {};
  try {
    const res = await fetch(NETLIFY_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    profiles = await res.json();

    const productKeys = Object.keys(profiles).filter(k => !k.startsWith('_'));
    const customProds = (profiles._customProducts || []).length;
    console.log(`      ✓ ${productKeys.length} product profiles  (${customProds} custom products)`);
  } catch (err) {
    console.warn(`      ⚠ Could not fetch profiles: ${err.message}`);
    console.warn('        Continuing without profile overrides (name/category edits will be lost)');
  }

  // ── STEP 2: Build full product list ──────────────────────────────────
  console.log(`\n[2/5] Merging product list`);

  const allProducts = [...PRODUCTS];
  for (const cp of (profiles._customProducts || [])) {
    if (!allProducts.find(p => p.id === cp.id)) allProducts.push(cp);
  }

  console.log(`      Base products : ${PRODUCTS.length}`);
  console.log(`      Custom added  : ${allProducts.length - PRODUCTS.length}`);
  console.log(`      Total         : ${allProducts.length}`);
  if (allProducts.length !== EXPECTED) {
    console.warn(`      ⚠ Expected ${EXPECTED} — count differs, proceed with caution`);
  }

  // ── STEP 3: Transform ────────────────────────────────────────────────
  console.log(`\n[3/5] Transforming`);

  const rows    = [];
  const skipped = [];

  for (const p of allProducts) {
    const profile = profiles[String(p.id)] || {};
    if (profile._trashed) {
      skipped.push({ id: p.id, name: p.en });
      continue;
    }
    rows.push(transform(p, profile));
  }

  const withBarcode = rows.filter(r => r.barcode).length;
  const withMould   = rows.filter(r => r.cycle_time_sec !== null).length;

  console.log(`      Rows ready     : ${rows.length}`);
  console.log(`      With barcode   : ${withBarcode}`);
  console.log(`      With mould data: ${withMould}`);
  if (skipped.length) {
    console.log(`      Trashed/skip   : ${skipped.length}`);
    skipped.forEach(s => console.log(`        ↷ [${s.id}] ${s.name}`));
  }

  // Internal-code collision check — unique constraint in DB will also catch this
  const codes = rows.map(r => r.internal_code).filter(Boolean);
  const dupes  = codes.filter((c, i) => codes.indexOf(c) !== i);
  if (dupes.length) {
    console.warn(`      ⚠ Duplicate internal_codes: ${[...new Set(dupes)].join(', ')}`);
  }

  if (DRY_RUN) {
    console.log('\n  [DRY RUN] Sample transformed rows (first 3):');
    rows.slice(0, 3).forEach((r, i) => console.log(`    [${i}] ${JSON.stringify(r)}`));
    console.log('\n✓ Dry run complete — no data written.\n');
    return;
  }

  // ── STEP 4: Pre-flight check & optional clear ─────────────────────────
  console.log(`\n[4/5] Inserting`);

  const { count: existing } = await supabase
    .from('products')
    .select('*', { count: 'exact', head: true });

  if (existing > 0) {
    if (CLEAR) {
      console.log(`      Clearing ${existing} existing rows (--clear flag)…`);
      const { error } = await supabase.from('products').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      if (error) { console.error(`      ✗ Clear failed: ${error.message}`); process.exit(1); }
      console.log('      ✓ Table cleared');
    } else {
      console.warn(`      ⚠ Table already has ${existing} rows.`);
      console.warn('        Re-run with --clear to wipe first, or remove duplicates manually.');
      console.warn('        Proceeding — unique constraint on internal_code will reject dupes.');
    }
  }

  // ── Insert in chunks ─────────────────────────────────────────────────
  let inserted = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { data, error } = await supabase.from('products').insert(chunk).select('id, name');

    if (error) {
      console.error(`\n      ✗ Chunk ${i}–${i + chunk.length - 1} failed: ${error.message}`);
      if (error.details) console.error(`        Details: ${error.details}`);

      // Re-try row-by-row to isolate the culprit(s)
      for (const row of chunk) {
        const { error: rowErr } = await supabase.from('products').insert(row);
        if (rowErr) {
          errors.push({ name: row.name, internal_code: row.internal_code, error: rowErr.message });
          console.error(`        ✗ "${row.name}" (${row.internal_code ?? 'no code'}): ${rowErr.message}`);
        } else {
          inserted++;
        }
      }
    } else {
      inserted += chunk.length;
      process.stdout.write(`      Inserted ${inserted}/${rows.length}\r`);
    }
  }
  process.stdout.write('\n');

  // ── STEP 5: Verify ───────────────────────────────────────────────────
  console.log(`\n[5/5] Verifying`);

  const { count: dbCount, error: countErr } = await supabase
    .from('products')
    .select('*', { count: 'exact', head: true });

  if (countErr) {
    console.error(`      ✗ Count query failed: ${countErr.message}`);
  } else {
    const ok = dbCount === inserted;
    console.log(`      DB count  : ${dbCount}`);
    console.log(`      Inserted  : ${inserted}`);
    console.log(`      ${ok ? '✓ Counts match' : '⚠ Count mismatch — check for pre-existing rows'}`);
  }

  // ── SUMMARY ──────────────────────────────────────────────────────────
  console.log('\n' + divider);
  console.log('SUMMARY');
  console.log(divider);
  console.log(`  Source products    : ${allProducts.length}`);
  console.log(`  Skipped (trashed)  : ${skipped.length}`);
  console.log(`  Attempted          : ${rows.length}`);
  console.log(`  Inserted OK        : ${inserted}`);
  console.log(`  Failed             : ${errors.length}`);
  console.log(`  DB total now       : ${dbCount ?? 'N/A'}`);

  if (errors.length) {
    console.log('\nFailed rows:');
    errors.forEach(e =>
      console.log(`  • "${e.name}" (${e.internal_code ?? 'no code'}): ${e.error}`)
    );
  }

  const success = errors.length === 0 && inserted === rows.length;
  console.log(success
    ? '\n✓ Migration complete!\n'
    : '\n⚠ Migration finished with issues. Review errors above.\n'
  );
  if (!success) process.exit(1);
}

main().catch(err => {
  console.error('\nFatal:', err.message ?? err);
  process.exit(1);
});
