import { S, act, api, confirmDialog, fmtBytes, fmtMs, fmtNum, fmtPct, fmtTime, h, icon, modal, on } from '../lib.js';
import { lineChart } from '../charts.js';
import { empty } from './common.js';

export default {
  title: 'Runs',
  subtitle: 'Every generation is logged with full measurements (data/runs.jsonl)',
  mount(root) {
    const chart = h('canvas.chart.sm');
    const chartCard = h('div.card', h('div.card-h', h('h3', 'Decode throughput over time'), h('span.hint', 'colour = mode')), h('div.card-b', chart));
    const body = h('div');
    const filter = h('input.input.sm', { placeholder: 'Filter by mode, model or tag…', style: { width: '260px' }, oninput: () => render() });
    const card = h('div.card', h('div.card-h', h('h3', 'Run log'), h('div.actions', filter,
      h('a.btn.sm', { href: '/api/runs.csv' }, icon('download'), 'Export CSV'),
      h('button.btn.sm.ghost', { onclick: async () => {
        if (await confirmDialog('Clear run log?', 'All logged runs on this laptop will be deleted. Experiments are kept.', 'Clear', true)) act(() => api('/api/runs/clear', { body: {} }));
      } }, icon('trash'), 'Clear'))), body);
    root.append(chartCard, card);

    function detail(r) {
      const m = r.metrics || {};
      const rows = Object.entries(m).filter(([k, v]) => typeof v !== 'object' || v === null);
      modal({
        title: `Run ${r.id}`, wide: true,
        body: h('div.col', { style: { gap: '14px' } },
          h('div.kv', h('span', 'When'), h('span', new Date(r.ts).toLocaleString()), h('span', 'Mode'), h('span', r.config.mode),
            h('span', 'Target'), h('span', r.config.target), h('span', 'Draft'), h('span', r.config.draft ? `${r.config.draft} on ${r.config.draft_node} (${r.config.draft_device}), n_max ${r.config.draft_max}` : '–'),
            h('span', 'Stages'), h('span', (r.config.stages || []).map((s) => `${s.name}:${s.device}${s.layers ? ` [${s.layers[0]}–${s.layers[1]}]` : ''}`).join('  →  ')),
            h('span', 'Injected delay'), h('span', JSON.stringify(r.config.latency_ms || {})), h('span', 'Prompt'), h('span', r.prompt)),
          h('div.grid.cols-2', { style: { gap: '20px' } },
            h('div.kv.mono', { style: { fontSize: '12px' } }, rows.flatMap(([k, v]) => [h('span', k), h('span', typeof v === 'number' ? fmtNum(v, 3) : String(v))])),
            h('div.col', Object.values(m.nodes || {}).map((n) => h('div.dev', { style: { padding: '10px 12px' } }, h('div.strong', n.name),
              h('div.kv.small', h('span', 'sent → worker'), h('span', fmtBytes(n.bytes_c2s)), h('span', 'received ←'), h('span', fmtBytes(n.bytes_s2c)),
                h('span', 'RPC calls'), h('span', `${n.calls} (${n.waits} awaited)`), h('span', 'compute (est.)'), h('span', fmtMs(n.est_compute_ms)),
                h('span', 'network (est.)'), h('span', fmtMs(n.est_network_ms)), h('span', 'rtt / injected'), h('span', `${fmtMs(n.rtt_ms)} / ${n.delay_ms} ms`)))))),
          h('details', h('summary.small.muted', { style: { cursor: 'pointer' } }, 'Output'), h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: '12.5px' } }, r.output))),
      });
    }

    function render() {
      const q = filter.value.trim().toLowerCase();
      const runs = S.runs.slice().reverse().filter((r) => !q || JSON.stringify([r.config.mode, r.config.target, r.config.draft, r.tag]).toLowerCase().includes(q));
      if (!runs.length) body.replaceChildren(empty('activity', 'No runs logged', 'Generations from the Playground and Experiments appear here.'));
      else body.replaceChildren(h('div.table-wrap', { style: { maxHeight: 'calc(100vh - 470px)', minHeight: '320px' } }, h('table.table',
        h('thead', h('tr', ['Time', 'Tag', 'Mode', 'Model', 'Prompt', 'Tok', 'Decode', 'TTFT', 'Accept', 'Network', 'J/tok'].map((x, i) => h('th', { class: i >= 5 ? 'r' : '' }, x)))),
        h('tbody', runs.slice(0, 400).map((r) => h('tr.click', { onclick: () => detail(r) },
          h('td.muted.num', fmtTime(r.ts)), h('td', h('span.pill', { class: r.tag.startsWith('exp') ? 'info' : '' }, r.tag.split(':')[0])),
          h('td', h('span.pill.outline', r.config.mode)),
          h('td.ellipsis', { style: { maxWidth: '220px' } }, (r.config.target || '').replace('.gguf', '')),
          h('td.ellipsis.muted', { style: { maxWidth: '260px' } }, r.prompt),
          h('td.r.num', r.metrics.gen_tokens), h('td.r.num.strong', fmtNum(r.metrics.gen_tps, 1)), h('td.r.num', fmtMs(r.metrics.ttft_ms)),
          h('td.r.num', fmtPct(r.metrics.accept_rate)), h('td.r.num', fmtBytes(r.metrics.net_bytes)),
          h('td.r.num', r.metrics.joules_per_token != null ? fmtNum(r.metrics.joules_per_token, 3) : '–')))))));
      const modes = [...new Set(S.runs.map((r) => r.config.mode))];
      const pal = ['var(--n0)', 'var(--n1)', 'var(--n2)', 'var(--n3)', 'var(--n4)', 'var(--n5)'];
      const t0 = S.runs[0]?.ts || 0;
      const real = S.runs.filter((r) => !r.tag.startsWith('exp-warmup'));
      lineChart(chart, modes.map((m, i) => ({ name: m, color: pal[i % 6], points: real.filter((r) => r.config.mode === m && r.metrics.gen_tps).map((r) => [(r.ts - t0) / 60000, r.metrics.gen_tps]) })),
        { xLabel: 'minutes since first logged run', yLabel: 'tok/s', yFmt: (v) => fmtNum(v, 0), xFmt: (v) => fmtNum(v, 0), dots: true, lines: false });
    }
    render();
    let t = 0;
    const offs = [on('run', () => { if (!t) t = setTimeout(() => { t = 0; render(); }, 400); }), on('runs', render)];
    return () => { offs.forEach((f) => f()); if (t) clearTimeout(t); };
  },
};
