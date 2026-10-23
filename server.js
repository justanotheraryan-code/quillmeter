#!/usr/bin/env node
// Vitals: a local Mac activity monitor that groups processes by app.
// Zero dependencies. Reads real data via ps, vm_stat, df, netstat, pmset, lsof.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const extra = require('./lib/extra');

const PORT = Number(process.env.PORT || 4747);
const PUBLIC = path.join(__dirname, 'public');
const HISTORY_LIMIT = 300; // samples kept server-side (2s each = 10 min)

const sh = (cmd, args, timeout = 4000) =>
  new Promise((resolve) =>
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, out) => resolve(err ? '' : out))
  );

// ---------- CPU (delta of os.cpus) ----------
let lastCpu = os.cpus();
function sampleCpu() {
  const now = os.cpus();
  let user = 0, sys = 0, idle = 0;
  now.forEach((c, i) => {
    const p = lastCpu[i].times;
    user += c.times.user - p.user + (c.times.nice - p.nice);
    sys += c.times.sys - p.sys;
    idle += c.times.idle - p.idle;
  });
  lastCpu = now;
  const total = user + sys + idle || 1;
  return { total: ((user + sys) / total) * 100, user: (user / total) * 100, system: (sys / total) * 100, cores: now.length };
}

// ---------- Memory ----------
async function sampleMemory() {
  const out = await sh('vm_stat', []);
  const page = Number((out.match(/page size of (\d+)/) || [])[1] || 16384);
  const get = (label) => Number((out.match(new RegExp(label + ':\\s+(\\d+)')) || [])[1] || 0) * page;
  const wired = get('Pages wired down');
  const compressed = get('Pages occupied by compressor');
  const purgeable = get('Pages purgeable');
  const app = Math.max(0, get('Anonymous pages') - purgeable);
  const total = os.totalmem();
  const used = Math.min(total, app + wired + compressed);
  const pressure = used / total > 0.9 ? 'critical' : used / total > 0.75 ? 'warn' : 'normal';
  return { total, used, app, wired, compressed, cached: get('File-backed pages'), pressure };
}

// ---------- Disk ----------
async function sampleDisk() {
  const out = await sh('df', ['-k', '/System/Volumes/Data']);
  const row = out.trim().split('\n')[1];
  if (!row) return { total: 0, free: 0 };
  const t = row.split(/\s+/);
  return { total: Number(t[1]) * 1024, free: Number(t[3]) * 1024 };
}

// ---------- Network (delta of netstat -ib on en*) ----------
let lastNet = null;
async function sampleNetwork() {
  // -n matters: without it netstat reverse-resolves every address and exceeds the 4s timeout.
  const out = await sh('netstat', ['-ibn']);
  const seen = new Set();
  let rx = 0, tx = 0;
  for (const line of out.split('\n')) {
    const t = line.trim().split(/\s+/);
    if (!t[0] || !/^en\d+/.test(t[0]) || !(t[2] || '').startsWith('<Link#') || seen.has(t[0])) continue;
    seen.add(t[0]);
    const off = t.length >= 11 ? 0 : -1; // Address column is blank on some rows
    rx += Number(t[6 + off] || 0);
    tx += Number(t[9 + off] || 0);
  }
  const now = Date.now();
  let down = 0, up = 0;
  if (lastNet) {
    const dt = (now - lastNet.t) / 1000 || 1;
    down = Math.max(0, (rx - lastNet.rx) / dt);
    up = Math.max(0, (tx - lastNet.tx) / dt);
  }
  lastNet = { t: now, rx, tx };
  return { down, up, totalDown: rx, totalUp: tx };
}

// ---------- Per-app network (nettop in short two-sample runs; the second block is the delta) ----------
let netByPid = new Map();
let stopping = false;
// nettop is a curses tool: it needs a TERM, and only emits CSV in logging mode (-L).
function runNettop() {
  if (stopping) return;
  execFile('nettop', ['-P', '-d', '-L', '2', '-s', '1', '-J', 'bytes_in,bytes_out', '-x'],
    { timeout: 20000, env: { ...process.env, TERM: 'xterm' }, maxBuffer: 8 * 1024 * 1024 },
    (_err, out) => {
      const blocks = [];
      for (const line of (out || '').split('\n')) {
        if (line.startsWith(',bytes_in')) { blocks.push(new Map()); continue; }
        const m = line.match(/^(.*)\.(\d+),(\d+),(\d+),$/);
        if (m && blocks.length) blocks[blocks.length - 1].set(Number(m[2]), { name: m[1], down: Number(m[3]), up: Number(m[4]) });
      }
      if (blocks.length >= 2) netByPid = blocks[1]; // blocks[0] is cumulative since each process started
      setTimeout(runNettop, 500);
    });
}
process.on('exit', () => { stopping = true; });
runNettop();

function networkApps(apps) {
  const pidApp = new Map();
  for (const a of apps) for (const pid of a.pids) pidApp.set(pid, a.name);
  const per = new Map();
  for (const [pid, v] of netByPid) {
    const name = pidApp.get(pid) || v.name;
    const e = per.get(name) || { name, down: 0, up: 0 };
    e.down += v.down; e.up += v.up;
    per.set(name, e);
  }
  return [...per.values()].filter((e) => e.down + e.up > 0).sort((a, b) => b.down + b.up - (a.down + a.up)).slice(0, 12);
}

// ---------- Disk I/O (ioreg byte counters, delta per tick) ----------
let lastIO = null;
async function sampleDiskIO() {
  const out = await sh('ioreg', ['-c', 'IOBlockStorageDriver', '-r', '-w0']);
  let r = 0, w = 0;
  for (const m of out.matchAll(/"Bytes \(Read\)"=(\d+)/g)) r += Number(m[1]);
  for (const m of out.matchAll(/"Bytes \(Write\)"=(\d+)/g)) w += Number(m[1]);
  const now = Date.now();
  let read = 0, write = 0;
  if (lastIO) {
    const dt = (now - lastIO.t) / 1000 || 1;
    read = Math.max(0, (r - lastIO.r) / dt);
    write = Math.max(0, (w - lastIO.w) / dt);
  }
  lastIO = { t: now, r, w };
  return { read, write, totalRead: r, totalWrite: w };
}

// ---------- Disk breakdown (du scan of $HOME to depth 2; slow, so cached and niced) ----------
const shRaw = (cmd, args, timeout) =>
  new Promise((resolve) => execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (_e, out) => resolve(out || '')));
const diskScan = { state: 'idle', startedAt: 0, scannedAt: 0, home: [], library: [], homeBytes: 0, appsBytes: 0 };
async function scanDisk() {
  if (diskScan.state === 'scanning') return;
  diskScan.state = 'scanning';
  diskScan.startedAt = Date.now();
  const home = os.homedir();
  try {
    const [duOut, appsOut] = await Promise.all([
      shRaw('nice', ['-n', '19', 'du', '-xk', '-d2', home], 300000),
      shRaw('nice', ['-n', '19', 'du', '-xsk', '/Applications'], 120000),
    ]);
    const rows = duOut.split('\n').map((l) => l.match(/^(\d+)\t(.+)$/)).filter(Boolean).map((m) => ({ kb: +m[1], p: m[2] }));
    const children = (parent) => rows
      .filter((r) => r.p !== parent && path.dirname(r.p) === parent)
      .sort((a, b) => b.kb - a.kb).slice(0, 10)
      .map((r) => ({ name: path.basename(r.p), path: r.p, bytes: r.kb * 1024 }));
    diskScan.home = children(home);
    diskScan.library = children(path.join(home, 'Library'));
    diskScan.homeBytes = ((rows.find((r) => r.p === home) || { kb: 0 }).kb) * 1024;
    diskScan.appsBytes = Number((appsOut.match(/^(\d+)/) || [])[1] || 0) * 1024;
    diskScan.scannedAt = Date.now();
    diskScan.state = 'ready';
  } catch (e) {
    console.error('disk scan failed:', e.message);
    diskScan.state = diskScan.scannedAt ? 'ready' : 'idle';
  }
}
setTimeout(scanDisk, 5000);
setInterval(scanDisk, 6 * 3600e3);

// ---------- Battery ----------
async function sampleBattery() {
  const out = await sh('pmset', ['-g', 'batt']);
  const m = out.match(/(\d+)%;\s*([^;]+);\s*([^;]*?)(?:\s+present|$)/m);
  if (!m) return { present: false };
  const state = m[2].trim();
  const remaining = (m[3].match(/(\d+:\d+) remaining/) || [])[1] || null;
  return { present: true, percent: Number(m[1]), state, onBattery: /Battery Power/.test(out), remaining };
}

// ---------- Processes grouped by app ----------
function appKey(command) {
  const m = command.match(/\/([^/]+)\.app\//);
  if (m) {
    // Helpers live inside the parent bundle: …/Foo.app/Contents/Frameworks/Foo Helper.app/…; take the outermost.
    const outer = command.match(/^.*?\/([^/]+)\.app\//);
    return { name: outer[1], kind: 'app' };
  }
  const base = command.split('/').pop().trim();
  return { name: base || command, kind: 'process' };
}

async function sampleProcesses() {
  const out = await sh('ps', ['-axo', 'pid=,pcpu=,rss=,comm=']);
  const groups = new Map();
  let count = 0;
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    count++;
    const [, pid, cpu, rss, command] = m;
    const { name, kind } = appKey(command);
    let g = groups.get(name);
    if (!g) groups.set(name, (g = { name, kind, cpu: 0, mem: 0, count: 0, pids: [], children: [] }));
    g.cpu += Number(cpu);
    g.mem += Number(rss) * 1024;
    g.count++;
    g.pids.push(Number(pid));
    g.children.push({ pid: Number(pid), name: command.split('/').pop(), cpu: Number(cpu), mem: Number(rss) * 1024 });
  }
  const apps = [...groups.values()].sort((a, b) => b.mem - a.mem);
  for (const a of apps) {
    a.children.sort((x, y) => y.mem - x.mem);
    a.children = a.children.slice(0, 6);
    a.pids = a.pids.slice(0, 200);
  }
  return { processCount: count, apps: apps.slice(0, 80), groupCount: apps.length, appCount: apps.filter((a) => a.kind === 'app').length };
}

// ---------- Dev servers / listening ports (cached; lsof is slow) ----------
let portsCache = { t: 0, data: [] };
const pidSeen = new Map();
const gitCache = new Map();
const parseEtime = (s) => { // [[dd-]hh:]mm:ss
  const m = s.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  return m ? ((+m[1] || 0) * 24 + (+m[2] || 0)) * 3600 + +m[3] * 60 + +m[4] : 0;
};
const parseCpuTime = (s) => { // [h:]mm:ss.cc
  const m = s.match(/^(?:(\d+):)?(\d+):(\d+)(?:\.\d+)?$/);
  return m ? (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3] : 0;
};
const fmtDur = (s) => (s >= 86400 ? `${Math.floor(s / 86400)} days` : s >= 3600 ? `${Math.floor(s / 3600)} hours` : `${Math.floor(s / 60)} min`);
function gitRoot(dir) {
  if (gitCache.has(dir)) return gitCache.get(dir);
  let d = dir, root = null;
  // Stop before $HOME: a dotfiles-style repo there would swallow every project.
  for (let i = 0; i < 12 && d && d !== '/' && d !== os.homedir(); i++, d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) { root = d; break; }
  }
  gitCache.set(dir, root);
  return root;
}
async function sampleProjects() {
  if (Date.now() - portsCache.t < 8000) return portsCache.data;
  const out = await sh('lsof', ['-iTCP', '-sTCP:LISTEN', '-n', '-P', '-Fpcn'], 6000);
  const entries = new Map(); // pid -> {command, ports:Set}
  let cur = null;
  for (const line of out.split('\n')) {
    const k = line[0], v = line.slice(1);
    if (k === 'p') entries.set((cur = Number(v)), { pid: cur, command: '', ports: new Set() });
    else if (k === 'c' && cur) entries.get(cur).command = v;
    else if (k === 'n' && cur) {
      const port = v.match(/:(\d+)$/);
      if (port) entries.get(cur).ports.add(Number(port[1]));
    }
  }
  const list = [];
  const now = Date.now();
  await Promise.all(
    [...entries.values()].map(async (e) => {
      const cwdOut = await sh('lsof', ['-a', '-p', String(e.pid), '-d', 'cwd', '-Fn'], 3000);
      const cwd = (cwdOut.match(/\nn(.+)/) || [])[1] || '';
      const stat = (await sh('ps', ['-o', 'etime=,time=,pcpu=,rss=', '-p', String(e.pid)])).trim().split(/\s+/);
      const up = parseEtime(stat[0] || ''), cpuSecs = parseCpuTime(stat[1] || '');
      const cpu = Number(stat[2] || 0);
      const seen = pidSeen.get(e.pid) || { first: now, lastActive: now };
      if (cpu >= 1) seen.lastActive = now;
      pidSeen.set(e.pid, seen);
      const idleSecs = (now - seen.lastActive) / 1000;
      const observed = (now - seen.first) / 1000;
      let status = 'working', note = 'working';
      if (cpu < 1) {
        if (idleSecs >= 1800 && observed >= 1800) { status = 'idle'; note = `idle ${fmtDur(idleSecs)}`; }
        else if (up > 86400 && cpuSecs / up < 0.005) { status = 'idle'; note = `up ${fmtDur(up)}, barely used`; }
        else { status = 'quiet'; note = 'quiet'; }
      }
      const home = os.homedir() + '/';
      const dev = cwd.startsWith(home) && !/\/Library\//.test(cwd);
      const root = dev ? gitRoot(cwd) : null;
      list.push({
        pid: e.pid,
        command: e.command,
        ports: [...e.ports].sort((a, b) => a - b),
        cwd,
        repo: root,
        dev,
        self: e.pid === process.pid,
        project: dev ? path.basename(root || cwd) : e.command,
        uptime: stat[0] || '',
        cpu,
        mem: Number(stat[3] || 0) * 1024,
        status,
        note,
      });
    })
  );
  for (const pid of [...pidSeen.keys()]) if (!entries.has(pid)) pidSeen.delete(pid);
  list.sort((a, b) => a.project.localeCompare(b.project) || a.ports[0] - b.ports[0]);
  portsCache = { t: Date.now(), data: list };
  return list;
}
// ---------- Coding agents (CLI binaries and everything they spawned) ----------
const AGENTS = { claude: 'Claude Code', codex: 'Codex', 'cursor-agent': 'Cursor Agent', gemini: 'Gemini CLI', opencode: 'OpenCode', aider: 'Aider' };
let agentsCache = { t: 0, data: [] };
async function sampleAgents() {
  if (Date.now() - agentsCache.t < 5000) return agentsCache.data;
  const out = await sh('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,etime=,comm=']);
  const procs = new Map(), kids = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const p = { pid: +m[1], ppid: +m[2], cpu: +m[3], mem: +m[4] * 1024, etime: m[5], name: m[6].split('/').pop() };
    procs.set(p.pid, p);
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p.pid);
  }
  const hasAgentAncestor = (p) => {
    let a = procs.get(p.ppid);
    for (let i = 0; a && i < 40; i++, a = procs.get(a.ppid)) if (AGENTS[a.name]) return true;
    return false;
  };
  const roots = [...procs.values()].filter((p) => AGENTS[p.name] && !hasAgentAncestor(p));
  const list = await Promise.all(roots.map(async (r) => {
    let cpu = 0, mem = 0, count = 0;
    const started = new Map();
    const queue = [r.pid];
    while (queue.length) {
      const p = procs.get(queue.shift());
      if (!p) continue;
      cpu += p.cpu; mem += p.mem; count++;
      if (p.pid !== r.pid) started.set(p.name, (started.get(p.name) || 0) + 1);
      queue.push(...(kids.get(p.pid) || []));
    }
    const cwdOut = await sh('lsof', ['-a', '-p', String(r.pid), '-d', 'cwd', '-Fn'], 3000);
    const cwd = (cwdOut.match(/\nn(.+)/) || [])[1] || '';
    const root = cwd.startsWith(os.homedir() + '/') ? gitRoot(cwd) : null;
    return {
      pid: r.pid, agent: AGENTS[r.name], uptime: r.etime, cwd, cpu, mem, procCount: count,
      project: cwd && cwd !== '/' ? path.basename(root || cwd) : '—',
      started: [...started].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, n]) => ({ name, n })),
    };
  }));
  list.sort((a, b) => b.mem - a.mem);
  agentsCache = { t: Date.now(), data: list };
  return list;
}

// Sample in the background so idle time is tracked even while nobody has the tab open.
setInterval(() => sampleProjects().catch(() => {}), 10000);

// ---------- Persistent history (per-minute rollups, 7 days, JSONL in ~/.pulse) ----------
const DATA_DIR = process.env.PULSE_DATA || path.join(os.homedir(), '.pulse');
const HIST_FILE = path.join(DATA_DIR, 'history.jsonl');
const ALERT_FILE = path.join(DATA_DIR, 'alerts.jsonl');
const MINUTE_RETENTION_MS = 7 * 864e5; // per-minute detail; older data lives on as hourly rollups
const HOUR_FILE = path.join(DATA_DIR, 'hourly.jsonl');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Settings (shared by the UI, alerts and retention) ----------
const DEFAULT_SETTINGS = {
  bits: false, cpuPerMac: false, palette: 'vitals', compact: false,
  retentionDays: 7, nativeNotify: true,
  tabs: { order: [], hidden: [] }, overview: { order: [], hidden: [] },
};
function sanitizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const s = { ...DEFAULT_SETTINGS, tabs: { order: [], hidden: [] }, overview: { order: [], hidden: [] } };
  for (const k of ['bits', 'cpuPerMac', 'compact', 'nativeNotify']) if (typeof r[k] === 'boolean') s[k] = r[k];
  if (['vitals', 'mono', 'accessible'].includes(r.palette)) s.palette = r.palette;
  if ([7, 30, 90, 180, 365].includes(r.retentionDays)) s.retentionDays = r.retentionDays;
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length < 32).slice(0, 40) : []);
  for (const k of ['tabs', 'overview']) if (r[k] && typeof r[k] === 'object') s[k] = { order: list(r[k].order), hidden: list(r[k].hidden) };
  return s;
}
let settings;
try { settings = sanitizeSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); } catch { settings = sanitizeSettings({}); }
function saveSettings(next) {
  settings = sanitizeSettings(next);
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, SETTINGS_FILE);
  return settings;
}
const retentionMs = () => settings.retentionDays * 864e5;

const readJsonl = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  } catch { return []; }
};
let minutes = readJsonl(HIST_FILE).filter((p) => p.t >= Date.now() - MINUTE_RETENTION_MS);
let hours = readJsonl(HOUR_FILE).filter((p) => p.t >= Date.now() - retentionMs());
// Rewrite once at startup to drop expired and corrupt lines.
try { fs.writeFileSync(HIST_FILE, minutes.map((p) => JSON.stringify(p) + '\n').join('')); } catch (e) { console.error('history rewrite failed:', e.message); }
try { fs.writeFileSync(HOUR_FILE, hours.map((p) => JSON.stringify(p) + '\n').join('')); } catch (e) { console.error('hourly rewrite failed:', e.message); }

// Hourly rollups: averages of the minute points, kept for the configured retention (up to a year).
let hacc = null;
const topApps = (entries) => {
  const keep = new Map();
  [...entries].sort((a, b) => b[1] - a[1]).slice(0, 8).forEach((a) => keep.set(a[0], a));
  [...entries].sort((a, b) => b[2] - a[2]).slice(0, 8).forEach((a) => keep.set(a[0], a));
  return [...keep.values()].map(([name, cpu, mem]) => [name, Math.round(cpu * 10) / 10, Math.round(mem)]);
};
function flushHour() {
  if (!hacc || !hacc.n) return;
  const n = hacc.n;
  const point = {
    t: hacc.t, cpu: hacc.cpu / n, mem: hacc.mem / n, down: hacc.down / n, up: hacc.up / n,
    apps: topApps([...hacc.apps].map(([name, v]) => [name, v.cpu / n, v.mem / n])),
  };
  hours.push(point);
  const cutoff = Date.now() - retentionMs();
  while (hours.length && hours[0].t < cutoff) hours.shift();
  try { fs.appendFileSync(HOUR_FILE, JSON.stringify(point) + '\n'); } catch (e) { console.error('hourly append failed:', e.message); }
  hacc = null;
}
function addHour(point) {
  const bucket = Math.floor(point.t / 3600000) * 3600000;
  if (hacc && hacc.t !== bucket) flushHour();
  if (!hacc) hacc = { t: bucket, n: 0, cpu: 0, mem: 0, down: 0, up: 0, apps: new Map() };
  hacc.n++; hacc.cpu += point.cpu; hacc.mem += point.mem; hacc.down += point.down; hacc.up += point.up;
  for (const [name, cpu, mem] of point.apps) {
    const e = hacc.apps.get(name) || { cpu: 0, mem: 0 };
    e.cpu += cpu; e.mem += mem;
    hacc.apps.set(name, e);
  }
}

let acc = null;
function flushMinute(sync = false) {
  if (!acc || !acc.n) return;
  const n = acc.n;
  const apps = [...acc.apps].map(([name, v]) => [name, v.cpu / n, v.mem / n]);
  const keep = new Map();
  [...apps].sort((a, b) => b[1] - a[1]).slice(0, 8).forEach((a) => keep.set(a[0], a));
  [...apps].sort((a, b) => b[2] - a[2]).slice(0, 8).forEach((a) => keep.set(a[0], a));
  const point = {
    t: acc.t, cpu: acc.cpu / n, mem: acc.mem / n, down: acc.down / n, up: acc.up / n,
    apps: [...keep.values()].map(([name, cpu, mem]) => [name, Math.round(cpu * 10) / 10, Math.round(mem)]),
  };
  minutes.push(point);
  addHour(point);
  const cutoff = Date.now() - MINUTE_RETENTION_MS;
  while (minutes.length && minutes[0].t < cutoff) minutes.shift();
  const line = JSON.stringify(point) + '\n';
  if (sync) {
    try { fs.appendFileSync(HIST_FILE, line); } catch (e) { console.error('history append failed:', e.message); }
  } else fs.appendFile(HIST_FILE, line, (e) => e && console.error('history append failed:', e.message));
}
function record(s) {
  const bucket = Math.floor(s.t / 60000) * 60000;
  if (acc && acc.t !== bucket) { flushMinute(); acc = null; }
  if (!acc) acc = { t: bucket, n: 0, cpu: 0, mem: 0, down: 0, up: 0, apps: new Map() };
  acc.n++; acc.cpu += s.cpu.total; acc.mem += s.memory.used; acc.down += s.network.down; acc.up += s.network.up;
  for (const a of s.apps) {
    const e = acc.apps.get(a.name) || { cpu: 0, mem: 0 };
    e.cpu += a.cpu; e.mem += a.mem;
    acc.apps.set(a.name, e);
  }
}
process.on('SIGINT', () => { flushMinute(true); flushHour(); process.exit(0); });
process.on('SIGTERM', () => { flushMinute(true); flushHour(); process.exit(0); });

function historyRange(range) {
  const days = { '30d': 30, '90d': 90, '180d': 180, '365d': 365 }[range];
  const span = Math.min(days ? days * 864e5 : { '1h': 36e5, '24h': 864e5, '7d': 7 * 864e5 }[range] || 36e5, retentionMs());
  const source = span > MINUTE_RETENTION_MS ? hours : minutes;
  const pts = source.filter((p) => p.t >= Date.now() - span);
  const size = Math.max(1, Math.ceil(pts.length / 120));
  const series = [];
  for (let i = 0; i < pts.length; i += size) {
    const c = pts.slice(i, i + size);
    const avg = (k) => c.reduce((s, p) => s + p[k], 0) / c.length;
    series.push({ t: c[0].t, cpu: avg('cpu'), mem: avg('mem'), down: avg('down'), up: avg('up') });
  }
  const per = new Map();
  for (const p of pts) for (const [name, cpu, mem] of p.apps) {
    const e = per.get(name) || { name, cpuSum: 0, memSum: 0, memN: 0, peakMem: 0 };
    e.cpuSum += cpu; e.memSum += mem; e.memN++; e.peakMem = Math.max(e.peakMem, mem);
    per.set(name, e);
  }
  const rows = [...per.values()].map((e) => ({
    name: e.name, avgCpu: e.cpuSum / (pts.length || 1), avgMem: e.memSum / (e.memN || 1), peakMem: e.peakMem,
  }));
  return {
    range, minutes: pts.length, unit: source === hours ? 'hours' : 'minutes', since: pts.length ? pts[0].t : null, series,
    topCpu: [...rows].sort((a, b) => b.avgCpu - a.avgCpu).slice(0, 10),
    topMem: [...rows].sort((a, b) => b.avgMem - a.avgMem).slice(0, 10),
  };
}

// ---------- Alerts ----------
const ALERT_CPU = Number(process.env.PULSE_ALERT_CPU || 80);                 // % of one core
const ALERT_CPU_SECS = Number(process.env.PULSE_ALERT_CPU_SECS || 300);
const GROWTH_BYTES = Number(process.env.PULSE_ALERT_GROWTH_MB || 1000) * 1e6;
const GROWTH_MIN_SPAN = Number(process.env.PULSE_ALERT_GROWTH_MIN || 10) * 60e3;
const GROWTH_WINDOW = 30 * 60e3;
const cpuSince = new Map();
const memTrack = new Map();
const active = new Map();
let alertLog = readJsonl(ALERT_FILE).slice(-50).reverse();

// Native macOS notification via osascript. Strings are JSON-quoted (AppleScript reads \" and \\ the same way)
// after control characters are stripped, so process names can't break out of the script.
function notifyNative(title, detail) {
  if (!settings.nativeNotify || process.platform !== 'darwin') return;
  const q = (s) => JSON.stringify(String(s).replace(/[\u0000-\u001f]/g, ' ').slice(0, 200));
  execFile('osascript', ['-e', `display notification ${q(detail)} with title ${q(title)}`], { timeout: 5000 }, () => {});
}

function raise(key, level, title, detail) {
  const existing = active.get(key);
  if (existing) { existing.detail = detail; return; }
  const a = { id: `${Date.now()}-${key}`, t: Date.now(), key, level, title, detail };
  active.set(key, a);
  alertLog.unshift(a);
  alertLog = alertLog.slice(0, 50);
  notifyNative(title, detail);
  fs.appendFile(ALERT_FILE, JSON.stringify(a) + '\n', (e) => e && console.error('alert append failed:', e.message));
}
const mb = (n) => (n / 1e9 >= 1 ? (n / 1e9).toFixed(1) + ' GB' : (n / 1e6).toFixed(0) + ' MB');

function evaluateAlerts(s) {
  const names = new Set(s.apps.map((a) => a.name));
  for (const a of s.apps) {
    const ck = `cpu:${a.name}`;
    if (a.cpu >= ALERT_CPU) {
      if (!cpuSince.has(a.name)) cpuSince.set(a.name, s.t);
      const secs = (s.t - cpuSince.get(a.name)) / 1000;
      if (secs >= ALERT_CPU_SECS) raise(ck, 'warn', `${a.name} is keeping the CPU busy`, `${a.cpu.toFixed(0)}% of a core for ${(secs / 60).toFixed(1)} min`);
    } else { cpuSince.delete(a.name); active.delete(ck); }

    const gk = `mem:${a.name}`;
    const track = memTrack.get(a.name) || [];
    if (!track.length || s.t - track[track.length - 1].t >= 30e3) track.push({ t: s.t, mem: a.mem });
    while (track.length && s.t - track[0].t > GROWTH_WINDOW) track.shift();
    memTrack.set(a.name, track);
    const first = track[0], last = track[track.length - 1];
    const max = Math.max(...track.map((x) => x.mem));
    if (last.t - first.t >= GROWTH_MIN_SPAN && last.mem - first.mem >= GROWTH_BYTES && last.mem >= max * 0.95) {
      raise(gk, 'warn', `${a.name} keeps using more memory`, `Up ${mb(last.mem - first.mem)} in ${Math.round((last.t - first.t) / 60e3)} min, now ${mb(last.mem)}`);
    } else if (active.has(gk) && last.mem < max * 0.9) active.delete(gk);
  }
  for (const name of [...cpuSince.keys()]) if (!names.has(name)) { cpuSince.delete(name); active.delete(`cpu:${name}`); }
  for (const name of [...memTrack.keys()]) if (!names.has(name)) { memTrack.delete(name); active.delete(`mem:${name}`); }

  if (s.memory.pressure === 'critical') raise('sys:mem', 'bad', 'Memory is nearly full', `${mb(s.memory.used)} of ${mb(s.memory.total)} in use`);
  else active.delete('sys:mem');
  if (s.battery.present && s.battery.onBattery && s.battery.percent < 15) raise('sys:bat', 'bad', 'Battery is low', `${s.battery.percent}% left`);
  else active.delete('sys:bat');
}

// ---------- Snapshot + history ----------
const history = [];
let latest = null;
async function tick() {
  try {
    const [memory, diskBase, io, netBase, batteryBase, procs, gpu, batteryExtra] = await Promise.all([
      sampleMemory(), sampleDisk(), sampleDiskIO(), sampleNetwork(), sampleBattery(), sampleProcesses(),
      extra.sampleGpu(), extra.sampleBatteryDetail(),
    ]);
    const battery = batteryBase.present ? { ...batteryBase, ...batteryExtra } : batteryBase;
    const cpu = sampleCpu();
    const disk = { ...diskBase, ...io };
    const network = { ...netBase, apps: networkApps(procs.apps) };
    latest = {
      t: Date.now(),
      host: { name: os.hostname(), model: os.cpus()[0].model, uptime: os.uptime(), platform: `${os.type()} ${os.release()}` },
      cpu, memory, disk, network, battery, gpu, ...procs,
    };
    history.push({ t: latest.t, cpu: cpu.total, mem: memory.used, down: network.down, up: network.up, dr: io.read, dw: io.write, gpu: gpu.present ? gpu.util : 0, bat: battery.present ? battery.percent : 0 });
    if (history.length > HISTORY_LIMIT) history.shift();
    record(latest);
    evaluateAlerts(latest);
  } catch (e) {
    console.error('tick failed:', e.message);
  }
}
tick();
setInterval(tick, 2000);

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

// Quit/force quit never trust client-supplied PIDs blindly: they must belong to a process group in the latest snapshot.
const PROTECTED = new Set(['Finder', 'WindowServer', 'loginwindow', 'Dock', 'SystemUIServer', 'launchd', 'kernel_task']);
function quitTargets(url) {
  if (!latest) return { error: 'still warming up', code: 503 };
  const name = url.searchParams.get('app');
  const pid = Number(url.searchParams.get('pid'));
  const group = name ? latest.apps.find((a) => a.name === name) : latest.apps.find((a) => a.pids.includes(pid));
  if (!group) return { error: 'not found in the current process list', code: 404 };
  if (PROTECTED.has(group.name)) return { error: `${group.name} is protected`, code: 400 };
  const pids = (name ? group.pids : [pid]).filter((p) => p > 1 && p !== process.pid);
  if (!pids.length) return { error: 'refusing to stop Vitals itself', code: 400 };
  return { group, pids };
}

// Only the page itself may call the API: the Host check blocks DNS rebinding, and POSTs need a custom
// header (which forces a CORS preflight that we never grant), so other websites can't signal processes.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 20000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve(null); } });
  });
}

const server = http.createServer(async (req, res) => {
  if (!ALLOWED_HOSTS.has(req.headers.host)) { res.writeHead(403); return res.end('forbidden host'); }
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (req.headers['x-vitals'] !== '1' || (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, '')))) {
      res.writeHead(403); return res.end('forbidden');
    }
  }
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/settings') {
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!body) return json(res, 400, { ok: false, error: 'invalid JSON' });
      return json(res, 200, saveSettings({ ...settings, ...body }));
    }
    return json(res, 200, settings);
  }
  if (url.pathname === '/api/notify-test' && req.method === 'POST') { notifyNative('Vitals', 'Notifications are working.'); return json(res, 200, { ok: true }); }
  if (url.pathname === '/api/quit' && req.method === 'POST') {
    const t = quitTargets(url);
    if (t.error) return json(res, t.code, { ok: false, error: t.error });
    const sig = url.searchParams.get('force') === '1' ? 'SIGKILL' : 'SIGTERM';
    let signalled = 0, failed = 0;
    for (const p of t.pids) { try { process.kill(p, sig); signalled++; } catch { failed++; } }
    return json(res, 200, { ok: true, app: t.group.name, signalled, failed, signal: sig });
  }
  if (url.pathname === '/api/snapshot') return json(res, 200, { ...latest, history, alerts: [...active.values()] });
  if (url.pathname === '/api/history') return json(res, 200, historyRange(url.searchParams.get('range')));
  if (url.pathname === '/api/alerts') return json(res, 200, { active: [...active.values()], log: alertLog });
  if (url.pathname === '/api/projects') return json(res, 200, await sampleProjects());
  if (url.pathname === '/api/docker') return json(res, 200, await extra.sampleDocker());
  if (url.pathname === '/api/tokens') return json(res, 200, extra.tokenUsage());
  if (url.pathname === '/api/disk') return json(res, 200, diskScan);
  if (url.pathname === '/api/disk/scan' && req.method === 'POST') { scanDisk(); return json(res, 202, { ok: true }); }
  if (url.pathname === '/api/agents') return json(res, 200, await sampleAgents());
  if (url.pathname === '/api/stop' && req.method === 'POST') {
    // Only stops a PID that currently owns a listening port; asks politely (SIGTERM).
    const pid = Number(url.searchParams.get('pid'));
    const owners = await sampleProjects();
    const target = owners.find((p) => p.pid === pid);
    if (!target || !target.dev) return json(res, 400, { ok: false, error: 'pid is not a listening dev server' });
    if (target.self) return json(res, 400, { ok: false, error: 'refusing to stop Pulse itself' });
    try { process.kill(pid, 'SIGTERM'); portsCache.t = 0; return json(res, 200, { ok: true }); }
    catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }
  const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// Bound to loopback only: this exposes process names and can signal processes.
server.listen(PORT, '127.0.0.1', () => console.log(`Vitals running at http://127.0.0.1:${PORT}`));
