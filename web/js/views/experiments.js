import { S, act, api, confirmDialog, fmtAgo, fmtBytes, fmtMs, fmtNum, fmtPct, h, icon, on } from '../lib.js';
import { barChart, lineChart, stackedBars } from '../charts.js';
import { empty } from './common.js';

const PALETTE = ['var(--n0)', 'var(--n1)', 'var(--n2)', 'var(--n3)', 'var(--n4)', 'var(--n5)', 'var(--n6)', 'var(--n7)'];
const KEY = 'lattice-exp-v1';

function chipsInput(values, onChange, placeholder) {
  const wrap = h('div.chips');
  const input = h('input', { placeholder });
  function render() {
    wrap.replaceChildren(...values.map((v, i) => h('span.chip', String(v), h('button', { title: 'remove', onclick: () => { values.splice(i, 1); onChange(values); render(); } }, '×'))), input);
  }
  input.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ',' || e.key === ' ') && input.value.trim()) {
      e.preventDefault();
      for (const part of input.value.split(/[ ,]+/)) {
        const v = Number(part);
        if (part !== '' && !isNaN(v) && v >= 0 && !values.includes(v)) values.push(v);
      }
      values.sort((a, b) => a - b);
      input.value = '';
      onChange(values);
      render();
      input.focus();
    } else if (e.key === 'Backspace' && !input.value && values.length) { values.pop(); onChange(values); render(); input.focus(); }
  });
  render();
  return wrap;
}

export default {
  title: 'Experiments',
  subtitle: 'Reproducible sweeps over topology, draft length and network latency',
  mount(root) {
    const saved = (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } })();
    const spec = Object.assign({ name: 'Draft length × latency', prompts: ['code', 'json', 'explain', 'story'], custom: '', max_tokens: 128, repeats: 2, warmup: true,
      draft_max: [2, 4, 8, 12], latency_ms: [0, 10, 30], latency_target: 'all', include_single: true, include_no_draft: true }, saved);
    const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(spec)); } catch { /* ignore */ } };
    let prompts = {};
    let viewing = null;

    const builder = h('div.card');
    const listCard = h('div.card');
    const results = h('div.col', { style: { gap: '20px' } });
    root.append(h('div.split', builder, listCard), results);

    // ------------------------------------------------------------ builder
    function renderBuilder() {
      const sess = S.session;
      const ready = sess?.state === 'ready';
      const hasDraft = ready && !!sess.config.draft;
      const remote = ready ? (sess.plan || []).filter((p) => !p.direct).map((p) => ({ id: p.id, name: p.name }))
        .concat(sess.draft && !sess.draft.direct && !(sess.plan || []).some((p) => p.id === sess.draft.id && !p.direct) ? [{ id: sess.draft.id, name: sess.draft.name }] : []) : [];
      const running = S.experiment?.status === 'running';
      const nPrompts = spec.prompts.length + spec.custom.split('\n').filter((x) => x.trim()).length;
      let arms = 1 + (spec.include_single && ready && sess.plan.length + (sess.draft ? 1 : 0) > 1 ? 1 : 0) + (spec.include_no_draft && hasDraft ? 1 : 0);
      const dCount = hasDraft && spec.draft_max.length ? spec.draft_max.length : 1;
      const lCount = remote.length && spec.latency_ms.length ? spec.latency_ms.length : 1;
      arms = (hasDraft ? dCount : 1) * lCount + (spec.include_single && ready ? 1 : 0) + (spec.include_no_draft && hasDraft ? lCount : 0);
      const total = arms * nPrompts * spec.repeats;
      const promptBoxes = Object.entries(prompts).map(([k, v]) => h('label.check', { title: v.text },
        h('input', { type: 'checkbox', checked: spec.prompts.includes(k), onchange: (e) => {
          spec.prompts = e.target.checked ? [...spec.prompts, k] : spec.prompts.filter((x) => x !== k); persist(); renderBuilder();
        } }), v.label));
      builder.replaceChildren(
        h('div.card-h', h('h3', 'New experiment'), h('span.hint', ready ? `sweeps around: ${sess.config.target}${hasDraft ? ' + draft' : ''}` : 'launch a cluster first')),
        h('div.card-b.col', { style: { gap: '16px' } },
          !ready ? h('div.callout.warn', icon('info'), h('div', 'Experiments run against the live cluster and relaunch it with variations as needed. Launch a configuration first (ideally pooled + speculative with a remote draft).')) : null,
          h('div.grid.cols-2', { style: { gap: '14px' } },
            h('div.field', h('label', 'Name'), h('input.input', { value: spec.name, oninput: (e) => { spec.name = e.target.value; persist(); } })),
            h('div.grid.cols-2', { style: { gap: '10px' } },
              h('div.field', h('label', 'Max tokens / run'), h('input.input', { type: 'number', min: 16, max: 2048, value: spec.max_tokens, onchange: (e) => { spec.max_tokens = Math.max(16, +e.target.value || 128); persist(); renderBuilder(); } })),
              h('div.field', h('label', 'Repeats'), h('input.input', { type: 'number', min: 1, max: 20, value: spec.repeats, onchange: (e) => { spec.repeats = Math.min(20, Math.max(1, +e.target.value || 1)); persist(); renderBuilder(); } })))),
          h('div.field', h('label', 'Prompt suite (task type strongly affects draft acceptance)'), h('div.row.wrap', { style: { gap: '14px' } }, promptBoxes)),
          h('div.field', h('label', 'Custom prompts (one per line)'), h('textarea.input', { rows: 2, value: spec.custom, oninput: (e) => { spec.custom = e.target.value; persist(); }, onchange: () => renderBuilder() })),
          h('div.grid.cols-2', { style: { gap: '14px' } },
            h('div.field', h('label', hasDraft ? 'Sweep draft length (tokens)' : 'Draft length sweep (needs a draft model)'),
              hasDraft ? chipsInput(spec.draft_max, (v) => { spec.draft_max = v; persist(); renderBuilderCount(); }, 'add…') : h('div.chips', h('span.muted.small', 'not applicable'))),
            h('div.field', h('label', remote.length ? 'Sweep injected RTT (ms)' : 'Latency sweep (needs a remote stage)'),
              remote.length ? chipsInput(spec.latency_ms, (v) => { spec.latency_ms = v; persist(); renderBuilderCount(); }, 'add…') : h('div.chips', h('span.muted.small', 'not applicable')))),
          remote.length > 1 ? h('div.field', h('label', 'Apply latency to'), h('select.input', { onchange: (e) => { spec.latency_target = e.target.value; persist(); } },
            h('option', { value: 'all', selected: spec.latency_target === 'all' }, 'all remote links'), remote.map((r) => h('option', { value: r.id, selected: spec.latency_target === r.id }, r.name)))) : null,
          h('div.row.wrap', { style: { gap: '18px' } },
            h('label.check', h('input', { type: 'checkbox', checked: spec.include_single, onchange: (e) => { spec.include_single = e.target.checked; persist(); renderBuilder(); } }), 'Single-node baseline (this laptop)'),
            hasDraft ? h('label.check', h('input', { type: 'checkbox', checked: spec.include_no_draft, onchange: (e) => { spec.include_no_draft = e.target.checked; persist(); renderBuilder(); } }), 'No-draft baseline') : null,
            h('label.check', h('input', { type: 'checkbox', checked: spec.warmup, onchange: (e) => { spec.warmup = e.target.checked; persist(); } }), 'Warm-up run per arm')),
          h('div.row', h('div.small.muted.count', `≈ ${arms} arm(s) × ${nPrompts} prompt(s) × ${spec.repeats} = ${total} runs · greedy decoding, fixed seed`), h('div.spacer'),
            running ? h('button.btn.danger', { onclick: () => api('/api/experiments/cancel', { body: {} }) }, icon('stop'), 'Cancel running')
              : h('button.btn.primary.lg', { disabled: !ready || !nPrompts, onclick: start }, icon('play'), 'Run experiment'))));
      function renderBuilderCount() { renderBuilder(); }
    }

    async function start() {
      const body = { name: spec.name, prompts: spec.prompts, custom_prompts: spec.custom.split('\n'), max_tokens: spec.max_tokens, repeats: spec.repeats,
        warmup: spec.warmup, draft_max: spec.draft_max, latency_ms: spec.latency_ms, latency_target: spec.latency_target,
        include_single: spec.include_single, include_no_draft: spec.include_no_draft, seed: 42 };
      const r = await act(() => api('/api/experiments', { body }));
      if (r) { viewing = { id: r.id, live: true }; renderResults(); }
    }

    // ------------------------------------------------------------ history
    function renderList() {
      const xs = S.experiments || [];
      listCard.replaceChildren(h('div.card-h', h('h3', 'History'), h('span.hint', 'saved in data/experiments')),
        !xs.length ? empty('flask', 'No experiments yet', 'Results are saved as JSON and can be exported to CSV for your report.') :
          h('div.table-wrap', { style: { maxHeight: '480px' } }, h('table.table', h('tbody', xs.map((x) => h('tr.click', { onclick: () => openExp(x.id) },
            h('td', h('div.strong', x.name), h('div.tiny.muted', `${x.id} · ${fmtAgo(x.created * 1000)}`)),
            h('td', h('span.pill', { class: x.status === 'done' ? 'ok' : x.status === 'running' ? 'info' : x.status === 'error' ? 'err' : '' }, x.status)),
            h('td.r.num.small', `${x.progress?.done ?? 0}/${x.progress?.total ?? 0}`),
            h('td.r', h('button.btn.sm.ghost.icon', { title: 'Delete', onclick: async (e) => {
              e.stopPropagation();
              if (await confirmDialog('Delete experiment?', `${x.name} (${x.id}) will be removed.`, 'Delete', true)) {
                await act(() => api('/api/experiments/' + x.id, { method: 'DELETE' }));
                if (viewing?.id === x.id) { viewing = null; renderResults(); }
              }
            } }, icon('trash')))))))));
    }

    async function openExp(id) {
      try { viewing = await api('/api/experiments/' + id); renderResults(); } catch (e) { /* ignore */ }
    }

    // ------------------------------------------------------------ results
    let exp = null;
    async function renderResults() {
      if (!viewing) {
        const cur = S.experiment;
        if (cur && cur.status === 'running') viewing = { id: cur.id, live: true };
        else { results.replaceChildren(); return; }
      }
      if (viewing.live || !viewing.rows) {
        try { exp = await api('/api/experiments/' + viewing.id); } catch { return; }
      } else exp = viewing;
      draw();
    }

    function draw() {
      if (!exp) return;
      const sm = exp.summary || [];
      const running = exp.status === 'running';
      const prog = exp.progress || { done: 0, total: 0 };
      const head = h('div.card', h('div.card-h', h('h3', exp.name), h('span.pill', { class: exp.status === 'done' ? 'ok' : running ? 'info' : exp.status === 'error' ? 'err' : '' }, exp.status),
        h('span.hint', `${exp.id} · base: ${exp.base_config?.target}${exp.base_config?.draft ? ' + ' + exp.base_config.draft : ''}`),
        h('div.actions', h('a.btn.sm', { href: `/api/experiments/${exp.id}.csv` }, icon('download'), 'CSV'), h('a.btn.sm', { href: `/api/experiments/${exp.id}.json` }, icon('file'), 'JSON'))),
        h('div.card-b.col', { style: { gap: '10px' } },
          running ? h('div', h('div.row.small', h('span', `Running: ${exp.current_arm || '…'}`), h('div.spacer'), h('span.num', `${prog.done}/${prog.total}`)),
            h('div.bar.thick.stripes', { style: { marginTop: '6px' } }, h('i', { style: { width: (prog.done / (prog.total || 1)) * 100 + '%' } }))) : null,
          exp.error && exp.status !== 'done' ? h('div.callout.err', icon('alert'), h('div', exp.error)) : null,
          !sm.length ? h('div.small.muted', 'Waiting for the first results…') :
            h('div.table-wrap', h('table.table',
              h('thead', h('tr', ['Arm', 'n', 'Decode tok/s', 'E2E tok/s', 'TTFT', 'Accept', 'Tok/step', 'Net/token', 'J/token'].map((x, i) => h('th', { class: i ? 'r' : '' }, x)))),
              h('tbody', sm.map((a, i) => {
                const best = Math.max(...sm.map((x) => x.gen_tps || 0));
                return h('tr', h('td', h('div.row', h('span.dot', { style: { background: PALETTE[i % 8] } }), a.label)), h('td.r.num', a.n),
                  h('td.r.num', { class: a.gen_tps === best ? 'strong' : '' }, `${fmtNum(a.gen_tps, 1)} ± ${fmtNum(a.gen_tps_std, 1)}`),
                  h('td.r.num', fmtNum(a.e2e_tps, 1)), h('td.r.num', fmtMs(a.ttft_ms)), h('td.r.num', fmtPct(a.accept_rate, 1)),
                  h('td.r.num', fmtNum(a.tokens_per_step, 2)), h('td.r.num', a.bytes_per_token != null ? fmtBytes(a.bytes_per_token) : '–'),
                  h('td.r.num', a.joules_per_token != null ? fmtNum(a.joules_per_token, 3) : '–'));
              }))))));
      const charts = [];
      const c1 = h('canvas.chart');
      charts.push(h('div.card', h('div.card-h', h('h3', 'Decode throughput by arm'), h('span.hint', 'mean ± std across prompts and repeats')), h('div.card-b', c1)));
      const latArms = sm.filter((a) => a.latency_ms != null);
      const c2 = h('canvas.chart');
      if (latArms.length) charts.push(h('div.card', h('div.card-h', h('h3', 'Throughput vs injected RTT'), h('span.hint', 'one line per draft length')), h('div.card-b', c2)));
      const dArms = sm.filter((a) => a.draft_max != null);
      const c3 = h('canvas.chart');
      if (new Set(dArms.map((a) => a.draft_max)).size > 1) charts.push(h('div.card', h('div.card-h', h('h3', 'Draft length trade-off'), h('span.hint', 'tok/s (solid) and acceptance ×100 (dashed)')), h('div.card-b', c3)));
      const posArms = sm.filter((a) => a.accept_by_pos?.length);
      const c4 = h('canvas.chart');
      if (posArms.length) charts.push(h('div.card', h('div.card-h', h('h3', 'Acceptance by draft position'), h('span.hint', 'P(token i of the draft is accepted)')), h('div.card-b', c4)));
      const promptArms = sm.filter((a) => Object.keys(a.accept_by_prompt || {}).length);
      const c5 = h('canvas.chart');
      if (promptArms.length) charts.push(h('div.card', h('div.card-h', h('h3', 'Acceptance by task type')), h('div.card-b', c5)));
      const nodeArms = sm.filter((a) => Object.keys(a.nodes || {}).length);
      const c6 = h('canvas.chart');
      if (nodeArms.length) charts.push(h('div.card', h('div.card-h', h('h3', 'Per-run time attribution'), h('span.hint', 'estimated from gate timings: compute (blue) vs network (amber)')), h('div.card-b', c6)));
      const grid = h('div.grid.cols-2', charts);
      results.replaceChildren(head, grid);
      requestAnimationFrame(() => {
        const short = (l) => l.replace('Current cluster', 'cluster').replace(/Single node \([^)]*\)/, 'single').replace('Cluster without draft', 'no draft');
        barChart(c1, sm.map((a) => short(a.label)), [{ name: 'tok/s', color: 'var(--accent)', values: sm.map((a) => a.gen_tps), errs: sm.map((a) => a.gen_tps_std) }],
          { yFmt: (v) => fmtNum(v, 1), yLabel: 'tok/s', rotate: sm.length > 3, colorsPerCat: sm.map((_, i) => PALETTE[i % 8]) });
        if (latArms.length) {
          const groups = {};
          for (const a of latArms) (groups[`${a.topology}${a.draft_max != null ? ' · draft ' + a.draft_max : ''}`] ||= []).push([a.latency_ms, a.gen_tps, a.gen_tps_std]);
          lineChart(c2, Object.entries(groups).map(([k, pts], i) => ({ name: k, color: PALETTE[i % 8], points: pts })),
            { xLabel: 'injected RTT (ms)', yLabel: 'tok/s', yFmt: (v) => fmtNum(v, 1), xFmt: (v) => fmtNum(v, 0) });
        }
        if (new Set(dArms.map((a) => a.draft_max)).size > 1) {
          const groups = {};
          for (const a of dArms) {
            const k = `${a.topology}${a.latency_ms != null ? ' · +' + a.latency_ms + 'ms' : ''}`;
            (groups[k] ||= { tps: [], acc: [] });
            groups[k].tps.push([a.draft_max, a.gen_tps]);
            if (a.accept_rate != null) groups[k].acc.push([a.draft_max, a.accept_rate * 100]);
          }
          const series = [];
          Object.entries(groups).forEach(([k, g], i) => {
            series.push({ name: k + ' tok/s', color: PALETTE[i % 8], points: g.tps });
            if (g.acc.length) series.push({ name: k + ' accept %', color: PALETTE[i % 8], points: g.acc, dash: true });
          });
          lineChart(c3, series, { xLabel: 'draft length', yLabel: 'tok/s · accept %', yFmt: (v) => fmtNum(v, 0), xFmt: (v) => fmtNum(v, 0) });
        }
        if (posArms.length) {
          lineChart(c4, posArms.map((a) => ({ name: a.label, color: PALETTE[sm.indexOf(a) % 8], points: a.accept_by_pos.map((v, i) => [i + 1, v]) })),
            { xLabel: 'draft position', yLabel: 'P(accept)', yMax: 1, yFmt: (v) => fmtPct(v), xFmt: (v) => '#' + v });
        }
        if (promptArms.length) {
          const cats = [...new Set(promptArms.flatMap((a) => Object.keys(a.accept_by_prompt)))];
          barChart(c5, cats, promptArms.slice(0, 6).map((a) => ({ name: a.label, color: PALETTE[sm.indexOf(a) % 8], values: cats.map((c) => a.accept_by_prompt[c] ?? null) })),
            { yFmt: (v) => fmtPct(v), yMax: 1 });
        }
        if (nodeArms.length) {
          const rows = [];
          for (const a of nodeArms) for (const [name, v] of Object.entries(a.nodes)) {
            rows.push({ label: `${a.label.replace(/^Current cluster · /, '')} @ ${name}`, parts: [
              { name: 'compute', value: v.compute_ms, color: 'var(--accent)' }, { name: 'network', value: v.network_ms, color: 'var(--warn)' }] });
          }
          c6.style.height = Math.max(160, rows.length * 30 + 20) + 'px';
          stackedBars(c6, rows, { xFmt: (v) => fmtMs(v) });
        }
      });
    }

    renderBuilder();
    renderList();
    api('/api/experiments/prompts').then((p) => { prompts = p; renderBuilder(); }).catch(() => {});
    api('/api/experiments').then((x) => { S.experiments = x; renderList(); }).catch(() => {});
    renderResults();
    let pend = 0;
    const offs = [
      on('session', renderBuilder),
      on('experiment', () => { renderBuilder(); if (S.experiment?.status === 'running' && (!viewing || viewing.id !== S.experiment.id)) { viewing = { id: S.experiment.id, live: true }; } }),
      on('experiment_row', (d) => {
        if (!viewing || viewing.id !== d.id || !exp) return;
        exp.rows.push(d.row); exp.summary = d.summary; exp.progress.done = exp.rows.length;
        if (!pend) pend = setTimeout(() => { pend = 0; draw(); }, 600);
      }),
      on('experiments', () => {
        renderList();
        const listed = (S.experiments || []).find((x) => x.id === viewing?.id);
        if (viewing && listed && (!exp || listed.status !== exp.status)) { viewing = { id: viewing.id, live: true }; renderResults(); }
      }),
    ];
    return () => { offs.forEach((f) => f()); if (pend) clearTimeout(pend); };
  },
};
