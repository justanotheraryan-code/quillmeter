'use strict';
// Decides which folders the disk breakdown may read. Nothing is read until the person has chosen folders in
// setup, folders that make macOS show a permission prompt start switched off, and some places are never read.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Skipped everywhere, whatever is enabled: the Photos library and the Trash.
const EVERYWHERE = ['*.photoslibrary', '.Trash'];
// Skipped inside ~/Library: other apps' private data. macOS guards these, and Quillmeter has no business in them.
const LIBRARY_MASKS = [
  'Mail', 'Messages', 'Safari', 'Containers', 'Group Containers', 'Photos', 'Mobile Documents', 'Calendars', 'Reminders',
  'Suggestions', 'IdentityServices', 'HomeKit', 'AddressBook', 'CallHistoryDB', 'CallHistoryTransactions',
  'MobileSync', 'Knowledge', 'com.apple.TCC', 'com.apple.sharedfilelist',
];
const STANDARD_HOME = new Set(['Desktop', 'Documents', 'Downloads', 'Library', 'Movies', 'Music', 'Pictures', 'Public']);

// prompt: true means macOS may ask for permission the first time the folder is read.
const CATALOG = [
  { id: 'applications', group: 'safe', label: 'Applications', note: 'Apps installed in the Applications folder.', prompt: false, defaultOn: true },
  { id: 'library', group: 'safe', label: 'App data and caches', note: 'Application Support, Caches, Logs and Developer in your Library folder. Other apps’ private data, such as Mail, Messages, Photos and iCloud, is never read.', prompt: false, defaultOn: true },
  { id: 'dotfolders', group: 'safe', label: 'Developer tool folders', note: 'Hidden folders in your home folder, such as .npm and .cache.', prompt: false, defaultOn: true },
  { id: 'otherfolders', group: 'safe', label: 'Other folders in your home folder', note: 'Folders you created yourself, such as projects.', prompt: false, defaultOn: true },
  { id: 'downloads', group: 'ask', label: 'Downloads', note: 'macOS asks for permission the first time.', prompt: true, defaultOn: false, dir: 'Downloads' },
  { id: 'documents', group: 'ask', label: 'Documents', note: 'macOS asks for permission, and again for iCloud Drive if Documents is synced.', prompt: true, defaultOn: false, dir: 'Documents' },
  { id: 'desktop', group: 'ask', label: 'Desktop', note: 'macOS asks for permission, and again for iCloud Drive if Desktop is synced.', prompt: true, defaultOn: false, dir: 'Desktop' },
  { id: 'pictures', group: 'ask', label: 'Pictures', note: 'Your Photos library is always skipped. macOS may still ask about the folder.', prompt: true, defaultOn: false, dir: 'Pictures' },
  { id: 'movies', group: 'ask', label: 'Movies', note: 'macOS may ask for permission.', prompt: true, defaultOn: false, dir: 'Movies' },
  { id: 'music', group: 'ask', label: 'Music', note: 'macOS may ask for permission.', prompt: true, defaultOn: false, dir: 'Music' },
  { id: 'icloud', group: 'ask', label: 'iCloud Drive', note: 'macOS asks for permission to read files managed by iCloud Drive.', prompt: true, defaultOn: false },
];
const IDS = CATALOG.map((c) => c.id);
const DEFAULT_ON = CATALOG.filter((c) => c.defaultOn).map((c) => c.id);

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const names = (p) => { try { return fs.readdirSync(p); } catch { return []; } };

/** The exact list of paths to measure for a set of enabled folder ids. Reads nothing but the home folder's own listing. */
function buildScanPlan(enabledIds, home = os.homedir()) {
  const on = new Set(enabledIds);
  const items = [];
  const add = (id, label, p, masks, depth) => items.push({ id, label, path: p, depth, masks: [...EVERYWHERE, ...masks] });

  if (on.has('applications') && isDir('/Applications')) add('applications', 'Applications', '/Applications', [], 0);
  if (on.has('library')) {
    for (const sub of ['Application Support', 'Caches', 'Logs', 'Developer']) {
      const p = path.join(home, 'Library', sub);
      if (isDir(p)) add('library', sub, p, LIBRARY_MASKS, 1);
    }
  }
  const entries = on.has('dotfolders') || on.has('otherfolders') ? names(home) : [];
  for (const n of entries) {
    if (n === '.Trash' || n === '.' || n === '..') continue;
    const p = path.join(home, n);
    if (n.startsWith('.')) { if (on.has('dotfolders') && isDir(p)) add('dotfolders', n, p, [], 0); }
    else if (on.has('otherfolders') && !STANDARD_HOME.has(n) && isDir(p)) add('otherfolders', n, p, [], 0);
  }
  for (const c of CATALOG) {
    if (c.dir && on.has(c.id) && isDir(path.join(home, c.dir))) add(c.id, c.label, path.join(home, c.dir), [], 0);
  }
  if (on.has('icloud')) {
    const p = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
    if (isDir(p)) add('icloud', 'iCloud Drive', p, [], 0);
  }
  return { items, skipped: CATALOG.filter((c) => !on.has(c.id)).map((c) => ({ id: c.id, label: c.label })) };
}

/** Group plan items into du invocations that share a depth and ignore list. */
function duCommands(plan) {
  const groups = new Map();
  for (const it of plan.items) {
    const key = `${it.depth}|${it.masks.join('\u0000')}`;
    if (!groups.has(key)) groups.set(key, { depth: it.depth, masks: it.masks, paths: [] });
    groups.get(key).paths.push(it.path);
  }
  return [...groups.values()].map((g) => ({
    args: ['-n', '19', 'du', '-xk', `-d${g.depth}`, ...g.masks.flatMap((m) => ['-I', m]), ...g.paths],
    depth: g.depth, paths: g.paths,
  }));
}

/** Catalog for the UI, with counts for the dynamic groups (names only; no folder contents are read). */
function describeCatalog(enabledIds, home = os.homedir()) {
  const on = new Set(enabledIds);
  const top = names(home);
  const counts = {
    dotfolders: top.filter((n) => n.startsWith('.') && n !== '.Trash' && n !== '.' && n !== '..').length,
    otherfolders: top.filter((n) => !n.startsWith('.') && !STANDARD_HOME.has(n)).length,
  };
  return CATALOG.map((c) => ({ ...c, enabled: on.has(c.id), count: counts[c.id] }));
}

module.exports = { CATALOG, IDS, DEFAULT_ON, EVERYWHERE, LIBRARY_MASKS, STANDARD_HOME, buildScanPlan, duCommands, describeCatalog };
