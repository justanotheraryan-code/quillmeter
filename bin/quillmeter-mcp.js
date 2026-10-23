#!/usr/bin/env node
// Quillmeter MCP server (stdio). Lets an AI assistant ask what is running on this Mac.
// Read-only by design: there is no tool that quits, stops or changes anything.
// It talks to the local Quillmeter server (QUILLMETER_URL, default http://127.0.0.1:4747), so Quillmeter must be running.
'use strict';
const http = require('node:http');
const readline = require('node:readline');

const BASE = new URL(process.env.QUILLMETER_URL || 'http://127.0.0.1:4747');
const get = (p) => new Promise((resolve, reject) => {
  http.get(new URL(p, BASE), { timeout: 8000 }, (res) => {
    let b = '';
    res.on('data', (d) => (b += d));
    res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(b)) : reject(new Error(`Quillmeter answered ${res.statusCode}`))));
  }).on('error', reject).on('timeout', function () { this.destroy(new Error('timed out')); });
});
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const gb = (n) => round(n / 1e9, 2);

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const TOOLS = [
  {
    name: 'quillmeter_status',
    description: 'Current CPU, memory, disk, network, GPU and battery figures for this Mac.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const s = await get('/api/snapshot');
      return {
        cpu_percent: round(s.cpu.total), cpu_cores: s.cpu.cores,
        memory_gb: { used: gb(s.memory.used), total: gb(s.memory.total), app: gb(s.memory.app), wired: gb(s.memory.wired), compressed: gb(s.memory.compressed), pressure: s.memory.pressure },
        disk_gb: { free: gb(s.disk.free), total: gb(s.disk.total) },
        disk_rate_mb_s: { read: round(s.disk.read / 1e6, 2), write: round(s.disk.write / 1e6, 2) },
        network_kb_s: { down: round(s.network.down / 1e3), up: round(s.network.up / 1e3) },
        gpu_percent: s.gpu && s.gpu.present ? s.gpu.util : null,
        battery: s.battery.present ? { percent: s.battery.percent, state: s.battery.state, remaining: s.battery.remaining, health_percent: s.battery.maxCapacity, cycles: s.battery.cycles, thermal: s.battery.thermal } : null,
        processes: s.processCount, apps: s.appCount, uptime_hours: round(s.host.uptime / 3600),
      };
    },
  },
  {
    name: 'quillmeter_apps',
    description: 'Apps ranked by memory or CPU, with each app\'s helper processes added into one row. CPU is percent of one core.',
    inputSchema: {
      type: 'object',
      properties: {
        sort: { type: 'string', enum: ['memory', 'cpu'], description: 'Ranking (default memory).' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many apps (default 15).' },
      },
      additionalProperties: false,
    },
    run: async (a) => {
      const s = await get('/api/snapshot');
      const key = a.sort === 'cpu' ? 'cpu' : 'mem';
      const limit = Math.min(Math.max(Number(a.limit) || 15, 1), 50);
      return [...s.apps].sort((x, y) => y[key] - x[key]).slice(0, limit)
        .map((p) => ({ app: p.name, processes: p.count, cpu_percent: round(p.cpu), memory_mb: Math.round(p.mem / 1e6) }));
    },
  },
  {
    name: 'quillmeter_dev_servers',
    description: 'Dev servers listening on ports under the home folder, grouped by project, with idle status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => (await get('/api/projects')).filter((p) => p.dev).map((p) => ({
      project: p.project, folder: p.repo || p.cwd, ports: p.ports, process: p.command, status: p.note, cpu_percent: round(p.cpu), memory_mb: Math.round(p.mem / 1e6), pid: p.pid,
    })),
  },
  {
    name: 'quillmeter_agents',
    description: 'Running coding agents (Claude Code, Codex, Cursor Agent, Gemini CLI, OpenCode, Aider), what each started, and Claude Code token counts for today.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const [agents, tokens] = await Promise.all([get('/api/agents'), get('/api/tokens')]);
      return {
        agents: agents.map((a) => ({ agent: a.agent, project: a.project, folder: a.cwd, processes: a.procCount, cpu_percent: round(a.cpu), memory_mb: Math.round(a.mem / 1e6), uptime: a.uptime, started: a.started })),
        claude_code_tokens_today: tokens.available ? { total: tokens.total, output: tokens.output, input_and_cache_writes: tokens.input + tokens.cacheCreate, cache_reads: tokens.cacheRead, by_project: tokens.byProject } : null,
      };
    },
  },
  {
    name: 'quillmeter_alerts',
    description: 'Alerts Quillmeter has raised: apps holding the CPU, apps growing in memory, low memory or battery. Active ones first, then recent history.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const a = await get('/api/alerts');
      const row = (x) => ({ title: x.title, detail: x.detail, level: x.level, at: new Date(x.t).toISOString() });
      return { active: a.active.map(row), recent: a.log.slice(0, 10).map(row) };
    },
  },
];

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const fail = (id, code, message) => send({ id, error: { code, message } });

async function handle(msg) {
  const { id, method, params = {} } = msg;
  if (method === 'initialize') {
    return send({ id, result: { protocolVersion: params.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'quillmeter', version: '3.0.0' } } });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return; // notifications get no reply
  if (method === 'ping') return send({ id, result: {} });
  if (method === 'tools/list') {
    return send({ id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: READ_ONLY })) } });
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params.name);
    if (!tool) return fail(id, -32602, `Unknown tool: ${params.name}`);
    try {
      const data = await tool.run(params.arguments || {});
      return send({ id, result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] } });
    } catch (e) {
      // Tool failures are reported to the model as results, not protocol errors.
      return send({ id, result: { isError: true, content: [{ type: 'text', text: `Quillmeter isn't reachable at ${BASE.origin} (${e.message}). Start it with service/service.sh install.` }] } });
    }
  }
  if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'Parse error'); }
  handle(msg).catch((e) => msg.id !== undefined && fail(msg.id, -32603, e.message));
});
