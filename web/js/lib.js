// Shared helpers: DOM builder, icons, formatting, API client, store/bus, toasts, modals.

// ------------------------------------------------------------------ DOM
// Views pass optional children as `cond ? node : null`; make the native DOM methods skip those
// instead of rendering the text "null".
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
  for (const m of ['replaceChildren', 'append', 'prepend']) {
    const orig = proto[m];
    proto[m] = function (...nodes) {
      return orig.apply(this, nodes.flat(Infinity).filter((n) => n != null && n !== false && n !== true));
    };
  }
}

export function h(tag, props, ...kids) {
  const [t, ...cls] = tag.split('.');
  const el = t === 'svg' || SVG_TAGS.has(t)
    ? document.createElementNS('http://www.w3.org/2000/svg', t)
    : document.createElement(t || 'div');
  if (cls.length) el.setAttribute('class', cls.join(' '));
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    kids.unshift(props);
    props = null;
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.setAttribute('class', ((el.getAttribute('class') || '') + ' ' + v).trim());
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v; // trusted constant markup only
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, kids);
  return el;
}
const SVG_TAGS = new Set(['g', 'path', 'circle', 'line', 'rect', 'text', 'polyline', 'polygon', 'defs', 'linearGradient', 'radialGradient', 'stop', 'marker', 'filter', 'feGaussianBlur', 'tspan', 'title']);
export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false || k === true) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function replace(el, ...kids) { clear(el); return append(el, kids); }
export const $ = (sel, root = document) => root.querySelector(sel);

// ------------------------------------------------------------------ icons (Lucide-style, MIT)
const I = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  radar: '<path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"/><path d="M4 6h.01"/><path d="M2.29 9.62A10 10 0 1 0 21.31 8.35"/><path d="M16.24 7.76A6 6 0 1 0 8.23 16.67"/><path d="M12 18h.01"/><path d="M17.99 11.66A6 6 0 0 1 15.77 16.67"/><circle cx="12" cy="12" r="2"/><path d="m13.41 10.59 5.66-5.66"/>',
  box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  flask: '<path d="M9 3h6"/><path d="M10 3v6.5L4.5 19a1.5 1.5 0 0 0 1.3 2.2h12.4a1.5 1.5 0 0 0 1.3-2.2L14 9.5V3"/><path d="M7 15h10"/>',
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  unlink: '<path d="m18.84 12.25 1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="m5.17 11.75-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71"/><line x1="8" y1="2" x2="8" y2="5"/><line x1="2" y1="8" x2="5" y2="8"/><line x1="16" y1="19" x2="16" y2="22"/><line x1="19" y1="16" x2="22" y2="16"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>',
  gpu: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="9" cy="12" r="3"/><circle cx="16.5" cy="12" r="1.5"/><path d="M6 18v3M10 18v3M14 18v3"/>',
  memory: '<rect x="2" y="7" width="20" height="10" rx="2"/><path d="M6 11v2M10 11v2M14 11v2M18 11v2M6 17v3M18 17v3"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  play: '<polygon points="7 4 20 12 7 20 7 4"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  laptop: '<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  network: '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M12 7.5v4M12 11.5 6.5 17M12 11.5l5.5 5.5"/>',
  battery: '<rect x="2" y="7" width="17" height="10" rx="2"/><line x1="22" y1="11" x2="22" y2="13"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"/>',
  thermo: '<path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  arrowUp: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
  arrowDown: '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>',
  split: '<path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"/><path d="m15 9 6-6"/>',
  sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
  wand: '<path d="m15 4-1 1"/><path d="m21 2-1 1"/><path d="m3 21 12-12"/><path d="M18 10h2"/><path d="M14 4V2"/><path d="m19 7 1 1"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  chevron: '<polyline points="9 18 15 12 9 6"/>',
};
export function icon(name, cls) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  if (cls) s.setAttribute('class', cls);
  s.innerHTML = I[name] || I.info;
  return s;
}
export const LOGO = `<svg viewBox="0 0 32 32" fill="none"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c8cff"/><stop offset="1" stop-color="#c084fc"/></linearGradient></defs>
<rect x="1" y="1" width="30" height="30" rx="9" fill="url(#lg)" opacity=".16"/><g stroke="url(#lg)" stroke-width="2" stroke-linecap="round">
<path d="M9 9 L23 9 L23 23 L9 23 Z M9 9 L23 23 M23 9 L9 23" opacity=".55"/></g>
<g fill="url(#lg)"><circle cx="9" cy="9" r="3.2"/><circle cx="23" cy="9" r="3.2"/><circle cx="23" cy="23" r="3.2"/><circle cx="9" cy="23" r="3.2"/><circle cx="16" cy="16" r="2.6"/></g></svg>`;

// ------------------------------------------------------------------ formatting
export function fmtBytes(n, d = 1) {
  if (n == null || isNaN(n)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  n = Number(n);
  while (Math.abs(n) >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? Math.round(n) : n.toFixed(n >= 100 ? 0 : d)) + ' ' + u[i];
}
export const fmtRate = (n) => (n == null ? '–' : fmtBytes(n) + '/s');
export function fmtNum(n, d = 1) {
  if (n == null || isNaN(n)) return '–';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 });
}
export function fmtMs(n) {
  if (n == null || isNaN(n)) return '–';
  if (n < 1) return n.toFixed(2) + ' ms';
  if (n < 1000) return n.toFixed(n < 10 ? 1 : 0) + ' ms';
  return (n / 1000).toFixed(2) + ' s';
}
export const fmtPct = (n, d = 0) => (n == null || isNaN(n) ? '–' : (n * 100).toFixed(d) + '%');
export const fmtPct100 = (n, d = 0) => (n == null || isNaN(n) ? '–' : Number(n).toFixed(d) + '%');
export function fmtAgo(ts) {
  if (!ts) return '–';
  const s = (Date.now() - ts) / 1000;
  if (s < 5) return 'just now';
  if (s < 60) return Math.floor(s) + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return new Date(ts).toLocaleDateString();
}
export function fmtDur(s) {
  if (s == null) return '–';
  s = Math.max(0, Math.floor(s));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}
export const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
export const fmtParams = (n) => (n == null ? '–' : n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : (n / 1e6).toFixed(0) + 'M');

// ------------------------------------------------------------------ API
export async function api(path, opts = {}) {
  const init = { method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'), headers: {} };
  if (init.method !== 'GET') init.headers['X-Lattice-UI'] = '1';
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const r = await fetch(path, init);
  let data = null;
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) data = await r.json();
  else data = await r.text();
  if (!r.ok) throw new Error((data && data.error) || (typeof data === 'string' ? data : `HTTP ${r.status}`));
  return data;
}
export async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg, 'success');
    return r;
  } catch (e) {
    toast(e.message || String(e), 'error');
    return null;
  }
}

// ------------------------------------------------------------------ store & bus
export const S = {
  self: null, nearby: [], peers: [], pairing: { incoming: [], outgoing: [] }, outgoing: {},
  session: null, downloads: [], models: [], catalog: [], hist: {}, gates: {}, events: [], runs: [],
  experiments: [], experiment: null, logs: { 'llama-server': [], 'rpc-server': [] }, gen: null, connected: false,
};
const subs = new Map();
export function on(topic, fn) {
  if (!subs.has(topic)) subs.set(topic, new Set());
  subs.get(topic).add(fn);
  return () => subs.get(topic).delete(fn);
}
export function emit(topic, data) {
  for (const fn of subs.get(topic) || []) {
    try { fn(data); } catch (e) { console.error(topic, e); }
  }
  for (const fn of subs.get('*') || []) {
    try { fn(topic, data); } catch (e) { console.error(e); }
  }
}

// node colours stay stable for the lifetime of the page
export function nodeColor(id) {
  if (!id) return 'var(--faint)';
  if (S.self && id === S.self.id) return 'var(--n0)';
  const i = S.peers.findIndex((p) => p.id === id);
  if (i >= 0) return `var(--n${(i + 1) % 8})`;
  let hsh = 0;
  for (const c of id) hsh = (hsh * 31 + c.charCodeAt(0)) >>> 0;
  return `var(--n${1 + (hsh % 7)})`;
}
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
export function resolveColor(c) {
  return c && c.startsWith('var(') ? cssVar(c.slice(4, -1)) : c;
}

// every node known to the UI (this node first) with its latest telemetry
export function allNodes() {
  const out = [];
  if (S.self) {
    const hist = S.hist[S.self.id] || [];
    out.push({ id: S.self.id, name: S.self.name, self: true, online: true, info: S.self, host: S.self.lan_ip,
               port: S.self.ports?.http, tel: hist[hist.length - 1], gate: S.gates[S.self.id], role: S.self.role });
  }
  for (const p of S.peers) {
    const hist = S.hist[p.id] || [];
    out.push({ id: p.id, name: p.name, self: false, online: p.online, info: p.info || { hw: p.hw }, host: p.host,
               port: p.port, tel: hist[hist.length - 1], gate: p.gate, role: p.info?.role, peer: p });
  }
  return out;
}
export function nodeName(id) {
  if (S.self && id === S.self.id) return S.self.name;
  return S.peers.find((p) => p.id === id)?.name || id;
}

// ------------------------------------------------------------------ toasts & modals
export function toast(msg, level = 'info', ms = 4200) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const ic = { success: 'check', warn: 'alert', error: 'alert', info: 'info' }[level] || 'info';
  const t = h('div.toast.' + level, icon(ic), h('div', msg));
  t.querySelector('svg').style.cssText = 'width:16px;height:16px;flex:none;margin-top:2px';
  box.append(t);
  setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, ms);
}
export function modal({ title, body, actions = [], wide = false, onClose, dismissable = true }) {
  const back = h('div.modal-back');
  const close = () => { back.remove(); document.removeEventListener('keydown', esc); onClose && onClose(); };
  const esc = (e) => { if (e.key === 'Escape' && dismissable) close(); };
  const foot = h('div.modal-f', actions.map((a) => h('button.btn' + (a.cls ? '.' + a.cls : ''),
    { onclick: async () => { const keep = await a.onClick?.(close); if (keep !== true) close(); } }, a.icon ? icon(a.icon) : null, a.label)));
  const m = h('div.modal' + (wide ? '.wide' : ''),
    h('div.modal-h', h('h2', title), h('div.spacer'), dismissable ? h('button.btn.ghost.icon.sm', { onclick: close, title: 'Close' }, icon('x')) : null),
    h('div.modal-b', body), actions.length ? foot : null);
  back.append(m);
  if (dismissable) back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', esc);
  document.body.append(back);
  return close;
}
export function confirmDialog(title, text, okLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    modal({
      title, body: h('p.muted', { style: { margin: 0 } }, text),
      actions: [
        { label: 'Cancel', cls: 'ghost', onClick: () => { done = true; resolve(false); } },
        { label: okLabel, cls: danger ? 'danger' : 'primary', onClick: () => { done = true; resolve(true); } },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}
export function copyText(text) {
  navigator.clipboard?.writeText(text).then(() => toast('Copied to clipboard', 'success', 1600),
    () => toast('Copy failed', 'error'));
}
export function meter(label, frac, valueText, cls = '', frac2 = null) {
  const f = Math.max(0, Math.min(1, frac || 0));
  return h('div.meter', h('span.k', label),
    h('div.bar' + (cls ? '.' + cls : ''), frac2 != null ? h('i.b2', { style: { width: Math.max(0, Math.min(1, frac2)) * 100 + '%' } }) : null,
      h('i', { style: { width: f * 100 + '%' } })),
    h('span.v', valueText));
}
export function levelCls(frac) { return frac > 0.9 ? 'err' : frac > 0.75 ? 'warn' : ''; }
export function deviceLabel(d) {
  if (!d) return 'auto';
  return `${d.name} · ${d.desc.replace(/\(R\)|\(TM\)/g, '').replace(/\s+/g, ' ').trim()}`;
}
export function shortGpu(name) {
  return (name || '').replace(/NVIDIA GeForce |Laptop GPU|\(R\)|\(TM\)|Graphics/g, '').replace(/\s+/g, ' ').trim();
}
