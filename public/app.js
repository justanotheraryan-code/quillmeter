const TABS = ['Overview', 'Apps', 'CPU', 'Memory', 'Disk', 'Network', 'GPU', 'Battery', 'History', 'Alerts', 'Projects', 'Docker', 'Agents', 'Settings'];
let settings = { bits: false, cpuPerMac: false, palette: 'vitals', compact: false, retentionDays: 7, nativeNotify: true, tabs: { order: [], hidden: [] }, overview: { order: [], hidden: [] } };
let notice = '', renderedTab = null;
const OVERVIEW_CARDS = [['cpu', 'CPU'], ['memory', 'Memory'], ['disk', 'Disk'], ['network', 'Network'], ['gpu', 'GPU'], ['battery', 'Battery'], ['apps', 'Top apps']];
// Saved order first (ignoring ids that no longer exist), then anything new in default order; hidden ids removed.
const arranged = (ids, cfg) => {
  const known = new Set(ids);
  const order = [...(cfg.order || []).filter((i) => known.has(i)), ...ids.filter((i) => !(cfg.order || []).includes(i))];
  return order.filter((i) => !(cfg.hidden || []).includes(i));
};
const visibleTabs = () => { const v = arranged(TABS, settings.tabs); return v.includes('Settings') ? v : [...v, 'Settings']; };
function renderTabs() {
  const tabs = visibleTabs();
  if (!tabs.includes(tab)) tab = tabs[0];
  $('#tabs').innerHTML = tabs.map((t) => `<button data-t="${t}">${t}</button>`).join('');
  markTabs();
}
// Every POST carries a custom header; the server rejects POSTs without it so other websites can't call the API.
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'X-Vitals': '1', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
let tab = localStorage.getItem('pulse.tab') || 'Overview';
if (!TABS.includes(tab)) tab = 'Overview';
let snap = null, projects = [], sortKey = 'mem', filter = '';
let range = localStorage.getItem('pulse.range') || '1h', histData = null, alertLog = [];
let agents = [], showSys = false, diskData = null, docker = null, tokens = null;
const compact = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
const ACCENT = { CPU: 'var(--blue)', Memory: 'var(--green)', Disk: 'var(--orange)', Network: 'var(--indigo)', GPU: 'var(--teal)', Docker: 'var(--blue)', Battery: 'var(--green)' };
const notified = new Set();
let firstPoll = true;
const open = new Set();
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const bytes = (n) => {
  const u = ['B', 'kB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return (n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(i >= 3 ? 2 : 1)) + ' ' + u[i];
};
const rate = (n) => bytes(n) + '/s';
const bitsFmt = (n) => { const u = ['bit', 'kbit', 'Mbit', 'Gbit']; let v = n * 8, i = 0; while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; } return (v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i]; };
const netRate = (n) => (settings.bits ? bitsFmt(n) + '/s' : rate(n));
const cpuFmt = (v) => (settings.cpuPerMac && snap ? v / snap.cpu.cores : v).toFixed(1) + '%';
const PALETTES = {
  vitals: {},
  mono: { '--blue': '#6e6e73', '--green': '#8e8e93', '--orange': '#48484a', '--indigo': '#636366', '--teal': '#aeaeb2' },
  accessible: { '--blue': '#0072B2', '--green': '#009E73', '--orange': '#E69F00', '--indigo': '#CC79A7', '--teal': '#56B4E9', '--red': '#D55E00' },
};
function applyLook() {
  const root = document.documentElement;
  for (const k of ['--blue', '--green', '--orange', '--indigo', '--teal', '--red']) root.style.removeProperty(k);
  for (const [k, v] of Object.entries(PALETTES[settings.palette] || {})) root.style.setProperty(k, v);
  document.body.classList.toggle('compact', settings.compact);
}
function say(msg) { notice = msg; render(true); setTimeout(() => { notice = ''; render(true); }, 7000); }
const pct = (n) => n.toFixed(0);
const dur = (s) => { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600); return d ? `${d}d ${h}h` : `${h}h ${Math.floor(s % 3600 / 60)}m`; };

function spark(vals, max, color = 'var(--blue)') {
  if (vals.length < 2) return '<svg class="spark"></svg>';
  const m = max || Math.max(...vals, 1), W = 300, H = 56;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1) * W).toFixed(1)},${(H - (v / m) * (H - 4) - 2).toFixed(1)}`);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" points="${pts.join(' ')}"/></svg>`;
}
const hist = (k) => snap.history.map((h) => h[k]);
const tone = (v, warn, bad) => (v >= bad ? 'var(--red)' : v >= warn ? 'var(--orange)' : 'var(--blue)');

function card(title, big, unit, rows, extra = '') {
  return `<div class="card"><h3>${title}</h3><div class="big">${big}<small>${unit}</small></div>${extra}${rows.map(([a, b]) => `<div class="row"><span>${a}</span><b>${b}</b></div>`).join('')}</div>`;
}

// Hero panel: big number and key/values on the left, area chart on the right.
function area(vals, max, color) {
  if (vals.length < 2) return '<svg class="area"></svg>';
  const m = max || Math.max(...vals, 1), W = 400, H = 140;
  const y = (v) => (H - (v / m) * (H - 12) - 6).toFixed(1);
  const pts = vals.map((v, i) => `${(i / (vals.length - 1) * W).toFixed(1)},${y(v)}`);
  const grid = [0.25, 0.5, 0.75].map((f) => `<line x1="0" x2="${W}" y1="${(H * f).toFixed(0)}" y2="${(H * f).toFixed(0)}" stroke="var(--line)" vector-effect="non-scaling-stroke"/>`).join('');
  return `<svg class="area" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}<polygon points="0,${H} ${pts.join(' ')} ${W},${H}" fill="${color}" fill-opacity="0.14"/><polyline fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke" points="${pts.join(' ')}"/></svg>`;
}
function hero({ label, value, unit, kv, series, max, color, chart }) {
  return `<div class="hero"><div class="hero-l"><div class="lbl">${esc(label)}</div><div class="bigger" style="color:${color}">${value}<small>${esc(unit)}</small></div>${kv.map(([a, b]) => `<div class="row"><span>${a}</span><b>${esc(b)}</b></div>`).join('')}</div><div class="hero-r">${area(series, max, color)}<div class="lbl" style="margin-top:4px">${esc(chart)}</div></div></div>`;
}
const tile = (label, value, color, glyph) => `<div class="tile"><span class="chip" style="--c:${color}">${glyph}</span><div><div class="lbl">${label}</div><div class="tv">${value}</div></div></div>`;
const SEG_COLORS = ['var(--muted)', 'var(--blue)', 'var(--orange)', 'var(--green)', 'var(--indigo)', 'var(--red)', 'var(--teal)', 'var(--line)'];
function stack(segs, total) {
  const live = segs.filter(([, v]) => v > 0);
  const color = (name, i) => (name === 'Free' ? 'var(--line)' : SEG_COLORS[i % (SEG_COLORS.length - 1)]);
  return `<div class="stack">${live.map(([n, v], i) => `<i title="${esc(n)}" style="width:${(v / total * 100).toFixed(2)}%;background:${color(n, i)}"></i>`).join('')}</div>
    <div class="legend">${live.map(([n, v], i) => `<span><i style="background:${color(n, i)}"></i>${esc(n)} <b>${bytes(v)}</b> <em>${(v / total * 100).toFixed(0)}%</em></span>`).join('')}</div>`;
}

const views = {
  Overview() {
    const { cpu, memory: m, disk: d, network: n, battery: b } = snap;
    const all = {
      cpu: card('CPU', pct(cpu.total), '%', [['User', pct(cpu.user) + '%'], ['System', pct(cpu.system) + '%'], ['Cores', cpu.cores]], spark(hist('cpu'), 100, tone(cpu.total, 60, 85))),
      memory: card('Memory', (m.used / 1e9).toFixed(2), `GB of ${(m.total / 1e9).toFixed(0)} GB`, [['Pressure', m.pressure], ['App', bytes(m.app)], ['Wired', bytes(m.wired)], ['Compressed', bytes(m.compressed)]], spark(hist('mem'), m.total)),
      disk: card('Disk', (d.free / 1e9).toFixed(0), 'GB free', [['Total', bytes(d.total)], ['Used', bytes(d.total - d.free)]], `<div class="bar"><i style="width:${((d.total - d.free) / d.total * 100).toFixed(0)}%"></i></div>`),
      network: card('Network', netRate(n.down).split(' ')[0], netRate(n.down).split(' ')[1] + ' ↓', [['Downloading', netRate(n.down)], ['Uploading', netRate(n.up)]], spark(hist('down'))),
      gpu: snap.gpu && snap.gpu.present ? card('GPU', snap.gpu.util, '%', [['Renderer', snap.gpu.renderer + '%'], ['Memory in use', bytes(snap.gpu.memUsed)], ['Cores', snap.gpu.cores]], spark(hist('gpu'), 100, 'var(--teal)')) : '',
      battery: b.present ? card('Battery', b.percent, '%', [['State', esc(b.state)], ['Remaining', b.remaining || '—']], `<div class="bar"><i style="width:${b.percent}%;background:${b.percent < 20 ? 'var(--red)' : 'var(--green)'}"></i></div>`) : '',
      apps: card('Top apps by memory', snap.appCount, 'apps running', snap.apps.slice(0, 5).map((a) => [esc(a.name), bytes(a.mem)])),
    };
    const cards = arranged(OVERVIEW_CARDS.map(([id]) => id), settings.overview).map((id) => all[id]).join('');
    return `${alertBanner()}<div class="grid">${cards}</div>
      <p class="hint">${snap.processCount} processes grouped into ${snap.appCount} apps plus ${snap.groupCount - snap.appCount} background services. All figures are live from this Mac.
      <button class="act" data-export="light">Export image (light)</button> <button class="act" data-export="dark">Export image (dark)</button></p>`;
  },
  Apps() {
    const apps = snap.apps.filter((a) => a.name.toLowerCase().includes(filter));
    apps.sort((a, b) => (sortKey === 'name' ? a.name.localeCompare(b.name) : b[sortKey] - a[sortKey]));
    const rows = apps.map((a) => {
      const o = open.has(a.name);
      let h = `<tr class="app" data-app="${esc(a.name)}"><td>${o ? '▾' : '▸'} ${esc(a.name)} <span class="pill">${a.count} proc</span></td><td class="num">${cpuFmt(a.cpu)}</td><td class="num">${bytes(a.mem)}</td><td class="num"><button class="act" data-quit="${esc(a.name)}" data-n="${a.count}">Quit…</button> <button class="act" data-quit="${esc(a.name)}" data-n="${a.count}" data-force="1">Force…</button></td></tr>`;
      if (o) h += a.children.map((c) => `<tr class="child"><td>${esc(c.name)} · ${c.pid}</td><td class="num">${cpuFmt(c.cpu)}</td><td class="num">${bytes(c.mem)}</td><td class="num"><button class="act" data-qpid="${c.pid}" data-name="${esc(c.name)}">Quit…</button></td></tr>`).join('');
      return h;
    }).join('');
    return `<input class="search" placeholder="Filter apps" value="${esc(filter)}" id="q"><div class="card pad"><table><thead><tr><th data-sort="name">App</th><th class="num" data-sort="cpu">CPU</th><th class="num" data-sort="mem">Memory</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="hint">Helpers are added to the app that launched them. Click a row to see its largest processes. Quit asks the app to close (SIGTERM); Force ends it immediately (SIGKILL).</p>`;
  },
  CPU() {
    const { cpu } = snap;
    const apps = [...snap.apps].sort((a, b) => b.cpu - a.cpu).slice(0, 12);
    return hero({ label: 'CPU now', value: pct(cpu.total), unit: '%', color: tone(cpu.total, 60, 85), series: hist('cpu'), max: 100, chart: 'Last 10 minutes',
      kv: [['User', pct(cpu.user) + '%'], ['System', pct(cpu.system) + '%'], ['Cores', cpu.cores]] }) + appTable(apps, 'cpu');
  },
  Memory() {
    const m = snap.memory;
    const apps = [...snap.apps].sort((a, b) => b.mem - a.mem).slice(0, 12);
    const free = Math.max(0, m.total - m.used);
    return hero({ label: `In use of ${(m.total / 1e9).toFixed(0)} GB`, value: (m.used / 1e9).toFixed(2), unit: 'GB', color: 'var(--green)', series: hist('mem'), max: m.total, chart: 'Last 10 minutes',
      kv: [['Pressure', m.pressure], ['App', bytes(m.app)], ['Wired', bytes(m.wired)], ['Compressed', bytes(m.compressed)]] })
      + `<div class="card" style="margin-top:16px"><h3>Where it goes</h3>${stack([['App', m.app], ['Wired', m.wired], ['Compressed', m.compressed], ['Free', free]], m.total)}</div>` + appTable(apps, 'mem');
  },
  Disk() {
    const d = snap.disk, used = d.total - d.free, ds = diskData;
    const hs = hist('dr').map((r, i) => r + snap.history[i].dw);
    let breakdown = '<div class="card">Preparing the storage breakdown…</div>';
    if (ds && ds.scannedAt) {
      const homeTop = ds.home.slice(0, 4);
      const homeRest = Math.max(0, ds.homeBytes - homeTop.reduce((s, h) => s + h.bytes, 0));
      const system = Math.max(0, used - ds.homeBytes - ds.appsBytes);
      const segs = [['System & other', system], ['Applications', ds.appsBytes], ...homeTop.map((h) => ['~/' + h.name, h.bytes]), ['Rest of home', homeRest], ['Free', d.free]];
      const list = (title, rows) => `<div class="card pad"><h3>${title}</h3><table><tbody>${rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${bytes(r.bytes)}</td><td style="width:35%"><div class="bar mini"><i style="width:${Math.min(100, r.bytes / (rows[0].bytes || 1) * 100).toFixed(0)}%;background:var(--orange)"></i></div></td></tr>`).join('')}</tbody></table></div>`;
      const status = ds.state === 'scanning' ? 'Scanning your home folder (about 20 seconds)…' : `Scanned ${Date.now() - ds.scannedAt < 60000 ? 'just now' : dur((Date.now() - ds.scannedAt) / 1000) + ' ago'}`;
      breakdown = `<div class="card"><h3>What is using your space</h3>${stack(segs, d.total)}
        <div class="row" style="margin-top:12px"><span>${status}</span><span><button class="act" data-scan ${ds.state === 'scanning' ? 'disabled' : ''}>Rescan</button></span></div></div>
        <div class="grid" style="margin-top:16px">${list('Largest in your home folder', ds.home.slice(0, 8))}${list('Largest in Library', ds.library.slice(0, 8))}</div>
        <p class="hint">Sizes are what each folder occupies on disk. System &amp; other is the rest of the used space: macOS, snapshots and files outside your home folder.</p>`;
    }
    return hero({ label: `Free of ${(d.total / 1e9).toFixed(2)} GB`, value: (d.free / 1e9).toFixed(2), unit: 'GB', color: 'var(--orange)', series: hs, max: 0, chart: 'Disk activity, last 10 minutes',
      kv: [['Used', bytes(used)], ['Read since boot', bytes(d.totalRead)], ['Written since boot', bytes(d.totalWrite)]] })
      + `<div class="tiles">${tile('Reading', rate(d.read), 'var(--orange)', '↓')}${tile('Writing', rate(d.write), 'var(--orange)', '↑')}</div>` + breakdown;
  },
  Network() {
    const n = snap.network;
    const apps = n.apps || [];
    const peak = Math.max(...apps.map((a) => a.down + a.up), 1);
    const rows = apps.map((a) => `<tr><td>${esc(a.name)}</td><td class="num">${netRate(a.down)}</td><td class="num">${netRate(a.up)}</td><td style="width:30%"><div class="bar mini"><i style="width:${((a.down + a.up) / peak * 100).toFixed(0)}%;background:var(--indigo)"></i></div></td></tr>`).join('');
    return hero({ label: 'Downloading', value: netRate(n.down).split(' ')[0], unit: netRate(n.down).split(' ')[1], color: 'var(--indigo)', series: hist('down'), max: 0, chart: 'Download, last 10 minutes',
      kv: [['Uploading', netRate(n.up)], ['Downloaded since boot', bytes(n.totalDown)], ['Uploaded since boot', bytes(n.totalUp)]] })
      + `<div class="tiles">${tile('Downloading', netRate(n.down), 'var(--indigo)', '↓')}${tile('Uploading', netRate(n.up), 'var(--indigo)', '↑')}</div>`
      + `<div class="card pad"><h3>Apps using the network right now</h3><table><thead><tr><th>App</th><th class="num">Down</th><th class="num">Up</th><th></th></tr></thead><tbody>${rows || '<tr><td>No app traffic in the last few seconds.</td></tr>'}</tbody></table></div>
      <p class="hint">Per-app figures come from nettop and refresh every few seconds. Helpers are counted with the app that launched them.</p>`;
  },
  Battery() {
    const b = snap.battery;
    if (!b.present) return '<div class="card">No battery detected.</div>';
    const low = b.percent < 20 && b.onBattery;
    const watts = b.watts != null ? b.watts.toFixed(1) + ' W' : '—';
    return hero({ label: 'Charge', value: b.percent, unit: '%', color: low ? 'var(--red)' : 'var(--green)', series: hist('bat'), max: 100, chart: 'Charge, last 10 minutes',
      kv: [['State', b.state], ['Source', b.onBattery ? 'Battery' : 'Power adapter'], ['Remaining', b.remaining || '—']] })
      + `<div class="tiles">${tile('Health', b.maxCapacity != null ? b.maxCapacity + '%' + (b.condition ? ' · ' + esc(b.condition) : '') : '—', 'var(--green)', '♥')}${tile('Cycles', b.cycles != null ? b.cycles + ' of ' + (b.designCycles || '—') : '—', 'var(--green)', '↻')}${tile(b.charging ? 'Charging at' : b.onBattery ? 'Power draw' : 'Power', watts, 'var(--orange)', 'W')}${tile('Thermal state', b.thermal ? b.thermal[0].toUpperCase() + b.thermal.slice(1) : '—', b.thermal === 'elevated' ? 'var(--red)' : 'var(--teal)', '°')}</div>
      <p class="hint">Health is the figure macOS reports for maximum capacity. Cycles are counted against the design limit. This Mac exposes no battery or CPU temperature without root, so Vitals shows macOS's thermal state instead.</p>`;
  },
  GPU() {
    const g = snap.gpu;
    if (!g || !g.present) return '<div class="card">No GPU statistics are available on this Mac.</div>';
    return hero({ label: `${g.model}${g.cores ? ' · ' + g.cores + ' cores' : ''}`, value: g.util, unit: '%', color: 'var(--teal)', series: hist('gpu'), max: 100, chart: 'GPU use, last 10 minutes',
      kv: [['Renderer', g.renderer + '%'], ['Tiler', g.tiler + '%'], ['Memory in use', bytes(g.memUsed)], ['Memory allocated', bytes(g.memAlloc)]] })
      + '<p class="hint">Per-app GPU use needs root on macOS, so only the total is shown.</p>';
  },
  Docker() {
    const d = docker;
    if (!d) return '<div class="card">Checking Docker…</div>';
    if (d.state === 'missing') return '<div class="card">Docker is not installed. Vitals looks for the docker command from Docker Desktop, OrbStack, Colima and Homebrew.</div>';
    if (d.state === 'stopped') return '<div class="card">Docker is installed but not running. Start Docker and this tab fills in.</div>';
    const total = d.containers.reduce((s, c) => s + c.mem, 0);
    const rows = d.containers.map((c) => `<tr><td>${esc(c.name)}<div class="hint" style="margin:0">${esc(c.image)}</div></td><td class="num">${c.cpu.toFixed(1)}%</td><td class="num">${bytes(c.mem)}<div class="hint" style="margin:0">of ${bytes(c.memLimit)}</div></td><td class="num">↓ ${bytes(c.netIn)}<br>↑ ${bytes(c.netOut)}</td><td>${esc(c.ports) || '—'}<div class="hint" style="margin:0">${esc(c.status)}</div></td></tr>`).join('');
    return `<div class="grid" style="margin-bottom:16px">${card('Containers', d.containers.length, 'running', [['Memory in use', bytes(total)]])}</div>
      <div class="card pad"><table><thead><tr><th>Container</th><th class="num">CPU</th><th class="num">Memory</th><th class="num">Network</th><th>Ports</th></tr></thead><tbody>${rows || '<tr><td>No containers are running.</td></tr>'}</tbody></table></div>`;
  },
  History() {
    const h = histData;
    const opts = [['1h', 0], ['24h', 0], ['7d', 7], ['30d', 30], ['90d', 90], ['180d', 180], ['365d', 365]].filter(([, d]) => d <= settings.retentionDays);
    if (!opts.some(([r]) => r === range)) range = '1h';
    const ranges = opts.map(([r]) => `<button data-range="${r}" class="${r === range ? 'on' : ''}">${r === '365d' ? '1y' : r}</button>`).join('');
    if (!h || h.series.length < 2) return `<div class="seg">${ranges}</div><div class="card">Collecting data. Vitals saves one point per minute, so the first chart appears after a couple of minutes.</div>`;
    const t = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const s = h.series, last = s[s.length - 1];
    const chart = (title, key, fmt, max, color) => `<div class="card"><h3>${title}</h3><div class="big">${fmt(last[key])}</div>${spark(s.map((p) => p[key]), max, color)}<div class="row"><span>${t(s[0].t)}</span><span>${t(last.t)}</span></div></div>`;
    const tbl = (title, rows, a, b) => `<div class="card pad"><h3>${title}</h3><table><thead><tr><th>App</th><th class="num">${a[0]}</th><th class="num">${b[0]}</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${a[1](r)}</td><td class="num">${b[1](r)}</td></tr>`).join('')}</tbody></table></div>`;
    return `<div class="seg">${ranges}</div>
      <div class="grid">${chart('CPU (avg)', 'cpu', (v) => pct(v) + '%', 100)}${chart('Memory in use', 'mem', bytes, snap.memory.total)}${chart('Download', 'down', netRate, 0)}</div>
      <div class="grid" style="margin-top:16px">${tbl('Most CPU over this range', h.topCpu, ['Avg CPU', (r) => cpuFmt(r.avgCpu)], ['Avg memory', (r) => bytes(r.avgMem)])}${tbl('Most memory over this range', h.topMem, ['Avg memory', (r) => bytes(r.avgMem)], ['Peak', (r) => bytes(r.peakMem)])}</div>
      <p class="hint">${h.minutes} ${h.unit || 'minutes'} of saved data since ${t(h.since)}. Stored in ~/.pulse and kept for ${settings.retentionDays} days: per-minute for 7 days, hourly averages after that. Per-app figures cover each ${h.unit === 'hours' ? 'hour' : 'minute'}'s top apps.</p>`;
  },
  Alerts() {
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    const btn = perm === 'default' ? '<button class="act" data-notify>Enable notifications</button>' : `<span class="pill ${perm === 'granted' ? 'ok' : ''}">notifications ${perm}</span>`;
    const rows = alertLog.map((a) => `<tr><td><span class="pill ${a.level === 'warn' ? 'warn' : 'bad'}">${a.level}</span> ${esc(a.title)}<div class="hint" style="margin:0">${esc(a.detail)}</div></td><td class="num">${new Date(a.t).toLocaleString()}</td></tr>`).join('');
    return `<div style="margin-bottom:16px">${btn}</div><div class="card pad"><table><tbody>${rows || '<tr><td>No alerts yet. Vitals warns when an app holds the CPU, keeps growing in memory, or the Mac runs low.</td></tr>'}</tbody></table></div>`;
  },
  Projects() {
    const dev = projects.filter((p) => p.dev), sys = projects.filter((p) => !p.dev);
    const idle = dev.filter((p) => p.status === 'idle').length;
    const byProject = new Map();
    for (const p of dev) byProject.set(p.project, [...(byProject.get(p.project) || []), p]);
    const pill = (p) => `<span class="pill ${p.status === 'idle' ? 'warn' : p.status === 'working' ? 'ok' : ''}">${esc(p.note)}</span>`;
    const row = (p) => `<tr><td>${p.ports.map((x) => `<span class="pill ok">:${x}</span>`).join(' ')}</td><td>${esc(p.command)} ${pill(p)}</td><td class="num">${cpuFmt(p.cpu)}</td><td class="num">${bytes(p.mem)}</td><td class="num">${p.self ? '<span class="pill">this app</span>' : `<button class="act" data-stop="${p.pid}" data-name="${esc(p.project)}">Stop…</button>`}</td></tr>`;
    const groups = [...byProject].map(([name, ps]) => `<div class="card pad" style="margin-bottom:16px"><h3>${esc(name)} · ${ps.length} server${ps.length > 1 ? 's' : ''}</h3><div class="hint" style="margin:0 0 8px">${esc(ps[0].repo || ps[0].cwd)}</div><table><tbody>${ps.map(row).join('')}</tbody></table></div>`).join('');
    const sysRows = sys.map((p) => `<tr><td>${p.ports.map((x) => `:${x}`).join(' ')}</td><td>${esc(p.command)}</td><td class="num">${cpuFmt(p.cpu)}</td><td class="num">${bytes(p.mem)}</td></tr>`).join('');
    return `<p class="hint" style="margin-top:0">${dev.length} dev server${dev.length === 1 ? '' : 's'}${dev.length ? ` · ${idle} idle` : ''}. Grouped by git repository.</p>
      ${groups || '<div class="card">No dev servers found under your home folder.</div>'}
      ${sys.length ? `<button class="act" data-sys>${showSys ? 'Hide' : 'Show'} ${sys.length} system listeners</button>${showSys ? `<div class="card pad" style="margin-top:12px"><table><tbody>${sysRows}</tbody></table></div>` : ''}` : ''}
      <p class="hint">Stop sends a polite SIGTERM after you confirm. Idle means no CPU use for 30 minutes while Vitals was watching, or days of uptime with almost no CPU time.</p>`;
  },
  Settings() {
    const s = settings;
    const sel = (key, opts) => `<select data-set="${key}">${opts.map(([v, l]) => `<option value="${v}" ${String(v) === String(s[key]) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    const row = (label, hint, control) => `<div class="setrow"><div><div>${label}</div><div class="hint" style="margin:0">${hint}</div></div><div>${control}</div></div>`;
    return `<div class="card">
      ${row('Network speed', 'Show network rates in bytes or bits per second.', sel('bits', [[false, 'Bytes (MB/s)'], [true, 'Bits (Mbit/s)']]))}
      ${row('CPU per app', 'Percent of a single core can exceed 100%. Percent of the Mac divides by the core count.', sel('cpuPerMac', [[false, 'Percent of one core'], [true, 'Percent of the whole Mac']]))}
      ${row('Chart colors', 'Vitals colors, gray charts, or a set people with color blindness can tell apart.', sel('palette', [['vitals', 'Vitals'], ['mono', 'Monochrome'], ['accessible', 'Accessible']]))}
      ${row('Layout', 'A compact layout fits a small screen.', sel('compact', [[false, 'Comfortable'], [true, 'Compact']]))}
      ${row('History kept', 'Per-minute detail is kept for 7 days. Longer periods are kept as hourly averages.', sel('retentionDays', [[7, '7 days'], [30, '30 days'], [90, '90 days'], [180, '6 months'], [365, '1 year']]))}
      ${row('Mac notifications', 'Show alerts as native macOS notifications, even with this page closed.', sel('nativeNotify', [[true, 'On'], [false, 'Off']]) + ' <button class="act" data-testnotify>Send test</button>')}
    </div>
    <h3 style="margin:24px 0 8px">Arrange</h3>
    <div class="grid">${arrangeList('tabs', 'Tabs', TABS.map((t) => [t, t]), settings.tabs, 'Settings')}${arrangeList('overview', 'Overview cards', OVERVIEW_CARDS, settings.overview)}</div>
    <p class="hint"><button class="act" data-resetarrange>Reset arrangement</button> Settings are saved in ~/.pulse/settings.json.</p>`;
  },
  Agents() {
    if (!agents.length) return tokenCard() + '<div class="card">No coding agents running. Vitals looks for Claude Code, Codex, Cursor Agent, Gemini CLI, OpenCode and Aider.</div>';
    const rows = agents.map((a) => `<div class="card pad" style="margin-bottom:16px"><h3>${esc(a.agent)} · ${esc(a.project)}</h3><div class="hint" style="margin:0 0 8px">${esc(a.cwd)} · up ${esc(a.uptime)} · pid ${a.pid}</div><div class="row"><span>${a.procCount} process${a.procCount > 1 ? 'es' : ''} in total</span><b>${cpuFmt(a.cpu)} CPU · ${bytes(a.mem)}</b></div>${a.started.length ? `<div style="margin-top:8px">${a.started.map((s) => `<span class="pill">${esc(s.name)}${s.n > 1 ? ' ×' + s.n : ''}</span>`).join(' ')}</div>` : ''}</div>`).join('');
    return `${tokenCard()}<p class="hint" style="margin-top:0">${agents.length} agent session${agents.length > 1 ? 's' : ''} running, with everything each one started.</p>${rows}`;
  },
};

// One row per item: show/hide checkbox plus up/down. 'locked' items can't be hidden (so Settings stays reachable).
function arrangeList(group, title, items, cfg, locked) {
  const ids = items.map(([id]) => id);
  const labels = Object.fromEntries(items);
  const order = [...(cfg.order || []).filter((i) => ids.includes(i)), ...ids.filter((i) => !(cfg.order || []).includes(i))];
  const rows = order.map((id, i) => `<div class="setrow" style="padding:6px 0"><label><input type="checkbox" data-arrange="${group}" data-id="${id}" data-act="toggle" ${(cfg.hidden || []).includes(id) ? '' : 'checked'} ${id === locked ? 'disabled' : ''}> ${esc(labels[id])}</label><span><button class="act" data-arrange="${group}" data-id="${id}" data-act="up" ${i === 0 ? 'disabled' : ''}>↑</button> <button class="act" data-arrange="${group}" data-id="${id}" data-act="down" ${i === order.length - 1 ? 'disabled' : ''}>↓</button></span></div>`).join('');
  return `<div class="card"><h3>${title}</h3>${rows}</div>`;
}
async function saveArrange(group, order, hidden) {
  settings = await (await post('/api/settings', { [group]: { order, hidden } })).json();
  renderTabs(); render(true);
}

// 1200x630 share card, drawn on a canvas in the chosen theme and downloaded as a PNG.
function exportCard(theme) {
  const dark = theme === 'dark';
  const C = dark ? { bg: '#000000', panel: '#1c1c1e', ink: '#f5f5f7', muted: '#98989d', line: '#2c2c2e' } : { bg: '#f5f5f7', panel: '#ffffff', ink: '#1d1d1f', muted: '#6e6e73', line: '#e5e5ea' };
  const css = getComputedStyle(document.documentElement);
  const col = (v, fb) => css.getPropertyValue(v).trim() || fb;
  const blue = col('--blue', '#0a84ff'), green = col('--green', '#30b455'), orange = col('--orange', '#ff9f0a');
  const cv = document.createElement('canvas'); cv.width = 1200; cv.height = 630;
  const g = cv.getContext('2d');
  const font = (w, px) => { g.font = `${w} ${px}px -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif`; };
  const rr = (x, y, w, h, r, fill) => { g.beginPath(); g.roundRect(x, y, w, h, r); g.fillStyle = fill; g.fill(); };
  g.fillStyle = C.bg; g.fillRect(0, 0, 1200, 630);
  rr(48, 48, 40, 40, 10, blue);
  g.fillStyle = C.ink; font(700, 34); g.fillText('Vitals', 104, 80);
  g.fillStyle = C.muted; font(400, 20); g.fillText(`${snap.host.model} · ${(snap.memory.total / 1e9).toFixed(0)} GB`, 48, 124);
  const m = snap.memory;
  rr(48, 150, 540, 190, 24, C.panel);
  g.fillStyle = C.muted; font(500, 20); g.fillText('Memory in use', 76, 190);
  g.fillStyle = green; font(700, 84); g.fillText((m.used / 1e9).toFixed(2), 76, 276);
  const w = g.measureText((m.used / 1e9).toFixed(2)).width;
  g.fillStyle = C.muted; font(500, 28); g.fillText('GB', 84 + w, 276);
  g.fillStyle = C.muted; font(400, 20); g.fillText(`Pressure ${m.pressure} · compressed ${bytes(m.compressed)}`, 76, 318);
  rr(612, 150, 540, 190, 24, C.panel);
  g.fillStyle = C.muted; font(500, 20); g.fillText('CPU now', 640, 190);
  g.fillStyle = blue; font(700, 84); g.fillText(pct(snap.cpu.total), 640, 276);
  const w2 = g.measureText(pct(snap.cpu.total)).width;
  g.fillStyle = C.muted; font(500, 28); g.fillText('%', 648 + w2, 276);
  g.fillStyle = C.muted; font(400, 20); g.fillText(`User ${pct(snap.cpu.user)}% · system ${pct(snap.cpu.system)}% · ${snap.cpu.cores} cores`, 640, 318);
  rr(48, 364, 1104, 218, 24, C.panel);
  g.fillStyle = C.muted; font(500, 20); g.fillText('Top apps by memory', 76, 402);
  const top = snap.apps.slice(0, 4), max = top[0] ? top[0].mem : 1;
  top.forEach((a, i) => {
    const y = 438 + i * 34;
    g.fillStyle = C.ink; font(500, 20); g.fillText(a.name.length > 28 ? a.name.slice(0, 27) + '…' : a.name, 76, y + 6);
    rr(420, y - 10, 520, 14, 7, C.line); rr(420, y - 10, Math.max(14, 520 * a.mem / max), 14, 7, orange);
    g.fillStyle = C.muted; font(500, 20); g.textAlign = 'right'; g.fillText(bytes(a.mem), 1124, y + 6); g.textAlign = 'left';
  });
  g.fillStyle = C.muted; font(400, 16); g.fillText(`${snap.appCount} apps · ${snap.processCount} processes · ${new Date().toLocaleString()}`, 48, 612);
  return cv;
}
function downloadCard(theme) {
  exportCard(theme).toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `vitals-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
}

function tokenCard() {
  const t = tokens;
  if (!t || !t.available) return '';
  const projects = t.byProject.map((p) => `<span class="pill">${esc(p.project)} ${compact(p.total)}</span>`).join(' ');
  return `<div class="card" style="margin-bottom:16px"><h3>Claude Code tokens today</h3><div class="big">${compact(t.total)}<small>tokens</small></div>
    <div class="row"><span>Output</span><b>${compact(t.output)}</b></div><div class="row"><span>Input and cache writes</span><b>${compact(t.input + t.cacheCreate)}</b></div><div class="row"><span>Cache reads (not counted above)</span><b>${compact(t.cacheRead)}</b></div>
    <div style="margin-top:8px">${projects}</div><p class="hint" style="margin:8px 0 0">Counted from Claude Code's local session logs: ${t.messages} messages since midnight. Only token counts are read, never message text. Plan limits aren't available without your account credentials.</p></div>`;
}

function alertBanner() {
  if (!snap.alerts || !snap.alerts.length) return '';
  return snap.alerts.map((a) => `<div class="banner ${a.level}"><b>${esc(a.title)}</b> · ${esc(a.detail)}</div>`).join('');
}

function notifyNew() {
  for (const a of snap.alerts || []) {
    if (notified.has(a.id)) continue;
    notified.add(a.id);
    if (!firstPoll && 'Notification' in window && Notification.permission === 'granted') new Notification(a.title, { body: a.detail });
  }
  firstPoll = false;
}

function appTable(apps, key) {
  return `<div class="card pad" style="margin-top:16px"><table><thead><tr><th>App</th><th class="num">${key === 'cpu' ? 'CPU' : 'Memory'}</th></tr></thead><tbody>${apps.map((a) => `<tr><td>${esc(a.name)} <span class="pill">${a.count} proc</span></td><td class="num">${key === 'cpu' ? cpuFmt(a.cpu) : bytes(a.mem)}</td></tr>`).join('')}</tbody></table></div>`;
}

function render(force = false) {
  if (!snap || !snap.cpu) return;
  // Re-rendering the Settings form every poll would close an open dropdown.
  if (tab === 'Settings' && renderedTab === 'Settings' && !force) return;
  $('#host').textContent = `${snap.host.name} · ${snap.host.model} · up ${dur(snap.host.uptime)}`;
  const focused = document.activeElement && document.activeElement.id === 'q';
  $('#view').innerHTML = (notice ? `<div class="banner warn">${esc(notice)}</div>` : '') + views[tab]();
  renderedTab = tab;
  const q = $('#q');
  if (q) { q.oninput = () => { filter = q.value.toLowerCase(); render(); }; if (focused) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }
}

const markTabs = () => document.querySelectorAll('#tabs button').forEach((b) => {
  b.classList.toggle('on', b.dataset.t === tab);
  b.style.setProperty('--acc', ACCENT[b.dataset.t] || 'var(--blue)');
});
renderTabs();

async function quit(query, label, count, force) {
  const msg = force ? `Force quit ${label}? ${count > 1 ? count + ' processes' : 'It'} will end immediately and unsaved work is lost.` : `Quit ${label}? ${count > 1 ? count + ' processes' : 'It'} will be asked to close.`;
  if (!confirm(msg)) return;
  const r = await (await post(`/api/quit?${query}${force ? '&force=1' : ''}`)).json();
  say(r.ok ? `${r.app}: signalled ${r.signalled} process${r.signalled === 1 ? '' : 'es'}${r.failed ? `, ${r.failed} not permitted` : ''}.` : `Could not quit: ${r.error}`);
  poll();
}

document.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-set]');
  if (!el) return;
  const raw = el.value;
  const val = raw === 'true' ? true : raw === 'false' ? false : /^\d+$/.test(raw) ? Number(raw) : raw;
  settings = await (await post('/api/settings', { [el.dataset.set]: val })).json();
  applyLook(); renderTabs(); render(true);
});

document.addEventListener('click', async (e) => {
  const ex = e.target.closest('[data-export]');
  if (ex) { downloadCard(ex.dataset.export); return; }
  if (e.target.closest('[data-resetarrange]')) { settings = await (await post('/api/settings', { tabs: { order: [], hidden: [] }, overview: { order: [], hidden: [] } })).json(); renderTabs(); render(true); return; }
  const ar = e.target.closest('[data-arrange]');
  if (ar) {
    const group = ar.dataset.arrange, id = ar.dataset.id, act = ar.dataset.act;
    const ids = (group === 'tabs' ? TABS : OVERVIEW_CARDS.map(([i]) => i));
    const cfg = settings[group];
    const order = [...(cfg.order || []).filter((i) => ids.includes(i)), ...ids.filter((i) => !(cfg.order || []).includes(i))];
    let hidden = [...(cfg.hidden || [])];
    const i = order.indexOf(id);
    if (act === 'up' && i > 0) [order[i - 1], order[i]] = [order[i], order[i - 1]];
    if (act === 'down' && i < order.length - 1) [order[i + 1], order[i]] = [order[i], order[i + 1]];
    if (act === 'toggle') hidden = hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id];
    if (act === 'toggle' && e.target.tagName !== 'INPUT') return;
    await saveArrange(group, order, hidden);
    return;
  }
  const q = e.target.closest('[data-quit]');
  if (q) { await quit('app=' + encodeURIComponent(q.dataset.quit), q.dataset.quit, Number(q.dataset.n), !!q.dataset.force); return; }
  const qp = e.target.closest('[data-qpid]');
  if (qp) { await quit('pid=' + qp.dataset.qpid, qp.dataset.name, 1, false); return; }
  if (e.target.closest('[data-testnotify]')) { await post('/api/notify-test'); return; }
  const t = e.target.closest('[data-t]');
  if (t) { tab = t.dataset.t; localStorage.setItem('pulse.tab', tab); markTabs(); render(true); poll(); return; }
  const th = e.target.closest('[data-sort]');
  if (th) { sortKey = th.dataset.sort; render(); return; }
  const row = e.target.closest('tr.app');
  if (row) { const n = row.dataset.app; open.has(n) ? open.delete(n) : open.add(n); render(); return; }
  const rg = e.target.closest('[data-range]');
  if (rg) { range = rg.dataset.range; localStorage.setItem('pulse.range', range); await poll(); return; }
  if (e.target.closest('[data-scan]')) { await post('/api/disk/scan'); await poll(); return; }
  if (e.target.closest('[data-sys]')) { showSys = !showSys; render(); return; }
  if (e.target.closest('[data-notify]')) { await Notification.requestPermission(); render(); return; }
  const stop = e.target.closest('[data-stop]');
  if (stop && confirm(`Stop ${stop.dataset.name} (pid ${stop.dataset.stop})?`)) {
    await post(`/api/stop?pid=${stop.dataset.stop}`);
    await poll();
  }
});

async function poll() {
  try {
    snap = await (await fetch('/api/snapshot')).json();
    if (tab === 'Projects' || tab === 'Overview') projects = await (await fetch('/api/projects')).json();
    if (tab === 'Disk') diskData = await (await fetch('/api/disk')).json();
    if (tab === 'Agents') { agents = await (await fetch('/api/agents')).json(); tokens = await (await fetch('/api/tokens')).json(); }
    if (tab === 'Docker') docker = await (await fetch('/api/docker')).json();
    if (tab === 'History') histData = await (await fetch(`/api/history?range=${range}`)).json();
    if (tab === 'Alerts') alertLog = (await (await fetch('/api/alerts')).json()).log;
    notifyNew();
    render();
  } catch { $('#host').textContent = 'server unreachable'; }
}
fetch('/api/settings').then((r) => r.json()).then((s) => { settings = s; applyLook(); renderTabs(); render(true); }).catch(() => {});
poll();
setInterval(poll, 2000);
