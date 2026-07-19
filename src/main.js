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
  analysis: null,     // full analysis of selected
  fullCache: new Map(), // path -> full analysis (session only; python has a disk cache too)
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
  // Badges only need a summary — the full module list lives in state.fullCache
  // (and in python's disk cache), so localStorage stays far below quota.
  const { modules, ...summary } = analysis;
  try { localStorage.setItem(cacheKey(f), JSON.stringify(summary)); }
  catch { pruneCache(); try { localStorage.setItem(cacheKey(f), JSON.stringify(summary)); } catch {} }
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
    computeRuns();
    renderRuns();
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
  const full = state.fullCache.get(f.path);
  if (full && full.mtime === f.mtime) {
    state.analysis = full;
    renderReport();
    return;
  }
  // No full report in memory — ask the backend (its disk cache makes repeats fast)
  await analyzeSelected();
}

async function analyzeSelected() {
  const f = state.selected;
  if (!f) return;
  try {
    const a = await tool(['analyze', f.path], `analyzing ${f.name} ...`);
    state.fullCache.set(f.path, a);
    setCached(f, a);
    state.analysis = a;
    renderList();
    renderReport();
  } catch (e) {
    toast(String(e.message || e), true);
  }
}

async function analyzeAll() {
  try { await refreshFiles(); } catch { /* keep stale list */ }
  const q = state.filter.toLowerCase();
  const pending = state.files.filter((f) => (!q || f.rel.toLowerCase().includes(q)) && !getCached(f));
  if (!pending.length) { toast('Everything in the list is already analyzed'); return; }
  const btn = $('btn-analyze-all');
  btn.disabled = true;

  // Pool of parallel workers — each analysis is its own python process, so this
  // is real multi-core parallelism. 3 keeps disk IO sane on big checkpoint files.
  const CONCURRENCY = 3;
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < pending.length) {
      const f = pending[next++];
      try {
        const a = await tool(['analyze', f.path]);
        state.fullCache.set(f.path, a);
        setCached(f, a);
        renderList();
      } catch (e) {
        toast(`${f.name}: ${e.message || e}`, true);
      }
      done++;
      $('list-status').textContent = `analyzing ${done}/${pending.length} (${CONCURRENCY} at a time)`;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));

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

/* ---------------- training tab ---------------- */

const train = { runs: [], selected: null, traj: null, trajKey: null };

function computeRuns() {
  const groups = new Map();
  for (const f of state.files) {
    if (f.is_clip) continue;
    const m = f.name.match(/^(.*?)_?(\d{4,9})\.safetensors$/);
    if (!m) continue;
    const key = f.dir + '|' + m[1];
    if (!groups.has(key)) groups.set(key, { key, name: m[1], dir: f.dir, ckpts: [] });
    groups.get(key).ckpts.push({ step: parseInt(m[2], 10), file: f });
  }
  train.runs = [...groups.values()]
    .filter((r) => r.ckpts.length >= 2)
    .map((r) => { r.ckpts.sort((a, b) => a.step - b.step); return r; })
    .sort((a, b) => b.ckpts[b.ckpts.length - 1].file.mtime - a.ckpts[a.ckpts.length - 1].file.mtime);
}

function renderRuns() {
  const q = state.filter.toLowerCase();
  const runs = train.runs.filter((r) => !q || (r.dir + '/' + r.name).toLowerCase().includes(q));
  $('runlist').innerHTML = runs.map((r) => {
    const sel = train.selected === r.key ? ' selected' : '';
    const steps = r.ckpts;
    return `<div class="run-item${sel}" data-run="${escapeHtml(r.key)}">
      <div class="rname">${escapeHtml(r.name)}</div>
      <div class="rsub">${escapeHtml(r.dir === '.' ? '/' : r.dir)} &middot; ${steps.length} ckpts &middot; ${steps[0].step}&ndash;${steps[steps.length - 1].step}</div>
    </div>`;
  }).join('') || '<div class="dir-head">no runs found (need 2+ numbered checkpoints)</div>';
}

function selectRun(key) {
  train.selected = key;
  renderRuns();
  const r = train.runs.find((x) => x.key === key);
  if (!r) return;
  $('train-empty').classList.add('hidden');
  $('train-report').classList.remove('hidden');
  $('train-name').textContent = r.name;
  $('btn-analyze-run').textContent = `Analyze run (${r.ckpts.length} checkpoints)`;
  if (train.trajKey === key && train.traj) {
    renderTraining(r);
  } else {
    $('train-charts').classList.add('hidden');
    $('train-status').textContent = 'not analyzed yet — first pass reads every checkpoint (fast when already analyzed in Inspect)';
  }
}

async function refreshFiles() {
  const dir = settings.folder;
  if (!dir) return;
  const data = await tool(['scan', dir]);
  state.files = data.files;
  renderList();
  computeRuns();
  renderRuns();
  $('list-status').textContent = `${state.files.length} files`;
}

async function analyzeRun() {
  let r = train.runs.find((x) => x.key === train.selected);
  if (!r) return;
  const btn = $('btn-analyze-run');
  btn.disabled = true;
  try {
    // pick up checkpoints saved since the last scan — Analyze means "what's there now"
    $('train-status').textContent = 'rescanning folder...';
    try {
      await refreshFiles();
      r = train.runs.find((x) => x.key === train.selected) || r;
      btn.textContent = `Analyze run (${r.ckpts.length} checkpoints)`;
    } catch { /* scan failure surfaces below via traj */ }
    // warm the per-file analysis cache in parallel first, then one traj call
    // (traj hits the disk cache for analyses and only loads factors for cosines)
    const pending = r.ckpts.map((c) => c.file).filter((f) => !getCached(f));
    let done = 0;
    let next = 0;
    const worker = async () => {
      while (next < pending.length) {
        const f = pending[next++];
        try {
          const a = await tool(['analyze', f.path]);
          state.fullCache.set(f.path, a);
          setCached(f, a);
        } catch { /* surfaced by traj below if fatal */ }
        $('train-status').textContent = `analyzing checkpoints ${++done}/${pending.length} (3 at a time)...`;
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, worker));

    $('train-status').textContent = 'computing direction trajectory (loads pairs of checkpoints, cached after first run)...';
    const traj = await tool(['traj', ...r.ckpts.map((c) => c.file.path)]);
    train.traj = traj;
    train.trajKey = r.key;
    renderList();
    renderTraining(r);
  } catch (e) {
    $('train-status').textContent = '';
    toast(String(e.message || e), true);
  } finally {
    btn.disabled = false;
  }
}

function analyzeTrajectory(steps, traj) {
  const norms = traj.files.map((f) => f.total_norm);
  const sranks = traj.files.map((f) => f.median_srank);
  const peaks = traj.files.map((f) => f.peak_smax);
  const cosines = traj.cosines;
  const n = steps.length;

  // direction lock: first checkpoint whose update direction matches the previous
  let lock = -1;
  for (let i = 1; i < n; i++) {
    if (cosines[i] != null && cosines[i] >= 0.995) { lock = i; break; }
  }

  const slopes = norms.map((v, i) => i === 0 ? 0 : (v - norms[i - 1]) / Math.max(steps[i] - steps[i - 1], 1));
  const maxSlope = Math.max(...slopes.slice(1), 1e-9);
  const lateFrom = Math.max(1, Math.floor(n * 0.75));
  const lateSlope = slopes.slice(lateFrom).reduce((a, b) => a + b, 0) / Math.max(1, n - lateFrom);
  const flattened = lateSlope <= 0.15 * maxSlope;

  const maxSrank = Math.max(...sranks);
  let rankFallAt = -1;
  for (let i = 1; i < n; i++) if (sranks[i] < 0.85 * maxSrank) { rankFallAt = i; break; }
  let spikeAt = -1;
  for (let i = 0; i < n; i++) if (peaks[i] > 5) { spikeAt = i; break; }

  let zone = null, endReason = null;
  if (lock >= 0) {
    const lockNorm = norms[lock];
    let end = n - 1;
    for (let i = lock; i < n; i++) {
      if (norms[i] > lockNorm * 1.3) { end = Math.max(lock, i - 1); endReason = 'amp'; break; }
      if (rankFallAt >= 0 && i >= rankFallAt) { end = Math.max(lock, i - 1); endReason = 'rank'; break; }
      if (peaks[i] > 8) { end = Math.max(lock, i - 1); endReason = 'spike'; break; }
    }
    zone = { start: lock, end };
  }
  const growthAfterLock = lock >= 0 ? norms[n - 1] / norms[lock] - 1 : null;
  const lastStrength = lock >= 0 && norms[n - 1] > 0 ? norms[lock] / norms[n - 1] : null;
  return { lock, zone, endReason, flattened, growthAfterLock, lastStrength,
           norms, sranks, peaks, maxSrank, rankFallAt, spikeAt };
}

function diagnose(steps, t) {
  const out = [];
  const last = steps.length - 1;
  const locked = t.lock >= 0;
  const rankFalling = t.rankFallAt >= 0;
  const maxPeak = Math.max(...t.peaks);

  // cos wobble after lock: direction destabilizing late
  let wobbleAt = -1;
  if (locked) {
    for (let i = t.lock + 1; i < steps.length; i++) {
      if (t.cosines[i] != null && t.cosines[i] < 0.98) { wobbleAt = i; break; }
    }
  }

  if (!locked && rankFalling) {
    out.push(['warn', `<b>Direction still searching while rank collapses</b> (since step ${steps[t.rankFallAt]}) — the classic signature of a dataset too small or too repetitive for this capacity. More/varied images, or lower rank/factor, will help more than training longer. Watch whether rank stabilizes as direction stability approaches 1.`]);
  }
  if (!locked && !rankFalling) {
    out.push(['info', `<b>Still absorbing</b> — direction moving, rank holding, no spike. This run simply isn't done; keep training and re-analyze (only new checkpoints get processed).`]);
  }
  if (locked && t.growthAfterLock > 0.25) {
    out.push(['warn', `<b>Amplifying after lock</b> — content froze at ~step ${steps[t.lock]} but magnitude grew +${Math.round(t.growthAfterLock * 100)}% since. Later checkpoints are the same concept, louder — that's where "weird" creeps in. Use the window, or run late checkpoints at reduced strength.`]);
  }
  if (locked && t.flattened && !rankFalling && maxPeak <= 5.5) {
    out.push(['good', `<b>Textbook clean run</b> — locked, saturated, no collapse, no spike. Pick from the window and stop training; further steps are GPU heat.`]);
  }
  if (t.spikeAt >= 0 && (!locked || t.spikeAt < t.lock)) {
    out.push(['bad', `<b>Spike forming before the concept settled</b> (σ crossed 5 at step ${steps[t.spikeAt]}) — the update is funneling into one direction instead of learning broadly. Lower the lr, or switch to full-rank LoKr; checkpoints from here will need clipping to stack.`]);
  }
  if (locked && rankFalling && t.rankFallAt > t.lock) {
    out.push(['warn', `<b>Converged, then memorizing</b> — rank started collapsing at step ${steps[t.rankFallAt]}, after lock. Everything past that is trading generality for dataset recall; stay before it.`]);
  }
  if (wobbleAt >= 0) {
    out.push(['warn', `<b>Direction destabilized late</b> (cos dipped at step ${steps[wobbleAt]} after locking) — often lr too high for the late phase. Prefer checkpoints before the wobble.`]);
  }
  return out;
}

function setRead(id, cls, text) {
  const el = $(id);
  el.className = 'chart-read ' + cls;
  el.textContent = text;
}

function fillReadings(steps, t) {
  const last = steps.length - 1;
  if (t.lock < 0) {
    setRead('read-cos', 'warn', `this run: never locked — the concept was still changing at step ${steps[last]}. Undercooked; train longer (or checkpoints are too far apart to tell).`);
  } else {
    setRead('read-cos', 'good', `this run: direction locked at ~step ${steps[t.lock]}. Content stopped changing there — everything after only changes strength.`);
  }

  if (t.lock >= 0 && t.growthAfterLock > 0.25) {
    setRead('read-norm', 'warn', `this run: +${Math.round(t.growthAfterLock * 100)}% louder since lock (step ${steps[t.lock]}) with no new content — amplification, the overcook mechanism. Expect drift/artifacts to creep in as this grows.`);
  } else if (t.flattened) {
    setRead('read-norm', 'good', 'this run: growth flattened — the adapter saturated cleanly.');
  } else if (t.lock < 0) {
    setRead('read-norm', 'good', 'this run: still climbing while direction is still moving — normal, still absorbing the dataset.');
  } else {
    setRead('read-norm', 'good', 'this run: modest growth since lock — within the healthy window.');
  }

  const maxPeak = Math.max(...t.peaks);
  if (maxPeak <= 5.5) {
    setRead('read-peak', 'good', `this run: stayed under the ceiling the whole way (max ${maxPeak.toFixed(1)}) — stacks clean, no clipping needed.`);
  } else if (maxPeak <= 8) {
    setRead('read-peak', 'warn', `this run: crossed σ5 at step ${steps[t.spikeAt]} (max ${maxPeak.toFixed(1)}) — clip checkpoints from there before stacking.`);
  } else {
    setRead('read-peak', 'bad', `this run: spike formed — σ ${maxPeak.toFixed(1)} by the end (crossed 5 at step ${steps[t.spikeAt]}). These checkpoints will break stacking unless clipped at 5.`);
  }

  if (t.rankFallAt < 0) {
    setRead('read-srank', 'good', 'this run: held steady — energy stayed spread across directions, no memorization collapse.');
  } else {
    setRead('read-srank', 'bad', `this run: fell after step ${steps[t.rankFallAt]} — collapsing onto fewer directions (memorizing). Prefer checkpoints before that.`);
  }
}

function drawSeries(canvas, steps, values, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const color = opts.color || css.getPropertyValue('--accent').trim();
  const padL = 42, padR = 8, padT = 8, padB = 16;
  const pw = w - padL - padR, ph = h - padT - padB;
  const vals = values.filter((v) => v != null);
  if (!vals.length) return;
  let lo = opts.yMin != null ? opts.yMin : Math.min(...vals);
  let hi = Math.max(...vals, opts.capY != null ? opts.capY * 1.15 : -Infinity);
  if (hi - lo < 1e-9) { hi = lo + 1; }
  const pad = (hi - lo) * 0.08; lo -= opts.yMin != null ? 0 : pad; hi += pad;
  const X = (i) => padL + (steps.length === 1 ? 0 : (steps[i] - steps[0]) / (steps[steps.length - 1] - steps[0]) * pw);
  const Y = (v) => padT + ph - (v - lo) / (hi - lo) * ph;

  // settling zone shading
  if (opts.zone) {
    ctx.fillStyle = 'rgba(107,138,255,0.08)';
    ctx.fillRect(X(opts.zone.start), padT, X(opts.zone.end) - X(opts.zone.start) || 2, ph);
  }
  ctx.font = '9px Consolas, monospace';
  ctx.fillStyle = 'rgba(200,200,200,0.4)';
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  for (const t of [lo, (lo + hi) / 2, hi]) {
    const y = Y(t);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillText(t >= 100 ? t.toFixed(0) : t.toFixed(2), 2, y + 3);
  }
  ctx.fillText(String(steps[0]), padL, h - 4);
  const lastLbl = String(steps[steps.length - 1]);
  ctx.fillText(lastLbl, w - padR - ctx.measureText(lastLbl).width, h - 4);

  if (opts.capY != null) {
    const y = Y(opts.capY);
    ctx.strokeStyle = css.getPropertyValue('--accent').trim();
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.strokeStyle = color; ctx.lineWidth = 1.6;
  ctx.beginPath();
  let started = false;
  values.forEach((v, i) => {
    if (v == null) return;
    if (!started) { ctx.moveTo(X(i), Y(v)); started = true; }
    else ctx.lineTo(X(i), Y(v));
  });
  ctx.stroke();
  ctx.fillStyle = color;
  canvas._pts = [];
  values.forEach((v, i) => {
    if (v == null) return;
    ctx.beginPath(); ctx.arc(X(i), Y(v), 2.4, 0, Math.PI * 2); ctx.fill();
    canvas._pts.push({ x: X(i), i, v });
  });
}

function spectroColor(s) {
  // 0 -> surface, 5 (cap) -> teal->amber boundary, >=15 -> hot orange
  const t = Math.min(s / 5, 1), u = Math.min(Math.max((s - 5) / 10, 0), 1);
  if (u <= 0) return `rgb(${Math.round(30 + 33 * t)},${Math.round(33 + 146 * t)},${Math.round(43 + 119 * t)})`;
  return `rgb(${Math.round(63 + (224 - 63) * u)},${Math.round(179 - (179 - 113) * u)},${Math.round(162 - (162 - 79) * u)})`;
}

function moduleSortKey(mod) {
  const b = mod.match(/blocks\.(\d+)\./);
  return (b ? parseInt(b[1], 10) : 999) * 100 + (mod.includes('mlp.gate') ? 0 : mod.includes('mlp') ? 1 : 2);
}

function renderTraining(r) {
  const traj = train.traj;
  const steps = r.ckpts.map((c) => c.step);
  $('train-charts').classList.remove('hidden');
  $('train-status').textContent = `${steps.length} checkpoints · steps ${steps[0]}–${steps[steps.length - 1]} · ${traj.files[0].type}`;

  const t = analyzeTrajectory(steps, traj);
  const zone = t.zone;
  fillReadings(steps, t);
  $('train-insights').innerHTML = diagnose(steps, t)
    .map(([sev, html]) => `<div class="insight ${sev}"><span class="dot"></span><span>${html}</span></div>`)
    .join('');

  const note = $('train-zone-note');
  if (zone) {
    const endWhy = { amp: 'magnitude passes +30% beyond the lock point (louder, not smarter)',
                     rank: 'stable rank starts collapsing (memorization)',
                     spike: 'the spike passes σ8' }[t.endReason] || 'the run ends';
    let html = `<b>Best-bet window (heuristic): steps ${steps[zone.start]}–${steps[zone.end]}</b> — starts where the direction locks, ends where ${endWhy}. Verify visually in this range; weight-space can't judge likeness.`;
    if (t.lastStrength != null && t.lastStrength < 0.9) {
      html += ` Late checkpoints aren't wasted: they're the same concept, amplified — e.g. run step ${steps[steps.length - 1]} at <b>strength ~${t.lastStrength.toFixed(2)}</b> to get its refinement at settled volume.`;
    }
    note.innerHTML = html;
  } else {
    note.innerHTML = `<b>No lock yet</b> — the concept was still changing at the last checkpoint. Undercooked: train longer, then re-analyze (only new checkpoints get processed).`;
  }

  drawSeries($('c-norm'), steps, traj.files.map((f) => f.total_norm), { zone });
  drawSeries($('c-peak'), steps, traj.files.map((f) => f.peak_smax), { zone, capY: 5, yMin: 0, color: getComputedStyle(document.documentElement).getPropertyValue('--bad').trim() });
  drawSeries($('c-srank'), steps, traj.files.map((f) => f.median_srank), { zone, yMin: 0 });
  drawSeries($('c-cos'), steps, traj.cosines, { zone, color: getComputedStyle(document.documentElement).getPropertyValue('--good').trim() });

  // spectrogram
  const canvas = $('c-spectro');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const order = traj.mod_order.map((m, idx) => ({ m, idx })).sort((a, b) => moduleSortKey(a.m) - moduleSortKey(b.m));
  const cols = traj.spectro.length, rows = order.length;
  const cw = w / cols, rh = h / rows;
  for (let c = 0; c < cols; c++) {
    for (let ri = 0; ri < rows; ri++) {
      ctx.fillStyle = spectroColor(traj.spectro[c][order[ri].idx]);
      ctx.fillRect(c * cw, ri * rh, Math.ceil(cw) - (cw > 3 ? 1 : 0), Math.ceil(rh));
    }
  }
  canvas._meta = { steps, order, cw, rh, traj, run: r };
  $('spectro-legend').innerHTML = `rows: modules grouped by block (gates first) &middot; color: <span style="color:${spectroColor(1)}">σ low</span> → <span style="color:${spectroColor(5)}">σ 5</span> → <span style="color:${spectroColor(15)}">σ 15+</span>`;
}

function spectroHover(ev) {
  const canvas = $('c-spectro');
  const meta = canvas._meta;
  const tip = $('tooltip');
  if (!meta) return;
  const rect = canvas.getBoundingClientRect();
  const c = Math.min(Math.floor((ev.clientX - rect.left) / meta.cw), meta.steps.length - 1);
  const ri = Math.min(Math.floor((ev.clientY - rect.top) / meta.rh), meta.order.length - 1);
  if (c < 0 || ri < 0) { tip.classList.add('hidden'); return; }
  const mod = meta.order[ri].m;
  const s = meta.traj.spectro[c][meta.order[ri].idx];
  tip.textContent = `step ${meta.steps[c]} · ${mod.replace('diffusion_model.', '')} · σ ${s.toFixed(2)}`;
  tip.classList.remove('hidden');
  tip.style.left = Math.min(ev.clientX + 12, window.innerWidth - tip.offsetWidth - 8) + 'px';
  tip.style.top = (ev.clientY + 14) + 'px';
}

function lineHover(ev) {
  const canvas = ev.currentTarget;
  const tip = $('tooltip');
  if (!canvas._pts || !canvas._pts.length) return;
  const rect = canvas.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  let best = canvas._pts[0];
  for (const p of canvas._pts) if (Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
  const meta = $('c-spectro')._meta;
  const step = meta ? meta.steps[best.i] : best.i;
  tip.textContent = `step ${step} · ${best.v.toFixed(3)}`;
  tip.classList.remove('hidden');
  tip.style.left = Math.min(ev.clientX + 12, window.innerWidth - tip.offsetWidth - 8) + 'px';
  tip.style.top = (ev.clientY + 14) + 'px';
}

function setTab(tab) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  const training = tab === 'training';
  $('filelist').classList.toggle('hidden', training);
  $('runlist').classList.toggle('hidden', !training);
  $('dashboard').classList.toggle('hidden', training);
  $('training').classList.toggle('hidden', !training);
  $('btn-analyze-all').classList.toggle('hidden', training);
  if (training) { computeRuns(); renderRuns(); }
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
  // migrate: strip module arrays from cache entries written by older versions
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith('ll_a:')) continue;
    try {
      const v = JSON.parse(localStorage.getItem(k));
      if (v && v.modules) { delete v.modules; localStorage.setItem(k, JSON.stringify(v)); }
    } catch { localStorage.removeItem(k); }
  }

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

  $('filter-input').addEventListener('input', () => { state.filter = $('filter-input').value; renderList(); renderRuns(); });

  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => setTab(t.dataset.tab)));
  $('runlist').addEventListener('click', (e) => {
    const item = e.target.closest('.run-item');
    if (item) selectRun(item.getAttribute('data-run'));
  });
  $('btn-analyze-run').addEventListener('click', analyzeRun);
  $('c-spectro').addEventListener('mousemove', spectroHover);
  $('c-spectro').addEventListener('mouseleave', () => $('tooltip').classList.add('hidden'));
  $('c-spectro').addEventListener('click', (ev) => {
    const meta = $('c-spectro')._meta;
    if (!meta) return;
    const rect = $('c-spectro').getBoundingClientRect();
    const c = Math.min(Math.floor((ev.clientX - rect.left) / meta.cw), meta.steps.length - 1);
    setTab('inspect');
    selectFile(meta.run.ckpts[c].file.path);
  });
  document.querySelectorAll('.tchart').forEach((cv) => {
    cv.addEventListener('mousemove', lineHover);
    cv.addEventListener('mouseleave', () => $('tooltip').classList.add('hidden'));
  });
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
  window.addEventListener('resize', () => {
    if (state.analysis) drawChart();
    const r = train.runs.find((x) => x.key === train.selected);
    if (r && train.trajKey === r.key && train.traj && !$('training').classList.contains('hidden')) renderTraining(r);
  });

  bindTooltips();
  bindResizer();

  if (settings.folder) scan();
}

document.addEventListener('DOMContentLoaded', init);
