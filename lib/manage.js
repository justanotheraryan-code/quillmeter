'use strict';
// App management for Quillmeter: cleaner, uninstaller, Homebrew manager and update checks.
//
// Rules that apply to everything here:
//  - Nothing runs until the person asks (a button press); there is no background scanning.
//  - Anything that removes files moves it to the Trash (Put Back works); nothing is deleted permanently.
//  - The client never sends a path. It sends ids from a scan the server did, and the server re-validates the path
//    behind each id (still exists, not a symlink, still inside an allowed folder) before it moves anything.
//  - The cleaner only looks in folders the person enabled during setup (see lib/scanplan.js).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const https = require('node:https');
const { execFile, spawn } = require('node:child_process');
const scanplan = require('./scanplan');

const HOME = process.env.QUILLMETER_HOME || os.homedir(); // overridable so tests never touch real folders
const APP_DIRS = (process.env.QUILLMETER_APP_DIRS ? process.env.QUILLMETER_APP_DIRS.split(':') : ['/Applications', path.join(HOME, 'Applications')]);
const LIB = path.join(HOME, 'Library');

const run = (cmd, args, { timeout = 8000, env } = {}) =>
  new Promise((resolve) => execFile(cmd, args, { timeout, env, maxBuffer: 32 * 1024 * 1024 }, (err, out, errOut) => resolve({ ok: !err, out: out || '', err: errOut || '' })));
const idOf = (p) => crypto.createHash('sha1').update(p).digest('hex').slice(0, 12);
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const lstat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
const names = (p) => { try { return fs.readdirSync(p); } catch { return []; } };
const display = (p) => (p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p);
const realEquals = (p) => { try { return fs.realpathSync(p) === p; } catch { return false; } }; // false for symlinks and vanished paths

// ---------- Trash (a small native helper, because Node can't call NSFileManager.trashItem) ----------
function helperPath() {
  const candidates = [process.env.QUILLMETER_TRASH, path.join(__dirname, '..', '..', 'qm-trash'), path.join(__dirname, '..', 'qm-trash'), path.join(os.homedir(), '.quillmeter', 'qm-trash')].filter(Boolean);
  return candidates.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
}
async function trash(paths) {
  const helper = helperPath();
  if (!helper) return { ok: false, error: 'The Trash helper is missing. Reinstall Quillmeter.app, or build it with: swiftc -O app/qm-trash.swift -o ~/.quillmeter/qm-trash' };
  const r = await run(helper, paths, { timeout: 180000 });
  const results = r.out.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  return { ok: true, results };
}

// ---------- sizes ----------
async function sizes(paths) {
  const map = new Map();
  for (let i = 0; i < paths.length; i += 60) {
    const r = await run('nice', ['-n', '19', 'du', '-xk', '-d0', ...paths.slice(i, i + 60)], { timeout: 240000 });
    for (const line of r.out.split('\n')) { const m = line.match(/^(\d+)\t(.+)$/); if (m) map.set(m[2], Number(m[1]) * 1024); }
  }
  return map;
}

// =====================================================================================================
// Cleaner
// =====================================================================================================
function cleanerRoots(enabled) {
  const on = new Set(enabled), roots = [];
  if (on.has('library')) {
    roots.push({ dir: path.join(LIB, 'Caches'), kind: 'cache', children: true, skipPrefix: 'com.apple.' });
    roots.push({ dir: path.join(LIB, 'Logs'), kind: 'log', children: true, skipPrefix: 'com.apple.' });
    roots.push({ dir: path.join(LIB, 'Developer', 'Xcode', 'DerivedData'), kind: 'dev', children: true });
  }
  if (on.has('dotfolders')) {
    roots.push({ dir: path.join(HOME, '.cache'), kind: 'cache', children: true });
    for (const rel of ['.npm/_cacache', '.npm/_npx', '.bun/install/cache']) roots.push({ dir: path.join(HOME, rel), kind: 'cache', children: false });
  }
  return roots.filter((r) => isDir(r.dir));
}
const KIND_NOTE = { cache: 'Rebuilds itself when the app needs it.', log: 'Old log files.', dev: 'Xcode rebuilds this when you build.' };
const cleaner = { items: new Map(), scannedAt: 0, scanning: false, error: null };

async function cleanerScan(enabled) {
  if (cleaner.scanning) return;
  cleaner.scanning = true; cleaner.error = null;
  try {
    const found = [];
    for (const root of cleanerRoots(enabled)) {
      const entries = root.children ? names(root.dir).map((n) => ({ n, p: path.join(root.dir, n) })) : [{ n: path.basename(root.dir), p: root.dir }];
      for (const { n, p } of entries) {
        if (root.skipPrefix && n.startsWith(root.skipPrefix)) continue;
        if (root.children && (scanplan.LIBRARY_MASKS.includes(n) || n.endsWith('.photoslibrary') || n === '.Trash')) continue;
        const st = lstat(p);
        if (!st || st.isSymbolicLink()) continue;
        found.push({ name: n, path: p, kind: root.kind, modified: st.mtimeMs });
      }
    }
    const sz = await sizes(found.map((f) => f.path));
    const items = new Map();
    for (const f of found) {
      const bytes = sz.get(f.path) || 0;
      if (bytes < 1e6) continue; // under 1 MB isn't worth listing
      items.set(idOf(f.path), { id: idOf(f.path), name: f.name, path: f.path, shown: display(f.path), bytes, kind: f.kind, modified: f.modified, note: KIND_NOTE[f.kind] });
    }
    cleaner.items = items; cleaner.scannedAt = Date.now();
  } catch (e) { cleaner.error = e.message; } finally { cleaner.scanning = false; }
}
function cleanerState(enabled) {
  const roots = cleanerRoots(enabled);
  return {
    allowed: roots.length > 0, scanning: cleaner.scanning, scannedAt: cleaner.scannedAt, error: cleaner.error,
    items: [...cleaner.items.values()].sort((a, b) => b.bytes - a.bytes).map(({ path: _p, ...rest }) => rest),
    total: [...cleaner.items.values()].reduce((s, i) => s + i.bytes, 0),
  };
}
const cleanerPathOk = (p, enabled) => realEquals(p) && cleanerRoots(enabled).some((r) => (r.children ? path.dirname(p) === r.dir : p === r.dir));
async function cleanerTrash(ids, enabled) {
  const picked = [], refused = [];
  for (const id of Array.isArray(ids) ? ids.slice(0, 500) : []) {
    const it = cleaner.items.get(String(id));
    if (!it) { refused.push({ id, error: 'Not part of the last scan. Scan again.' }); continue; }
    if (!cleanerPathOk(it.path, enabled)) { refused.push({ id, name: it.name, error: 'No longer in a folder you allowed, or it changed.' }); continue; }
    picked.push(it);
  }
  if (!picked.length) return { ok: false, error: refused[0] ? refused[0].error : 'Nothing selected.', refused };
  const t = await trash(picked.map((i) => i.path));
  if (!t.ok) return t;
  const done = new Set(t.results.filter((r) => r.ok).map((r) => r.path));
  let freed = 0;
  for (const it of picked) if (done.has(it.path)) { freed += it.bytes; cleaner.items.delete(it.id); }
  return { ok: true, moved: done.size, freed, failed: t.results.filter((r) => !r.ok).map((r) => ({ path: display(r.path), error: r.error })), refused };
}

// =====================================================================================================
// Uninstaller
// =====================================================================================================
const appsCache = { t: 0, apps: new Map() };
const leftoverCache = new Map(); // appId -> Map(leftoverId -> item)

async function readPlist(file) {
  const r = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file]);
  try { return r.ok ? JSON.parse(r.out) : null; } catch { return null; }
}
async function listApps() {
  if (Date.now() - appsCache.t > 5 * 60e3) {
    const found = [];
    for (const dir of APP_DIRS) for (const n of names(dir)) {
      const p = path.join(dir, n);
      const st = lstat(p);
      if (n.endsWith('.app') && st && !st.isSymbolicLink() && st.isDirectory()) found.push(p);
    }
    const infos = await Promise.all(found.map((p) => readPlist(path.join(p, 'Contents', 'Info.plist'))));
    const sz = await sizes(found);
    const apps = new Map();
    found.forEach((p, i) => {
      const info = infos[i] || {};
      const bundleId = info.CFBundleIdentifier || '';
      const prot = bundleId.startsWith('com.apple.') || bundleId === 'com.quillmeter.app' || p.startsWith('/System/');
      apps.set(idOf(p), {
        id: idOf(p), name: path.basename(p, '.app'), path: p, bundleId, version: info.CFBundleShortVersionString || info.CFBundleVersion || '', build: info.CFBundleVersion || '',
        feed: typeof info.SUFeedURL === 'string' ? info.SUFeedURL : '', bytes: sz.get(p) || 0,
        protected: prot, reason: prot ? (bundleId === 'com.quillmeter.app' ? 'This is Quillmeter' : 'Part of macOS') : '',
      });
    });
    appsCache.apps = apps; appsCache.t = Date.now();
  }
  const ps = await run('ps', ['-axo', 'comm=']);
  const commands = ps.out.split('\n');
  return [...appsCache.apps.values()].map((a) => ({ ...a, running: commands.some((c) => c.startsWith(a.path + '/')) })).sort((a, b) => b.bytes - a.bytes);
}

// Places an app commonly leaves data. Only these exact locations are checked, never a walk of the Library.
function leftoverCandidates(app) {
  const B = app.bundleId, N = app.name, out = [];
  const add = (p, exact, label) => { if (p) out.push({ path: p, exact, label }); };
  if (B) {
    add(path.join(LIB, 'Application Support', B), true, 'Application Support');
    add(path.join(LIB, 'Caches', B), true, 'Caches');
    add(path.join(LIB, 'Preferences', B + '.plist'), true, 'Preferences');
    add(path.join(LIB, 'Saved Application State', B + '.savedState'), true, 'Saved state');
    add(path.join(LIB, 'HTTPStorages', B), true, 'Network storage');
    add(path.join(LIB, 'HTTPStorages', B + '.binarycookies'), true, 'Network storage');
    add(path.join(LIB, 'WebKit', B), true, 'Web data');
    add(path.join(LIB, 'Cookies', B + '.binarycookies'), true, 'Cookies');
    add(path.join(LIB, 'Logs', B), true, 'Logs');
    for (const n of names(path.join(LIB, 'Preferences'))) if (n.startsWith(B + '.') && n !== B + '.plist') add(path.join(LIB, 'Preferences', n), true, 'Preferences');
    for (const n of names(path.join(LIB, 'LaunchAgents'))) if (n.startsWith(B)) add(path.join(LIB, 'LaunchAgents', n), true, 'Login item');
    for (const n of names(path.join(LIB, 'Preferences', 'ByHost'))) if (n.startsWith(B + '.')) add(path.join(LIB, 'Preferences', 'ByHost', n), true, 'Preferences');
  }
  // Matching by the app's name is less certain (another app could share it), so these start unticked.
  add(path.join(LIB, 'Application Support', N), false, 'Application Support');
  add(path.join(LIB, 'Caches', N), false, 'Caches');
  add(path.join(LIB, 'Logs', N), false, 'Logs');
  return out;
}
const LEFTOVER_PARENTS = () => new Set(['Application Support', 'Caches', 'Preferences', 'Saved Application State', 'HTTPStorages', 'WebKit', 'Cookies', 'Logs', 'LaunchAgents'].map((d) => path.join(LIB, d)).concat([path.join(LIB, 'Preferences', 'ByHost')]));

async function leftovers(appId) {
  const apps = await listApps();
  const app = apps.find((a) => a.id === appId);
  if (!app) return { code: 404, body: { ok: false, error: 'App not found. Reload the list.' } };
  const seen = new Set(), cands = [];
  for (const c of leftoverCandidates(app)) {
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    const st = lstat(c.path);
    if (st && !st.isSymbolicLink()) cands.push(c);
  }
  const sz = await sizes(cands.map((c) => c.path));
  const map = new Map();
  for (const c of cands) map.set(idOf(c.path), { id: idOf(c.path), path: c.path, shown: display(c.path), label: c.label, exact: c.exact, bytes: sz.get(c.path) || 0 });
  leftoverCache.set(appId, map);
  return { code: 200, body: { ok: true, app, leftovers: [...map.values()].map(({ path: _p, ...r }) => r) } };
}
async function uninstall(appId, ids) {
  const apps = await listApps();
  const app = apps.find((a) => a.id === appId);
  if (!app) return { code: 404, body: { ok: false, error: 'App not found. Reload the list.' } };
  if (app.protected) return { code: 400, body: { ok: false, error: `${app.name} can't be removed here: ${app.reason}.` } };
  if (app.running) return { code: 409, body: { ok: false, error: `${app.name} is running. Quit it first, then try again.` } };
  if (!APP_DIRS.includes(path.dirname(app.path)) || !realEquals(app.path)) return { code: 400, body: { ok: false, error: 'That app is no longer where it was. Reload the list.' } };
  const known = leftoverCache.get(appId) || new Map();
  const parents = LEFTOVER_PARENTS();
  const picked = [], refused = [];
  for (const id of Array.isArray(ids) ? ids.slice(0, 100) : []) {
    const it = known.get(String(id));
    if (!it) { refused.push({ id, error: 'Not part of the last check.' }); continue; }
    if (!parents.has(path.dirname(it.path)) || !realEquals(it.path)) { refused.push({ id, name: it.shown, error: 'Not in an allowed place, or it changed.' }); continue; }
    picked.push(it);
  }
  // The app goes first: if it can't be moved (for example it belongs to another user), its data stays untouched.
  const t = await trash([app.path]);
  if (!t.ok) return { code: 500, body: t };
  const appResult = t.results[0] || { ok: false, error: 'No answer from the helper.' };
  if (!appResult.ok) return { code: 500, body: { ok: false, error: `Couldn't move ${app.name} to the Trash: ${appResult.error}`, appMoved: false } };
  appsCache.t = 0;
  let moved = 0, freed = app.bytes, failed = [];
  if (picked.length) {
    const lt = await trash(picked.map((i) => i.path));
    if (lt.ok) {
      const done = new Set(lt.results.filter((r) => r.ok).map((r) => r.path));
      for (const it of picked) if (done.has(it.path)) { moved++; freed += it.bytes; }
      failed = lt.results.filter((r) => !r.ok).map((r) => ({ path: display(r.path), error: r.error }));
    }
  }
  leftoverCache.delete(appId);
  return { code: 200, body: { ok: true, app: app.name, appMoved: true, leftoversMoved: moved, freed, failed, refused } };
}

// =====================================================================================================
// Homebrew
// =====================================================================================================
const BREW_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin'];
function brewBin() {
  const c = [process.env.QUILLMETER_BREW, ...BREW_DIRS.map((d) => path.join(d, 'brew'))].filter(Boolean);
  return c.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
}
// No auto-update and no analytics: reading and searching never touch the network. `update` is its own explicit button.
const brewEnv = () => ({ ...process.env, PATH: [...BREW_DIRS, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'), HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ANALYTICS: '1', HOMEBREW_NO_ENV_HINTS: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1' });
const PKG_RE = /^[A-Za-z0-9][A-Za-z0-9@+._-]*(\/[A-Za-z0-9][A-Za-z0-9@+._-]*){0,2}$/;
const parseVersions = (out) => out.split('\n').filter(Boolean).map((l) => { const [name, ...v] = l.trim().split(/\s+/); return { name, version: v.join(' ') }; });

async function brewOverview() {
  const bin = brewBin();
  if (!bin) return { installed: false };
  const env = brewEnv();
  const [ver, formulae, casks] = await Promise.all([
    run(bin, ['--version'], { env }), run(bin, ['list', '--formula', '--versions'], { env, timeout: 30000 }), run(bin, ['list', '--cask', '--versions'], { env, timeout: 30000 }),
  ]);
  return { installed: true, version: (ver.out.split('\n')[0] || '').replace(/^Homebrew\s*/, ''), formulae: parseVersions(formulae.out), casks: parseVersions(casks.out) };
}
async function brewOutdated() {
  const bin = brewBin();
  if (!bin) return { installed: false, formulae: [], casks: [] };
  const r = await run(bin, ['outdated', '--json=v2'], { env: brewEnv(), timeout: 60000 });
  try {
    const j = JSON.parse(r.out || '{}');
    const row = (x) => ({ name: x.name, installed: (x.installed_versions || []).join(', '), latest: x.current_version || '' });
    return { installed: true, formulae: (j.formulae || []).map(row), casks: (j.casks || []).map(row) };
  } catch { return { installed: true, formulae: [], casks: [], error: 'Homebrew did not return a readable answer.' }; }
}
async function brewSearch(q) {
  const bin = brewBin();
  if (!bin) return { code: 400, body: { ok: false, error: 'Homebrew is not installed.' } };
  if (!/^[\w@+./ -]{1,60}$/.test(q || '')) return { code: 400, body: { ok: false, error: 'Use letters, numbers and . _ - + @ / in the search.' } };
  const r = await run(bin, ['search', q.trim()], { env: brewEnv(), timeout: 60000 });
  const out = { formulae: [], casks: [] };
  let section = 'formulae';
  for (const line of r.out.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('No ')) continue;
    if (t.startsWith('==>')) { section = /cask/i.test(t) ? 'casks' : 'formulae'; continue; }
    if (PKG_RE.test(t) && out[section].length < 40) out[section].push(t);
  }
  return { code: 200, body: { ok: true, ...out } };
}

let job = null; // one Homebrew task at a time, so two installs never fight over Homebrew's lock
function startJob(title, args) {
  const bin = brewBin();
  if (!bin) return { code: 400, body: { ok: false, error: 'Homebrew is not installed.' } };
  if (job && job.status === 'running') return { code: 409, body: { ok: false, error: 'Another Homebrew task is still running.' } };
  const j = { id: idOf(String(Date.now()) + title), title, lines: [], status: 'running', startedAt: Date.now(), child: null };
  const push = (chunk) => { for (const l of String(chunk).split(/\r?\n/)) if (l.trim()) { j.lines.push(l.slice(0, 400)); if (j.lines.length > 2000) j.lines.shift(); } };
  const child = spawn(bin, args, { env: brewEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  j.child = child;
  child.stdout.on('data', push); child.stderr.on('data', push);
  child.on('error', (e) => { push(e.message); j.status = 'failed'; });
  child.on('close', (code, sig) => { j.status = j.status === 'cancelled' ? 'cancelled' : code === 0 ? 'done' : 'failed'; j.code = code; j.signal = sig; j.endedAt = Date.now(); });
  job = j;
  return { code: 200, body: { ok: true, id: j.id } };
}
function brewRun({ action, name, type }) {
  if (action === 'update') return startJob('Updating Homebrew’s package list', ['update']);
  if (action === 'upgrade-all') return startJob('Upgrading everything', ['upgrade']);
  if (!['install', 'uninstall', 'upgrade'].includes(action)) return { code: 400, body: { ok: false, error: 'Unknown action.' } };
  if (typeof name !== 'string' || name.length > 100 || !PKG_RE.test(name)) return { code: 400, body: { ok: false, error: 'That package name isn’t valid.' } };
  const kind = type === 'cask' ? 'cask' : 'formula';
  const verb = { install: 'Installing', uninstall: 'Removing', upgrade: 'Upgrading' }[action];
  return startJob(`${verb} ${name}`, [action, `--${kind}`, name]);
}
const jobState = () => (job ? { id: job.id, title: job.title, status: job.status, lines: job.lines.slice(-200), startedAt: job.startedAt, endedAt: job.endedAt || null } : null);
function jobCancel() {
  if (!job || job.status !== 'running') return { code: 409, body: { ok: false, error: 'Nothing is running.' } };
  job.status = 'cancelled';
  job.child.kill('SIGTERM');
  return { code: 200, body: { ok: true } };
}

// =====================================================================================================
// App updates
// =====================================================================================================
function compareVersions(a, b) {
  const pa = String(a).split(/[.\-+_]/).map((x) => parseInt(x, 10) || 0), pb = String(b).split(/[.\-+_]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}
function privateHost(h) {
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.includes(':')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}
function fetchText(url, hops = 0) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve(null); }
    if (u.protocol !== 'https:' || privateHost(u.hostname) || hops > 3) return resolve(null);
    const req = https.get(u, { timeout: 8000, headers: { 'User-Agent': 'Quillmeter', Accept: 'application/xml,text/xml,*/*' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) { res.resume(); return resolve(fetchText(new URL(res.headers.location, u).href, hops + 1)); }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; if (body.length > 1.5e6) { req.destroy(); resolve(null); } });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}
/** The newest version in a Sparkle appcast. Appcasts usually list newest first, but we compare them all. */
function newestInAppcast(xml) {
  let best = null;
  for (const item of xml.match(/<item[\s>][\s\S]*?<\/item>/g) || []) {
    const short = (item.match(/sparkle:shortVersionString="([^"]+)"/) || item.match(/<sparkle:shortVersionString>([^<]+)</) || [])[1];
    const build = (item.match(/sparkle:version="([^"]+)"/) || item.match(/<sparkle:version>([^<]+)</) || [])[1];
    const v = short || build;
    if (v && (!best || compareVersions(v, best.version) > 0)) best = { version: v, build: build || '', short: short || '' };
  }
  return best;
}
async function checkUpdates({ feeds }) {
  const out = { updates: [], brew: { installed: false }, feeds: { checked: 0, withFeed: 0, withoutFeed: 0, failed: 0, ran: false } };
  const outdated = await brewOutdated();
  out.brew = { installed: outdated.installed };
  for (const kind of ['casks', 'formulae']) for (const x of outdated[kind] || []) out.updates.push({ source: 'Homebrew', kind: kind === 'casks' ? 'cask' : 'formula', name: x.name, installed: x.installed, latest: x.latest });
  const apps = (await listApps()).filter((a) => !a.protected);
  out.feeds.withFeed = apps.filter((a) => /^https:/i.test(a.feed)).length;
  out.feeds.withoutFeed = apps.length - out.feeds.withFeed;
  if (feeds) {
    out.feeds.ran = true;
    const queue = apps.filter((a) => /^https:/i.test(a.feed));
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const a = queue[next++];
        const xml = await fetchText(a.feed);
        const best = xml ? newestInAppcast(xml) : null;
        if (!best) { out.feeds.failed++; continue; }
        out.feeds.checked++;
        const installed = a.version || a.build;
        const newer = best.short && a.version ? compareVersions(best.short, a.version) > 0 : best.build && a.build ? compareVersions(best.build, a.build) > 0 : false;
        if (newer) out.updates.push({ source: 'Developer feed', kind: 'app', name: a.name, installed, latest: best.short || best.build, path: a.path });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }
  return out;
}

// =====================================================================================================
// Routes (all under /api/manage/)
// =====================================================================================================
async function handle(method, url, body, ctx) {
  const p = url.pathname.replace('/api/manage/', '');
  const settings = ctx.settings();
  const enabled = settings.setupDone ? settings.scanFolders : [];
  if (p === 'cleaner' && method === 'GET') return { code: 200, body: cleanerState(enabled) };
  if (p === 'cleaner/scan' && method === 'POST') { if (!cleanerRoots(enabled).length) return { code: 400, body: { ok: false, error: 'Turn on App data and caches or Developer tool folders in Settings, Folders first.' } }; cleanerScan(enabled); return { code: 202, body: { ok: true } }; }
  if (p === 'cleaner/trash' && method === 'POST') return { code: 200, body: await cleanerTrash(body.ids, enabled) };
  if (p === 'apps' && method === 'GET') return { code: 200, body: { ok: true, apps: await listApps() } };
  if (p === 'apps/leftovers' && method === 'GET') return leftovers(url.searchParams.get('id') || '');
  if (p === 'apps/uninstall' && method === 'POST') return uninstall(String(body.id || ''), body.leftovers);
  if (p === 'brew' && method === 'GET') return { code: 200, body: await brewOverview() };
  if (p === 'brew/outdated' && method === 'GET') return { code: 200, body: await brewOutdated() };
  if (p === 'brew/search' && method === 'GET') return brewSearch(url.searchParams.get('q'));
  if (p === 'brew/run' && method === 'POST') return brewRun(body);
  if (p === 'brew/job' && method === 'GET') return { code: 200, body: { job: jobState() } };
  if (p === 'brew/cancel' && method === 'POST') return jobCancel();
  if (p === 'updates/check' && method === 'POST') return { code: 200, body: { ok: true, ...(await checkUpdates({ feeds: body.feeds === true })) } };
  return null;
}

module.exports = { handle, _test: { compareVersions, newestInAppcast, privateHost, cleanerRoots, cleanerScan, cleanerTrash, cleaner, listApps, leftovers, uninstall, brewRun, jobState, brewSearch, brewOverview, brewOutdated, checkUpdates, helperPath, PKG_RE } };
