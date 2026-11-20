// Builders shared by several views.
import { S, allNodes, fmtBytes, fmtMs, fmtNum, fmtPct100, fmtRate, h, icon, levelCls, meter, nodeColor, shortGpu } from '../lib.js';
import { sparkline } from '../charts.js';

export function empty(ic, title, text, action) {
  return h('div.empty', icon(ic), h('b', title), text ? h('div.small', text) : null, action || null);
}

export function stageOf(id) {
  const s = S.session;
  if (!s || !['ready', 'launching'].includes(s.state)) return { stage: null, draft: null };
  return { stage: (s.plan || []).find((p) => p.id === id) || null, draft: s.draft && s.draft.id === id ? s.draft : null };
}

export function gpuOf(tel) {
  const gs = (tel?.gpus || []).filter((g) => !g.integrated);
  return gs.length ? gs : (tel?.gpus || []);
}

export function roleText(n) {
  const { stage, draft } = stageOf(n.id);
  const parts = [];
  if (stage) parts.push(stage.layers ? `layers ${stage.layers[0]}–${stage.layers[1]}` : 'stage');
  if (draft) parts.push('draft model');
  const dev = stage?.device || draft?.device;
  if (dev) parts.push(dev);
  if (parts.length) return parts.join(' · ');
  if (!n.online) return 'offline';
  if (n.role === 'coordinator') return 'coordinator';
  if (n.role === 'worker') return 'worker for ' + (n.info?.serving_for || '?');
  return 'idle';
}

export function topoModel() {
  const nodes = allNodes();
  const sess = S.session;
  const live = sess && ['ready', 'launching'].includes(sess.state);
  const selfWorker = S.self?.worker;
  const model = { nodes: [], edges: [] };
  for (const n of nodes) {
    const t = n.tel;
    const gpus = gpuOf(t);
    const { stage, draft } = stageOf(n.id);
    let sub = n.self ? (live ? 'coordinator' : n.role === 'worker' ? 'worker' : 'this node') : (n.online ? (n.role || 'idle') : 'offline');
    if (n.self && n.role === 'worker') sub = `worker → ${n.info?.serving_for || ''}`;
    model.nodes.push({
      id: n.id, name: n.name, self: n.self, online: n.online, color: nodeColor(n.id),
      cpu: t?.cpu?.util ?? 0, gpu: gpus.length ? Math.max(...gpus.map((g) => g.util || 0)) : 0,
      sub, sub2: stage || draft ? roleText(n) : (t ? `CPU ${fmtPct100(t.cpu?.util)} · GPU ${fmtPct100(gpus[0]?.util)}` : ''),
      active: !!(stage || draft || (n.self && live) || n.role === 'worker'),
    });
  }
  for (const n of nodes.slice(1)) {
    const { stage, draft } = stageOf(n.id);
    let up = 0, down = 0, phase = null, delay = null;
    let active = false;
    if (live && ((stage && !stage.direct) || (draft && !draft.direct)) && n.gate) {
      up = n.gate.rate_c2s; down = n.gate.rate_s2c; phase = n.gate.phase; delay = n.gate.delay_ms; active = true;
    } else if (selfWorker && selfWorker.coordinator_id === n.id && S.gates[S.self.id]) {
      const g = S.gates[S.self.id];
      up = g.rate_s2c; down = g.rate_c2s; phase = g.phase; delay = g.delay_ms; active = true;
    }
    model.edges.push({ b: n.id, active, up, down, phase, delay, rtt: n.peer?.rtt_best_ms ?? null, online: n.online });
  }
  return model;
}

// ------------------------------------------------------------------ node card
export function nodeCard(n) {
  const body = h('div.node-metrics');
  const sparkCpu = h('canvas', { style: { width: '100%', height: '38px', display: 'block' } });
  const head = h('div.card-h',
    h('span.badge-n', { style: { background: nodeColor(n.id) } }),
    h('h3.ellipsis', n.name), n.self ? h('span.pill.accent', 'this node') : null,
    h('div.actions', h('span.pill', { class: n.online ? 'ok' : 'err' }, n.online ? roleText(n) : 'offline')));
  const card = h('div.card.node-card', head, h('div.card-b', body, h('div', { style: { marginTop: '10px' } }, sparkCpu)));
  card._update = () => updateNodeCard(n.id, body, sparkCpu, head);
  card._update();
  return card;
}

function updateNodeCard(id, body, spark, head) {
  const n = allNodes().find((x) => x.id === id);
  if (!n) return;
  const pill = head.querySelector('.actions .pill');
  if (pill) { pill.textContent = n.online ? roleText(n) : 'offline'; pill.className = 'pill ' + (n.online ? (n.role === 'idle' && !stageOf(id).stage ? '' : 'ok') : 'err'); }
  const t = n.tel;
  const rows = [];
  if (!t) {
    rows.push(h('div.muted.small', n.online ? 'Waiting for telemetry…' : 'Node is offline'));
  } else {
    const cpu = t.cpu || {};
    const ghz = cpu.eff_mhz ? (cpu.eff_mhz / 1000).toFixed(2) + ' GHz' : '';
    const throttled = cpu.perf_pct != null && cpu.util > 40 && cpu.perf_pct < 60;
    rows.push(meter('CPU', (cpu.util || 0) / 100, fmtPct100(cpu.util), levelCls((cpu.util || 0) / 100)));
    const mem = t.mem || {};
    rows.push(meter('RAM', mem.used / mem.total, `${fmtBytes(mem.used, 1)}`, levelCls(mem.used / mem.total)));
    for (const g of gpuOf(t).slice(0, 2)) {
      rows.push(meter(shortGpu(g.name).slice(0, 10) || 'GPU', (g.util || 0) / 100, fmtPct100(g.util), '', g.mem_total ? g.mem_used / g.mem_total : null));
    }
    const lat = t.lattice || {};
    const info = [];
    info.push(['Clock', ghz ? `${ghz}${cpu.perf_pct != null ? ` (${Math.round(cpu.perf_pct)}% of base)` : ''}` : '–']);
    const g0 = gpuOf(t)[0];
    if (g0) {
      const extra = [g0.mem_total ? `${fmtBytes(g0.mem_used)} / ${fmtBytes(g0.mem_total, 0)}` : null,
        g0.temp_c != null ? `${g0.temp_c}°C` : null, g0.power_w != null ? `${g0.power_w.toFixed(1)} W` : null].filter(Boolean).join(' · ');
      info.push(['GPU mem', extra || '–']);
    }
    info.push(['Lattice', `CPU ${fmtPct100(lat.cpu, 1)} · ${fmtBytes(lat.rss)} · GPU ${fmtPct100(lat.gpu)}`]);
    if (t.battery) info.push(['Power', `${t.battery.plugged ? 'plugged in' : 'on battery'} · ${Math.round(t.battery.pct)}%`]);
    const g = n.self ? S.gates[n.id] : n.gate;
    if (g && (g.connections || g.rate_c2s > 0 || g.rate_s2c > 0)) {
      info.push(['RPC gate', `↓${fmtRate(g.rate_c2s)} ↑${fmtRate(g.rate_s2c)} · ${g.phase}${g.lat_p50 != null ? ' · p50 ' + fmtMs(g.lat_p50) : ''}`]);
    }
    if (!n.self && n.peer) {
      info.push(['Link', `${n.host}:${n.port} · rtt ${fmtMs(n.peer.rtt_best_ms)} · clock ${n.peer.offset_ms != null ? (n.peer.offset_ms >= 0 ? '+' : '') + n.peer.offset_ms.toFixed(1) + ' ms ± ' + fmtNum(n.peer.offset_err_ms, 1) : '–'}`]);
    }
    rows.push(h('div.kv', { style: { marginTop: '6px' } }, info.flatMap(([k, v]) => [h('span', k), h('span', v)])));
    if (throttled) rows.push(h('div.callout.warn', icon('thermo'), h('div', `CPU running at ${Math.round(cpu.perf_pct)}% of base clock under load: likely thermal or power throttling.`)));
  }
  body.replaceChildren(...rows);
  const hist = S.hist[id] || [];
  sparkline(spark, hist.slice(-90).map((x) => x.cpu?.util), { color: nodeColor(id), max: 100, min: 0 });
}

export function statTile(label, ic, opts = {}) {
  const value = h('div.value');
  const sub = h('div.sub');
  const canvas = opts.spark ? h('canvas.spark') : null;
  const el = h('div.card.stat', h('div.label', icon(ic), label), value, sub, canvas);
  el.set = (v, s, series, color, max) => {
    if (v instanceof Node) value.replaceChildren(v); else value.textContent = v;
    sub.textContent = s || '';
    if (canvas && series) sparkline(canvas, series, { color: color || 'var(--accent)', max, min: 0 });
  };
  return el;
}
