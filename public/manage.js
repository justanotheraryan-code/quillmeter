'use strict';
// Manage: Cleaner, Uninstaller, Homebrew and Updates. Loaded after app.js, which owns the shell, the `views` table and
// helpers such as esc, bytes, post and getJSON. Nothing here runs until a view is opened and a button is pressed:
// the views only read state (or, for Homebrew, ask for a read-only list). Removing anything always goes through a
// confirm prompt, and everything removed goes to the Trash.
const MG = {
  cleaner: { data: null, loading: false, picked: new Set(), poll: 0 },
  apps: { list: null, loading: false, sel: null, lo: null, picked: new Set(), q: '', busy: false },
  brew: { over: null, outdated: null, loading: false, view: 'installed', q: '', results: null, searching: false, job: null, poll: 0 },
  upd: { data: null, busy: false },
};
const mRender = () => render(true);
const agoShort = (ms) => { const d = Math.floor((Date.now() - ms) / 86400e3); return d < 1 ? 'today' : d === 1 ? 'yesterday' : d < 60 ? `${d} days ago` : `${Math.round(d / 30)} months ago`; };
const mget = async (url) => { try { return await (await fetch(url)).json(); } catch { return { ok: false, error: 'Quillmeter isn’t answering.' }; } };
const mpost = async (url, body) => { try { return await (await post(url, body)).json(); } catch { return { ok: false, error: 'Quillmeter isn’t answering.' }; } };
const empty = (title, text, extra = '') => `<div class="card empty"><h3>${title}</h3><p>${text}</p>${extra}</div>`;
const bar = (frac, color = 'var(--disk, var(--brown))') => `<div class="bar mini" aria-hidden="true"><i style="width:${Math.min(100, Math.max(2, frac * 100)).toFixed(0)}%;background:${color}"></i></div>`;

// ---------- Toolbar ----------
function manageActions(t) {
  if (t === 'Cleaner') {
    const c = MG.cleaner, n = c.picked.size;
    const scanning = c.data && c.data.scanning;
    return `<button class="btn" data-m="cl-scan" ${scanning || !c.data || !c.data.allowed ? 'disabled' : ''}>${c.data && c.data.scannedAt ? 'Scan Again' : 'Scan'}</button>${n ? `<button class="btn primary" data-m="cl-trash">Move ${n} to Trash…</button>` : ''}`;
  }
  if (t === 'Uninstaller') return MG.apps.sel ? '' : '<input class="search" id="mq" type="search" placeholder="Filter apps" aria-label="Filter apps">';
  if (t === 'Homebrew') return `<input class="search" id="mq" type="search" placeholder="Search Homebrew" aria-label="Search Homebrew"><button class="btn" data-m="br-update" ${brewBusy() ? 'disabled' : ''}>Update List…</button>`;
  if (t === 'Updates') return `<button class="btn primary" data-m="up-check" ${MG.upd.busy ? 'disabled' : ''}>${MG.upd.busy ? 'Checking…' : 'Check for Updates'}</button>`;
  return null;
}
// Put the search text back after the toolbar is rebuilt (inputs can't be kept across innerHTML changes).
function manageToolbarSync() {
  const q = document.getElementById('mq');
  if (!q) return;
  q.value = tab === 'Uninstaller' ? MG.apps.q : MG.brew.q;
}
const brewBusy = () => !!(MG.brew.job && MG.brew.job.status === 'running');

// ---------- Cleaner ----------
async function loadCleaner(keepPicked) {
  const d = await mget('/api/manage/cleaner');
  MG.cleaner.data = d;
  if (!keepPicked) MG.cleaner.picked = new Set();
  else MG.cleaner.picked = new Set([...MG.cleaner.picked].filter((id) => d.items.some((i) => i.id === id)));
  if (d.scanning && !MG.cleaner.poll) MG.cleaner.poll = setInterval(async () => { const x = await mget('/api/manage/cleaner'); MG.cleaner.data = x; if (!x.scanning) { clearInterval(MG.cleaner.poll); MG.cleaner.poll = 0; MG.cleaner.picked = new Set(); } if (tab === 'Cleaner') mRender(); }, 1500);
  if (tab === 'Cleaner') mRender();
}
views.Cleaner = function Cleaner() {
  const c = MG.cleaner;
  if (!c.data) { if (!c.loading) { c.loading = true; loadCleaner().finally(() => { c.loading = false; }); } return '<div class="card">Loading…</div>'; }
  const d = c.data;
  if (!d.allowed) return empty('Cleaner Is Off', 'The cleaner only looks in folders you allowed during setup. Turn on <b>App data and caches</b> (and, for developer caches, <b>Developer tool folders</b>) and it can list what is safe to clear.', '<button class="btn primary" data-choose-folders>Choose Folders…</button>');
  if (d.scanning) return '<div class="card"><h3>Looking for Caches and Logs</h3><p class="hint" style="margin:0">Measuring what each one takes. This can take up to a minute.</p><div class="bar indeterminate" aria-hidden="true"><i></i></div></div>';
  if (!d.scannedAt) return empty('Clear Caches and Logs', 'Scan to see which caches and old logs are taking space. Nothing is removed until you pick items and confirm, and everything goes to the Trash so you can put it back. It looks only inside folders you allowed, and skips Apple’s own caches.', '<button class="btn primary" data-m="cl-scan">Scan</button>');
  const msg = c.msg ? `<div class="banner warn" role="status">${esc(c.msg)}</div>` : '';
  if (!d.items.length) return msg + empty('Nothing Big to Clear', 'No caches or logs over 1 MB were found in the folders you allowed.');
  const picked = d.items.filter((i) => c.picked.has(i.id)), pickedBytes = picked.reduce((s, i) => s + i.bytes, 0), max = d.items[0].bytes || 1;
  const rows = d.items.map((i) => `<tr><td class="chk"><input type="checkbox" data-mpick="cl" data-id="${esc(i.id)}" ${c.picked.has(i.id) ? 'checked' : ''} aria-label="Select ${esc(i.name)}"></td><td>${esc(i.name)}<div class="hint" style="margin:0">${esc(i.shown)} · ${esc(i.note)}</div></td><td><span class="pill">${i.kind === 'cache' ? 'Cache' : i.kind === 'log' ? 'Log' : 'Build'}</span></td><td class="num">${agoShort(i.modified)}</td><td class="num">${bytes(i.bytes)}</td><td style="width:18%">${bar(i.bytes / max)}</td></tr>`).join('');
  return `${msg}<div class="card" style="margin-bottom:16px"><h3>Can Be Cleared</h3><div class="big">${bytes(d.total)}</div><div class="row"><span>${d.items.length} items found ${agoShort(d.scannedAt) === 'today' ? 'just now' : agoShort(d.scannedAt)}</span><b>${picked.length ? `${picked.length} selected, ${bytes(pickedBytes)}` : 'none selected'}</b></div>
    <p class="hint" style="margin:8px 0 0"><button class="link" data-m="cl-all">Select all</button> · <button class="link" data-m="cl-none">Select none</button> · Items move to the Trash. Empty it to free the space.</p></div>
    <div class="card pad"><table><thead><tr><th><span class="sr">Select</span></th><th>Item</th><th>Type</th><th class="num">Last used</th><th class="num">Size</th><th><span class="sr">Share</span></th></tr></thead><tbody>${rows}</tbody></table></div>`;
};

// ---------- Uninstaller ----------
async function loadApps() {
  MG.apps.loading = true;
  const r = await mget('/api/manage/apps');
  MG.apps.list = r.apps || [];
  MG.apps.loading = false;
  if (tab === 'Uninstaller') mRender();
}
async function openApp(id) {
  MG.apps.sel = id; MG.apps.lo = null; MG.apps.picked = new Set();
  mRender();
  const r = await mget('/api/manage/apps/leftovers?id=' + encodeURIComponent(id));
  if (!r.ok) { MG.apps.sel = null; say(r.error || 'Couldn’t check that app.'); return; }
  MG.apps.lo = r;
  MG.apps.picked = new Set(r.leftovers.filter((l) => l.exact).map((l) => l.id)); // sure matches start ticked, name matches don't
  mRender();
}
views.Uninstaller = function Uninstaller() {
  const a = MG.apps;
  if (!a.list) { if (!a.loading) loadApps(); return '<div class="card">Reading your apps…</div>'; }
  if (a.sel) {
    const app = a.list.find((x) => x.id === a.sel);
    if (!app) { a.sel = null; return views.Uninstaller(); }
    if (!a.lo) return `<div class="card"><h3>${esc(app.name)}</h3><p class="hint" style="margin:0">Looking for the files it left behind…</p><div class="bar indeterminate" aria-hidden="true"><i></i></div></div>`;
    const lo = a.lo.leftovers, pickedBytes = lo.filter((l) => a.picked.has(l.id)).reduce((s, l) => s + l.bytes, 0);
    const rows = lo.map((l) => `<tr><td class="chk"><input type="checkbox" data-mpick="lo" data-id="${esc(l.id)}" ${a.picked.has(l.id) ? 'checked' : ''} aria-label="Select ${esc(l.shown)}"></td><td>${esc(l.shown)}<div class="hint" style="margin:0">${esc(l.label)}${l.exact ? '' : ' · matched by name only, so check it is really this app’s'}</div></td><td class="num">${bytes(l.bytes)}</td></tr>`).join('');
    return `<div class="card" style="margin-bottom:16px"><h3>Remove ${esc(app.name)}</h3><div class="big">${bytes(app.bytes + pickedBytes)}<small>to move to the Trash</small></div>
      <div class="row"><span>The app</span><b>${bytes(app.bytes)}</b></div><div class="row"><span>${a.picked.size} of ${lo.length} leftover file${lo.length === 1 ? '' : 's'} selected</span><b>${bytes(pickedBytes)}</b></div>
      <p class="hint" style="margin:8px 0 12px">Everything goes to the Trash, so you can put it back. Data that sandboxed apps keep in macOS’s Containers folders isn’t looked at.</p>
      <button class="btn primary" data-m="ap-go" ${a.busy ? 'disabled' : ''}>${a.busy ? 'Moving…' : 'Move to Trash…'}</button> <button class="btn" data-m="ap-back" ${a.busy ? 'disabled' : ''}>Cancel</button></div>
      ${lo.length ? `<div class="card pad"><table><thead><tr><th><span class="sr">Select</span></th><th>Leftover files</th><th class="num">Size</th></tr></thead><tbody>${rows}</tbody></table></div>` : empty('No Leftovers Found', 'Only the app itself will be moved.')}`;
  }
  const q = a.q.toLowerCase();
  const list = a.list.filter((x) => !q || x.name.toLowerCase().includes(q) || x.bundleId.toLowerCase().includes(q));
  const rows = list.map((x) => `<tr><td>${esc(x.name)} <span class="pill">${esc(x.version || '—')}</span>${x.running ? ' <span class="pill warn">Running</span>' : ''}<div class="hint" style="margin:0">${esc(x.bundleId)}</div></td><td class="num">${bytes(x.bytes)}</td><td class="num">${x.protected ? `<span class="pill">${esc(x.reason)}</span>` : x.running ? '<span class="hint" style="margin:0">Quit it first</span>' : `<button class="act" data-m="ap-open" data-id="${esc(x.id)}">Uninstall…</button>`}</td></tr>`).join('');
  return `${a.msg ? `<div class="banner warn" role="status">${esc(a.msg)}</div>` : ''}<div class="card pad"><table><thead><tr><th>App</th><th class="num">Size</th><th><span class="sr">Action</span></th></tr></thead><tbody>${rows || '<tr><td colspan="3">No apps match.</td></tr>'}</tbody></table></div>
    <p class="hint">${a.list.length} apps in your Applications folders. You choose what to remove and it goes to the Trash. Apple’s own apps and Quillmeter are protected.</p>`;
};

// ---------- Homebrew ----------
async function loadBrew() {
  MG.brew.loading = true;
  const [over, out] = await Promise.all([mget('/api/manage/brew'), mget('/api/manage/brew/outdated')]);
  MG.brew.over = over; MG.brew.outdated = out; MG.brew.loading = false;
  if (tab === 'Homebrew') mRender();
}
async function pollJob() {
  const r = await mget('/api/manage/brew/job');
  MG.brew.job = r.job;
  if (!r.job || r.job.status !== 'running') { clearInterval(MG.brew.poll); MG.brew.poll = 0; if (r.job) { MG.brew.over = null; MG.brew.outdated = null; MG.brew.loading = false; } }
  if (tab === 'Homebrew') { mRender(); const l = document.querySelector('.joblog'); if (l) l.scrollTop = l.scrollHeight; }
}
async function brewRunJob(body, question) {
  if (!confirm(question)) return;
  const r = await mpost('/api/manage/brew/run', body);
  if (!r.ok) { say(r.error || 'Couldn’t start that.'); return; }
  if (!MG.brew.poll) MG.brew.poll = setInterval(pollJob, 1000);
  pollJob();
}
function jobPanel() {
  const j = MG.brew.job;
  if (!j) return '';
  const label = { running: 'Running…', done: 'Finished', failed: 'Failed', cancelled: 'Cancelled' }[j.status];
  return `<div class="card" style="margin-bottom:16px"><div class="row" style="margin:0 0 8px"><b>${esc(j.title)}</b><span>${label}${j.status === 'running' ? ' <button class="act" data-m="br-cancel">Cancel</button>' : ' <button class="act" data-m="br-dismiss">Dismiss</button>'}</span></div><div class="joblog" tabindex="0" aria-label="Homebrew output">${j.lines.map(esc).join('\n') || 'Waiting for output…'}</div></div>`;
}
views.Homebrew = function Homebrew() {
  const b = MG.brew;
  if (!b.over) { if (!b.loading) loadBrew(); return '<div class="card">Looking for Homebrew…</div>'; }
  if (!b.over.installed) return empty('Homebrew Isn’t Installed', 'Homebrew is a package manager for Mac. Once it’s installed, this view lists what you installed with it and lets you search, install, upgrade and remove packages without a terminal. Install it from brew.sh.');
  const outdated = new Map([...(b.outdated.formulae || []), ...(b.outdated.casks || [])].map((o) => [o.name, o]));
  const seg = [['installed', `Installed (${b.over.formulae.length + b.over.casks.length})`], ['outdated', `Outdated (${outdated.size})`], ['search', 'Search']].map(([k, l]) => `<button data-m="br-view" data-v="${k}" aria-pressed="${b.view === k}" class="${b.view === k ? 'on' : ''}">${l}</button>`).join('');
  const busy = brewBusy();
  const pkgRow = (kind) => (p) => { const o = outdated.get(p.name); return `<tr><td>${esc(p.name)} <span class="pill">${esc(p.version)}</span>${o ? ` <span class="pill warn">${esc(o.latest)} available</span>` : ''}</td><td class="num">${o ? `<button class="act" data-m="br-act" data-a="upgrade" data-k="${kind}" data-n="${esc(p.name)}" ${busy ? 'disabled' : ''}>Upgrade…</button> ` : ''}<button class="act" data-m="br-act" data-a="uninstall" data-k="${kind}" data-n="${esc(p.name)}" ${busy ? 'disabled' : ''}>Remove…</button></td></tr>`; };
  let body = '';
  if (b.view === 'installed') {
    const q = b.q.toLowerCase(), f = (x) => !q || x.name.toLowerCase().includes(q);
    body = `<div class="grid"><div class="card pad"><h3>Apps (casks)</h3><table><tbody>${b.over.casks.filter(f).map(pkgRow('cask')).join('') || '<tr><td>None.</td></tr>'}</tbody></table></div><div class="card pad"><h3>Command line (formulae)</h3><table><tbody>${b.over.formulae.filter(f).map(pkgRow('formula')).join('') || '<tr><td>None.</td></tr>'}</tbody></table></div></div>`;
  } else if (b.view === 'outdated') {
    const list = [...(b.outdated.casks || []).map((o) => ['cask', o]), ...(b.outdated.formulae || []).map((o) => ['formula', o])];
    body = list.length ? `<div class="card pad"><table><thead><tr><th>Package</th><th class="num">Installed</th><th class="num">Latest</th><th></th></tr></thead><tbody>${list.map(([k, o]) => `<tr><td>${esc(o.name)} <span class="pill">${k}</span></td><td class="num">${esc(o.installed)}</td><td class="num">${esc(o.latest)}</td><td class="num"><button class="act" data-m="br-act" data-a="upgrade" data-k="${k}" data-n="${esc(o.name)}" ${busy ? 'disabled' : ''}>Upgrade…</button></td></tr>`).join('')}</tbody></table></div><p class="hint"><button class="btn" data-m="br-upgrade-all" ${busy ? 'disabled' : ''}>Upgrade All…</button> This list comes from Homebrew’s last update. Use Update List to refresh it from the internet.</p>` : empty('Everything Is Up to Date', 'Based on Homebrew’s last update. Use Update List to check again.');
  } else {
    const r = b.results;
    const col = (title, names, kind) => `<div class="card pad"><h3>${title}</h3><table><tbody>${names.map((n) => `<tr><td>${esc(n)}${(kind === 'cask' ? b.over.casks : b.over.formulae).some((p) => p.name === n) ? ' <span class="pill ok">Installed</span>' : ''}</td><td class="num">${(kind === 'cask' ? b.over.casks : b.over.formulae).some((p) => p.name === n) ? '' : `<button class="act" data-m="br-act" data-a="install" data-k="${kind}" data-n="${esc(n)}" ${busy ? 'disabled' : ''}>Install…</button>`}</td></tr>`).join('') || '<tr><td>No matches.</td></tr>'}</tbody></table></div>`;
    body = b.searching ? '<div class="card">Searching…</div>' : r ? `<div class="grid">${col('Apps (casks)', r.casks, 'cask')}${col('Command line (formulae)', r.formulae, 'formula')}</div>` : empty('Search Homebrew', 'Type a name in the search box and press Return. Installing runs Homebrew’s installer, so you are asked first.');
  }
  return `${jobPanel()}<div class="seg" role="group" aria-label="Homebrew view" style="margin-bottom:16px">${seg}</div>${body}<p class="hint">Homebrew ${esc(b.over.version)}. Reading and searching stay on your Mac. Install, upgrade and Update List use the internet.</p>`;
};
async function brewSearch(q) {
  MG.brew.view = 'search'; MG.brew.searching = true; MG.brew.results = null; mRender();
  const r = await mget('/api/manage/brew/search?q=' + encodeURIComponent(q));
  MG.brew.searching = false;
  if (!r.ok) { say(r.error || 'Search failed.'); return; }
  MG.brew.results = r; mRender();
}

// ---------- Updates ----------
views.Updates = function Updates() {
  const u = MG.upd.data;
  if (!u) return empty('Check Your Apps for Updates', 'Check for Updates lists Homebrew packages with a newer version, using Homebrew’s last update and no internet. You can also check the update feeds that your apps declare for themselves. That contacts each developer’s server, so it’s a separate, optional step.');
  const rows = u.updates.map((x) => `<tr><td>${esc(x.name)} <span class="pill">${esc(x.source)}</span></td><td class="num">${esc(x.installed)}</td><td class="num">${esc(x.latest)}</td><td class="num">${x.source === 'Homebrew' ? `<button class="act" data-m="br-act" data-a="upgrade" data-k="${esc(x.kind)}" data-n="${esc(x.name)}" ${brewBusy() ? 'disabled' : ''}>Upgrade…</button>` : '<span class="hint" style="margin:0">Open the app to update</span>'}</td></tr>`).join('');
  const f = u.feeds;
  const feedBox = f.ran
    ? `<p class="hint">Developer feeds: ${f.checked} checked, ${f.failed} didn’t answer. ${f.withoutFeed} app${f.withoutFeed === 1 ? '' : 's'} don’t publish a feed Quillmeter can read (for example App Store apps).</p>`
    : `<div class="card" style="margin-top:16px"><h3>Developer Feeds</h3><p class="hint" style="margin:0 0 10px">${f.withFeed} of your apps publish an update feed. Checking them contacts each developer’s server over HTTPS, and they can see your IP address and which app asked. ${f.withoutFeed} other app${f.withoutFeed === 1 ? '' : 's'} have none Quillmeter can read.</p><button class="btn" data-m="up-feeds" ${MG.upd.busy || !f.withFeed ? 'disabled' : ''}>Check ${f.withFeed} Developer Feed${f.withFeed === 1 ? '' : 's'}…</button></div>`;
  return `${jobPanel()}${rows ? `<div class="card pad"><table><thead><tr><th>App</th><th class="num">Installed</th><th class="num">Latest</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : empty('Nothing to Update', u.brew.installed ? 'No outdated Homebrew packages' + (u.feeds.ran ? ' and no newer versions in the feeds that answered.' : ' were found. Homebrew’s list is as of its last update.') : 'Homebrew isn’t installed, so there is nothing to check there.')}${feedBox}`;
};

// ---------- Events ----------
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-m]');
  if (!t) return;
  const m = t.dataset.m;
  const c = MG.cleaner, a = MG.apps, b = MG.brew;
  if (m === 'cl-scan') {
    c.msg = '';
    const r = await mpost('/api/manage/cleaner/scan', {});
    if (!r.ok) { say(r.error || 'Couldn’t start the scan.'); return; }
    c.data = { ...(c.data || {}), scanning: true }; mRender(); loadCleaner();
  } else if (m === 'cl-all') { c.picked = new Set(c.data.items.map((i) => i.id)); mRender(); }
  else if (m === 'cl-none') { c.picked = new Set(); mRender(); }
  else if (m === 'cl-trash') {
    const items = c.data.items.filter((i) => c.picked.has(i.id)), size = items.reduce((s, i) => s + i.bytes, 0);
    if (!confirm(`Move ${items.length} item${items.length === 1 ? '' : 's'} (${bytes(size)}) to the Trash? You can put them back from the Trash.`)) return;
    const r = await mpost('/api/manage/cleaner/trash', { ids: [...c.picked] });
    c.msg = r.ok ? `Moved ${r.moved} item${r.moved === 1 ? '' : 's'} (${bytes(r.freed)}) to the Trash. Empty the Trash to free the space.${r.failed && r.failed.length ? ` ${r.failed.length} couldn’t be moved: ${r.failed[0].error}` : ''}` : (r.error || 'Nothing was moved.');
    await loadCleaner();
  } else if (m === 'ap-open') openApp(t.dataset.id);
  else if (m === 'ap-back') { a.sel = null; a.lo = null; mRender(); }
  else if (m === 'ap-go') {
    const app = a.list.find((x) => x.id === a.sel), lo = a.lo.leftovers.filter((l) => a.picked.has(l.id)), size = app.bytes + lo.reduce((s, l) => s + l.bytes, 0);
    if (!confirm(`Move ${app.name} and ${lo.length} leftover file${lo.length === 1 ? '' : 's'} (${bytes(size)}) to the Trash? You can put them back from the Trash.`)) return;
    a.busy = true; mRender();
    const r = await mpost('/api/manage/apps/uninstall', { id: a.sel, leftovers: [...a.picked] });
    a.busy = false;
    a.msg = r.ok ? `${r.app} is in the Trash, with ${r.leftoversMoved} leftover file${r.leftoversMoved === 1 ? '' : 's'} (${bytes(r.freed)}). Empty the Trash to free the space.${r.failed && r.failed.length ? ` ${r.failed.length} couldn’t be moved.` : ''}` : (r.error || 'Nothing was moved.');
    a.sel = null; a.lo = null; a.list = null; mRender();
    setTimeout(() => { a.msg = ''; if (tab === 'Uninstaller') mRender(); }, 12000);
  } else if (m === 'br-view') { b.view = t.dataset.v; mRender(); }
  else if (m === 'br-act') {
    const { a: action, k: kind, n: name } = t.dataset;
    const q = { install: `Install ${name} with Homebrew? This downloads software from the internet and runs its installer.`, uninstall: `Remove ${name} with Homebrew? Its files are deleted by Homebrew, not moved to the Trash.`, upgrade: `Upgrade ${name} to its latest version? This downloads from the internet.` }[action];
    brewRunJob({ action, name, type: kind }, q);
  } else if (m === 'br-upgrade-all') brewRunJob({ action: 'upgrade-all' }, 'Upgrade every outdated Homebrew package? This downloads from the internet and can take a while.');
  else if (m === 'br-update') brewRunJob({ action: 'update' }, 'Update Homebrew’s package list? This contacts Homebrew’s servers.');
  else if (m === 'br-cancel') { await mpost('/api/manage/brew/cancel', {}); pollJob(); }
  else if (m === 'br-dismiss') { b.job = null; mRender(); }
  else if (m === 'up-check' || m === 'up-feeds') {
    if (m === 'up-feeds' && !confirm(`Check ${MG.upd.data.feeds.withFeed} developer update feeds? This contacts each developer’s server over HTTPS. They can see your IP address and which app asked.`)) return;
    MG.upd.busy = true; mRender();
    const r = await mpost('/api/manage/updates/check', { feeds: m === 'up-feeds' });
    MG.upd.busy = false;
    if (r.ok) MG.upd.data = r; else say(r.error || 'The check failed.');
    mRender();
  }
});
document.addEventListener('change', (e) => {
  const p = e.target.closest('[data-mpick]');
  if (!p) return;
  const set = p.dataset.mpick === 'cl' ? MG.cleaner.picked : MG.apps.picked;
  p.checked ? set.add(p.dataset.id) : set.delete(p.dataset.id);
  mRender();
});
document.addEventListener('input', (e) => {
  if (e.target.id !== 'mq') return;
  if (tab === 'Uninstaller') { MG.apps.q = e.target.value; const el = document.getElementById('mq'); mRender(); const again = document.getElementById('mq'); if (again && again !== el) again.value = MG.apps.q; }
  else if (tab === 'Homebrew') { MG.brew.q = e.target.value; if (MG.brew.view === 'installed') mRender(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'mq' && tab === 'Homebrew' && e.target.value.trim()) { MG.brew.q = e.target.value.trim(); brewSearch(MG.brew.q); }
});
