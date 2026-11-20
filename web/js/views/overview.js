import { S, allNodes, fmtBytes, fmtMs, fmtNum, fmtPct, fmtRate, fmtTime, h, icon, nodeColor, on } from '../lib.js';
import { Topology } from '../topology.js';
import { empty, nodeCard, statTile, topoModel } from './common.js';

export default {
  title: 'Overview',
  subtitle: 'Live state of every laptop in your cluster',
  mount(root) {
    const tNodes = statTile('Nodes online', 'network');
    const tMem = statTile('Pooled memory', 'memory');
    const tTps = statTile('Decode throughput', 'zap', { spark: true });
    const tNet = statTile('RPC traffic now', 'activity', { spark: true });
    const netHist = [];

    const svg = h('svg.topo');
    const topo = new Topology(svg);
    const legend = h('div.legend', { style: { padding: '0 18px 14px' } },
      h('span', h('i', { style: { background: 'var(--up)' } }), 'coordinator → worker (weights, activations)'),
      h('span', h('i', { style: { background: 'var(--down)' } }), 'worker → coordinator (results)'),
      h('span', h('i', { style: { background: 'var(--accent)', borderRadius: '50%' } }), 'outer ring: CPU'),
      h('span', h('i', { style: { background: 'var(--accent-2)', borderRadius: '50%' } }), 'inner ring: GPU'));
    const topoCard = h('div.card', h('div.card-h', h('h3', 'Topology'), h('span.hint', 'particles are real RPC bytes measured by each node’s gate'),
      h('div.actions', h('a.btn.sm', { href: '#/devices' }, icon('radar'), 'Add devices'))), svg, legend);

    const feed = h('div.feed');
    const feedCard = h('div.card', h('div.card-h', h('h3', 'Wire activity'), h('span.hint', 'decoded ggml-rpc commands')), feed);

    const nodesGrid = h('div.grid.cols-auto');
    const runsBody = h('div');
    const runsCard = h('div.card', h('div.card-h', h('h3', 'Recent generations'), h('div.actions', h('a.btn.sm.ghost', { href: '#/runs' }, 'All runs'))), runsBody);

    root.append(
      h('div.grid.cols-4', tNodes, tMem, tTps, tNet),
      h('div.split', topoCard, feedCard),
      nodesGrid,
      runsCard,
    );

    let cards = new Map();
    function renderCards() {
      const nodes = allNodes();
      const key = nodes.map((n) => n.id).join('|');
      if (key !== nodesGrid._key) {
        nodesGrid._key = key;
        cards = new Map();
        nodesGrid.replaceChildren(...nodes.map((n) => { const c = nodeCard(n); cards.set(n.id, c); return c; }));
        if (nodes.length === 1) nodesGrid.append(h('div.card', empty('radar', 'Only this laptop so far', 'Start Lattice on another laptop on the same Wi-Fi and pair it from the Devices page.', h('a.btn.primary', { href: '#/devices' }, 'Find devices'))));
      } else for (const c of cards.values()) c._update();
    }

    function renderStats() {
      const nodes = allNodes();
      const online = nodes.filter((n) => n.online);
      tNodes.set(h('span', String(online.length), h('small', `/ ${nodes.length}`)), `${S.nearby.filter((n) => n.online && !n.paired).length} unpaired nearby`);
      let ram = 0, vram = 0;
      for (const n of online) {
        ram += n.tel?.mem?.total || n.info?.hw?.ram || 0;
        for (const g of n.info?.hw?.gpus || []) if (!g.integrated) vram += g.vram || 0;
      }
      tMem.set(fmtBytes(ram + vram, 1), `${fmtBytes(ram, 0)} RAM + ${fmtBytes(vram, 0)} VRAM`);
      const runs = S.runs.slice(-30);
      const last = runs[runs.length - 1];
      tTps.set(S.gen ? h('span', fmtNum(S.gen.tps, 1), h('small', 'tok/s live')) : last ? h('span', fmtNum(last.metrics.gen_tps, 1), h('small', 'tok/s')) : '–',
        last ? `last: ${last.config.mode} · ${last.metrics.gen_tokens} tokens` : 'run a prompt in the Playground',
        runs.map((r) => r.metrics.gen_tps), 'var(--accent)');
      let rate = 0;
      for (const n of nodes) {
        const g = n.self ? S.gates[n.id] : n.gate;
        if (g) rate += (g.rate_c2s || 0) + (g.rate_s2c || 0);
      }
      netHist.push(rate);
      if (netHist.length > 60) netHist.shift();
      tNet.set(fmtRate(rate), S.session?.state === 'ready' ? `${S.session.plan.filter((p) => !p.direct).length + (S.session.draft && !S.session.draft.direct ? 1 : 0)} RPC link(s)` : 'no active links', netHist, 'var(--down)');
    }

    const seen = new Set();
    function renderFeed() {
      const items = [];
      for (const n of allNodes()) {
        const g = n.self ? S.gates[n.id] : n.gate;
        for (const a of g?.activity || []) {
          const key = n.id + a.ts;
          items.push({ n, a, key });
        }
      }
      items.sort((x, y) => y.a.ts - x.a.ts);
      const rows = items.slice(0, 40).map(({ n, a, key }) => {
        const cmds = Object.entries(a.cmds || {}).sort((x, y) => y[1][1] - x[1][1]);
        const fresh = !seen.has(key);
        seen.add(key);
        return h('div.it', { style: fresh ? {} : { animation: 'none' } }, h('span.t', fmtTime(a.ts)),
          h('span.w', h('b', { style: { color: nodeColor(n.id) } }, n.name), ' ',
            h('span.tag.up', '→ ' + fmtBytes(a.c2s)), h('span.tag.down', '← ' + fmtBytes(a.s2c)),
            a.lat_ms != null ? h('span.tag', fmtMs(a.lat_ms)) : null, ' ',
            cmds.slice(0, 3).map(([k, v]) => h('span.tag', `${k} ×${v[0]}`))));
      });
      if (!rows.length) feed.replaceChildren(empty('activity', 'No RPC traffic', 'Traffic appears here when a cluster spans more than one laptop. Every message is decoded: SET_TENSOR uploads weights, GRAPH_COMPUTE runs layers, GET_TENSOR returns results.'));
      else feed.replaceChildren(...rows);
    }

    function renderRuns() {
      const runs = S.runs.slice(-6).reverse();
      if (!runs.length) { runsBody.replaceChildren(empty('chat', 'No generations yet', 'Launch a cluster, then try the Playground.')); return; }
      runsBody.replaceChildren(h('div.table-wrap', h('table.table',
        h('thead', h('tr', ['Time', 'Mode', 'Model', 'Tokens', 'tok/s', 'TTFT', 'Accept', 'Network'].map((x, i) => h('th', { class: i > 2 ? 'r' : '' }, x)))),
        h('tbody', runs.map((r) => h('tr', h('td.muted', fmtTime(r.ts)), h('td', h('span.pill.outline', r.config.mode)),
          h('td.ellipsis', { style: { maxWidth: '260px' } }, (r.config.target || '').replace('.gguf', '') + (r.config.draft ? ' ← ' + r.config.draft.replace('.gguf', '') : '')),
          h('td.r.num', r.metrics.gen_tokens), h('td.r.num.strong', fmtNum(r.metrics.gen_tps, 1)), h('td.r.num', fmtMs(r.metrics.ttft_ms)),
          h('td.r.num', fmtPct(r.metrics.accept_rate)), h('td.r.num', fmtBytes(r.metrics.net_bytes))))))));
    }

    function all() { topo.update(topoModel()); renderStats(); renderCards(); renderFeed(); }
    all();
    renderRuns();
    const offs = [on('telemetry', all), on('peers', all), on('session', all), on('self', all), on('nearby', renderStats),
      on('run', () => { renderRuns(); renderStats(); }), on('gen', renderStats)];
    return () => { offs.forEach((f) => f()); topo.destroy(); };
  },
};
