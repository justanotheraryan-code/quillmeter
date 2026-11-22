'use strict';
// Sound: output and input devices, their volume and mute, and the volume of single apps. The Mac app (app/sound.swift)
// does the work and pushes state here; this page only shows it and sends requests back. Nothing is listened to until
// the Sound tab is open, and per-app volume asks macOS for permission only when you first move an app's slider.
const SND = { data: null, drag: false, watching: false, sig: '', last: 0 };

window.onSoundState = (s) => { SND.data = s; if (tab === 'Sound' && !SETTINGS_MODE) soundRefresh(); };
function soundWatch(on) {
  if (!native || SND.watching === on) return;
  SND.watching = on;
  nativeCall({ sound: { watch: on } });
}
const soundSend = (m) => nativeCall({ sound: m });
const soundSig = (d) => d ? JSON.stringify([d.outputs.map((x) => [x.uid, x.current, x.muted]), d.inputs.map((x) => [x.uid, x.current, x.muted]), d.apps.map((a) => [a.key, a.playing, a.error || '']), d.perApp]) : '';

function soundRefresh() {
  const d = SND.data;
  if (!d) return;
  if (soundSig(d) !== SND.sig) { if (!SND.drag) render(true); return; }
  if (SND.drag) return;                                       // leave a slider alone while it is being dragged
  for (const el of document.querySelectorAll('[data-sndvol]')) {
    const list = el.dataset.kind === 'output' ? d.outputs : d.inputs, dev = list.find((x) => x.uid === el.dataset.uid);
    if (dev && dev.volume !== undefined) { el.value = Math.round(dev.volume * 100); soundPct(el); }
  }
  for (const el of document.querySelectorAll('[data-sndapp]')) {
    const a = d.apps.find((x) => x.key === el.dataset.sndapp);
    if (a) { el.value = Math.round(a.volume * 100); soundPct(el); }
  }
}
function soundPct(el) { const o = el.parentElement.querySelector('.pct'); if (o) o.textContent = `${el.value}%`; }

function deviceRows(list, kind) {
  if (!list.length) return '<div class="setrow slim"><span class="hint" style="margin:0">None found.</span></div>';
  return list.map((x) => {
    const slider = x.volume !== undefined
      ? `<span class="vol"><input type="range" min="0" max="100" value="${Math.round(x.volume * 100)}" data-sndvol data-kind="${kind}" data-uid="${esc(x.uid)}" aria-label="${esc(x.name)} volume"><span class="pct">${Math.round(x.volume * 100)}%</span></span>`
      : '<span class="hint" style="margin:0">No volume control</span>';
    const mute = x.muted !== undefined ? `<button class="act" data-snd="mute" data-kind="${kind}" data-uid="${esc(x.uid)}" data-on="${x.muted ? 0 : 1}" aria-pressed="${x.muted}">${x.muted ? 'Unmute' : 'Mute'}</button>` : '';
    const use = x.current ? '<span class="pill ok">In use</span>' : `<button class="act" data-snd="use" data-kind="${kind}" data-uid="${esc(x.uid)}">Use</button>`;
    return `<div class="setrow"><div><div class="set-label">${esc(x.name)} ${x.transport ? `<span class="pill">${esc(x.transport)}</span>` : ''}</div>${slider}</div><div>${mute} ${use}</div></div>`;
  }).join('');
}

views.Sound = function Sound() {
  if (!native) return empty('Sound is part of the Quillmeter app', 'Open this page from Quillmeter.app to switch devices and set volume.');
  soundWatch(true);
  const d = SND.data;
  if (!d) return empty('Reading your audio devices…', 'This takes a moment.');
  SND.sig = soundSig(d);
  const apps = !d.perApp
    ? '<div class="card"><p style="margin:0">Per-app volume needs macOS 14.2 or later.</p></div>'
    : `<div class="card"><h3>Apps making sound</h3>${d.apps.length ? d.apps.map((a) => `<div class="setrow"><div><div class="set-label">${esc(a.name)} ${a.playing ? '' : '<span class="pill">Quiet</span>'}</div>
        <span class="vol"><input type="range" min="0" max="100" value="${Math.round(a.volume * 100)}" data-sndapp="${esc(a.key)}" aria-label="${esc(a.name)} volume"><span class="pct">${Math.round(a.volume * 100)}%</span></span>
        ${a.error ? `<div class="hint" style="margin:0">${esc(a.error)}</div>` : ''}</div></div>`).join('') : '<div class="setrow slim"><span class="hint" style="margin:0">No app is playing sound right now. Play something and it appears here.</span></div>'}</div>
      <p class="hint">Moving an app's slider below 100% routes that app's sound through Quillmeter. The first time, macOS asks to allow Quillmeter to record system audio; it is used only to play the sound again at your volume, and nothing is saved. If an app goes silent, set it back to 100%, or check System Settings, Privacy &amp; Security, Screen &amp; System Audio Recording. Settings reset when Quillmeter quits.</p>`;
  return `<div class="card"><h3>Output</h3>${deviceRows(d.outputs, 'output')}</div>${apps}<div class="card"><h3>Input</h3>${deviceRows(d.inputs, 'input')}</div>`;
};

// Slider changes are sent at most every 80 ms while dragging, and once more when the drag ends.
document.addEventListener('pointerdown', (e) => { if (e.target.closest && e.target.closest('[data-sndvol], [data-sndapp]')) SND.drag = true; });
document.addEventListener('pointerup', () => { if (SND.drag) { SND.drag = false; setTimeout(soundRefresh, 150); } });
document.addEventListener('input', (e) => {
  const v = e.target.closest && e.target.closest('[data-sndvol], [data-sndapp]');
  if (!v) return;
  soundPct(v);
  const now = Date.now();
  if (now - SND.last < 80) { clearTimeout(SND.t); SND.t = setTimeout(() => sendSlider(v), 80); return; }
  SND.last = now; sendSlider(v);
});
function sendSlider(v) {
  const value = Number(v.value) / 100;
  if (v.dataset.sndapp !== undefined) soundSend({ setAppVolume: { key: v.dataset.sndapp, value } });
  else soundSend({ setVolume: { kind: v.dataset.kind, uid: v.dataset.uid, value } });
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-snd]');
  if (!b) return;
  const { snd, kind, uid } = b.dataset;
  if (snd === 'use') soundSend({ setDefault: { kind, uid } });
  if (snd === 'mute') soundSend({ setMute: { kind, uid, value: b.dataset.on === '1' } });
  if (snd === 'reset') soundSend({ resetApps: true });
});
