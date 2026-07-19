import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import './style.css';

const appWindow = getCurrentWindow();

setTimeout(() => {
  appWindow.show();
  appWindow.setFocus();
  document.body.classList.add('ready');
}, 150);

/* ---------------- state ---------------- */

const DEFAULT_PYTHON = 'C:\\Users\\CRZ\\Documents\\lora-inspect\\venv\\Scripts\\python.exe';

const state = {
  files: [],
  selected: null,     // file entry
  analysis: null,     // analysis of selected
  filter: '',
  busyCount: 0,
};

const $ = (id) => document.getElementById(id);
const settings = {
  get python() { return localStorage.getItem('ll_python') || DEFAULT_PYTHON; },
  set python(v) { localStorage.setItem('ll_python', v); },
  get folder() { return localStorage.getItem('ll_folder') || ''; },
  set folder(v) { localStorage.setItem('ll_folder', v); },
  get cap() { return localStorage.getItem('ll_cap') || '5.0'; },
  set cap(v) { localStorage.setItem('ll_cap', v); },
};

const cacheKey = (f) => `ll_a:${f.path}:${f.mtime}:${f.size}`;
const getCached = (f) => {
  try { const s = localStorage.getItem(cacheKey(f)); return s ? JSON.parse(s) : null; }
  catch { return null; }
};
const setCached = (f, analysis) => {
  try { localStorage.setItem(cacheKey(f), JSON.stringify(analysis)); }
  catch { pruneCache(); try { localStorage.setItem(cacheKey(f), JSON.stringify(analysis)); } catch {} }
};
function pruneCache() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('ll_a:')) keys.push(k);
  }
  keys.slice(0, Math.ceil(keys.length / 2)).forEach((k) => localStorage.removeItem(k));
}

/* ---------------- backend ---------------- */

async function tool(args, busyText) {
  if (busyText) setBusy(true, busyText);
  try {
    const out = await invoke('run_tool', { python: settings.python, args });
    let data;
    try { data = JSON.parse(out); }
    catch { throw new Error(`backend returned non-JSON: ${out.slice(0, 300)}`); }
    if (data.error) throw new Error(data.error);
    return data;
  } finally {
    if (busyText) setBusy(false);
  }
}

function setBusy(on, text) {
  state.busyCount += on ? 1 : -1;
  if (state.busyCount < 0) state.busyCount = 0;
  $('busy').classList.toggle('hidden', state.busyCount === 0);
  if (on && text) $('busy-text').textContent = text;
}

function toast(msg, isError) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', !!isError);
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), isError ? 6000 : 3000);
}

/* ---------------- scan + file list ---------------- */

async function scan() {
  const dir = $('folder-input').value.trim();
  if (!dir) { toast('Enter or browse to a folder first', true); return; }
  settings.folder = dir;
  try {
    const data = await tool(['scan', dir], 'scanning folder...');
    state.files = data.files;
    renderList();
    $('list-status').textContent = `${state.files.length} files`;
    if (!state.files.length) toast('No .safetensors found in that folder', true);
  } catch (e) {
    toast(String(e.message || e), true);
  }
}

function fmtSize(b) {
  if (b > 1e9) return (b / 1e9).toFixed(2) + ' GB';
  if (b > 1e6) return (b / 1e6).toFixed(0) + ' MB';
  return (b / 1e3).toFixed(0) + ' KB';
}
function fmtDate(t) {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function badgeFor(f) {
  const a = getCached(f);
  if (!a) return '<span class="badge unknown">?</span>';
  if (a.type === 'lokr') return `<span class="badge lokr">lokr</span><span class="badge ${a.verdict}">${a.verdict} ${a.peak_smax.toFixed(1)}</span>`;
  return `<span class="badge ${a.verdict}">${a.verdict} ${a.peak_smax.toFixed(1)}</span>`;
}

function renderList() {
  const list = $('filelist');
  const q = state.filter.toLowerCase();
  const files = state.files.filter((f) => !q || f.rel.toLowerCase().includes(q));
  let html = '';
  let lastDir = null;
  for (const f of files) {
    if (f.dir !== lastDir) {
      lastDir = f.dir;
      html += `<div class="dir-head">${escapeHtml(f.dir === '.' ? '/' : f.dir)}</div>`;
    }
    const sel = state.selected && state.selected.path === f.path ? ' selected' : '';
    const clipCls = f.is_clip ? ' clipfile' : '';
    html += `<div class="file-item${sel}${clipCls}" data-path="${escapeHtml(f.path)}">
      <div class="fmeta">
        <div class="fname">${escapeHtml(f.name)}</div>
        <div class="fsub">${fmtSize(f.size)} &middot; ${fmtDate(f.mtime)}</div>
      </div>
      ${badgeFor(f)}
    </div>`;
  }
  list.innerHTML = html || '<div class="dir-head">no matches</div>';
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------------- analysis ---------------- */

async function selectFile(path) {
  const f = state.files.find((x) => x.path === path);
  if (!f) return;
  state.selected = f;
  renderList();
  const cached = getCached(f);
  if (cached) {
    state.analysis = cached;
    renderReport();
    return;
  }
  await analyzeSelected();
}

async function analyzeSelected() {
  const f = state.selected;
  if (!f) return;
  try {
    const a = await tool(['analyze', f.path], `analyzing ${f.name} ...`);
    setCached(f, a);
    state.analysis = a;
    renderList();
    renderReport();
  } catch (e) {
    toast(String(e.message || e), true);
  }
}

async function analyzeAll() {
  const q = state.filter.toLowerCase();
  const pending = state.files.filter((f) => (!q || f.rel.toLowerCase().includes(q)) && !getCached(f));
  if (!pending.length) { toast('Everything in the list is already analyzed'); return; }
  const btn = $('btn-analyze-all');
  btn.disabled = true;
  let done = 0;
  for (const f of pending) {
    $('list-status').textContent = `analyzing ${++done}/${pending.length}: ${f.name}`;
    try {
      const a = await tool(['analyze', f.path]);
      setCached(f, a);
      renderList();
    } catch (e) {
      toast(`${f.name}: ${e.message || e}`, true);
    }
  }
  $('list-status').textContent = `${state.files.length} files`;
  btn.disabled = false;
  toast(`Analyzed ${done} files`);
}

/* ---------------- report ---------------- */

function statCls(a) {
  return a.verdict === 'healthy' ? 'good' : a.verdict === 'spiked' ? 'bad' : 'warn';
}

function renderReport() {
  const a = state.analysis;
  if (!a) return;
  $('empty-state').classList.add('hidden');
  $('report').classList.remove('hidden');
  $('clip-result').classList.add('hidden');
  $('clip-status').textContent = '';

  $('report-name').textContent = a.name;
  $('report-chips').innerHTML =
    `<span class="chip ${a.verdict}">${a.verdict}</span>` +
    `<span class="chip type">${a.type} &middot; ${a.module_count} modules</span>`;

  const vcls = statCls(a);
  $('stats-row').innerHTML = `
    <div class="stat"><div class="v ${vcls}">${a.peak_smax.toFixed(1)}</div><div class="k">peak &sigma;_max</div></div>
    <div class="stat"><div class="v">${a.median_smax.toFixed(2)}</div><div class="k">median &sigma;_max</div></div>
    <div class="stat"><div class="v ${a.median_srank < 2 && a.type === 'lora' ? 'bad' : 'good'}">${a.median_srank.toFixed(1)}</div><div class="k">median stable rank</div></div>
    <div class="stat"><div class="v ${a.over_cap_5 ? 'warn' : 'good'}">${a.over_cap_5}</div><div class="k">modules &sigma; &gt; 5</div></div>
    <div class="stat"><div class="v">${a.total_norm.toFixed(0)}</div><div class="k">total &Delta; norm</div></div>`;

  $('chart-sub').textContent = `— ${a.module_count} modules, cap line at ${parseFloat($('cap-input').value || settings.cap) || 5}`;
  drawChart();

  const tb = $('offenders').querySelector('tbody');
  const top = [...a.modules].sort((x, y) => y.smax - x.smax).slice(0, 10);
  tb.innerHTML = top.map((m) => {
    const hot = m.smax > 8 ? ' class="hot"' : '';
    const short = m.mod.replace('diffusion_model.', '');
    return `<tr><td${hot} data-tip="${escapeHtml(m.mod)}">${escapeHtml(short)}</td><td class="num${m.smax > 8 ? ' hot' : ''}">${m.smax.toFixed(2)}</td><td class="num">${m.srank.toFixed(1)}</td></tr>`;
  }).join('');

  const clippable = a.type === 'lora';
  $('btn-clip').disabled = !clippable;
  $('verdict-note').innerHTML = verdictNote(a);
}

function verdictNote(a) {
  if (a.type === 'lokr') {
    return `<b class="good">LoKr file.</b> Full&#8209;rank Kronecker parameterization &mdash; structurally resistant to the rank&#8209;1 spike. ${a.verdict === 'healthy' ? 'Spectrally healthy; stack freely.' : 'Unusual spectrum for a LoKr &mdash; worth a stacking test.'} Clipping is not implemented (or needed) for LoKr.`;
  }
  if (a.verdict === 'healthy') {
    return `<b class="good">Stackable as-is.</b> Peak &sigma; ${a.peak_smax.toFixed(1)} is within the healthy ceiling (~5). No clip needed.`;
  }
  if (a.verdict === 'spiked') {
    return `<b class="bad">Will break stacking.</b> ${a.over_cap_5} of ${a.module_count} modules exceed &sigma; 5 (peak ${a.peak_smax.toFixed(1)}, median stable rank ${a.median_srank.toFixed(1)} &asymp; rank&#8209;1). Alone it may look fine &mdash; combined with any other LoRA, fine detail will collapse. Clip before use.`;
  }
  return `<b class="warn">Borderline.</b> Peak &sigma; ${a.peak_smax.toFixed(1)}. May stack acceptably at reduced strength; clipping at 5 is the safe move.`;
}

/* ---------------- chart ---------------- */

function drawChart() {
  const a = state.analysis;
  if (!a) return;
  const canvas = $('chart');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const css = getComputedStyle(document.documentElement);
  const cGood = css.getPropertyValue('--good').trim();
  const cBad = css.getPropertyValue('--bad').trim();
  const cAccent = css.getPropertyValue('--accent').trim();
  const cDim = 'rgba(200,200,200,0.35)';

  const sorted = [...a.modules].sort((x, y) => y.smax - x.smax);
  const cap = parseFloat($('cap-input').value) || 5;
  const maxV = Math.max(a.peak_smax, cap * 1.3, 6);
  const padL = 30, padB = 14, padT = 6;
  const plotW = w - padL - 4, plotH = h - padT - padB;
  const n = sorted.length;
  const bw = Math.max(1, plotW / n - 1);

  // y gridlines at 0, 5, 10, 20
  ctx.font = '9px Consolas, monospace';
  ctx.fillStyle = cDim;
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  for (const gv of [0, 5, 10, 15, 20, 25].filter((v) => v <= maxV)) {
    const y = padT + plotH - (gv / maxV) * plotH;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - 4, y); ctx.stroke();
    ctx.fillText(String(gv), 4, y + 3);
  }

  canvas._bars = [];
  sorted.forEach((m, i) => {
    const x = padL + (i / n) * plotW;
    const bh = Math.max(1, (m.smax / maxV) * plotH);
    ctx.fillStyle = m.smax > cap ? cBad : cGood;
    ctx.fillRect(x, padT + plotH - bh, bw, bh);
    canvas._bars.push({ x, w: Math.max(bw, 3), m });
  });

  // cap line
  const capY = padT + plotH - (cap / maxV) * plotH;
  ctx.strokeStyle = cAccent;
  ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(padL, capY); ctx.lineTo(w - 4, capY); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = cAccent;
  ctx.fillText(`cap ${cap}`, w - 44, capY - 4);
}

function chartHover(ev) {
  const canvas = $('chart');
  const tip = $('chart-tip');
  if (!canvas._bars || !state.analysis) return;
  const rect = canvas.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const hit = canvas._bars.find((b) => x >= b.x && x <= b.x + b.w + 1);
  if (!hit) { tip.classList.add('hidden'); return; }
  const m = hit.m;
  const cap = parseFloat($('cap-input').value) || 5;
  tip.innerHTML = `${escapeHtml(m.mod.replace('diffusion_model.', ''))}<br>` +
    `<span class="${m.smax > cap ? 'tt-bad' : 'tt-good'}">&sigma; ${m.smax.toFixed(2)}</span> · sr ${m.srank.toFixed(1)}`;
  tip.classList.remove('hidden');
  const wrapRect = $('chart-wrap').getBoundingClientRect();
  let tx = ev.clientX - wrapRect.left + 12;
  if (tx + tip.offsetWidth > wrapRect.width - 8) tx = ev.clientX - wrapRect.left - tip.offsetWidth - 12;
  tip.style.left = tx + 'px';
  tip.style.top = (ev.clientY - wrapRect.top - 10) + 'px';
}

/* ---------------- clip ---------------- */

async function clipSelected() {
  const a = state.analysis;
  if (!a || a.type !== 'lora') return;
  const cap = parseFloat($('cap-input').value);
  if (!cap || cap <= 0) { toast('Enter a valid cap', true); return; }
  settings.cap = String(cap);
  try {
    const r = await tool(['clip', a.path, String(cap)], `clipping at ${cap} ...`);
    const res = r.result;
    $('clip-status').textContent = '';
    const el = $('clip-result');
    el.classList.remove('hidden');
    el.innerHTML = `
      <div>wrote <span class="dst">${escapeHtml(r.dst.split(/[\\/]/).pop())}</span> &mdash; ${r.clipped_modules}/${r.total_modules} modules clipped</div>
      <div class="ba">
        <span class="h"></span><span class="h">before</span><span class="h">after</span>
        <span class="h" style="align-self:center">peak &sigma;</span><span>${a.peak_smax.toFixed(2)}</span><span style="color:var(--good)">${res.peak_smax.toFixed(2)}</span>
        <span class="h" style="align-self:center">&sigma; &gt; 5</span><span>${a.over_cap_5}</span><span style="color:var(--good)">${res.over_cap_5}</span>
        <span class="h" style="align-self:center">verdict</span><span>${a.verdict}</span><span style="color:var(--good)">${res.verdict}</span>
      </div>`;
    toast(`Clipped → ${r.dst.split(/[\\/]/).pop()}`);
    await scanRefreshKeep();
  } catch (e) {
    toast(String(e.message || e), true);
  }
}

async function scanRefreshKeep() {
  const dir = settings.folder;
  if (!dir) return;
  try {
    const data = await tool(['scan', dir]);
    state.files = data.files;
    // seed cache for any file we already analyzed via clip result
    renderList();
    $('list-status').textContent = `${state.files.length} files`;
  } catch { /* silent */ }
}

/* ---------------- custom tooltips ---------------- */

function bindTooltips() {
  const tip = $('tooltip');
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tip]');
    if (!el) { tip.classList.add('hidden'); return; }
    tip.textContent = el.getAttribute('data-tip');
    tip.classList.remove('hidden');
    const r = el.getBoundingClientRect();
    tip.style.left = Math.min(r.left, window.innerWidth - tip.offsetWidth - 8) + 'px';
    tip.style.top = (r.bottom + 4) + 'px';
  });
}

/* ---------------- sidebar resize ---------------- */

function bindResizer() {
  const saved = parseInt(localStorage.getItem('ll_sidebar_w'), 10);
  if (saved) document.documentElement.style.setProperty('--sidebar-w', saved + 'px');

  const resizer = $('resizer');
  let raf = 0;

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    resizer.classList.add('dragging');
    document.body.classList.add('resizing');

    const onMove = (ev) => {
      const w = Math.min(Math.max(ev.clientX, 180), window.innerWidth * 0.6);
      document.documentElement.style.setProperty('--sidebar-w', w + 'px');
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (state.analysis) drawChart(); });
    };
    const onUp = (ev) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      resizer.classList.remove('dragging');
      document.body.classList.remove('resizing');
      const w = Math.min(Math.max(ev.clientX, 180), window.innerWidth * 0.6);
      localStorage.setItem('ll_sidebar_w', String(Math.round(w)));
      if (state.analysis) drawChart();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  resizer.addEventListener('dblclick', () => {
    document.documentElement.style.setProperty('--sidebar-w', '290px');
    localStorage.setItem('ll_sidebar_w', '290');
    if (state.analysis) drawChart();
  });
}

/* ---------------- init ---------------- */

function init() {
  $('folder-input').value = settings.folder;
  $('python-input').value = settings.python;
  $('cap-input').value = settings.cap;
  $('default-cap').value = settings.cap;

  $('btn-scan').addEventListener('click', scan);
  $('folder-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') scan(); });

  $('btn-browse').addEventListener('click', async () => {
    try {
      const r = await tool(['pick']);
      if (r.dir) { $('folder-input').value = r.dir.replace(/\//g, '\\'); scan(); }
    } catch (e) { toast(String(e.message || e), true); }
  });

  $('btn-settings').addEventListener('click', () => $('settings-row').classList.toggle('hidden'));
  $('python-input').addEventListener('change', () => { settings.python = $('python-input').value.trim(); });
  $('default-cap').addEventListener('change', () => {
    settings.cap = $('default-cap').value.trim();
    $('cap-input').value = settings.cap;
  });

  $('filter-input').addEventListener('input', () => { state.filter = $('filter-input').value; renderList(); });
  $('btn-analyze-all').addEventListener('click', analyzeAll);

  $('filelist').addEventListener('click', (e) => {
    const item = e.target.closest('.file-item');
    if (item) selectFile(item.getAttribute('data-path'));
  });

  $('btn-clip').addEventListener('click', clipSelected);
  document.querySelectorAll('.preset').forEach((b) =>
    b.addEventListener('click', () => { $('cap-input').value = b.dataset.cap; drawChart(); }));
  $('cap-input').addEventListener('change', drawChart);

  $('chart').addEventListener('mousemove', chartHover);
  $('chart').addEventListener('mouseleave', () => $('chart-tip').classList.add('hidden'));
  window.addEventListener('resize', () => { if (state.analysis) drawChart(); });

  bindTooltips();
  bindResizer();

  if (settings.folder) scan();
}

document.addEventListener('DOMContentLoaded', init);
