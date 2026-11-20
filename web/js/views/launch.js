import { S, act, allNodes, api, copyText, fmtBytes, fmtDur, fmtMs, fmtNum, h, icon, nodeColor, nodeName, on, toast } from '../lib.js';
import { empty } from './common.js';

const KEY = 'lattice-launch-v1';
const OVERHEAD = 320 * 1048576;
const STRATS = [
  { id: 'single', icon: 'laptop', t: 'Single node', d: 'Baseline: the whole model on one device. Use it to measure what distribution buys you.' },
  { id: 'pooled', icon: 'layers', t: 'Pooled', d: 'Split layers across laptops (pipeline parallel). Runs models no single laptop can hold.' },
  { id: 'spec', icon: 'sparkles', t: 'Speculative', d: 'A small draft model on one laptop proposes tokens; the target verifies them in one batch.' },
  { id: 'pooledspec', icon: 'network', t: 'Pooled + speculative', d: 'Split the target across laptops and add a draft model anywhere in the cluster.' },
];

function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
function save(st) { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* ignore */ } }

function devicesOf(n) {
  if (n.self) return S.self.devices || [];
  return n.info?.devices || [];
}
function defaultDevice(n) {
  const info = n.self ? S.self : n.info;
  return info?.default_device || (devicesOf(n).find((d) => d.kind === 'gpu' && d.total_mb >= 3000)?.name) || 'CPU';
}
function capacityOf(n, dev) {
  const d = devicesOf(n).find((x) => x.name === dev);
  if (d && d.kind !== 'cpu') return d.free_mb * 1048576;
  return n.tel?.mem?.avail || (d ? d.free_mb * 1048576 : n.info?.hw?.ram * 0.5) || 0;
}
export function layerAssignment(nLayers, weights) {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  const cum = weights.map((w) => (acc += w / total));
  const ranges = weights.map(() => [-1, -1]);
  for (let il = 0; il < nLayers; il++) {
    const x = il / (nLayers + 1);
    let dev = cum.findIndex((c) => c > x);
    if (dev < 0) dev = weights.length - 1;
    if (ranges[dev][0] < 0) ranges[dev][0] = il;
    ranges[dev][1] = il;
  }
  return ranges;
}

export default {
  title: 'Launch',
  subtitle: 'Design the distributed inference topology and bring it up',
  mount(root) {
    const st = Object.assign({ strategy: 'pooled', policy: 'memory', nodes: [], draftMax: 8, draftMin: 0, pMin: 0, ctx: 4096, threads: 0, selfViaRpc: false, ngram: false, latency: {} }, load());
    const left = h('div.col', { style: { gap: '20px' } });
    const right = h('div.col', { style: { gap: '20px' } });
    root.append(h('div.split', left, right));

    // ------------------------------------------------------------ state sync
    function syncNodes() {
      const nodes = allNodes().filter((n) => n.online);
      const known = new Map(st.nodes.map((x) => [x.id, x]));
      const next = [];
      for (const x of st.nodes) if (nodes.find((n) => n.id === x.id)) next.push(x);
      for (const n of nodes) if (!known.has(n.id)) {
        const entry = { id: n.id, include: true, device: defaultDevice(n), weight: 50 };
        if (n.self) next.push(entry); else next.splice(Math.max(0, next.findIndex((x) => x.id === S.self.id)), 0, entry);
      }
      if (!next.find((x) => x.id === S.self.id)) next.push({ id: S.self.id, include: true, device: defaultDevice(allNodes()[0]), weight: 50 });
      for (const x of next) {
        const n = nodes.find((m) => m.id === x.id);
        const devs = n ? devicesOf(n) : [];
        if (devs.length && !devs.find((d) => d.name === x.device)) x.device = defaultDevice(n);
      }
      st.nodes = next;
      const ms = S.models.filter((m) => !m.error);
      if (!ms.find((m) => m.file === st.target)) st.target = [...ms].sort((a, b) => b.size - a.size)[0]?.file;
      const tgt = ms.find((m) => m.file === st.target);
      const drafts = ms.filter((m) => tgt && m.file !== tgt.file && m.vocab_sig === tgt.vocab_sig && m.tokenizer === tgt.tokenizer && m.size < tgt.size);
      if (!drafts.find((m) => m.file === st.draft)) st.draft = [...drafts].sort((a, b) => a.size - b.size)[0]?.file || null;
      if (!nodes.find((n) => n.id === st.single)) st.single = S.self.id;
      if (!nodes.find((n) => n.id === st.draftNode)) st.draftNode = nodes.find((n) => !n.self)?.id || S.self.id;
      const dn = nodes.find((n) => n.id === st.draftNode);
      if (dn && devicesOf(dn).length && !devicesOf(dn).find((d) => d.name === st.draftDevice)) st.draftDevice = defaultDevice(dn);
      if (dn && !st.draftDevice) st.draftDevice = defaultDevice(dn);
      const sn = nodes.find((n) => n.id === st.single);
      if (sn && (!st.singleDevice || (devicesOf(sn).length && !devicesOf(sn).find((d) => d.name === st.singleDevice)))) st.singleDevice = defaultDevice(sn);
      return { nodes, ms, tgt, drafts };
    }

    const pooled = () => st.strategy === 'pooled' || st.strategy === 'pooledspec';
    const spec = () => st.strategy === 'spec' || st.strategy === 'pooledspec';

    function weightsFor(rows, nodes) {
      return rows.map((x) => {
        const n = nodes.find((m) => m.id === x.id);
        if (st.policy === 'equal') return 1;
        if (st.policy === 'manual') return Math.max(1, x.weight);
        return Math.max(1, capacityOf(n, x.device) / 1048576);
      });
    }

    function buildConfig() {
      const { nodes } = syncNodes();
      let stages;
      if (pooled()) {
        const rows = st.nodes.filter((x) => x.include);
        const w = weightsFor(rows, nodes);
        stages = rows.map((x, i) => ({ id: x.id, device: x.device, weight: +w[i].toFixed(3) }));
      } else stages = [{ id: st.single, device: st.singleDevice, weight: 1 }];
      const involved = new Set(stages.map((s) => s.id));
      if (spec() && st.draft) involved.add(st.draftNode);
      const latency = {};
      for (const [k, v] of Object.entries(st.latency || {})) if (involved.has(k) && k !== S.self.id && v) latency[k] = v;
      return {
        target: st.target, nodes: stages, ctx: st.ctx, threads: st.threads, self_via_rpc: st.selfViaRpc,
        draft: spec() ? st.draft : null, draft_node: spec() ? st.draftNode : null, draft_device: spec() ? st.draftDevice : null,
        draft_max: st.draftMax, draft_min: st.draftMin, draft_p_min: st.pMin,
        spec_type: !spec() && st.ngram ? 'ngram-mod' : 'none', latency_ms: latency,
      };
    }

    // ------------------------------------------------------------ left: configuration
    function deviceSelect(n, value, onchange) {
      const devs = devicesOf(n);
      if (!devs.length) return h('select.input.sm', { disabled: true }, h('option', 'auto (runtime installs on launch)'));
      return h('select.input.sm', { onchange: (e) => onchange(e.target.value) },
        devs.map((d) => h('option', { value: d.name, selected: d.name === value },
          `${d.name}: ${d.kind === 'cpu' ? 'CPU' : d.desc.replace(/\(R\)|\(TM\)|NVIDIA GeForce /g, '').trim()} (${fmtBytes(d.total_mb * 1048576, 0)})`)));
    }

    function renderLeft() {
      const { nodes, ms, tgt, drafts } = syncNodes();
      save(st);
      const parts = [];
      // strategy
      parts.push(h('div.card', h('div.card-h', h('h3', 'Strategy')),
        h('div.card-b', h('div.options', STRATS.map((s) => h('button.opt', { class: st.strategy === s.id ? 'on' : '', onclick: () => { st.strategy = s.id; renderAll(); } },
          h('div.t', icon(s.icon), s.t), h('div.d', s.d)))))));
      // model
      parts.push(h('div.card', h('div.card-h', h('h3', 'Model'), h('div.actions', h('a.btn.sm.ghost', { href: '#/models' }, icon('download'), 'Get models'))),
        h('div.card-b.col', !ms.length ? empty('box', 'No models on this laptop', 'The coordinator needs the GGUF file; workers receive weights over RPC.', h('a.btn.primary', { href: '#/models' }, 'Open catalog')) :
          h('div.grid.cols-2', { style: { gap: '14px' } },
            h('div.field', h('label', 'Target model'), h('select.input', { onchange: (e) => { st.target = e.target.value; renderAll(); } },
              ms.map((m) => h('option', { value: m.file, selected: m.file === st.target }, `${m.title || m.name} · ${m.quant} · ${fmtBytes(m.size, 1)}`)))),
            h('div.field', h('label', 'Context length'), h('select.input', { onchange: (e) => { st.ctx = +e.target.value; renderAll(); } },
              [1024, 2048, 4096, 8192, 16384, 32768].map((c) => h('option', { value: c, selected: c === st.ctx }, `${c.toLocaleString()} tokens`))))),
          tgt ? h('div.small.muted', `${tgt.arch} · ${tgt.n_layers} layers · hidden ${tgt.n_embd} · vocab ${fmtNum(tgt.vocab_size, 0)} · KV ${fmtBytes(tgt.kv_bytes_per_token_layer * tgt.n_layers)}/token`) : null)));
      // placement
      if (pooled()) {
        const rows = st.nodes;
        const incl = rows.filter((x) => x.include);
        const w = weightsFor(incl, nodes);
        const tot = w.reduce((a, b) => a + b, 0) || 1;
        parts.push(h('div.card', h('div.card-h', h('h3', 'Pipeline stages'), h('span.hint', 'order = layer order'),
          h('div.actions', h('div.seg', ['memory', 'equal', 'manual'].map((p) => h('button', { class: st.policy === p ? 'on' : '', onclick: () => { st.policy = p; renderAll(); } },
            p === 'memory' ? 'By free memory' : p === 'equal' ? 'Equal' : 'Manual'))))),
        h('div.card-b.col', { style: { gap: '10px' } }, rows.map((x, i) => {
          const n = nodes.find((m) => m.id === x.id);
          if (!n) return null;
          const share = x.include ? w[incl.indexOf(x)] / tot : 0;
          return h('div.dev', { style: { padding: '10px 12px', gap: '8px', opacity: x.include ? 1 : 0.55 } },
            h('div.row',
              h('input', { type: 'checkbox', checked: x.include, onchange: (e) => { x.include = e.target.checked; renderAll(); } }),
              h('span.dot', { style: { background: nodeColor(n.id) } }),
              h('div.strong.ellipsis', { style: { flex: 1 } }, n.name, n.self ? h('span.muted', ' (this laptop)') : null),
              h('span.num.strong', { style: { minWidth: '44px', textAlign: 'right' } }, x.include ? Math.round(share * 100) + '%' : '–'),
              h('button.btn.sm.ghost.icon', { title: 'Move earlier', disabled: i === 0, onclick: () => { rows.splice(i - 1, 0, rows.splice(i, 1)[0]); renderAll(); } }, icon('arrowUp')),
              h('button.btn.sm.ghost.icon', { title: 'Move later', disabled: i === rows.length - 1, onclick: () => { rows.splice(i + 1, 0, rows.splice(i, 1)[0]); renderAll(); } }, icon('arrowDown'))),
            h('div.row', { style: { gap: '10px' } }, h('div', { style: { flex: 1, minWidth: 0 } }, deviceSelect(n, x.device, (v) => { x.device = v; renderAll(); })),
              st.policy === 'manual' ? h('input', { type: 'range', min: 1, max: 100, value: x.weight, style: { flex: 1 },
                oninput: (e) => { x.weight = +e.target.value; renderRight(); }, onchange: () => renderAll() }) : null));
        }), incl.length < 2 ? h('div.callout.warn', icon('info'), h('div', 'Select at least two laptops to pool. With one, this is the same as Single node.')) : null)));
      } else {
        parts.push(h('div.card', h('div.card-h', h('h3', spec() ? 'Target placement' : 'Placement')),
          h('div.card-b.grid.cols-2', { style: { gap: '14px' } },
            h('div.field', h('label', 'Laptop'), h('select.input', { onchange: (e) => { st.single = e.target.value; st.singleDevice = null; renderAll(); } },
              nodes.map((n) => h('option', { value: n.id, selected: n.id === st.single }, n.name + (n.self ? ' (this laptop)' : ''))))),
            h('div.field', h('label', 'Device'), deviceSelect(nodes.find((n) => n.id === st.single) || nodes[0], st.singleDevice, (v) => { st.singleDevice = v; renderAll(); })))));
      }
      // speculative
      if (spec()) {
        const dnode = nodes.find((n) => n.id === st.draftNode) || nodes[0];
        parts.push(h('div.card', h('div.card-h', h('h3', 'Speculative decoding'), h('span.hint', 'greedy draft, target verifies a batch per step')),
          h('div.card-b.col', { style: { gap: '14px' } },
            !drafts.length ? h('div.callout.warn', icon('alert'), h('div', 'No compatible draft model on this laptop. Download a smaller model from the same family (e.g. Qwen2.5 0.5B for a Qwen2.5 target).')) :
              h('div.grid.cols-2', { style: { gap: '14px' } },
                h('div.field', h('label', 'Draft model'), h('select.input', { onchange: (e) => { st.draft = e.target.value; renderAll(); } },
                  drafts.map((m) => h('option', { value: m.file, selected: m.file === st.draft }, `${m.title || m.name} · ${fmtBytes(m.size, 1)}`)))),
                h('div.field', h('label', 'Draft runs on'), h('select.input', { onchange: (e) => { st.draftNode = e.target.value; st.draftDevice = null; renderAll(); } },
                  nodes.map((n) => h('option', { value: n.id, selected: n.id === st.draftNode }, n.name + (n.self ? ' (this laptop)' : ''))))),
                h('div.field', h('label', 'Draft device'), deviceSelect(dnode, st.draftDevice, (v) => { st.draftDevice = v; renderAll(); })),
                h('div.field', h('label', `Draft length (tokens per step): ${st.draftMax}`), h('input', { type: 'range', min: 1, max: 24, value: st.draftMax,
                  oninput: (e) => { st.draftMax = +e.target.value; e.target.previousSibling.textContent = `Draft length (tokens per step): ${st.draftMax}`; }, onchange: () => renderAll() })),
                h('div.field', h('label', 'Min draft tokens'), h('input.input', { type: 'number', min: 0, max: 16, value: st.draftMin, onchange: (e) => { st.draftMin = Math.max(0, +e.target.value || 0); renderAll(); } })),
                h('div.field', h('label', 'Min draft probability (p-min)'), h('input.input', { type: 'number', min: 0, max: 1, step: 0.05, value: st.pMin, onchange: (e) => { st.pMin = Math.min(1, Math.max(0, +e.target.value || 0)); renderAll(); } }))),
            dnode && !dnode.self ? h('div.callout', icon('info'), h('div', `Every draft token is a network round trip to ${dnode.name}. Watch how the acceptance rate and RTT trade off in Experiments.`)) : null)));
      }
      // advanced
      const remote = nodes.filter((n) => !n.self);
      parts.push(h('div.card', h('div.card-h', h('h3', 'Advanced & network emulation')),
        h('div.card-b.col', { style: { gap: '14px' } },
          h('div.grid.cols-2', { style: { gap: '14px' } },
            h('div.field', h('label', 'CPU threads (0 = auto)'), h('input.input', { type: 'number', min: 0, max: 128, value: st.threads, onchange: (e) => { st.threads = Math.max(0, +e.target.value || 0); save(st); } })),
            h('div.field', h('label', 'Options'),
              h('label.check', h('input', { type: 'checkbox', checked: st.selfViaRpc, onchange: (e) => { st.selfViaRpc = e.target.checked; renderAll(); } }), 'Route this laptop through RPC too (measures RPC overhead)'),
              !spec() ? h('label.check', h('input', { type: 'checkbox', checked: st.ngram, onchange: (e) => { st.ngram = e.target.checked; renderAll(); } }), 'N-gram self-speculation (no draft model)') : null)),
          remote.length ? h('div.col', { style: { gap: '8px' } }, h('div.label-sm', 'Injected one-way delay per link (applied by the worker’s gate, adjustable live)'),
            remote.map((n) => h('div.row', h('span.dot', { style: { background: nodeColor(n.id) } }), h('span', { style: { width: '140px' } }, n.name),
              h('input', { type: 'range', min: 0, max: 100, step: 1, value: st.latency[n.id] || 0, style: { flex: 1 },
                oninput: (e) => { st.latency[n.id] = +e.target.value; e.target.nextSibling.textContent = `+${st.latency[n.id]} ms RTT`; },
                onchange: () => { save(st); if (S.session?.state === 'ready') api('/api/session/latency', { body: { id: n.id, ms: st.latency[n.id] } }).catch((er) => toast(er.message, 'error')); } }),
              h('span.num.small', { style: { width: '90px', textAlign: 'right' } }, `+${st.latency[n.id] || 0} ms RTT`)))) : null)));
      left.replaceChildren(...parts);
    }

    // ------------------------------------------------------------ right: plan / progress / live
    function planPreview() {
      const { nodes, tgt } = syncNodes();
      const cfg = buildConfig();
      if (!tgt) return h('div.card', empty('box', 'Pick a target model', 'Download one on the Models page.'));
      const weights = cfg.nodes.map((s) => s.weight);
      const ranges = layerAssignment(tgt.n_layers, weights);
      const kvTok = (tgt.kv_bytes_per_token_layer || 0) * cfg.ctx;
      const stages = cfg.nodes.map((s, i) => {
        const n = nodes.find((m) => m.id === s.id);
        const [a, b] = ranges[i];
        const nl = a >= 0 ? b - a + 1 : 0;
        let wbytes = nl ? tgt.layer_bytes.slice(a, b + 1).reduce((x, y) => x + y, 0) : 0;
        if (i === cfg.nodes.length - 1) wbytes += tgt.output_bytes || 0;
        const draftHere = cfg.draft && cfg.draft_node === s.id;
        const dm = draftHere ? S.models.find((m) => m.file === cfg.draft) : null;
        const need = wbytes + kvTok * nl + (nl ? OVERHEAD : 0) + (dm ? dm.size + OVERHEAD : 0);
        const cap = n ? capacityOf(n, s.device) : 0;
        return { s, n, a, b, nl, wbytes, kv: kvTok * nl, need, cap, dm };
      });
      const actBytes = (tgt.n_embd || 0) * 4;
      const logitBytes = (tgt.vocab_size || 0) * 4;
      const lastRemote = cfg.nodes[cfg.nodes.length - 1]?.id !== S.self.id;
      const pipe = h('div.pipe');
      pipe.append(h('div.stage', { style: { minWidth: '130px', borderStyle: 'dashed' } }, h('div.hd', icon('laptop'), 'Coordinator'),
        h('div.tiny.muted', S.self.name), h('div.tiny.muted', 'tokenizer · embeddings · sampling')));
      stages.forEach((x, i) => {
        const remote = x.s.id !== S.self.id || cfg.self_via_rpc;
        pipe.append(h('div.link-arrow', h('span', i === 0 ? 'embeddings' : 'activations'), h('div.ln'),
          h('span', remote || (i > 0 && stages[i - 1].s.id !== S.self.id) ? `${fmtBytes(actBytes)}/tok` : 'local')));
        const over = x.cap && x.need > x.cap;
        pipe.append(h('div.stage', { style: { borderColor: over ? 'var(--err)' : '' } },
          h('div.hd', h('span.sw', { style: { background: nodeColor(x.s.id) } }), h('span.ellipsis', x.n?.name || x.s.id)),
          h('div.tiny.muted', `${x.s.device || 'auto'}${remote ? ' · via RPC' : ' · direct'}`),
          h('div.small', x.nl ? `layers ${x.a}–${x.b} (${x.nl})` : 'no layers'),
          h('div.bar' + (over ? '.err' : ''), h('i', { style: { width: Math.min(100, (x.need / (x.cap || x.need || 1)) * 100) + '%' } })),
          h('div.tiny.muted', `${fmtBytes(x.need, 1)} of ${x.cap ? fmtBytes(x.cap, 1) : '?'} free`),
          x.dm ? h('span.pill.accent', icon('sparkles'), 'draft here') : null));
      });
      pipe.append(h('div.link-arrow' + (lastRemote ? '.hot' : ''), h('span', 'logits'), h('div.ln'), h('span', lastRemote ? `${fmtBytes(logitBytes)}/tok` : 'local')));
      pipe.append(h('div.stage', { style: { minWidth: '110px', borderStyle: 'dashed' } }, h('div.hd', icon('zap'), 'Sample'), h('div.tiny.muted', 'next token')));
      const map = h('div.layermap', Array.from({ length: tgt.n_layers }, (_, il) => {
        const si = ranges.findIndex(([a, b]) => il >= a && il <= b);
        return h('i', { title: `layer ${il} → ${stages[si]?.n?.name || '?'}`, style: { background: si >= 0 ? nodeColor(stages[si].s.id) : 'var(--surface-3)' } });
      }));
      const warnings = [];
      if (stages.some((x) => x.cap && x.need > x.cap)) warnings.push(h('div.callout.err', icon('alert'), h('div', 'A stage needs more memory than its device has free. Shift weight to other laptops, lower the context, or pick a smaller quantisation.')));
      if (lastRemote && cfg.nodes.length > 0) warnings.push(h('div.callout.warn', icon('info'), h('div', h('b', 'Network tip: '), `the last stage computes the output head, so ${fmtBytes(logitBytes)} of logits per token travel back to this laptop. Put this laptop last in the order to keep that traffic local; only ${fmtBytes(actBytes)} of activations will cross the network per hop.`)));
      if (cfg.draft && cfg.draft_node !== S.self.id) warnings.push(h('div.callout', icon('network'), h('div', `Remote draft: ${cfg.draft_max} sequential draft steps on ${nodeName(cfg.draft_node)} per verification. Each step returns ${fmtBytes(logitBytes)} of draft logits, so RTT and bandwidth both matter.`)));
      const ready = S.session?.state === 'ready';
      const launching = S.session?.state === 'launching';
      const canLaunch = !launching && cfg.target && cfg.nodes.length && (!spec() || cfg.draft) && (!pooled() || cfg.nodes.length >= 1);
      return h('div.card.glow',
        h('div.card-h', h('h3', 'Execution plan'), h('span.hint', `${cfg.nodes.length} stage${cfg.nodes.length > 1 ? 's' : ''}${cfg.draft ? ' + draft' : ''} · ${tgt.n_layers} layers`)),
        h('div.card-b.col', { style: { gap: '14px' } }, pipe, h('div', h('div.label-sm', { style: { marginBottom: '6px' } }, 'Layer map'), map), ...warnings,
          h('div.row', h('button.btn.lg.primary', { style: { flex: 1 }, disabled: !canLaunch, onclick: launch },
            icon(ready ? 'refresh' : 'rocket'), ready ? 'Relaunch with this plan' : 'Launch cluster'),
            h('button.btn.lg', { title: 'Copy config as JSON', onclick: () => copyText(JSON.stringify(cfg, null, 2)) }, icon('copy')))));
    }

    async function launch() {
      const cfg = buildConfig();
      if (S.session?.state === 'ready') await api('/api/session/stop', { body: {} }).catch(() => {});
      act(() => api('/api/session/launch', { body: cfg }));
    }

    function progressCard() {
      const s = S.session;
      if (!s || s.state === 'idle') return null;
      const steps = s.steps || [];
      const items = steps.map((x) => {
        const subs = Object.entries(x.nodes || {}).map(([nid, v]) => h('div.tiny', { style: { color: v.status === 'done' ? 'var(--ok)' : 'var(--muted)' } }, `${nodeName(nid)}: ${v.detail}`));
        let extra = null;
        if (x.key === 'load' && x.status === 'running') {
          extra = h('div.col', { style: { gap: '6px', marginTop: '6px' } }, (s.plan || []).filter((p) => !p.direct).concat(s.draft && !s.draft.direct ? [{ ...s.draft, est_weights: s.draft.est_weights, isDraft: true }] : [])
            .map((p) => {
              const got = s.progress?.[p.id] || 0;
              const exp = (s.plan || []).filter((q) => q.id === p.id && !q.direct).reduce((a, q) => a + q.est_weights, 0) + (s.draft && s.draft.id === p.id && !s.draft.direct ? s.draft.est_weights : 0);
              if (p.isDraft && (s.plan || []).some((q) => q.id === p.id && !q.direct)) return null;
              return h('div', h('div.tiny.muted', `${p.name}: ${fmtBytes(got)} / ~${fmtBytes(exp)} weights streamed`), h('div.bar.stripes', h('i', { style: { width: Math.min(100, (got / (exp || 1)) * 100) + '%' } })));
            }));
        }
        const el = x.t0 ? ((x.t1 || Date.now() / 1000) - x.t0) : null;
        return h('div.stepi', { class: x.status }, h('div.ic', x.status === 'done' ? icon('check') : x.status === 'error' ? icon('x') : null),
          h('div', h('div.t', x.label), x.detail ? h('div.d', x.detail) : null, subs, extra), h('div.el', el != null ? el.toFixed(1) + 's' : ''));
      });
      return h('div.card', h('div.card-h', h('h3', s.state === 'ready' ? 'Launch log' : s.state === 'error' ? 'Launch failed' : 'Bringing the cluster up'),
        h('div.actions', s.state === 'launching' || s.state === 'ready' ? h('button.btn.sm.danger', { onclick: () => act(() => api('/api/session/stop', { body: {} })) }, icon('stop'), 'Stop') : null)),
        h('div.card-b', h('div.steps', items), s.error ? h('div.callout.err', { style: { marginTop: '10px' } }, icon('alert'), h('div', s.error)) : null));
    }

    const openDetails = new Set();
    const det = (key, summary, ...kids) => h('details', { open: openDetails.has(key), ontoggle: (e) => (e.target.open ? openDetails.add(key) : openDetails.delete(key)) },
      h('summary.small.muted', { style: { cursor: 'pointer' } }, summary), ...kids);
    function liveCard() {
      const s = S.session;
      if (!s || s.state !== 'ready') return null;
      const up = s.ready_at ? Date.now() / 1000 - s.ready_at : 0;
      const alloc = Object.entries(s.alloc || {});
      const rows = (s.plan || []).map((p) => {
        const peer = S.peers.find((x) => x.id === p.id);
        const g = p.id === S.self.id ? S.gates[p.id] : peer?.gate;
        return h('tr', h('td', h('div.row', h('span.dot', { style: { background: nodeColor(p.id) } }), p.name)), h('td', p.device), h('td', p.layers ? `${p.layers[0]}–${p.layers[1]}` : '–'),
          h('td', p.direct ? h('span.pill', 'direct') : h('span.pill.accent', p.rpc_name)), h('td.r.num', g?.lat_p50 != null ? fmtMs(g.lat_p50) : '–'), h('td.r.num', g ? fmtBytes(g.bytes_c2s + g.bytes_s2c) : '–'));
      });
      return h('div.card.glow', h('div.card-h', h('span.dot.ok.pulse'), h('h3', 'Cluster serving'), h('span.hint', `up ${fmtDur(up)}`),
        h('div.actions', h('a.btn.sm.primary', { href: '#/playground' }, icon('chat'), 'Open playground'))),
        h('div.card-b.col', { style: { gap: '12px' } },
          h('div.kv', h('span', 'Model'), h('span', s.config.target + (s.config.draft ? `  ←  draft ${s.config.draft} on ${s.draft?.name} (${s.draft?.device})` : '')),
            h('span', 'OpenAI API'), h('span.row', h('code', s.api), h('button.btn.sm.ghost.icon', { onclick: () => copyText(s.api) }, icon('copy')))),
          h('table.table', h('thead', h('tr', ['Stage', 'Device', 'Layers', 'Link', 'RPC p50', 'Traffic'].map((x, i) => h('th', { class: i > 3 ? 'r' : '' }, x)))), h('tbody', rows)),
          alloc.length ? det('alloc', 'Measured allocations (from llama.cpp)',
            h('table.table', { style: { marginTop: '6px' } }, h('thead', h('tr', h('th', 'Buffer'), h('th.r', 'Weights'), h('th.r', 'KV cache'), h('th.r', 'Compute'))),
              h('tbody', alloc.map(([k, v]) => h('tr', h('td.mono.small', k), h('td.r.num', v.model ? fmtBytes(v.model * 1048576) : '–'),
                h('td.r.num', v.kv ? fmtBytes(v.kv * 1048576) : '–'), h('td.r.num', v.compute ? fmtBytes(v.compute * 1048576) : '–')))))) : null,
          det('cmd', 'llama-server command line',
            h('div.copy-box', { style: { marginTop: '6px', alignItems: 'flex-start' } }, h('span', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, (s.args || []).join(' ')),
              h('button.btn.sm', { onclick: () => copyText((s.args || []).join(' ')) }, icon('copy'))))));
    }

    let liveEl = null;
    function renderRight() {
      const s = S.session;
      const cards = [];
      liveEl = s && s.state === 'ready' ? liveCard() : null;
      if (liveEl) cards.push(liveEl);
      if (s && s.state === 'launching') cards.push(progressCard());
      cards.push(planPreview());
      if (s && (s.state === 'error' || s.state === 'ready')) cards.push(progressCard());
      right.replaceChildren(...cards.filter(Boolean));
    }
    function refreshLive() {
      if (!liveEl || S.session?.state !== 'ready' || !liveEl.isConnected) return;
      const n = liveCard();
      liveEl.replaceWith(n);
      liveEl = n;
    }

    function renderAll() { renderLeft(); renderRight(); }
    renderAll();
    let lastTel = 0;
    const offs = [
      on('session', renderRight),
      on('models', renderAll),
      on('peers', () => { const key = S.peers.map((p) => p.id + p.online + (p.info?.devices || []).length).join(); if (key !== right._pk) { right._pk = key; renderAll(); } }),
      on('self', () => { const k = (S.self.devices || []).length; if (k !== right._dk) { right._dk = k; renderAll(); } }),
      on('telemetry', () => { if (Date.now() - lastTel > 3000) { lastTel = Date.now(); refreshLive(); } }),
    ];
    return () => offs.forEach((f) => f());
  },
};
