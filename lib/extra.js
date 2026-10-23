'use strict';
// Extra samplers for Quillmeter: GPU, battery detail, Docker containers and Claude Code token usage.
// None of these need root. Everything is read-only.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const run = (cmd, args, { timeout = 4000, env } = {}) =>
  new Promise((resolve) => execFile(cmd, args, { timeout, env, maxBuffer: 16 * 1024 * 1024 }, (err, out) => resolve({ ok: !err, out: out || '' })));
const num = (text, key) => {
  const m = text.match(new RegExp(`"${key}"\\s*=\\s*(-?\\d+)`));
  return m ? Number(m[1]) : null;
};
const parseJsonLines = (t) => t.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

// ---------- GPU (IOAccelerator performance statistics) ----------
async function sampleGpu() {
  const { out } = await run('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator', '-w0']);
  const util = num(out, 'Device Utilization %');
  if (util === null) return { present: false };
  return {
    present: true,
    model: (out.match(/"model" = "([^"]+)"/) || [])[1] || 'GPU',
    cores: num(out, 'gpu-core-count'),
    util,
    renderer: num(out, 'Renderer Utilization %'),
    tiler: num(out, 'Tiler Utilization %'),
    memUsed: num(out, 'In use system memory'),
    memAlloc: num(out, 'Alloc system memory'),
  };
}

// ---------- Battery detail ----------
// Health is read from system_profiler because that is the figure macOS shows (the raw capacity fields disagree
// with it). It is slow, so it is refreshed in the background every 10 minutes.
let health = { t: 0, data: null };
async function refreshHealth() {
  if (Date.now() - health.t < 600e3) return;
  health.t = Date.now();
  const { out } = await run('system_profiler', ['SPPowerDataType'], { timeout: 20000 });
  health.data = {
    maxCapacity: Number((out.match(/Maximum Capacity:\s*(\d+)%/) || [])[1]) || null,
    condition: ((out.match(/Condition:\s*(.+)/) || [])[1] || '').trim() || null,
  };
}
let therm = { t: 0, state: 'nominal' };
async function thermalState() {
  if (Date.now() - therm.t < 10e3) return therm.state;
  therm.t = Date.now();
  const { out } = await run('pmset', ['-g', 'therm']);
  therm.state = out && /No thermal warning level/.test(out) && /No performance warning level/.test(out) ? 'nominal' : out ? 'elevated' : therm.state;
  return therm.state;
}
async function sampleBatteryDetail() {
  refreshHealth();
  const { out } = await run('ioreg', ['-r', '-n', 'AppleSmartBattery', '-w0']);
  if (!out) return {};
  const voltage = num(out, 'Voltage');
  // InstantAmperage is a signed 64-bit value printed as unsigned: negative means discharging.
  const rawAmp = out.match(/"InstantAmperage" = (\d+)/);
  const amperage = rawAmp ? Number(BigInt.asIntN(64, BigInt(rawAmp[1]))) : null;
  return {
    cycles: num(out, 'CycleCount'),
    designCycles: num(out, 'DesignCycleCount9C'),
    voltage,
    amperage,
    watts: voltage != null && amperage != null ? Math.abs(voltage * amperage) / 1e6 : null,
    charging: /"IsCharging" = Yes/.test(out),
    plugged: /"ExternalConnected" = Yes/.test(out),
    maxCapacity: health.data ? health.data.maxCapacity : null,
    condition: health.data ? health.data.condition : null,
    thermal: await thermalState(),
  };
}

// ---------- Docker (CLI only: never talks to the daemon socket directly) ----------
const DOCKER_DIRS = [
  '/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.orbstack/bin'),
  '/Applications/Docker.app/Contents/Resources/bin', path.join(os.homedir(), '.docker/bin'),
  ...(process.env.PATH || '').split(':').filter(Boolean),
];
function findDocker() {
  for (const d of DOCKER_DIRS) {
    const p = path.join(d, 'docker');
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
  }
  return null;
}
const UNITS = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
const parseSize = (s) => {
  const m = String(s).trim().match(/^([\d.]+)\s*([a-z]*)$/i);
  return m ? Number(m[1]) * (UNITS[(m[2] || 'b').toLowerCase()] || 1) : 0;
};
const pair = (s) => String(s || '').split('/').map(parseSize);
let dockerCache = { t: 0, data: { state: 'missing', containers: [] } };
let dockerInflight = null;
function sampleDocker() {
  if (Date.now() - dockerCache.t < 8000) return Promise.resolve(dockerCache.data);
  if (dockerInflight) return dockerInflight; // docker stats takes ~2s; share one run between callers
  dockerInflight = (async () => {
    const bin = findDocker();
    let data;
    if (!bin) data = { state: 'missing', containers: [] };
    else {
      const env = { ...process.env, PATH: DOCKER_DIRS.join(':') };
      const ps = await run(bin, ['ps', '--format', '{{json .}}'], { timeout: 6000, env });
      if (!ps.ok) data = { state: 'stopped', containers: [] };
      else {
        const rows = parseJsonLines(ps.out);
        const stats = new Map();
        if (rows.length) {
          const st = await run(bin, ['stats', '--no-stream', '--format', '{{json .}}'], { timeout: 15000, env });
          for (const s of parseJsonLines(st.out)) stats.set(s.ID || s.Container, s);
        }
        data = {
          state: 'running',
          containers: rows.map((r) => {
            const s = stats.get(r.ID) || [...stats.values()].find((x) => x.Name === r.Names) || {};
            const [mem, memLimit] = pair(s.MemUsage), [netIn, netOut] = pair(s.NetIO);
            return { id: r.ID, name: r.Names, image: r.Image, status: r.Status, ports: r.Ports || '', cpu: parseFloat(s.CPUPerc) || 0, mem: mem || 0, memLimit: memLimit || 0, netIn: netIn || 0, netOut: netOut || 0, pids: Number(s.PIDs) || 0 };
          }).sort((a, b) => b.mem - a.mem),
        };
      }
    }
    dockerCache = { t: Date.now(), data };
    return data;
  })().finally(() => { dockerInflight = null; });
  return dockerInflight;
}

// ---------- Claude Code token usage today (counts only; message content is never kept) ----------
const TOKEN_ROOT = path.join(os.homedir(), '.claude', 'projects');
const tok = { day: '', files: new Map(), msgs: new Map(), t: 0 };
const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const MAX_READ = 256 * 1024 * 1024;

function ingest(file, projectDir, mid) {
  let st;
  try { st = fs.statSync(file); } catch { return; }
  if (st.mtimeMs < mid) return;
  const state = tok.files.get(file) || { offset: 0 };
  if (st.size < state.offset) state.offset = 0; // file was replaced
  if (st.size === state.offset) { tok.files.set(file, state); return; }
  const len = Math.min(st.size - state.offset, MAX_READ);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, state.offset); } finally { fs.closeSync(fd); }
  const end = buf.lastIndexOf(10); // only whole lines; a partial last line is picked up next time
  if (end < 0) return;
  state.offset += end + 1;
  tok.files.set(file, state);
  for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
    if (!line.includes('"usage"')) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const u = j.message && j.message.usage;
    if (!u || !(Date.parse(j.timestamp) >= mid)) continue;
    const id = j.message.id || j.requestId || j.uuid;
    if (!id) continue;
    // The same API message is logged once per content block; keep the latest usage for each.
    tok.msgs.set(id, {
      input: u.input_tokens || 0, output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0, cacheCreate: u.cache_creation_input_tokens || 0,
      project: j.cwd ? path.basename(j.cwd) : projectDir,
    });
  }
}

function tokenUsage() {
  const mid = midnight(), day = new Date(mid).toDateString();
  if (tok.day !== day) { tok.day = day; tok.files = new Map(); tok.msgs = new Map(); tok.t = 0; }
  if (Date.now() - tok.t >= 15000) {
    tok.t = Date.now();
    let dirs = [];
    try { dirs = fs.readdirSync(TOKEN_ROOT); } catch { return { available: false }; }
    for (const d of dirs) {
      let files = [];
      try { files = fs.readdirSync(path.join(TOKEN_ROOT, d)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) ingest(path.join(TOKEN_ROOT, d, f), d, mid);
    }
  }
  const t = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  const per = new Map();
  for (const m of tok.msgs.values()) {
    t.input += m.input; t.output += m.output; t.cacheRead += m.cacheRead; t.cacheCreate += m.cacheCreate;
    per.set(m.project, (per.get(m.project) || 0) + m.input + m.output + m.cacheCreate);
  }
  return {
    available: true, day, messages: tok.msgs.size, ...t, total: t.input + t.output + t.cacheCreate,
    byProject: [...per].map(([project, total]) => ({ project, total })).sort((a, b) => b.total - a.total).slice(0, 8),
  };
}

module.exports = { sampleGpu, sampleBatteryDetail, sampleDocker, tokenUsage, _test: { parseSize, pair, findDocker } };
