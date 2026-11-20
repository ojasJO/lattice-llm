// App shell: live state over WebSocket, hash routing, sidebar/topbar, pairing prompts.
import { LOGO, S, api, clear, emit, fmtAgo, h, icon, modal, on, toast, fmtNum, shortGpu, fmtBytes } from './lib.js';
import overview from './views/overview.js';
import devices from './views/devices.js';
import launch from './views/launch.js';
import models from './views/models.js';
import playground from './views/playground.js';
import experiments from './views/experiments.js';
import runs from './views/runs.js';
import logs from './views/logs.js';
import settings from './views/settings.js';

const ROUTES = [
  { sec: 'Cluster' },
  { id: 'overview', label: 'Overview', icon: 'grid', view: overview },
  { id: 'devices', label: 'Devices', icon: 'radar', view: devices },
  { id: 'launch', label: 'Launch', icon: 'rocket', view: launch },
  { id: 'models', label: 'Models', icon: 'box', view: models },
  { sec: 'Research' },
  { id: 'playground', label: 'Playground', icon: 'chat', view: playground },
  { id: 'experiments', label: 'Experiments', icon: 'flask', view: experiments },
  { id: 'runs', label: 'Runs', icon: 'activity', view: runs },
  { sec: 'System' },
  { id: 'logs', label: 'Logs', icon: 'terminal', view: logs },
  { id: 'settings', label: 'Settings', icon: 'sliders', view: settings },
];

// ------------------------------------------------------------------ theme
const savedTheme = (() => { try { return localStorage.getItem('lattice-theme'); } catch { return null; } })();
document.documentElement.dataset.theme = savedTheme || 'dark';
function toggleTheme() {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('lattice-theme', t); } catch { /* ignore */ }
  emit('theme', t);
  renderTopRight();
}

// ------------------------------------------------------------------ shell
const navLinks = {};
const nav = h('nav.nav', ROUTES.map((r) => {
  if (r.sec) return h('div.nav-sec', r.sec);
  const count = h('span.count.hidden');
  const a = h('a', { href: '#/' + r.id }, icon(r.icon), h('span', r.label), count);
  navLinks[r.id] = { a, count };
  return a;
}));
const sideFoot = h('div.side-foot');
const sidebar = h('aside.sidebar', h('div.brand', h('span', { html: LOGO }), h('div', h('b', 'Lattice'), h('small', 'distributed inference'))), nav, sideFoot);
const title = h('h1');
const subtitle = h('div.subtitle');
const topRight = h('div.right');
const content = h('div.content');
const main = h('main.main', h('header.topbar', h('div', title, subtitle), topRight), content);
const banner = h('div.connection-lost.hidden', 'Connection to the local Lattice node lost: reconnecting…');
document.body.append(h('div.app', sidebar, main), h('div#toasts.toasts'), banner);

function renderSideFoot() {
  const s = S.self;
  if (!s) return;
  const role = s.role === 'coordinator' ? ['accent', 'Coordinating'] : s.role === 'worker' ? ['ok', 'Serving ' + (s.serving_for || '')] : ['', 'Idle'];
  const online = S.peers.filter((p) => p.online).length;
  sideFoot.replaceChildren(
    h('div.row', h('span.dot.' + (role[0] || 'ok') + (s.role !== 'idle' ? '.pulse' : '')), h('div.name', s.name)),
    h('div.sub', `${s.lan_ip}:${s.ports?.http}`),
    h('div.small.muted', { style: { marginTop: '6px' } }, `${role[1]} · ${online}/${S.peers.length} peer${S.peers.length === 1 ? '' : 's'} online`),
  );
}

function renderTopRight() {
  const sess = S.session;
  const items = [];
  if (S.gen) items.push(h('span.pill.accent', h('span.dot.accent.pulse'), `generating · ${fmtNum(S.gen.tps, 1)} tok/s`));
  if (sess && sess.state === 'ready') {
    const stages = sess.plan?.length || 0;
    items.push(h('span.pill.ok', h('span.dot.ok'), `${sess.config?.target?.replace(/\.gguf$/i, '')} · ${stages} stage${stages > 1 ? 's' : ''}${sess.draft ? ' + draft' : ''}`));
  } else if (sess && sess.state === 'launching') items.push(h('span.pill.info', h('span.dot.pulse'), 'launching cluster…'));
  else if (sess && sess.state === 'error') items.push(h('span.pill.err', 'launch failed'));
  else if (S.self?.role === 'worker') items.push(h('span.pill.ok', h('span.dot.ok.pulse'), `worker for ${S.self.serving_for}`));
  else items.push(h('span.pill', 'no cluster running'));
  const dark = document.documentElement.dataset.theme === 'dark';
  items.push(h('button.btn.ghost.icon', { title: 'Toggle theme', onclick: toggleTheme }, icon(dark ? 'sun' : 'moon')));
  topRight.replaceChildren(...items);
}

function renderNavCounts() {
  const pend = S.pairing.incoming.filter((r) => r.status === 'pending').length;
  const unpaired = S.nearby.filter((n) => n.online && !n.paired).length;
  const d = navLinks.devices.count;
  if (pend) { d.textContent = pend; d.className = 'count hot'; }
  else if (unpaired) { d.textContent = unpaired; d.className = 'count'; }
  else d.className = 'count hidden';
  const l = navLinks.launch.count;
  if (S.session?.state === 'ready') { l.textContent = 'live'; l.className = 'count hot'; }
  else if (S.session?.state === 'launching') { l.textContent = '…'; l.className = 'count'; }
  else l.className = 'count hidden';
  const e = navLinks.experiments.count;
  if (S.experiment?.status === 'running') { e.textContent = `${S.experiment.progress.done}/${S.experiment.progress.total}`; e.className = 'count hot'; }
  else e.className = 'count hidden';
}

// ------------------------------------------------------------------ routing
let current = null;
let cleanup = null;
function route() {
  const id = (location.hash.match(/^#\/([\w-]+)/) || [])[1] || 'overview';
  const r = ROUTES.find((x) => x.id === id) || ROUTES[1];
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } }
  cleanup = null;
  for (const [k, v] of Object.entries(navLinks)) v.a.classList.toggle('active', k === r.id);
  title.textContent = r.view.title || r.label;
  subtitle.textContent = r.view.subtitle || '';
  clear(content);
  content.scrollTop = 0;
  current = r;
  if (!S.self) {
    content.append(h('div.page', h('div.card', h('div.empty', h('div.skeleton', { style: { width: '220px', height: '14px' } }), 'Connecting to the local node…'))));
    return;
  }
  const root = h('div.page');
  content.append(root);
  try {
    cleanup = r.view.mount(root) || null;
  } catch (e) {
    console.error(e);
    root.append(h('div.callout.err', icon('alert'), h('div', 'This view failed to render: ' + e.message)));
  }
}
window.addEventListener('hashchange', route);

// ------------------------------------------------------------------ pairing prompt
const openPrompts = new Map();
function showPairPrompt(req) {
  if (openPrompts.has(req.id) || req.status !== 'pending') return;
  const f = req.from || {};
  const hw = f.hw || {};
  const gpus = (hw.gpus || []).filter((g) => !g.integrated).map((g) => shortGpu(g.name));
  const left = h('span.muted.small');
  const timer = setInterval(() => {
    const s = Math.max(0, 120 - Math.floor(Date.now() / 1000 - req.created));
    left.textContent = `expires in ${s}s`;
  }, 500);
  const close = modal({
    title: 'Connection request',
    dismissable: false,
    body: h('div.col', { style: { gap: '14px' } },
      h('div.dev', h('div.top', h('div.ico', icon('laptop')), h('div', h('div.nm', f.name || 'Unknown device'), h('div.muted.small.mono', req.host))),
        h('div.specs', hw.cpu ? h('span.spec', icon('cpu'), hw.cpu.replace(/\(R\)|\(TM\)|CPU|@.*$/g, '').trim()) : null,
          hw.ram ? h('span.spec', icon('memory'), fmtBytes(hw.ram, 0) + ' RAM') : null,
          ...gpus.map((g) => h('span.spec', icon('gpu'), g)))),
      h('div.muted.small', `${f.name || 'This device'} wants to join your cluster. If you approve, it can borrow this laptop's compute and fetch models from it. Check that the code below matches the one on its screen.`),
      h('div.code-digits', `${req.code.slice(0, 3)} ${req.code.slice(3)}`),
      left),
    actions: [
      { label: 'Deny', cls: 'ghost', onClick: () => api('/api/pair/respond', { body: { request_id: req.id, approve: false } }).catch((e) => toast(e.message, 'error')) },
      { label: 'Approve', cls: 'primary', icon: 'check', onClick: () => api('/api/pair/respond', { body: { request_id: req.id, approve: true } }).catch((e) => toast(e.message, 'error')) },
    ],
    onClose: () => { clearInterval(timer); openPrompts.delete(req.id); },
  });
  openPrompts.set(req.id, close);
}

// ------------------------------------------------------------------ live state
function pushHist(id, s) {
  if (!s) return;
  const arr = S.hist[id] || (S.hist[id] = []);
  if (arr.length && arr[arr.length - 1].ts >= s.ts) return;
  arr.push(s);
  if (arr.length > 180) arr.splice(0, arr.length - 180);
}

const handlers = {
  snapshot(d) {
    Object.assign(S, {
      self: d.self, nearby: d.nearby, peers: d.peers, pairing: d.pairing, session: d.session,
      downloads: d.downloads, models: d.models, catalog: d.catalog, events: d.events, runs: d.runs,
      experiments: d.experiments, experiment: d.experiment, logs: d.logs,
    });
    S.hist[d.self.id] = d.telemetry || [];
    S.gates[d.self.id] = d.gate;
    for (const p of d.peers) pushHist(p.id, p.telemetry);
    for (const o of d.pairing.outgoing || []) S.outgoing[o.id] = o;
    for (const r of d.pairing.incoming || []) showPairPrompt(r);
    renderSideFoot(); renderTopRight(); renderNavCounts();
    route();
  },
  self(d) { S.self = d; renderSideFoot(); renderTopRight(); emit('self', d); },
  telemetry(d) { pushHist(d.id, d.s); S.gates[d.id] = d.gate; emit('telemetry', d.id); },
  peers(d) {
    S.peers = d;
    for (const p of d) pushHist(p.id, p.telemetry);
    renderSideFoot(); emit('peers', d);
  },
  nearby(d) { S.nearby = d; renderNavCounts(); emit('nearby', d); },
  pair_request(d) {
    S.pairing.incoming = S.pairing.incoming.filter((r) => r.id !== d.id).concat([d]);
    showPairPrompt(d); renderNavCounts(); emit('pairing');
  },
  pair_update(d) {
    S.pairing.incoming = S.pairing.incoming.map((r) => (r.id === d.id ? d : r));
    if (d.status !== 'pending' && openPrompts.has(d.id)) openPrompts.get(d.id)();
    renderNavCounts(); emit('pairing');
  },
  pair_outgoing(d) { S.outgoing[d.id] = d; emit('pairing'); },
  session(d) { S.session = d; renderTopRight(); renderNavCounts(); emit('session', d); },
  downloads(d) { S.downloads = d; emit('downloads', d); },
  models(d) { S.models = d; emit('models', d); },
  catalog(d) { S.catalog = d; emit('catalog', d); },
  event(d) {
    S.events.push(d);
    if (S.events.length > 300) S.events.splice(0, S.events.length - 300);
    if (d.toast) toast(d.text, d.level === 'success' ? 'success' : d.level === 'error' ? 'error' : d.level === 'warn' ? 'warn' : 'info');
    emit('event', d);
  },
  log(d) {
    const arr = S.logs[d.proc] || (S.logs[d.proc] = []);
    arr.push(d.line);
    if (arr.length > 3000) arr.splice(0, arr.length - 3000);
    emit('log', d);
  },
  run(d) { S.runs.push(d); if (S.runs.length > 500) S.runs.shift(); emit('run', d); },
  runs(d) { S.runs = d; emit('runs', d); },
  gen(d) { S.gen = d; renderTopRight(); emit('gen', d); },
  experiment(d) { S.experiment = d && d.status === 'running' ? d : (d ? d : null); renderNavCounts(); emit('experiment', d); },
  experiment_row(d) { emit('experiment_row', d); },
  experiments(d) { S.experiments = d; if (S.experiment && S.experiment.status !== 'running') S.experiment = null; renderNavCounts(); emit('experiments', d); },
};

let ws;
let retry = 0;
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { retry = 0; S.connected = true; banner.classList.add('hidden'); };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    const fn = handlers[m.t];
    if (fn) { try { fn(m.d); } catch (e) { console.error(m.t, e); } }
  };
  ws.onclose = () => {
    S.connected = false;
    banner.classList.remove('hidden');
    setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
  };
}
connect();
setInterval(() => { if (ws && ws.readyState === 1) ws.send('ping'); }, 15000);
setInterval(renderSideFoot, 5000);
on('theme', () => route());
window.__lattice = { S, fmtAgo };
