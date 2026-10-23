'use strict';
// Liquid-glass behavior for Quillmeter's controls.
//
// The cursor-reactive parts follow the technique in liquid-glass-react (MIT, Copyright 2025 Max Rovensky,
// https://github.com/rdev/liquid-glass-react): a control leans toward the pointer, stretches along it, shows a rim
// light that follows the cursor, and squashes when pressed. This is a vanilla port, because Quillmeter is plain HTML
// with no build step. See THIRD_PARTY_NOTICES.md.
//
// It works item to item: only the control under the cursor reacts, and the light hands off to the next control as the
// pointer moves, so nothing glows by proximity and nothing spills onto its neighbors.
//
// Apple's guidance is followed on top of that: real glass (a backdrop blur) only on the floating control layer
// (toolbar controls, the sidebar and segmented indicators, sheets); Reduce Motion drops the movement; Reduce
// Transparency and Increase Contrast get opaque fills (see app.css).
(() => {
  const params = new URLSearchParams(location.search).get('glass') || ''; // test hooks: basic, reduce
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const coarse = matchMedia('(pointer: coarse)');
  const cssOK = (p, v) => window.CSS && CSS.supports(p, v);
  // Displacement (real refraction) is only used on Chromium, where it renders. WebKit parses the filter but the
  // library documents that it doesn't show the bending, so the app's web view uses blur, saturation and light.
  const refract = /Chrome\//.test(navigator.userAgent) && cssOK('backdrop-filter', 'url(#qm-refract)') && params !== 'basic' && params !== 'reduce';

  const MAX_SHIFT = 3;                                                // px, so a small control never wanders from its hit area
  const REACTIVE = '.btn, .act, .icon-btn, .search, .side-item';      // the controls that react to the cursor
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // Run on the next frame, or after 40 ms if no frame comes (animation frames pause when a window is in the background).
  const defer = (fn) => { let done = false; const run = () => { if (!done) { done = true; fn(); } }; requestAnimationFrame(run); setTimeout(run, 40); };
  const motionOn = () => !reduceMotion.matches && !coarse.matches && params !== 'reduce';

  // ---------- Which elements are glass ----------
  function classify(el) {
    el.classList.add('glass');
    // Sidebar rows are menu items: they get the light and the sliding indicator, not their own blur.
    const floating = el.matches('.lens, .thumb') || (el.closest('.toolbar, #sheet-root') !== null && !el.matches('.side-item'));
    el.classList.toggle('float', floating);
    el.classList.toggle('lite', !floating);
    el.classList.toggle('press', el.matches('.btn, .act, .icon-btn, .side-item'));
    el.classList.toggle('react', el.matches(REACTIVE));
    // Buttons lean toward the cursor; menu rows and fields only get the light.
    el.dataset.elastic = el.matches('.btn, .act, .icon-btn') ? '0.15' : '0';
    if (refract && el.matches('.btn, .icon-btn, .lens, .thumb')) el.classList.add('refract-ok');
  }

  // ---------- The sliding glass indicator under the selected section, and under segmented controls ----------
  const thumbMemory = new Map(); // remember where each segmented control's thumb was, so it slides instead of jumping
  function placeLens() {
    const nav = document.getElementById('tabs'), lens = nav && nav.querySelector('.lens');
    if (!nav || !lens) return;
    const on = nav.querySelector('.side-item.on');
    if (!on) { lens.style.opacity = '0'; return; }
    const a = nav.getBoundingClientRect(), b = on.getBoundingClientRect();
    lens.style.opacity = '1';
    lens.style.setProperty('--ly', `${(b.top - a.top + nav.scrollTop).toFixed(1)}px`);
    lens.style.width = `${b.width.toFixed(1)}px`;
    lens.style.height = `${b.height.toFixed(1)}px`;
  }
  function placeThumbs() {
    for (const seg of document.querySelectorAll('.seg, .panes')) {
      const on = seg.querySelector('button.on, button[aria-pressed="true"], button[aria-selected="true"]');
      let thumb = seg.querySelector(':scope > .thumb');
      if (!on) { if (thumb) thumb.style.opacity = '0'; continue; }
      if (!thumb) { thumb = document.createElement('span'); thumb.className = 'thumb'; thumb.setAttribute('aria-hidden', 'true'); seg.prepend(thumb); classify(thumb); }
      const key = seg.getAttribute('aria-label') || seg.className;
      const a = seg.getBoundingClientRect(), b = on.getBoundingClientRect();
      const to = { x: b.left - a.left, w: b.width, h: b.height, y: b.top - a.top };
      const from = thumbMemory.get(key);
      thumb.style.opacity = '1';
      thumb.style.height = `${to.h.toFixed(1)}px`;
      thumb.style.top = `${to.y.toFixed(1)}px`;
      if (from && !reduceMotion.matches) {          // start where it was, then slide to the new spot
        thumb.style.transition = 'none';
        thumb.style.setProperty('--lx', `${from.x.toFixed(1)}px`);
        thumb.style.width = `${from.w.toFixed(1)}px`;
        thumb.getBoundingClientRect();                // commit the start position
        thumb.style.transition = '';
      }
      thumb.style.setProperty('--lx', `${to.x.toFixed(1)}px`);
      thumb.style.width = `${to.w.toFixed(1)}px`;
      thumbMemory.set(key, to);
    }
  }

  // ---------- Pointer: one control at a time ----------
  let active = null, pointer = null, queued = false;

  function release(el) {
    el.style.setProperty('--fade', '0');
    for (const [k, v] of [['--tx', '0px'], ['--ty', '0px'], ['--sx', '1'], ['--sy', '1']]) el.style.setProperty(k, v);
  }
  function engage(el, x, y) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    el.style.setProperty('--mx', `${(x - r.left).toFixed(1)}px`);
    el.style.setProperty('--my', `${(y - r.top).toFixed(1)}px`);
    el.style.setProperty('--fade', '1');
    const k = Number(el.dataset.elastic || 0);
    if (!k || !motionOn()) return;
    // The pointer's offset from the centre, as the library does it: lean toward it, stretch along it.
    const dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2), dist = Math.hypot(dx, dy) || 1;
    const nx = dx / dist, ny = dy / dist, stretch = Math.min(dist / 60, 1) * k;
    el.style.setProperty('--tx', `${clamp(dx * k * 0.2, -MAX_SHIFT, MAX_SHIFT).toFixed(2)}px`);
    el.style.setProperty('--ty', `${clamp(dy * k * 0.2, -MAX_SHIFT, MAX_SHIFT).toFixed(2)}px`);
    el.style.setProperty('--sx', clamp(1 + Math.abs(nx) * stretch * 0.3 - Math.abs(ny) * stretch * 0.15, 0.94, 1.06).toFixed(3));
    el.style.setProperty('--sy', clamp(1 + Math.abs(ny) * stretch * 0.3 - Math.abs(nx) * stretch * 0.15, 0.94, 1.06).toFixed(3));
  }
  function apply() {
    queued = false;
    const target = pointer && pointer.el && pointer.el.isConnected && !pointer.el.disabled ? pointer.el : null;
    if (active && active !== target) release(active);   // hand the light off: the old control fades, the new one lights
    active = target;
    if (active) engage(active, pointer.x, pointer.y);
  }
  const schedule = () => { if (!queued) { queued = true; defer(apply); } };

  const controlAt = (target) => (target instanceof Element ? target.closest(REACTIVE) : null);
  addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const el = controlAt(e.target);
    pointer = { el: el && el.classList.contains('glass') ? el : null, x: e.clientX, y: e.clientY };
    schedule();
  }, { passive: true });
  const clear = () => { pointer = null; schedule(); };
  document.addEventListener('pointerleave', clear);
  addEventListener('blur', clear);

  // ---------- Keep up with the page ----------
  function refresh() {
    document.querySelectorAll('.btn, .act, .icon-btn, .search, .side-item, .seg, .panes, .sheet, .lens, .thumb').forEach(classify);
    placeLens();
    placeThumbs();
    // The page re-renders often; if the cursor is resting on a control that was just rebuilt, light it again.
    if (pointer && !(pointer.el && pointer.el.isConnected)) {
      const el = controlAt(document.elementFromPoint(pointer.x, pointer.y));
      pointer.el = el && el.classList.contains('glass') ? el : null;
      schedule();
    }
  }
  let pending = false;
  const later = () => { if (!pending) { pending = true; defer(() => { pending = false; refresh(); }); } };

  function start() {
    document.body.classList.add('glass-ready');
    if (refract) { document.body.classList.add('refract'); document.body.prepend(refractionFilter()); }
    if (params === 'reduce') document.body.classList.add('reduce-motion', 'reduce-transparency');
    new MutationObserver(later).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    if (window.ResizeObserver) new ResizeObserver(later).observe(document.body);
    addEventListener('resize', later);
    refresh();
  }

  // The shared SVG filter, built with DOM calls (no HTML string).
  function refractionFilter() {
    const NS = 'http://www.w3.org/2000/svg';
    const make = (tag, attrs, parent) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (parent) parent.appendChild(n); return n; };
    const svg = make('svg', { width: '0', height: '0', 'aria-hidden': 'true' });
    svg.style.position = 'absolute';
    const f = make('filter', { id: 'qm-refract', x: '0', y: '0', width: '100%', height: '100%', 'color-interpolation-filters': 'sRGB' }, svg);
    make('feImage', { href: displacementMap(), x: '0', y: '0', width: '100%', height: '100%', preserveAspectRatio: 'none', result: 'map' }, f);
    make('feDisplacementMap', { in: 'SourceGraphic', in2: 'map', scale: '22', xChannelSelector: 'R', yChannelSelector: 'G' }, f);
    return svg;
  }

  // A pill-shaped displacement map drawn on a canvas: neutral in the middle, bending inward near the rim
  // (the library ships a 41 KB image for this; drawing it keeps the app small).
  function displacementMap() {
    const w = 256, h = 128, r = h / 2, c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d'), img = g.createImageData(w, h), band = r * 0.55;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const px = clamp(x, r, w - r), dxp = x - px, dyp = y - r, len = Math.hypot(dxp, dyp) || 1;
      const inside = r - len;                                   // distance in from the rim (negative = outside)
      const m = inside >= band ? 0 : inside <= 0 ? 1 : Math.pow(1 - inside / band, 2);
      const i = (y * w + x) * 4;
      img.data[i] = 128 - (dxp / len) * m * 127;                // inward, so the content bends toward the middle
      img.data[i + 1] = 128 - (dyp / len) * m * 127;
      img.data[i + 2] = 128; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }

  window.Glass = { refresh, refract };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
