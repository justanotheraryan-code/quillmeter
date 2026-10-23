#!/usr/bin/env node
// vitals: print what the running Vitals server sees, as a table or as JSON.
//   vitals status | apps [--sort cpu|mem] [--top N] | ports | agents    add --json for machine output
const http = require('node:http');

const BASE = new URL(process.env.VITALS_URL || 'http://127.0.0.1:4747');
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const cmd = args.find((a) => !a.startsWith('--') && !['cpu', 'mem'].includes(a) && !/^\d+$/.test(a)) || 'status';

const HELP = `vitals: what is running on this Mac

  vitals status                        CPU, memory, disk, network and battery
  vitals apps [--sort cpu|mem] [--top N]  apps with their helpers added up (default: memory, top 15)
  vitals ports                         dev servers and the ports they hold
  vitals agents                        running coding agents and what they started

  --json    print JSON instead of a table
  Server:   ${BASE.origin} (set VITALS_URL to change)`;

const bytes = (n) => {
  const u = ['B', 'kB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return (n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(i >= 3 ? 2 : 1)) + ' ' + u[i];
};
const get = (p) => new Promise((resolve, reject) => {
  http.get(new URL(p, BASE), (res) => {
    let b = '';
    res.on('data', (d) => (b += d));
    res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(b)) : reject(new Error(`server answered ${res.statusCode}`))));
  }).on('error', reject);
});
function table(headers, rows, right = []) {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => (right.includes(i) ? String(c).padStart(w[i]) : String(c).padEnd(w[i]))).join('  ');
  console.log(line(headers)); console.log(w.map((n) => '-'.repeat(n)).join('  ')); rows.forEach((r) => console.log(line(r)));
}

(async () => {
  if (flag('help') || flag('h') || cmd === 'help') return console.log(HELP);
  let data;
  try {
    data = await get(cmd === 'ports' ? '/api/projects' : cmd === 'agents' ? '/api/agents' : '/api/snapshot');
  } catch (e) {
    console.error(`Vitals isn't reachable at ${BASE.origin} (${e.message}).\nStart it with: node server.js   or install the login service: service/service.sh install`);
    process.exit(1);
  }
  if (flag('json')) {
    if (cmd === 'apps') { const { cpu, memory, apps } = data; return console.log(JSON.stringify({ cpuTotal: cpu.total, apps }, null, 2)); }
    return console.log(JSON.stringify(data, null, 2));
  }
  if (cmd === 'status') {
    const { cpu, memory: m, disk: d, network: n, battery: b } = data;
    table(['', 'now', 'detail'], [
      ['CPU', `${cpu.total.toFixed(0)}%`, `user ${cpu.user.toFixed(0)}%, system ${cpu.system.toFixed(0)}%, ${cpu.cores} cores`],
      ['Memory', `${bytes(m.used)} of ${bytes(m.total)}`, `pressure ${m.pressure}, app ${bytes(m.app)}, wired ${bytes(m.wired)}, compressed ${bytes(m.compressed)}`],
      ['Disk', `${bytes(d.free)} free`, `of ${bytes(d.total)}, read ${bytes(d.read)}/s, write ${bytes(d.write)}/s`],
      ['Network', `${bytes(n.down)}/s down`, `${bytes(n.up)}/s up`],
      ...(b.present ? [['Battery', `${b.percent}%`, `${b.state}${b.remaining ? ', ' + b.remaining + ' left' : ''}`]] : []),
    ]);
  } else if (cmd === 'apps') {
    const key = opt('sort', 'mem') === 'cpu' ? 'cpu' : 'mem';
    const top = Number(opt('top', 15)) || 15;
    const rows = [...data.apps].sort((a, b) => b[key] - a[key]).slice(0, top).map((a) => [a.name, a.count, `${a.cpu.toFixed(1)}%`, bytes(a.mem)]);
    table(['app', 'procs', 'cpu', 'memory'], rows, [1, 2, 3]);
    console.log(`\n${data.processCount} processes in ${data.appCount} apps (+${data.groupCount - data.appCount} background services)`);
  } else if (cmd === 'ports') {
    const dev = data.filter((p) => p.dev);
    if (!dev.length) return console.log('No dev servers found under your home folder.');
    table(['project', 'ports', 'process', 'status', 'cpu', 'memory'], dev.map((p) => [p.project, p.ports.join(','), p.command, p.note, `${p.cpu.toFixed(1)}%`, bytes(p.mem)]), [4, 5]);
  } else if (cmd === 'agents') {
    if (!data.length) return console.log('No coding agents running.');
    table(['agent', 'project', 'procs', 'cpu', 'memory', 'uptime'], data.map((a) => [a.agent, a.project, a.procCount, `${a.cpu.toFixed(1)}%`, bytes(a.mem), a.uptime]), [2, 3, 4]);
  } else {
    console.error(`Unknown command "${cmd}".\n\n${HELP}`); process.exit(2);
  }
})();
