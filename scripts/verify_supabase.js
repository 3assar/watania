#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';

function env(name) { const v = process.env[name]; if (!v) { console.error(`ERROR: ${name} env var is required`); process.exit(1); } return v; }

const SUPABASE_URL = env('SUPABASE_URL');
const SUPABASE_KEY = env('SUPABASE_SERVICE_KEY');
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
  console.log('Running Supabase verifications for `products` table...');

  // Total count
  const { count: total, error: cntErr } = await supabase.from('products').select('id', { count: 'exact', head: true });
  if (cntErr) { console.error('Count query failed:', cntErr.message); process.exit(1); }
  console.log(`Total products: ${total}`);

  // Sample rows
  const { data: sample, error: sampleErr } = await supabase.from('products').select('id, name, internal_code, barcode, category, active').order('id', { ascending: true }).limit(20);
  if (sampleErr) { console.error('Sample query failed:', sampleErr.message); process.exit(1); }
  console.log('\nSample rows (first 20):');
  sample.forEach(r => console.log(` - ${r.id} | ${r.name} | code=${r.internal_code ?? 'NULL'} | bc=${r.barcode ?? 'NULL'} | cat=${r.category} | active=${r.active}`));

  // Fetch all internal_codes to detect duplicates
  const { data: all, error: allErr } = await supabase.from('products').select('id, name, internal_code');
  if (allErr) { console.error('Full fetch failed:', allErr.message); process.exit(1); }

  const codes = new Map();
  for (const r of all) {
    if (!r.internal_code) continue;
    const list = codes.get(r.internal_code) || [];
    list.push(r.id);
    codes.set(r.internal_code, list);
  }
  const dupes = [...codes.entries()].filter(([k, v]) => v.length > 1);
  console.log(`\nDuplicate internal_code count: ${dupes.length}`);
  if (dupes.length) dupes.slice(0, 20).forEach(([k, v]) => console.log(` - ${k}: ${v.join(', ')}`));

  // Null checks
  const q = async (expr) => {
    const { count, error } = await supabase.from('products').select('id', { count: 'exact', head: true }).filter(expr.field, expr.op, expr.value);
    if (error) { console.error('Null-check failed:', error.message); return null; }
    return count;
  };

  const nullBarcode = await q({ field: 'barcode', op: 'is', value: null });
  const nullWeight  = await q({ field: 'weight_g', op: 'is', value: null });
  const nullDims    = await q({ field: 'dimensions_json', op: 'is', value: null });

  console.log(`\nNull barcode count: ${nullBarcode}`);
  console.log(`Null weight_g count: ${nullWeight}`);
  console.log(`Null dimensions_json count: ${nullDims}`);

  // dye_ratio deviations
  const { data: dyeDiff, error: dyeErr } = await supabase.from('products').select('id, name, dye_ratio').neq('dye_ratio', 0.5).limit(50);
  if (dyeErr) { console.error('dye query failed:', dyeErr.message); } else {
    console.log(`\nProducts with dye_ratio != 0.5 (sample up to 50): ${dyeDiff.length}`);
    dyeDiff.slice(0, 10).forEach(r => console.log(` - ${r.id} | ${r.name} | dye_ratio=${r.dye_ratio}`));
  }

  console.log('\nVerification complete.');
}

main().catch(e => { console.error('Fatal:', e.message ?? e); process.exit(1); });
