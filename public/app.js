'use strict';
// Quillmeter dashboard. Two modes share this file: the main window, and (?settings=1) the Settings window.
const SETTINGS_MODE = new URLSearchParams(location.search).has('settings');
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- Structure ----------
// Sidebar: two levels at most (a group title, then sections), as the macOS guidelines ask.
const GROUPS = [
  { name: null, tabs: ['Overview'] },
  { name: 'System', tabs: ['CPU', 'Memory', 'Disk', 'Network', 'GPU', 'Battery'] },
  { name: 'Processes', tabs: ['Apps', 'Projects', 'Docker', 'Agents'] },
  { name: 'Over Time', tabs: ['History', 'Alerts'] },
];
const TABS = [...GROUPS.flatMap((g) => g.tabs), 'Settings'];
const OVERVIEW_CARDS = [['cpu', 'CPU'], ['memory', 'Memory'], ['disk', 'Disk'], ['network', 'Network'], ['gpu', 'GPU'], ['battery', 'Battery'], ['apps', 'Top Apps']];
const PANES = [['general', 'General'], ['folders', 'Folders'], ['display', 'Display'], ['sidebar', 'Sidebar']];

// One color means one thing. Orange and red are reserved for warnings, so no metric uses them.
const C = { cpu: 'var(--blue)', mem: 'var(--purple)', disk: 'var(--brown)', net: 'var(--indigo)', gpu: 'var(--teal)', bat: 'var(--green)' };
const TAB_COLOR = { CPU: C.cpu, Memory: C.mem, Disk: C.disk, Network: C.net, GPU: C.gpu, Battery: C.bat };

// Simple line icons: one visual language (16 px grid, 1.5 px round strokes), always paired with a text label.
const ICONS = {
  Overview: '<rect x="2" y="2" width="5" height="5" rx="1.2"/><rect x="9" y="2" width="5" height="5" rx="1.2"/><rect x="2" y="9" width="5" height="5" rx="1.2"/><rect x="9" y="9" width="5" height="5" rx="1.2"/>',
  CPU: '<rect x="4" y="4" width="8" height="8" rx="1.5"/><path d="M6.5 1.8v2.2M9.5 1.8v2.2M6.5 12v2.2M9.5 12v2.2M1.8 6.5H4M1.8 9.5H4M12 6.5h2.2M12 9.5h2.2"/>',
  Memory: '<rect x="1.5" y="4.5" width="13" height="6" rx="1.2"/><path d="M4.5 10.5v2M7.5 10.5v2M10.5 10.5v2M13 10.5v2M4 7.5h2M8 7.5h2"/>',
  Disk: '<rect x="2" y="4.5" width="12" height="7" rx="2"/><circle cx="11.5" cy="8" r=".8" fill="currentColor"/><path d="M4.5 8h3.5"/>',
  Network: '<circle cx="8" cy="8" r="6"/><ellipse cx="8" cy="8" rx="2.6" ry="6"/><path d="M2 8h12"/>',
  GPU: '<rect x="2" y="3" width="12" height="8" rx="1.5"/><circle cx="8" cy="7" r="2"/><path d="M5 13.2h6"/>',
  Battery: '<rect x="1.5" y="4.5" width="11" height="7" rx="1.6"/><path d="M14.2 7v2"/><rect x="3.5" y="6.5" width="5" height="3" rx=".6" fill="currentColor" stroke="none"/>',
  Apps: '<rect x="3" y="6" width="10" height="7" rx="1.6"/><path d="M5 3.4h6"/>',
  Projects: '<path d="M2 4.6h4l1.5 1.6H14v6.4H2z"/>',
  Docker: '<path d="M8 2l5 2.5v5L8 12 3 9.5v-5z"/><path d="M3 4.5l5 2.5 5-2.5M8 7v5"/>',
  Agents: '<path d="M8 2.2l1.4 3.4 3.4 1.4-3.4 1.4L8 11.8 6.6 8.4 3.2 7l3.4-1.4z"/><path d="M12.5 11.5v2.5M11.2 12.8h2.6"/>',
  History: '<circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.4 1.5"/>',
  Alerts: '<path d="M4 11V7.4a4 4 0 0 1 8 0V11l1 1H3z"/><path d="M6.6 13.6a1.5 1.5 0 0 0 2.8 0"/>',
  Settings: '<circle cx="8" cy="8" r="2.2"/><circle cx="8" cy="8" r="5.4" stroke-dasharray="2.3 2.3"/>',
};
const icon = (name) => `<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// ---------- State ----------
let settings = { bits: false, cpuPerMac: false, palette: 'quillmeter', compact: false, retentionDays: 7, nativeNotify: true, setupDone: true, scanFolders: [], tabs: { order: [], hidden: [] }, overview: { order: [], hidden: [] } };
let catalog = [];
let tab = localStorage.getItem('quillmeter.tab') || 'Overview';
if (!TABS.includes(tab)) tab = 'Overview';
let pane = new URLSearchParams(location.search).get('pane') || localStorage.getItem('quillmeter.pane') || 'general';
if (!PANES.some(([id]) => id === pane)) pane = 'general';
let snap = null, projects = [], sortKey = 'mem', filter = '';
let range = localStorage.getItem('quillmeter.range') || '1h', histData = null, alertLog = [];
let agents = [], showSys = false, diskData = null, docker = null, tokens = null;
let notice = '', renderedKey = null, lastActions = null, sheetFolders = null, sheetOpts = null;
const notified = new Set();
const open = new Set();
let firstPoll = true;

// Set by Quillmeter.app (see app/main.swift); null when the page is opened in an ordinary browser.
let native = window.quillmeterNative || null;
window.onNativeState = (s) => { native = s; renderSheet(); render(true); };
window.setPane = (p) => { if (PANES.some(([id]) => id === p)) { pane = p; localStorage.setItem('quillmeter.pane', p); render(true); } };
window.toggleSidebar = () => setSidebar(document.body.classList.contains('sidebar-hidden'));
const nativeCall = (msg) => { if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.native) { window.webkit.messageHandlers.native.postMessage(msg); return true; } return false; };

// Every POST carries a custom header; the server rejects POSTs without it so other websites can't call the API.
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'X-Quillmeter': '1', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const getJSON = async (url) => (await fetch(url)).json();

// ---------- Formatting ----------
const bytes = (n) => {
  const u = ['B', 'kB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return (n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(i >= 3 ? 2 : 1)) + ' ' + u[i];
};
const rate = (n) => bytes(n) + '/s';
const bitsFmt = (n) => { const u = ['bit', 'kbit', 'Mbit', 'Gbit']; let v = n * 8, i = 0; while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; } return (v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i]; };
const netRate = (n) => (settings.bits ? bitsFmt(n) + '/s' : rate(n));
const cpuFmt = (v) => (settings.cpuPerMac && snap ? v / snap.cpu.cores : v).toFixed(1) + '%';
const pct = (n) => n.toFixed(0);
const compact = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
const dur = (s) => { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600); return d ? `${d}d ${h}h` : `${h}h ${Math.floor(s % 3600 / 60)}m`; };
const ago = (ms) => (Date.now() - ms < 60000 ? 'just now' : dur((Date.now() - ms) / 1000) + ' ago');
const hist = (k) => snap.history.map((h) => h[k]);
const tone = (v, warn, bad, base) => (v >= bad ? 'var(--red)' : v >= warn ? 'var(--orange)' : base);

// ---------- Appearance ----------
const PALETTES = {
  quillmeter: {},
  mono: { '--blue': '#6e6e73', '--purple': '#8e8e93', '--brown': '#48484a', '--indigo': '#636366', '--teal': '#aeaeb2', '--green': '#7c7c80' },
  accessible: { '--blue': '#0072B2', '--purple': '#8a5aa8', '--brown': '#7a5c3e', '--indigo': '#CC79A7', '--teal': '#56B4E9', '--green': '#009E73', '--orange': '#E69F00', '--red': '#D55E00' },
};
function applyLook() {
  const root = document.documentElement;
  for (const k of ['--blue', '--purple', '--brown', '--indigo', '--teal', '--green', '--orange', '--red']) root.style.removeProperty(k);
  for (const [k, v] of Object.entries(PALETTES[settings.palette] || {})) root.style.setProperty(k, v);
  document.body.classList.toggle('compact', settings.compact);
}
const narrow = () => matchMedia('(max-width: 820px)').matches;
function setSidebar(show) {
  document.body.classList.toggle('sidebar-hidden', !show);
  // On a narrow window the sidebar is a temporary overlay, so that state isn't remembered for wide windows.
  if (!narrow()) { try { localStorage.setItem('quillmeter.sidebar', show ? 'shown' : 'hidden'); } catch { /* storage can be unavailable */ } }
  const b = $('#sidebarToggle');
  if (b) { b.setAttribute('aria-label', show ? 'Hide Sidebar' : 'Show Sidebar'); b.setAttribute('aria-expanded', String(show)); }
}

// ---------- Charts ----------
function spark(vals, max, color) {
  if (vals.length < 2) return '<svg class="spark" aria-hidden="true"></svg>';
  const m = max || Math.max(...vals, 1), W = 300, H = 48;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1) * W).toFixed(1)},${(H - (v / m) * (H - 4) - 2).toFixed(1)}`);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polyline fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke" points="${pts.join(' ')}"/></svg>`;
}
function area(vals, max, color) {
  if (vals.length < 2) return '<svg class="area" aria-hidden="true"></svg>';
  const m = max || Math.max(...vals, 1), W = 400, H = 140;
  const y = (v) => (H - (v / m) * (H - 12) - 6).toFixed(1);
  const pts = vals.map((v, i) => `${(i / (vals.length - 1) * W).toFixed(1)},${y(v)}`);
  const grid = [0.25, 0.5, 0.75].map((f) => `<line x1="0" x2="${W}" y1="${(H * f).toFixed(0)}" y2="${(H * f).toFixed(0)}" stroke="var(--line)" vector-effect="non-scaling-stroke"/>`).join('');
  return `<svg class="area" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${grid}<polygon points="0,${H} ${pts.join(' ')} ${W},${H}" fill="${color}" fill-opacity="0.14"/><polyline fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke" points="${pts.join(' ')}"/></svg>`;
}
// The signature element: a 240-degree gauge, the same shape as the app icon. The number sits inside in the system's
// rounded face; the arc carries the metric color.
function gauge(fraction, color, value, sub, label) {
  const p = Math.max(0, Math.min(1, fraction)), cx = 100, cy = 100, r = 78;
  const at = (deg) => [cx + r * Math.cos(deg * Math.PI / 180), cy - r * Math.sin(deg * Math.PI / 180)];
  const [sx, sy] = at(210), [ex, ey] = at(-30);
  const sweep = 240 * p, [vx, vy] = at(210 - sweep);
  const ticks = Array.from({ length: 13 }, (_, i) => {
    const a = (210 - i * 20) * Math.PI / 180;
    return `<line x1="${(cx + (r + 11) * Math.cos(a)).toFixed(1)}" y1="${(cy - (r + 11) * Math.sin(a)).toFixed(1)}" x2="${(cx + (r + 16) * Math.cos(a)).toFixed(1)}" y2="${(cy - (r + 16) * Math.sin(a)).toFixed(1)}" stroke="var(--line)" stroke-width="2" stroke-linecap="round"/>`;
  }).join('');
  const val = p > 0.002 ? `<path d="M${sx.toFixed(1)} ${sy.toFixed(1)} A${r} ${r} 0 ${sweep > 180 ? 1 : 0} 1 ${vx.toFixed(1)} ${vy.toFixed(1)}" fill="none" stroke="${color}" stroke-width="12" stroke-linecap="round"/>` : '';
  return `<svg class="gauge" viewBox="0 0 200 160" role="img" aria-label="${esc(label)}">${ticks}
    <path d="M${sx.toFixed(1)} ${sy.toFixed(1)} A${r} ${r} 0 1 1 ${ex.toFixed(1)} ${ey.toFixed(1)}" fill="none" stroke="var(--line)" stroke-width="12" stroke-linecap="round"/>${val}
    <circle cx="${vx.toFixed(1)}" cy="${vy.toFixed(1)}" r="4.5" fill="var(--panel)" stroke="${color}" stroke-width="3"/>
    <text x="100" y="104" text-anchor="middle" class="gval">${esc(value)}</text><text x="100" y="128" text-anchor="middle" class="gsub">${esc(sub)}</text></svg>`;
}

// ---------- Building blocks ----------
function card(title, tabName, big, unit, rows, extra = '') {
  return `<div class="card"><h3><button class="card-link" data-t="${tabName}">${title}</button></h3><div class="big">${big}<small>${unit}</small></div>${extra}${rows.map(([a, b]) => `<div class="row"><span>${a}</span><b>${b}</b></div>`).join('')}</div>`;
}
const kvRows = (kv) => kv.map(([a, b]) => `<div class="row"><span>${a}</span><b>${esc(b)}</b></div>`).join('');
// Hero panel: a gauge (or a plain number) with key figures on the left, the recent history on the right.
function hero({ label, gaugeHtml, value, unit, kv, series, max, color, chart }) {
  const left = gaugeHtml || `<div class="bignum" style="color:var(--ink)">${value}<small>${esc(unit)}</small></div>`;
  return `<div class="hero"><div class="hero-l"><div class="lbl">${esc(label)}</div>${left}${kvRows(kv)}</div><div class="hero-r">${area(series, max, color)}<div class="lbl" style="margin-top:4px">${esc(chart)}</div></div></div>`;
}
const tile = (label, value, color, glyph) => `<div class="tile"><span class="chip" style="--c:${color}" aria-hidden="true">${glyph}</span><div><div class="lbl">${label}</div><div class="tv">${value}</div></div></div>`;
function stack(segs, total, colors) {
  const live = segs.filter(([, v]) => v > 0);
  const col = (name, i) => (name === 'Free' ? 'var(--line)' : colors[i % colors.length]);
  return `<div class="stack" role="img" aria-label="${esc(live.map(([n, v]) => `${n} ${bytes(v)}`).join(', '))}">${live.map(([n, v], i) => `<i style="width:${(v / total * 100).toFixed(2)}%;background:${col(n, i)}"></i>`).join('')}</div>
    <div class="legend">${live.map(([n, v], i) => `<span><i style="background:${col(n, i)}"></i>${esc(n)} <b>${bytes(v)}</b> <em>${(v / total * 100).toFixed(0)}%</em></span>`).join('')}</div>`;
}
const MEM_COLORS = ['var(--purple)', 'var(--indigo)', 'var(--brown)', 'var(--teal)'];
const DISK_COLORS = ['var(--muted)', 'var(--blue)', 'var(--brown)', 'var(--purple)', 'var(--indigo)', 'var(--teal)', 'var(--green)', 'var(--orange)'];

function appTable(apps, key) {
  return `<div class="card pad" style="margin-top:16px"><table><thead><tr><th>App</th><th class="num">${key === 'cpu' ? 'CPU' : 'Memory'}</th></tr></thead><tbody>${apps.map((a) => `<tr><td>${esc(a.name)} <span class="pill">${a.count} proc</span></td><td class="num">${key === 'cpu' ? cpuFmt(a.cpu) : bytes(a.mem)}</td></tr>`).join('')}</tbody></table></div>`;
}
function alertBanner() {
  if (!snap.alerts || !snap.alerts.length) return '';
  return snap.alerts.map((a) => `<div class="banner ${a.level}" role="status"><b>${esc(a.title)}</b> · ${esc(a.detail)}</div>`).join('');
}
function tokenCard() {
  const t = tokens;
  if (!t || !t.available) return '';
  const projects = t.byProject.map((p) => `<span class="pill">${esc(p.project)} ${compact(p.total)}</span>`).join(' ');
  return `<div class="card" style="margin-bottom:16px"><h3>Claude Code Tokens Today</h3><div class="big">${compact(t.total)}<small>tokens</small></div>
    <div class="row"><span>Output</span><b>${compact(t.output)}</b></div><div class="row"><span>Input and cache writes</span><b>${compact(t.input + t.cacheCreate)}</b></div><div class="row"><span>Cache reads (not counted above)</span><b>${compact(t.cacheRead)}</b></div>
    <div style="margin-top:8px">${projects}</div><p class="hint" style="margin:8px 0 0">Counted from Claude Code's local session logs: ${t.messages} messages since midnight. Only token counts are read, never message text. Plan limits aren't available without your account credentials.</p></div>`;
}

// ---------- Folder choices (setup sheet and Settings > Folders) ----------
function folderRow(c, checked, scope) {
  const detail = c.count != null ? ` (${c.count})` : '';
  return `<label class="folder"><input type="checkbox" data-folder="${c.id}" data-scope="${scope}" ${checked ? 'checked' : ''}>
    <span><span class="f-name">${esc(c.label)}${detail}</span><span class="f-note">${esc(c.note)}</span></span></label>`;
}
function folderLists(items, selected, scope) {
  const safe = items.filter((c) => !c.prompt), ask = items.filter((c) => c.prompt);
  return `<fieldset class="folders"><legend>No permission needed</legend>${safe.map((c) => folderRow(c, selected.has(c.id), scope)).join('')}</fieldset>
    <fieldset class="folders"><legend>macOS will ask first</legend>${ask.map((c) => folderRow(c, selected.has(c.id), scope)).join('')}</fieldset>`;
}

// ---------- Setup sheet (first run) ----------
function renderSheet() {
  const root = $('#sheet-root');
  if (SETTINGS_MODE || !root) return;
  const need = settings.setupDone === false && catalog.length;
  if (!need) { root.innerHTML = ''; document.body.classList.remove('has-sheet'); return; }
  if (!sheetFolders) { sheetFolders = new Set(catalog.filter((c) => c.enabled).map((c) => c.id)); sheetOpts = { notify: settings.nativeNotify, login: native ? !!native.launchAtLogin : false }; }
  if (root.firstChild && root.dataset.native === String(!!native)) return; // keep checkboxes and focus stable while it is open
  root.dataset.native = String(!!native);
  document.body.classList.add('has-sheet');
  root.innerHTML = `<div class="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
    <h2 id="sheet-title">Choose What Quillmeter Can Read</h2>
    <p class="sheet-lead">Quillmeter shows what is using your Mac. To break down your disk space it can measure the size of folders. It reads sizes only, never file contents, and nothing leaves your Mac.</p>
    <div class="sheet-scroll"><div data-scope="sheet">${folderLists(catalog, sheetFolders, 'sheet')}</div>
    <fieldset class="folders"><legend>Also</legend>
      <label class="folder"><input type="checkbox" id="opt-notify" ${sheetOpts.notify ? 'checked' : ''}><span><span class="f-name">Show alerts as Mac notifications</span><span class="f-note">When an app keeps the CPU busy or memory runs low.</span></span></label>
      ${native ? `<label class="folder"><input type="checkbox" id="opt-login" ${sheetOpts.login ? 'checked' : ''}><span><span class="f-name">Open Quillmeter when I log in</span><span class="f-note">It runs quietly in the menu bar.</span></span></label>` : ''}
    </fieldset>
    </div>
    <p class="hint sheet-foot">You can change any of this later in Settings.</p>
    <div class="sheet-actions"><button class="btn" data-sheet="skip">Not Now</button><button class="btn primary" data-sheet="done" id="sheet-primary">Continue</button></div></div></div>`;
  const first = $('#sheet-primary');
  if (first) first.focus();
}
async function finishSheet(skip) {
  const folders = skip ? [] : [...sheetFolders];
  const next = { setupDone: true, scanFolders: folders, nativeNotify: skip ? settings.nativeNotify : $('#opt-notify').checked };
  if (!skip && native && $('#opt-login') && $('#opt-login').checked !== !!native.launchAtLogin) nativeCall({ launchAtLogin: $('#opt-login').checked });
  settings = await (await post('/api/settings', next)).json();
  sheetFolders = null;
  await loadCatalog();
  renderSheet(); render(true); poll();
}

// ---------- Views ----------
const views = {
  Overview() {
    const { cpu, memory: m, disk: d, network: n, battery: b } = snap;
    const all = {
      cpu: card('CPU', 'CPU', pct(cpu.total), '%', [['User', pct(cpu.user) + '%'], ['System', pct(cpu.system) + '%'], ['Cores', cpu.cores]], spark(hist('cpu'), 100, tone(cpu.total, 60, 85, C.cpu))),
      memory: card('Memory', 'Memory', (m.used / 1e9).toFixed(2), `GB of ${(m.total / 1e9).toFixed(0)} GB`, [['Pressure', m.pressure], ['App', bytes(m.app)], ['Wired', bytes(m.wired)], ['Compressed', bytes(m.compressed)]], spark(hist('mem'), m.total, C.mem)),
      disk: card('Disk', 'Disk', (d.free / 1e9).toFixed(0), 'GB free', [['Total', bytes(d.total)], ['Used', bytes(d.total - d.free)]], `<div class="bar" role="img" aria-label="${((d.total - d.free) / d.total * 100).toFixed(0)}% used"><i style="width:${((d.total - d.free) / d.total * 100).toFixed(0)}%;background:${C.disk}"></i></div>`),
      network: card('Network', 'Network', netRate(n.down).split(' ')[0], netRate(n.down).split(' ')[1] + ' ↓', [['Downloading', netRate(n.down)], ['Uploading', netRate(n.up)]], spark(hist('down'), 0, C.net)),
      gpu: snap.gpu && snap.gpu.present ? card('GPU', 'GPU', snap.gpu.util, '%', [['Renderer', snap.gpu.renderer + '%'], ['Memory in use', bytes(snap.gpu.memUsed)], ['Cores', snap.gpu.cores]], spark(hist('gpu'), 100, C.gpu)) : '',
      battery: b.present ? card('Battery', 'Battery', b.percent, '%', [['State', esc(b.state)], ['Remaining', b.remaining || '—']], `<div class="bar" role="img" aria-label="${b.percent}% charged"><i style="width:${b.percent}%;background:${b.percent < 20 && b.onBattery ? 'var(--red)' : C.bat}"></i></div>`) : '',
      apps: card('Top Apps by Memory', 'Apps', snap.appCount, 'apps running', snap.apps.slice(0, 5).map((a) => [esc(a.name), bytes(a.mem)])),
    };
    const cards = arranged(OVERVIEW_CARDS.map(([id]) => id), settings.overview).map((id) => all[id]).join('');
    return `${alertBanner()}<div class="grid">${cards}</div>
      <p class="hint">${snap.processCount} processes grouped into ${snap.appCount} apps plus ${snap.groupCount - snap.appCount} background services. All figures are live from this Mac.</p>`;
  },
  Apps() {
    const apps = snap.apps.filter((a) => a.name.toLowerCase().includes(filter));
    apps.sort((a, b) => (sortKey === 'name' ? a.name.localeCompare(b.name) : b[sortKey] - a[sortKey]));
    const rows = apps.map((a) => {
      const o = open.has(a.name);
      let h = `<tr class="app" tabindex="0" role="button" aria-expanded="${o}" data-app="${esc(a.name)}"><td><span class="disc" aria-hidden="true">${o ? '▾' : '▸'}</span> ${esc(a.name)} <span class="pill">${a.count} proc</span></td><td class="num">${cpuFmt(a.cpu)}</td><td class="num">${bytes(a.mem)}</td><td class="num"><button class="act" data-quit="${esc(a.name)}" data-n="${a.count}">Quit…</button> <button class="act" data-quit="${esc(a.name)}" data-n="${a.count}" data-force="1">Force Quit…</button></td></tr>`;
      if (o) h += a.children.map((c) => `<tr class="child"><td>${esc(c.name)} · ${c.pid}</td><td class="num">${cpuFmt(c.cpu)}</td><td class="num">${bytes(c.mem)}</td><td class="num"><button class="act" data-qpid="${c.pid}" data-name="${esc(c.name)}">Quit…</button></td></tr>`).join('');
      return h;
    }).join('');
    return `<div class="card pad"><table><thead><tr><th data-sort="name" tabindex="0">App</th><th class="num" data-sort="cpu" tabindex="0">CPU</th><th class="num" data-sort="mem" tabindex="0">Memory</th><th><span class="sr">Actions</span></th></tr></thead><tbody>${rows || '<tr><td colspan="4">No apps match.</td></tr>'}</tbody></table></div>
      <p class="hint">Helpers are added to the app that launched them. Select a row to see its largest processes. Quit asks the app to close (SIGTERM); Force Quit ends it immediately (SIGKILL).</p>`;
  },
  CPU() {
    const { cpu } = snap, apps = [...snap.apps].sort((a, b) => b.cpu - a.cpu).slice(0, 12);
    const color = tone(cpu.total, 60, 85, C.cpu);
    return hero({ label: 'CPU Now', gaugeHtml: gauge(cpu.total / 100, color, pct(cpu.total) + '%', `${cpu.cores} cores`, `CPU ${pct(cpu.total)} percent`), color, series: hist('cpu'), max: 100, chart: 'Last 10 minutes',
      kv: [['User', pct(cpu.user) + '%'], ['System', pct(cpu.system) + '%']] }) + appTable(apps, 'cpu');
  },
  Memory() {
    const m = snap.memory, apps = [...snap.apps].sort((a, b) => b.mem - a.mem).slice(0, 12), free = Math.max(0, m.total - m.used);
    const color = m.pressure === 'critical' ? 'var(--red)' : m.pressure === 'warn' ? 'var(--orange)' : C.mem;
    return hero({ label: `In Use of ${(m.total / 1e9).toFixed(0)} GB`, gaugeHtml: gauge(m.used / m.total, color, (m.used / 1e9).toFixed(1), 'GB in use', `Memory ${(m.used / 1e9).toFixed(1)} gigabytes of ${(m.total / 1e9).toFixed(0)}`), color, series: hist('mem'), max: m.total, chart: 'Last 10 minutes',
      kv: [['Pressure', m.pressure], ['App', bytes(m.app)], ['Wired', bytes(m.wired)], ['Compressed', bytes(m.compressed)]] })
      + `<div class="card" style="margin-top:16px"><h3>Where It Goes</h3>${stack([['App', m.app], ['Wired', m.wired], ['Compressed', m.compressed], ['Free', free]], m.total, MEM_COLORS)}</div>` + appTable(apps, 'mem');
  },
  Disk() {
    const d = snap.disk, used = d.total - d.free, ds = diskData;
    const hs = hist('dr').map((r, i) => r + snap.history[i].dw);
    const usedFrac = used / d.total, color = usedFrac > 0.9 ? 'var(--orange)' : C.disk;
    const head = hero({ label: `Free of ${(d.total / 1e9).toFixed(2)} GB`, gaugeHtml: gauge(usedFrac, color, (d.free / 1e9).toFixed(1), 'GB free', `Disk ${(d.free / 1e9).toFixed(1)} gigabytes free`), color: C.disk, series: hs, max: 0, chart: 'Disk activity, last 10 minutes',
      kv: [['Used', bytes(used)], ['Read since boot', bytes(d.totalRead)], ['Written since boot', bytes(d.totalWrite)]] })
      + `<div class="tiles">${tile('Reading', rate(d.read), C.disk, '↓')}${tile('Writing', rate(d.write), C.disk, '↑')}</div>`;
    const choose = '<button class="btn primary" data-choose-folders>Choose Folders…</button>';
    let body;
    if (!ds || ds.state === 'notconfigured' || ds.state === 'empty') {
      body = `<div class="card empty"><h3>Storage Breakdown Is Off</h3><p>${ds && ds.state === 'empty' ? 'No folders are selected.' : 'Quillmeter hasn’t been given any folders to measure yet.'} Choose which ones it may look at. It reads sizes only, never file contents.</p>${choose}</div>`;
    } else if (!ds.scannedAt) {
      body = '<div class="card"><h3>What Is Using Your Space</h3><p class="hint" style="margin:0">Measuring the folders you chose. This takes up to a minute.</p><div class="bar indeterminate" aria-hidden="true"><i></i></div></div>';
    } else {
      const homeTop = ds.home.slice(0, 4), homeRest = Math.max(0, ds.homeBytes - homeTop.reduce((s, h) => s + h.bytes, 0));
      const other = Math.max(0, used - ds.homeBytes - ds.appsBytes);
      const segs = [[ds.skipped.length ? 'Other and not scanned' : 'System and other', other], ['Applications', ds.appsBytes], ...homeTop.map((h) => [h.name, h.bytes]), ['Rest of what you chose', homeRest], ['Free', d.free]];
      const list = (title, rows) => rows.length ? `<div class="card pad"><h3>${title}</h3><table><tbody>${rows.map((r) => `<tr><td>${esc(r.name)}${r.parent ? `<div class="hint" style="margin:0">${esc(r.parent)}</div>` : ''}</td><td class="num">${bytes(r.bytes)}</td><td style="width:35%"><div class="bar mini"><i style="width:${Math.min(100, r.bytes / (rows[0].bytes || 1) * 100).toFixed(0)}%;background:${C.disk}"></i></div></td></tr>`).join('')}</tbody></table></div>` : '';
      const status = ds.state === 'scanning' ? 'Measuring again…' : `Measured ${ago(ds.scannedAt)}`;
      const notIncluded = ds.skipped.length ? `<p class="hint">Not included: ${ds.skipped.map((s) => esc(s.label)).join(', ')}. <button class="link" data-choose-folders>Choose Folders…</button></p>` : '';
      body = `<div class="card"><h3>What Is Using Your Space</h3>${stack(segs, d.total, DISK_COLORS)}<p class="hint" style="margin:12px 0 0">${status}</p></div>
        <div class="grid" style="margin-top:16px">${list('Largest Folders You Chose', ds.home.slice(0, 8))}${list('Largest in Library', ds.library.slice(0, 8))}</div>${notIncluded}
        <p class="hint">Sizes are what each folder occupies on disk. The photo library, the Trash and other apps' private data are never read.</p>`;
    }
    return head + body;
  },
  Network() {
    const n = snap.network, apps = n.apps || [], peak = Math.max(...apps.map((a) => a.down + a.up), 1);
    const rows = apps.map((a) => `<tr><td>${esc(a.name)}</td><td class="num">${netRate(a.down)}</td><td class="num">${netRate(a.up)}</td><td style="width:30%"><div class="bar mini"><i style="width:${((a.down + a.up) / peak * 100).toFixed(0)}%;background:${C.net}"></i></div></td></tr>`).join('');
    return hero({ label: 'Downloading', value: netRate(n.down).split(' ')[0], unit: netRate(n.down).split(' ')[1], color: C.net, series: hist('down'), max: 0, chart: 'Download, last 10 minutes',
      kv: [['Uploading', netRate(n.up)], ['Downloaded since boot', bytes(n.totalDown)], ['Uploaded since boot', bytes(n.totalUp)]] })
      + `<div class="tiles">${tile('Downloading', netRate(n.down), C.net, '↓')}${tile('Uploading', netRate(n.up), C.net, '↑')}</div>`
      + `<div class="card pad"><h3>Apps Using the Network Right Now</h3><table><thead><tr><th>App</th><th class="num">Down</th><th class="num">Up</th><th><span class="sr">Share</span></th></tr></thead><tbody>${rows || '<tr><td>No app traffic in the last few seconds.</td></tr>'}</tbody></table></div>
      <p class="hint">Per-app figures come from nettop and refresh every few seconds. Helpers are counted with the app that launched them.</p>`;
  },
  GPU() {
    const g = snap.gpu;
    if (!g || !g.present) return '<div class="card">No GPU statistics are available on this Mac.</div>';
    return hero({ label: `${g.model}${g.cores ? ' · ' + g.cores + ' cores' : ''}`, gaugeHtml: gauge(g.util / 100, C.gpu, g.util + '%', 'GPU use', `GPU ${g.util} percent`), color: C.gpu, series: hist('gpu'), max: 100, chart: 'GPU use, last 10 minutes',
      kv: [['Renderer', g.renderer + '%'], ['Tiler', g.tiler + '%'], ['Memory in use', bytes(g.memUsed)], ['Memory allocated', bytes(g.memAlloc)]] })
      + '<p class="hint">Per-app GPU use needs root on macOS, so only the total is shown.</p>';
  },
  Battery() {
    const b = snap.battery;
    if (!b.present) return '<div class="card">No battery detected.</div>';
    const low = b.percent < 20 && b.onBattery, color = low ? 'var(--red)' : C.bat, watts = b.watts != null ? b.watts.toFixed(1) + ' W' : '—';
    return hero({ label: 'Charge', gaugeHtml: gauge(b.percent / 100, color, b.percent + '%', b.state, `Battery ${b.percent} percent, ${b.state}`), color, series: hist('bat'), max: 100, chart: 'Charge, last 10 minutes',
      kv: [['Source', b.onBattery ? 'Battery' : 'Power adapter'], ['Remaining', b.remaining || '—']] })
      + `<div class="tiles">${tile('Health', b.maxCapacity != null ? b.maxCapacity + '%' + (b.condition ? ' · ' + esc(b.condition) : '') : '—', C.bat, '♥')}${tile('Cycles', b.cycles != null ? b.cycles + ' of ' + (b.designCycles || '—') : '—', C.bat, '↻')}${tile(b.charging ? 'Charging at' : b.onBattery ? 'Power Draw' : 'Power', watts, C.bat, 'W')}${tile('Thermal State', b.thermal ? b.thermal[0].toUpperCase() + b.thermal.slice(1) : '—', b.thermal === 'elevated' ? 'var(--red)' : C.gpu, '°')}</div>
      <p class="hint">Health is the figure macOS reports for maximum capacity. Cycles are counted against the design limit. This Mac exposes no battery or CPU temperature without root, so Quillmeter shows macOS's thermal state instead.</p>`;
  },
  Docker() {
    const d = docker;
    if (!d) return '<div class="card">Checking Docker…</div>';
    if (d.state === 'missing') return '<div class="card empty"><h3>Docker Isn’t Installed</h3><p>Quillmeter looks for the docker command from Docker Desktop, OrbStack, Colima and Homebrew.</p></div>';
    if (d.state === 'stopped') return '<div class="card empty"><h3>Docker Isn’t Running</h3><p>Start Docker and this view fills in.</p></div>';
    const total = d.containers.reduce((s, c) => s + c.mem, 0);
    const rows = d.containers.map((c) => `<tr><td>${esc(c.name)}<div class="hint" style="margin:0">${esc(c.image)}</div></td><td class="num">${c.cpu.toFixed(1)}%</td><td class="num">${bytes(c.mem)}<div class="hint" style="margin:0">of ${bytes(c.memLimit)}</div></td><td class="num">↓ ${bytes(c.netIn)}<br>↑ ${bytes(c.netOut)}</td><td>${esc(c.ports) || '—'}<div class="hint" style="margin:0">${esc(c.status)}</div></td></tr>`).join('');
    return `<div class="grid" style="margin-bottom:16px">${card('Containers', 'Docker', d.containers.length, 'running', [['Memory in use', bytes(total)]])}</div>
      <div class="card pad"><table><thead><tr><th>Container</th><th class="num">CPU</th><th class="num">Memory</th><th class="num">Network</th><th>Ports</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No containers are running.</td></tr>'}</tbody></table></div>`;
  },
  History() {
    const h = histData;
    if (!h || h.series.length < 2) return '<div class="card empty"><h3>Collecting Data</h3><p>Quillmeter saves one point per minute, so the first chart appears after a couple of minutes.</p></div>';
    const t = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const s = h.series, last = s[s.length - 1];
    const chart = (title, key, fmt, max, color) => `<div class="card"><h3>${title}</h3><div class="big">${fmt(last[key])}</div>${spark(s.map((p) => p[key]), max, color)}<div class="row"><span>${t(s[0].t)}</span><span>${t(last.t)}</span></div></div>`;
    const tbl = (title, rows, a, b) => `<div class="card pad"><h3>${title}</h3><table><thead><tr><th>App</th><th class="num">${a[0]}</th><th class="num">${b[0]}</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${a[1](r)}</td><td class="num">${b[1](r)}</td></tr>`).join('')}</tbody></table></div>`;
    return `<div class="grid">${chart('CPU (Average)', 'cpu', (v) => pct(v) + '%', 100, C.cpu)}${chart('Memory in Use', 'mem', bytes, snap.memory.total, C.mem)}${chart('Download', 'down', netRate, 0, C.net)}</div>
      <div class="grid" style="margin-top:16px">${tbl('Most CPU Over This Range', h.topCpu, ['Avg CPU', (r) => cpuFmt(r.avgCpu)], ['Avg memory', (r) => bytes(r.avgMem)])}${tbl('Most Memory Over This Range', h.topMem, ['Avg memory', (r) => bytes(r.avgMem)], ['Peak', (r) => bytes(r.peakMem)])}</div>
      <p class="hint">${h.minutes} ${h.unit || 'minutes'} of saved data since ${t(h.since)}. Stored in ~/.quillmeter and kept for ${settings.retentionDays} days: per-minute for 7 days, hourly averages after that. Per-app figures cover each ${h.unit === 'hours' ? 'hour' : 'minute'}'s top apps.</p>`;
  },
  Alerts() {
    const rows = alertLog.map((a) => `<tr><td><span class="pill ${a.level === 'warn' ? 'warn' : 'bad'}">${a.level === 'warn' ? 'Warning' : 'Critical'}</span> ${esc(a.title)}<div class="hint" style="margin:0">${esc(a.detail)}</div></td><td class="num">${new Date(a.t).toLocaleString()}</td></tr>`).join('');
    if (!rows) return '<div class="card empty"><h3>No Alerts Yet</h3><p>Quillmeter warns when an app holds the CPU, keeps growing in memory, or the Mac runs low on memory or battery.</p></div>';
    return `<div class="card pad"><table><tbody>${rows}</tbody></table></div>`;
  },
  Projects() {
    const dev = projects.filter((p) => p.dev), sys = projects.filter((p) => !p.dev);
    const idle = dev.filter((p) => p.status === 'idle').length;
    const byProject = new Map();
    for (const p of dev) byProject.set(p.project, [...(byProject.get(p.project) || []), p]);
    const pill = (p) => `<span class="pill ${p.status === 'idle' ? 'warn' : p.status === 'working' ? 'ok' : ''}">${esc(p.note)}</span>`;
    const row = (p) => `<tr><td>${p.ports.map((x) => `<span class="pill ok">:${x}</span>`).join(' ')}</td><td>${esc(p.command)} ${pill(p)}</td><td class="num">${cpuFmt(p.cpu)}</td><td class="num">${bytes(p.mem)}</td><td class="num">${p.self ? '<span class="pill">This app</span>' : `<button class="act" data-stop="${p.pid}" data-name="${esc(p.project)}">Stop…</button>`}</td></tr>`;
    const groups = [...byProject].map(([name, ps]) => `<div class="card pad" style="margin-bottom:16px"><h3>${esc(name)} · ${ps.length} server${ps.length > 1 ? 's' : ''}</h3><div class="hint" style="margin:0 0 8px">${esc(ps[0].repo || ps[0].cwd)}</div><table><tbody>${ps.map(row).join('')}</tbody></table></div>`).join('');
    const sysRows = sys.map((p) => `<tr><td>${p.ports.map((x) => `:${x}`).join(' ')}</td><td>${esc(p.command)}</td><td class="num">${cpuFmt(p.cpu)}</td><td class="num">${bytes(p.mem)}</td></tr>`).join('');
    return `<p class="hint" style="margin-top:0">${dev.length} dev server${dev.length === 1 ? '' : 's'}${dev.length ? ` · ${idle} idle` : ''}. Grouped by git repository.</p>
      ${groups || '<div class="card empty"><h3>No Dev Servers Found</h3><p>Servers listening on a port from a folder inside your home folder show up here.</p></div>'}
      ${sys.length ? `<button class="btn" data-sys>${showSys ? 'Hide' : 'Show'} ${sys.length} System Listeners</button>${showSys ? `<div class="card pad" style="margin-top:12px"><table><tbody>${sysRows}</tbody></table></div>` : ''}` : ''}
      <p class="hint">Stop sends a polite SIGTERM after you confirm. Idle means no CPU use for 30 minutes while Quillmeter was watching, or days of uptime with almost no CPU time.</p>`;
  },
  Agents() {
    if (!agents.length) return tokenCard() + '<div class="card empty"><h3>No Coding Agents Running</h3><p>Quillmeter looks for Claude Code, Codex, Cursor Agent, Gemini CLI, OpenCode and Aider.</p></div>';
    const rows = agents.map((a) => `<div class="card pad" style="margin-bottom:16px"><h3>${esc(a.agent)} · ${esc(a.project)}</h3><div class="hint" style="margin:0 0 8px">${esc(a.cwd)} · up ${esc(a.uptime)} · pid ${a.pid}</div><div class="row"><span>${a.procCount} process${a.procCount > 1 ? 'es' : ''} in total</span><b>${cpuFmt(a.cpu)} CPU · ${bytes(a.mem)}</b></div>${a.started.length ? `<div style="margin-top:8px">${a.started.map((s) => `<span class="pill">${esc(s.name)}${s.n > 1 ? ' ×' + s.n : ''}</span>`).join(' ')}</div>` : ''}</div>`).join('');
    return `${tokenCard()}<p class="hint" style="margin-top:0">${agents.length} agent session${agents.length > 1 ? 's' : ''} running, with everything each one started.</p>${rows}`;
  },
  Settings() { return settingsView(); },
};

// ---------- Settings (a window in the app, a view in a browser) ----------
const sel = (key, opts) => `<select data-set="${key}" aria-label="${esc(key)}">${opts.map(([v, l]) => `<option value="${v}" ${String(v) === String(settings[key]) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
const setRow = (label, hint, control) => `<div class="setrow"><div><div class="set-label">${label}</div><div class="hint" style="margin:0">${hint}</div></div><div>${control}</div></div>`;
function loginRow() {
  if (!native) return '';
  const hint = native.status === 'needs approval' ? 'Approve Quillmeter in System Settings, General, Login Items.' : native.status === 'unavailable' ? 'Move Quillmeter.app to the Applications folder to turn this on.' : 'Start Quillmeter automatically when you log in.';
  return setRow('Open at Login', hint, `<select data-native="launchAtLogin" aria-label="Open at login"><option value="true" ${native.launchAtLogin ? 'selected' : ''}>On</option><option value="false" ${native.launchAtLogin ? '' : 'selected'}>Off</option></select>`);
}
function arrangeList(group, title, items, cfg) {
  const ids = items.map(([id]) => id), labels = Object.fromEntries(items);
  const order = [...(cfg.order || []).filter((i) => ids.includes(i)), ...ids.filter((i) => !(cfg.order || []).includes(i))];
  const rows = order.map((id, i) => `<div class="setrow slim"><label><input type="checkbox" data-arrange="${group}" data-id="${id}" data-act="toggle" ${(cfg.hidden || []).includes(id) ? '' : 'checked'}> ${esc(labels[id])}</label><span><button class="act" data-arrange="${group}" data-id="${id}" data-act="up" aria-label="Move ${esc(labels[id])} up" ${i === 0 ? 'disabled' : ''}>↑</button> <button class="act" data-arrange="${group}" data-id="${id}" data-act="down" aria-label="Move ${esc(labels[id])} down" ${i === order.length - 1 ? 'disabled' : ''}>↓</button></span></div>`).join('');
  return `<div class="card"><h3>${title}</h3>${rows}</div>`;
}
function panePage(name) {
  if (name === 'general') {
    return `<div class="card">${loginRow()}
      ${setRow('Mac Notifications', 'Show alerts as native macOS notifications, even with the window closed.', sel('nativeNotify', [[true, 'On'], [false, 'Off']]) + ' <button class="btn" data-testnotify>Send Test</button>')}
      ${setRow('History Kept', 'Per-minute detail is kept for 7 days. Longer periods are kept as hourly averages.', sel('retentionDays', [[7, '7 days'], [30, '30 days'], [90, '90 days'], [180, '6 months'], [365, '1 year']]))}</div>
      <p class="hint">Settings are saved in ~/.quillmeter/settings.json.</p>`;
  }
  if (name === 'folders') {
    const selected = new Set(settings.scanFolders);
    const ds = diskData, state = ds ? ds.state : 'idle';
    const status = state === 'scanning' ? 'Measuring the folders you chose…' : state === 'notconfigured' ? 'Nothing is measured until you finish setup.' : state === 'empty' ? 'No folders are selected, so nothing is measured.' : ds && ds.scannedAt ? `Measured ${ago(ds.scannedAt)}.` : '';
    return `<p class="pane-lead">Choose the folders Quillmeter may measure for the disk breakdown. It reads sizes only, never file contents. Your photo library, the Trash and other apps' private data are never read.</p>
      <div data-scope="settings">${catalog.length ? folderLists(catalog, selected, 'settings') : '<div class="card">Loading…</div>'}</div>
      <p class="hint"><span id="scanStatus">${status}</span> <button class="btn" data-scan ${state === 'scanning' || state === 'notconfigured' || state === 'empty' ? 'disabled' : ''}>Measure Again</button></p>`;
  }
  if (name === 'display') {
    return `<div class="card">${setRow('Network Speed', 'Show network rates in bytes or bits per second.', sel('bits', [[false, 'Bytes (MB/s)'], [true, 'Bits (Mbit/s)']]))}
      ${setRow('CPU per App', 'Percent of a single core can exceed 100%. Percent of the Mac divides by the core count.', sel('cpuPerMac', [[false, 'Percent of one core'], [true, 'Percent of the whole Mac']]))}
      ${setRow('Chart Colors', 'Quillmeter colors, gray charts, or a set people with color blindness can tell apart.', sel('palette', [['quillmeter', 'Quillmeter'], ['mono', 'Monochrome'], ['accessible', 'Accessible']]))}
      ${setRow('Layout', 'A compact layout fits a small screen.', sel('compact', [[false, 'Comfortable'], [true, 'Compact']]))}</div>
      <p class="hint">Quillmeter follows your Mac's light or dark appearance, accent color, reduced motion and increased contrast settings.</p>`;
  }
  return `<div class="grid">${arrangeList('tabs', 'Sidebar Sections', TABS.filter((t) => t !== 'Settings').map((t) => [t, t]), settings.tabs)}${arrangeList('overview', 'Overview Cards', OVERVIEW_CARDS, settings.overview)}</div>
    <p class="hint"><button class="btn" data-resetarrange>Reset Arrangement</button></p>`;
}
function settingsView() {
  const tabs = PANES.map(([id, label]) => `<button role="tab" aria-selected="${id === pane}" class="${id === pane ? 'on' : ''}" data-pane="${id}">${label}</button>`).join('');
  return `<div class="panes" role="tablist" aria-label="Settings sections">${tabs}</div><div class="pane-body">${panePage(pane)}</div>`;
}

// ---------- Arrangement ----------
// Saved order first (ignoring ids that no longer exist), then anything new in default order; hidden ids removed.
const arranged = (ids, cfg) => {
  const known = new Set(ids);
  const order = [...(cfg.order || []).filter((i) => known.has(i)), ...ids.filter((i) => !(cfg.order || []).includes(i))];
  return order.filter((i) => !(cfg.hidden || []).includes(i));
};
function visibleGroups() {
  const order = arranged(TABS.filter((t) => t !== 'Settings'), settings.tabs);
  return GROUPS.map((g) => ({ name: g.name, tabs: order.filter((t) => g.tabs.includes(t)) })).filter((g) => g.tabs.length);
}
function renderTabs() {
  if (SETTINGS_MODE) return;
  const groups = visibleGroups();
  const visible = groups.flatMap((g) => g.tabs);
  if (tab !== 'Settings' && !visible.includes(tab)) tab = visible[0] || 'Overview';
  const badge = snap && snap.alerts && snap.alerts.length ? `<span class="badge" aria-label="${snap.alerts.length} active alerts">${snap.alerts.length}</span>` : '';
  const item = (t) => `<button class="side-item ${t === tab ? 'on' : ''}" data-t="${t}" ${t === tab ? 'aria-current="page"' : ''} style="--ic:${TAB_COLOR[t] || 'var(--accent)'}">${icon(t)}<span>${t}</span>${t === 'Alerts' ? badge : ''}</button>`;
  $('#tabs').innerHTML = groups.map((g) => `${g.name ? `<div class="side-group">${g.name}</div>` : ''}${g.tabs.map(item).join('')}`).join('')
    + `<div class="side-group"></div><button class="side-item ${tab === 'Settings' ? 'on' : ''}" data-open-settings ${tab === 'Settings' ? 'aria-current="page"' : ''}>${icon('Settings')}<span>Settings…</span></button>`;
}

// ---------- Toolbar ----------
function actionsFor() {
  if (SETTINGS_MODE || tab === 'Settings') return '';
  if (tab === 'Overview') return '<button class="btn" data-export>Export Image…</button>';
  if (tab === 'Apps') return '<input class="search" id="q" type="search" placeholder="Filter" aria-label="Filter apps">';
  if (tab === 'Disk') { const st = diskData ? diskData.state : 'idle'; return st === 'ready' || st === 'scanning' ? `<button class="btn" data-scan ${st === 'scanning' ? 'disabled' : ''}>Measure Again</button>` : ''; }
  if (tab === 'History') {
    const opts = [['1h', 0], ['24h', 0], ['7d', 7], ['30d', 30], ['90d', 90], ['180d', 180], ['365d', 365]].filter(([, d]) => d <= settings.retentionDays);
    if (!opts.some(([r]) => r === range)) range = '1h';
    return `<div class="seg" role="group" aria-label="Time range">${opts.map(([r]) => `<button data-range="${r}" aria-pressed="${r === range}" class="${r === range ? 'on' : ''}">${r === '365d' ? '1y' : r}</button>`).join('')}</div>`;
  }
  return '';
}

// ---------- Rendering ----------
function render(force = false) {
  if (SETTINGS_MODE) {
    const key = `s|${pane}`;
    if (renderedKey === key && !force) return;
    $('#title').textContent = 'Settings';
    $('#view').innerHTML = settingsView();
    renderedKey = key;
    return;
  }
  if (!snap || !snap.cpu) return;
  // A form that is open must not be rebuilt on every poll (it would close dropdowns and drop focus).
  if (tab === 'Settings' && renderedKey === `v|Settings|${pane}` && !force) return;
  $('#hostline').innerHTML = `<div>${esc(snap.host.name.replace(/\.local$/, ''))}</div><div>${esc(snap.host.model)} · up ${dur(snap.host.uptime)}</div>`;
  $('#title').textContent = tab;
  renderTabs();
  const actions = actionsFor();
  if (actions !== lastActions) { $('#actions').innerHTML = actions; lastActions = actions; const q = $('#q'); if (q) q.value = filter; }
  $('#view').innerHTML = (notice ? `<div class="banner warn" role="status">${esc(notice)}</div>` : '') + views[tab]();
  renderedKey = tab === 'Settings' ? `v|Settings|${pane}` : tab;
}
function say(msg) { notice = msg; render(true); setTimeout(() => { notice = ''; render(true); }, 7000); }

// ---------- Export image ----------
// 1200x630 share card, drawn on a canvas in the current appearance.
function exportCard() {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const T = dark ? { bg: '#000000', panel: '#1c1c1e', ink: '#f5f5f7', muted: '#98989d', line: '#2c2c2e' } : { bg: '#f5f5f7', panel: '#ffffff', ink: '#1d1d1f', muted: '#6e6e73', line: '#e5e5ea' };
  const css = getComputedStyle(document.documentElement);
  const col = (v, fb) => css.getPropertyValue(v).trim() || fb;
  const blue = col('--blue', '#0071e3'), purple = col('--purple', '#8944ab');
  const cv = document.createElement('canvas'); cv.width = 1200; cv.height = 630;
  const g = cv.getContext('2d');
  const font = (w, px, rounded) => { g.font = `${w} ${px}px ${rounded ? 'ui-rounded, ' : ''}-apple-system, "SF Pro Text", "Helvetica Neue", sans-serif`; };
  const rr = (x, y, w, h, r, fill) => { g.beginPath(); g.roundRect(x, y, w, h, r); g.fillStyle = fill; g.fill(); };
  g.fillStyle = T.bg; g.fillRect(0, 0, 1200, 630);
  rr(48, 48, 40, 40, 10, blue);
  g.fillStyle = T.ink; font(700, 34); g.fillText('Quillmeter', 104, 80);
  g.fillStyle = T.muted; font(400, 20); g.fillText(`${snap.host.model} · ${(snap.memory.total / 1e9).toFixed(0)} GB`, 48, 124);
  const m = snap.memory;
  rr(48, 150, 540, 190, 24, T.panel);
  g.fillStyle = T.muted; font(500, 20); g.fillText('Memory in use', 76, 190);
  g.fillStyle = T.ink; font(600, 84, true); g.fillText((m.used / 1e9).toFixed(2), 76, 276);
  const w = g.measureText((m.used / 1e9).toFixed(2)).width;
  g.fillStyle = T.muted; font(500, 28); g.fillText('GB', 84 + w, 276);
  g.fillStyle = T.muted; font(400, 20); g.fillText(`Pressure ${m.pressure} · compressed ${bytes(m.compressed)}`, 76, 318);
  rr(612, 150, 540, 190, 24, T.panel);
  g.fillStyle = T.muted; font(500, 20); g.fillText('CPU now', 640, 190);
  g.fillStyle = T.ink; font(600, 84, true); g.fillText(pct(snap.cpu.total), 640, 276);
  const w2 = g.measureText(pct(snap.cpu.total)).width;
  g.fillStyle = T.muted; font(500, 28); g.fillText('%', 648 + w2, 276);
  g.fillStyle = T.muted; font(400, 20); g.fillText(`User ${pct(snap.cpu.user)}% · system ${pct(snap.cpu.system)}% · ${snap.cpu.cores} cores`, 640, 318);
  rr(48, 364, 1104, 218, 24, T.panel);
  g.fillStyle = T.muted; font(500, 20); g.fillText('Top apps by memory', 76, 402);
  const top = snap.apps.slice(0, 4), max = top[0] ? top[0].mem : 1;
  top.forEach((a, i) => {
    const y = 438 + i * 34;
    g.fillStyle = T.ink; font(500, 20); g.fillText(a.name.length > 28 ? a.name.slice(0, 27) + '…' : a.name, 76, y + 6);
    rr(420, y - 10, 520, 14, 7, T.line); rr(420, y - 10, Math.max(14, 520 * a.mem / max), 14, 7, purple);
    g.fillStyle = T.muted; font(500, 20); g.textAlign = 'right'; g.fillText(bytes(a.mem), 1124, y + 6); g.textAlign = 'left';
  });
  g.fillStyle = T.muted; font(400, 16); g.fillText(`${snap.appCount} apps · ${snap.processCount} processes · ${new Date().toLocaleString()}`, 48, 612);
  return cv;
}
function exportImage() {
  const name = `quillmeter-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`;
  const cv = exportCard();
  // In the app the native save panel lets you choose where it goes (no folder permission needed).
  if (native && nativeCall({ saveImage: cv.toDataURL('image/png'), name })) return;
  cv.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
}

// ---------- Actions ----------
async function quit(query, label, count, force) {
  const msg = force ? `Force quit ${label}? ${count > 1 ? count + ' processes' : 'It'} will end immediately and unsaved work is lost.` : `Quit ${label}? ${count > 1 ? count + ' processes' : 'It'} will be asked to close.`;
  if (!confirm(msg)) return;
  const r = await (await post(`/api/quit?${query}${force ? '&force=1' : ''}`)).json();
  say(r.ok ? `${r.app}: signalled ${r.signalled} process${r.signalled === 1 ? '' : 'es'}${r.failed ? `, ${r.failed} not permitted` : ''}.` : `Could not quit: ${r.error}`);
  poll();
}
function openSettings(p) {
  if (p) { pane = p; localStorage.setItem('quillmeter.pane', p); }
  if (native && nativeCall({ openSettings: true, pane })) return;
  tab = 'Settings'; localStorage.setItem('quillmeter.tab', tab); render(true); poll();
}
async function saveFolders(ids) {
  settings = await (await post('/api/settings', { scanFolders: ids })).json();
  await pollDisk();
  if (SETTINGS_MODE) render(true);
}

document.addEventListener('change', async (e) => {
  const f = e.target.closest('[data-folder]');
  if (f) {
    if (f.dataset.scope === 'sheet') { f.checked ? sheetFolders.add(f.dataset.folder) : sheetFolders.delete(f.dataset.folder); return; }
    const ids = [...document.querySelectorAll('[data-folder][data-scope="settings"]')].filter((x) => x.checked).map((x) => x.dataset.folder);
    await saveFolders(ids);
    return;
  }
  const nat = e.target.closest('[data-native]');
  if (nat) { nativeCall({ launchAtLogin: nat.value === 'true' }); return; }
  const el = e.target.closest('[data-set]');
  if (!el) return;
  const raw = el.value;
  const val = raw === 'true' ? true : raw === 'false' ? false : /^\d+$/.test(raw) ? Number(raw) : raw;
  settings = await (await post('/api/settings', { [el.dataset.set]: val })).json();
  applyLook(); render(true);
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'q') { filter = e.target.value.toLowerCase(); render(); }
});

document.addEventListener('click', async (e) => {
  if (narrow() && !document.body.classList.contains('sidebar-hidden') && !e.target.closest('#sidebarToggle') && (!e.target.closest('#sidebar') || e.target.closest('.side-item'))) setSidebar(false);
  const sh = e.target.closest('[data-sheet]');
  if (sh) { await finishSheet(sh.dataset.sheet === 'skip'); return; }
  if (e.target.closest('#opt-notify, #opt-login')) { sheetOpts = { notify: $('#opt-notify').checked, login: $('#opt-login') ? $('#opt-login').checked : false }; return; }
  if (e.target.closest('[data-export]')) { exportImage(); return; }
  const pn = e.target.closest('[data-pane]');
  if (pn) { pane = pn.dataset.pane; localStorage.setItem('quillmeter.pane', pane); render(true); if (pane === 'folders') pollDisk(); return; }
  if (e.target.closest('[data-open-settings]')) { openSettings(); return; }
  if (e.target.closest('[data-choose-folders]')) { openSettings('folders'); return; }
  if (e.target.closest('[data-resetarrange]')) { settings = await (await post('/api/settings', { tabs: { order: [], hidden: [] }, overview: { order: [], hidden: [] } })).json(); render(true); return; }
  const ar = e.target.closest('[data-arrange]');
  if (ar) {
    const group = ar.dataset.arrange, id = ar.dataset.id, act = ar.dataset.act;
    const ids = group === 'tabs' ? TABS.filter((t) => t !== 'Settings') : OVERVIEW_CARDS.map(([i]) => i);
    const cfg = settings[group];
    const order = [...(cfg.order || []).filter((i) => ids.includes(i)), ...ids.filter((i) => !(cfg.order || []).includes(i))];
    let hidden = [...(cfg.hidden || [])];
    const i = order.indexOf(id);
    if (act === 'up' && i > 0) [order[i - 1], order[i]] = [order[i], order[i - 1]];
    if (act === 'down' && i < order.length - 1) [order[i + 1], order[i]] = [order[i], order[i + 1]];
    if (act === 'toggle') hidden = hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id];
    if (act === 'toggle' && e.target.tagName !== 'INPUT') return;
    settings = await (await post('/api/settings', { [group]: { order, hidden } })).json();
    render(true);
    return;
  }
  const q = e.target.closest('[data-quit]');
  if (q) { await quit('app=' + encodeURIComponent(q.dataset.quit), q.dataset.quit, Number(q.dataset.n), !!q.dataset.force); return; }
  const qp = e.target.closest('[data-qpid]');
  if (qp) { await quit('pid=' + qp.dataset.qpid, qp.dataset.name, 1, false); return; }
  if (e.target.closest('[data-testnotify]')) { await post('/api/notify-test'); return; }
  const t = e.target.closest('[data-t]');
  if (t) { tab = t.dataset.t; localStorage.setItem('quillmeter.tab', tab); render(true); poll(); return; }
  const th = e.target.closest('[data-sort]');
  if (th) { sortKey = th.dataset.sort; render(); return; }
  const row = e.target.closest('tr.app');
  if (row) { const n = row.dataset.app; open.has(n) ? open.delete(n) : open.add(n); render(); return; }
  const rg = e.target.closest('[data-range]');
  if (rg) { range = rg.dataset.range; localStorage.setItem('quillmeter.range', range); lastActions = null; await poll(); return; }
  if (e.target.closest('[data-scan]')) { await post('/api/disk/scan'); await pollDisk(); render(true); return; }
  if (e.target.closest('[data-sys]')) { showSys = !showSys; render(); return; }
  const stop = e.target.closest('[data-stop]');
  if (stop && confirm(`Stop ${stop.dataset.name} (pid ${stop.dataset.stop})?`)) {
    await post(`/api/stop?pid=${stop.dataset.stop}`);
    await poll();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('.sheet')) { finishSheet(true); return; }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('tr.app, th[data-sort]')) { e.preventDefault(); e.target.click(); }
});

// ---------- Data ----------
async function loadCatalog() { try { catalog = (await getJSON('/api/scan-catalog')).items; } catch { /* keep the old list */ } }
async function pollDisk() {
  try {
    diskData = await getJSON('/api/disk');
    const s = $('#scanStatus');
    if (s && pane === 'folders') {
      const st = diskData.state;
      s.textContent = st === 'scanning' ? 'Measuring the folders you chose…' : st === 'notconfigured' ? 'Nothing is measured until you finish setup.' : st === 'empty' ? 'No folders are selected, so nothing is measured.' : diskData.scannedAt ? `Measured ${ago(diskData.scannedAt)}.` : '';
    }
  } catch { /* offline */ }
}
async function refreshSettings() {
  try {
    const s = await getJSON('/api/settings');
    if (JSON.stringify(s) !== JSON.stringify(settings)) { settings = s; applyLook(); await loadCatalog(); renderSheet(); render(true); }
  } catch { /* offline */ }
}
function notifyNew() {
  for (const a of snap.alerts || []) {
    if (notified.has(a.id)) continue;
    notified.add(a.id);
    if (!firstPoll && 'Notification' in window && Notification.permission === 'granted' && !native) new Notification(a.title, { body: a.detail });
  }
  firstPoll = false;
}
async function poll() {
  if (SETTINGS_MODE) { if (pane === 'folders') await pollDisk(); return; }
  try {
    snap = await getJSON('/api/snapshot');
    if (tab === 'Projects' || tab === 'Overview') projects = await getJSON('/api/projects');
    if (tab === 'Disk') await pollDisk();
    if (tab === 'Agents') { agents = await getJSON('/api/agents'); tokens = await getJSON('/api/tokens'); }
    if (tab === 'Docker') docker = await getJSON('/api/docker');
    if (tab === 'History') histData = await getJSON(`/api/history?range=${range}`);
    if (tab === 'Alerts') alertLog = (await getJSON('/api/alerts')).log;
    notifyNew();
    render();
  } catch { const h = $('#hostline'); if (h) h.textContent = 'Server unreachable'; }
}

// ---------- Start ----------
document.body.classList.toggle('settings-mode', SETTINGS_MODE);
$('#sidebarToggle')?.addEventListener('click', () => window.toggleSidebar());
{ let saved = null; try { saved = localStorage.getItem('quillmeter.sidebar'); } catch { /* ignore */ } setSidebar(narrow() ? false : saved !== 'hidden'); }
(async () => {
  try { settings = await getJSON('/api/settings'); } catch { /* retry on the next poll */ }
  applyLook();
  await loadCatalog();
  if (SETTINGS_MODE) { await pollDisk(); render(true); } else { renderSheet(); await poll(); render(true); }
})();
setInterval(() => { poll(); refreshSettings(); }, 2000);
window.addEventListener('focus', () => { refreshSettings(); if (SETTINGS_MODE) pollDisk(); });
