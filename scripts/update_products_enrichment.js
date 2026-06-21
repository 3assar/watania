#!/usr/bin/env node
/**
 * update_products_enrichment.js
 * Updates existing Supabase products rows with:
 *   - name_ar   (Arabic name from BARCODES{})
 *   - image_url (from IMG_MAP{} → elwataniaplast.com image URL)
 *
 * Usage:
 *   node --env-file=scripts/.env scripts/update_products_enrichment.js
 *   node --env-file=scripts/.env scripts/update_products_enrichment.js --dry-run
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

function env(name) {
  const v = process.env[name];
  if (!v) { console.error(`ERROR: ${name} is required`); process.exit(1); }
  return v;
}

const SUPABASE_URL = env('SUPABASE_URL');
const SUPABASE_KEY = env('SUPABASE_SERVICE_KEY');

// ── Extract data from index.html ──────────────────────────────────────────────

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
const html     = readFileSync(join(ROOT, 'index.html'), 'utf8');
const PRODUCTS = extractVar(html, 'PRODUCTS');
const BARCODES = extractVar(html, 'BARCODES');
const IMG_MAP  = extractVar(html, 'IMG_MAP');

console.log(`  PRODUCTS : ${PRODUCTS.length}`);
console.log(`  BARCODES : ${Object.keys(BARCODES).length} entries`);
console.log(`  IMG_MAP  : ${Object.keys(IMG_MAP).length} entries`);

// ── Build name_ar lookup: product id → Arabic name ───────────────────────────
// BARCODES = { arabicName: { bc[], codes[], colours[], names[] } }
// Match by codes[] → products.internal_code, or bc[] → products.barcode
// Fetch current products from Supabase to do the reverse lookup.

console.log('\n  Fetching products from Supabase for name_ar matching…');
const prodRes = await fetch(
  `${SUPABASE_URL}/rest/v1/products?select=id,internal_code,barcode&limit=500`,
  { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
);
const dbProducts = await prodRes.json();
// Build lookup maps
const byInternalCode = {};
const byBarcode      = {};
for (const p of dbProducts) {
  if (p.internal_code) byInternalCode[p.internal_code.trim()] = p.id;
  if (p.barcode)       byBarcode[p.barcode.trim()]            = p.id;
}

const arNameById = {};
for (const [arName, data] of Object.entries(BARCODES)) {
  // Try matching each code in codes[]
  for (const code of (data.codes || [])) {
    const id = byInternalCode[code.trim()];
    if (id && !arNameById[id]) arNameById[id] = arName;
  }
  // Try matching each barcode in bc[]
  for (const bc of (data.bc || [])) {
    const id = byBarcode[bc.trim()];
    if (id && !arNameById[id]) arNameById[id] = arName;
  }
}
console.log(`  Mapped Arabic names: ${Object.keys(arNameById).length} products`);

// ── Build image_url lookup ────────────────────────────────────────────────────
// IMG_MAP: { productId: imageId }
// URL pattern: https://elwataniaplast.com/products/thumps/{imageId}_500_500.jpg

const IMAGE_BASE = 'https://elwataniaplast.com/products/thumps';
const imageUrlById = {};
for (const [productId, imageId] of Object.entries(IMG_MAP)) {
  imageUrlById[String(productId)] = `${IMAGE_BASE}/${imageId}_500_500.jpg`;
}
console.log(`  Mapped image URLs : ${Object.keys(imageUrlById).length} products`);

// ── Build update list ─────────────────────────────────────────────────────────

const updates = [];
let noName = 0;
let noImg  = 0;

for (const p of PRODUCTS) {
  const id      = String(p.id);
  const name_ar = arNameById[id] ?? null;
  const image_url = imageUrlById[id] ?? null;

  if (!name_ar) noName++;
  if (!image_url) noImg++;

  // Only update rows that have at least one value to set
  if (name_ar || image_url) {
    updates.push({ id, name_ar, image_url });
  }
}

console.log(`\n  Products with Arabic name : ${updates.filter(u => u.name_ar).length}`);
console.log(`  Products without Arabic   : ${noName}`);
console.log(`  Products with image URL   : ${updates.filter(u => u.image_url).length}`);
console.log(`  Products without image    : ${noImg}`);
console.log(`  Total updates to apply    : ${updates.length}`);

if (DRY_RUN) {
  console.log('\n[DRY RUN] First 5 updates:');
  updates.slice(0, 5).forEach(u => console.log(`  id=${u.id}  name_ar=${u.name_ar}  image_url=${u.image_url}`));
  console.log('\n✓ Dry run complete.\n');
  process.exit(0);
}

// ── REST helper ───────────────────────────────────────────────────────────────

const HEADERS = {
  apikey:         SUPABASE_KEY,
  Authorization:  `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer:         'return=minimal',
};

async function patchProduct(id, patch) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/products?id=eq.${encodeURIComponent(id)}`, {
    method:  'PATCH',
    headers: HEADERS,
    body:    JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log('  AWP Products Enrichment Update');
  console.log('═'.repeat(60) + '\n');

  let ok = 0;
  const errors = [];

  for (let i = 0; i < updates.length; i++) {
    const { id, name_ar, image_url } = updates[i];
    const patch = {};
    if (name_ar)   patch.name_ar   = name_ar;
    if (image_url) patch.image_url = image_url;

    try {
      await patchProduct(id, patch);
      ok++;
      process.stdout.write(`  Updated ${ok}/${updates.length}\r`);
    } catch (err) {
      errors.push({ id, error: err.message });
      console.error(`\n  ✗ id=${id}: ${err.message}`);
    }
  }
  process.stdout.write('\n');

  // Verify a sample
  const sampleId = updates[0]?.id;
  if (sampleId) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/products?id=eq.${sampleId}&select=id,name,name_ar,image_url`,
      { headers: HEADERS }
    );
    const [row] = await res.json();
    console.log(`\n  Sample verify [id=${sampleId}]:`, row);
  }

  console.log('\n' + '─'.repeat(60));
  console.log('SUMMARY');
  console.log('─'.repeat(60));
  console.log(`  Updates attempted : ${updates.length}`);
  console.log(`  Succeeded         : ${ok}`);
  console.log(`  Failed            : ${errors.length}`);
  if (errors.length) {
    errors.forEach(e => console.log(`  • id=${e.id}: ${e.error}`));
  }
  console.log(errors.length === 0 ? '\n✓ Done!\n' : '\n⚠ Finished with errors.\n');
  if (errors.length) process.exit(1);
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
