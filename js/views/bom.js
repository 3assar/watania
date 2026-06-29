// BOM viewer (read-only) — Gate 1. ES module; shared layer via ../api.js (window.AWP bridge).
// Part-centric: moulds aren't linked to the products catalog yet (moulds.product_id is null),
// so we browse by mould/part + group_ar. Product-centric view comes once the link is built.
import { SB, getSession } from '../api.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let PARTS = [];          // [{compId, name_ar, group_ar, mould_code}]
let loadedMaterials = false;

async function start() {
  try {
    const s = getSession && getSession();
    if (s) $('user-badge').textContent = `${s.username} · ${s.role}`;
  } catch {}
  wireTabs();
  $('part-search').addEventListener('input', renderPartList);
  $('group-filter').addEventListener('change', renderPartList);
  await loadParts();
}
window.bomStart = start;
if (window.__bomReady) start();   // auth may have resolved before this module loaded

function wireTabs() {
  document.querySelectorAll('.bom-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.bom-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const v = btn.dataset.view;
      $('view-parts').style.display     = v === 'parts'     ? '' : 'none';
      $('view-materials').style.display = v === 'materials' ? '' : 'none';
      if (v === 'materials' && !loadedMaterials) loadMaterials();
    });
  });
}

// ── Parts (moulds) ────────────────────────────────────────────────────────────
async function loadParts() {
  try {
    const rows = await SB.fetch('/bom_components?select=id,moulds(name_ar,group_ar,mould_code)&order=id');
    PARTS = (rows || []).map(r => ({
      compId: r.id,
      name_ar: r.moulds?.name_ar || '',
      group_ar: r.moulds?.group_ar || '—',
      mould_code: r.moulds?.mould_code || '',
    }));
    // group filter options
    const groups = [...new Set(PARTS.map(p => p.group_ar))].sort((a, b) => a.localeCompare(b, 'ar'));
    const sel = $('group-filter');
    groups.forEach(g => { const o = document.createElement('option'); o.value = g; o.textContent = g; sel.appendChild(o); });
    $('part-hint').textContent = `${PARTS.length} parts across ${groups.length} groups · search or pick a group, then tap a part`;
    renderPartList();
  } catch (e) {
    $('part-hint').textContent = 'Failed to load parts: ' + e.message;
  }
}

function renderPartList() {
  const q = ($('part-search').value || '').trim().toLowerCase();
  const g = $('group-filter').value;
  let list = PARTS;
  if (g) list = list.filter(p => p.group_ar === g);
  if (q) list = list.filter(p =>
    p.name_ar.toLowerCase().includes(q) || p.group_ar.toLowerCase().includes(q) || p.mould_code.toLowerCase().includes(q));
  const shown = list.slice(0, 150);
  $('part-list').innerHTML = shown.length
    ? shown.map(p => `
      <div class="prod-row" data-cid="${p.compId}">
        <div>
          <div class="pa pn">${esc(p.name_ar || '(no name)')}</div>
          <div class="pa" style="font-weight:400">${esc(p.group_ar)}${p.mould_code ? ' · ' + esc(p.mould_code) : ''}</div>
        </div>
      </div>`).join('')
    : `<div class="empty">No parts match.</div>`;
  if (list.length > shown.length)
    $('part-list').innerHTML += `<div class="bom-hint">Showing first 150 of ${list.length} — refine your search or pick a group.</div>`;
  $('part-list').querySelectorAll('.prod-row').forEach(row =>
    row.addEventListener('click', () => showPartDetail(row.dataset.cid)));
}

async function showPartDetail(compId) {
  const box = $('part-detail');
  box.innerHTML = `<div class="bom-hint">Loading BOM…</div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const sel = 'id,part_weight_g,moulds(name_ar,group_ar,mould_code),' +
    'bom_recipes(name,is_default,active,bom_recipe_materials(ratio_qty,qty_explicit,position,materials(name_ar,polymer_type))),' +
    'bom_component_colours(colours(name_ar))';
  try {
    const rows = await SB.fetch(`/bom_components?id=eq.${encodeURIComponent(compId)}&select=${encodeURIComponent(sel)}`);
    if (!rows || !rows.length) { box.innerHTML = `<div class="empty">Part not found.</div>`; return; }
    box.innerHTML = renderPart(rows[0]);
  } catch (e) {
    box.innerHTML = `<div class="empty">Failed to load BOM: ${esc(e.message)}</div>`;
  }
}

function renderPart(c) {
  const m = c.moulds || {};
  const recipes = (c.bom_recipes || []).slice().sort((a, b) => (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0));
  const colours = (c.bom_component_colours || []).map(x => x.colours?.name_ar).filter(Boolean);
  return `
    <div class="card">
      <div class="part-hdr">
        <div class="part-name">${esc(m.name_ar || 'Part')}</div>
        <div class="part-meta">${esc(m.group_ar || '')}${m.mould_code ? ' · mould ' + esc(m.mould_code) : ''}${c.part_weight_g ? ' · ' + esc(c.part_weight_g) + ' g' : ''}</div>
      </div>
      ${recipes.length ? recipes.map(renderRecipe).join('') : '<div class="empty">No recipe.</div>'}
      <div class="sub-lbl">Colours (${colours.length})</div>
      <div class="col-chips">${colours.length ? colours.map(x => `<span class="col-chip">${esc(x)}</span>`).join('') : '<span class="bom-hint">—</span>'}</div>
    </div>`;
}

function renderRecipe(r) {
  const mats = (r.bom_recipe_materials || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0));
  const badge = r.is_default ? '<span class="badge def">DEFAULT</span>' : '<span class="badge alt">ALT</span>';
  const off = r.active ? '' : '<span class="badge off">OFF</span>';
  return `
    <div class="recipe">
      <div class="recipe-name">${badge}${off}<span>${esc(r.name || 'Recipe')}</span></div>
      <div class="mat-chips">
        ${mats.map(mm => `<span class="mat-chip">${esc(mm.materials?.name_ar || '?')} <b>×${esc(mm.ratio_qty)}</b>${mm.qty_explicit ? '' : '<span class="star" title="quantity not written; defaulted to 1 part">*</span>'}</span>`).join('')}
      </div>
    </div>`;
}

// ── Materials master ──────────────────────────────────────────────────────────
async function loadMaterials() {
  loadedMaterials = true;
  try {
    const rows = await SB.fetch('/materials?select=name_ar,name_en,polymer_type,grade,modifier&order=polymer_type,name_ar');
    $('mat-hint').textContent = `${rows.length} materials`;
    $('mat-table').innerHTML = `
      <table class="mtable">
        <thead><tr><th>Material</th><th>Type</th><th>Grade</th><th>Modifier</th></tr></thead>
        <tbody>
          ${rows.map(m => `<tr>
            <td class="ar">${esc(m.name_ar)}</td>
            <td>${esc(m.polymer_type || '—')}</td>
            <td>${esc(m.grade || '—')}</td>
            <td>${esc(m.modifier || '—')}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  } catch (e) {
    $('mat-hint').textContent = 'Failed to load materials: ' + e.message;
  }
}
