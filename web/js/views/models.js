import { S, act, api, confirmDialog, fmtBytes, fmtNum, fmtParams, fmtRate, h, icon, modal, on } from '../lib.js';
import { barChart } from '../charts.js';
import { empty } from './common.js';

export default {
  title: 'Models',
  subtitle: 'GGUF library, LAN-first downloads and the llama.cpp runtime',
  mount(root) {
    const rtBody = h('div.card-b');
    const rtCard = h('div.card', h('div.card-h', h('h3', 'Runtime'), h('span.hint', 'identical llama.cpp build on every node (RPC protocol is versioned)')), rtBody);
    const dlBody = h('div');
    const dlCard = h('div.card', h('div.card-h', h('h3', 'Transfers'),
      h('div.actions', h('button.btn.sm.ghost', { onclick: () => api('/api/downloads/clear', { body: {} }) }, 'Clear finished'))), dlBody);
    const libBody = h('div');
    const libCard = h('div.card', h('div.card-h', h('h3', 'On this laptop'), h('span.hint', 'drop any .gguf file into the models folder'),
      h('div.actions', h('button.btn.sm', { onclick: () => api('/api/models').catch(() => {}) }, icon('refresh'), 'Rescan'))), libBody);
    const catBody = h('div.card-b.grid.cols-auto', { style: { gap: '12px' } });
    const catCard = h('div.card', h('div.card-h', h('h3', 'Catalog'), h('span.hint', 'speculative decoding needs a draft and target from the same family')), catBody);
    root.append(libCard, h('div.grid.cols-2', { style: { alignItems: 'start' } }, rtCard, dlCard), catCard);

    function renderRuntime() {
      const rs = S.self.runtime_status || {};
      const devs = rs.devices || [];
      rtBody.replaceChildren(
        h('div.row', { style: { marginBottom: '12px' } }, h('div.strong', rs.label || 'llama.cpp'),
          rs.installed ? h('span.pill.ok', icon('check'), 'installed') : h('span.pill.warn', 'not installed'),
          h('span.pill.outline', `RPC v${rs.rpc_proto}`), h('div.spacer'),
          rs.installed ? h('button.btn.sm', { onclick: () => act(() => api('/api/runtime/probe', { body: {} }), 'Devices re-detected') }, icon('refresh'), 'Re-detect')
            : h('button.btn.sm.primary', { onclick: () => act(() => api('/api/runtime/install', { body: {} })) }, icon('download'), 'Install (38 MB)')),
        devs.length ? h('table.table', h('thead', h('tr', h('th', 'Device'), h('th', 'Type'), h('th.r', 'Memory'), h('th.r', 'Free'))),
          h('tbody', devs.map((d) => h('tr', h('td', h('div.strong', d.name), h('div.tiny.muted', d.desc)),
            h('td', h('span.pill', { class: d.kind === 'gpu' ? 'accent' : '' }, d.kind === 'igpu' ? 'integrated GPU' : d.kind.toUpperCase()),
              d.name === rs.default_device ? h('span.pill.ok', { style: { marginLeft: '6px' } }, 'default') : null),
            h('td.r.num', fmtBytes(d.total_mb * 1048576, 1)), h('td.r.num', fmtBytes(d.free_mb * 1048576, 1))))))
          : h('div.small.muted', rs.installed ? 'No devices detected yet.' : 'The runtime is fetched automatically from a paired laptop (or GitHub) the first time you launch.'),
        rs.error ? h('div.callout.err', { style: { marginTop: '10px' } }, icon('alert'), h('div', rs.error)) : null);
    }

    function renderDownloads() {
      const d = S.downloads;
      if (!d.length) { dlBody.replaceChildren(h('div.card-b.small.muted', 'No transfers. Models you download from a paired laptop travel over the LAN at full speed.')); return; }
      dlBody.replaceChildren(h('div.card-b.col', d.map((x) => {
        const frac = x.total ? x.done / x.total : 0;
        const eta = x.speed > 0 && x.total ? (x.total - x.done) / x.speed : null;
        const cls = x.status === 'error' ? 'err' : x.status === 'done' ? 'ok' : '';
        return h('div.col', { style: { gap: '6px' } },
          h('div.row', h('span.strong.ellipsis', { style: { flex: 1 } }, x.name),
            h('span.pill', { class: cls || 'info' }, x.status === 'running' ? `${Math.round(frac * 100)}%` : x.status),
            x.status === 'running' ? h('button.btn.sm.ghost.icon', { title: 'Cancel', onclick: () => api(`/api/downloads/${x.id}/cancel`, { body: {} }) }, icon('x')) : null),
          h('div.bar.thick' + (cls ? '.' + cls : '') + (x.status === 'running' ? '.stripes' : ''), h('i', { style: { width: (x.status === 'done' ? 100 : frac * 100) + '%' } })),
          h('div.tiny.muted', `${fmtBytes(x.done)} / ${fmtBytes(x.total)} · from ${x.source || '…'}${x.status === 'running' ? ` · ${fmtRate(x.speed)}${eta != null ? ` · ${Math.ceil(eta)}s left` : ''}` : ''}`),
          x.error ? h('div.tiny', { style: { color: 'var(--err)' } }, x.error) : null);
      })));
    }

    function renderLib() {
      const ms = S.models;
      if (!ms.length) { libBody.replaceChildren(empty('box', 'No models yet', 'Download one from the catalog below. If a paired laptop already has it, it is copied over the LAN.')); return; }
      const inUse = [S.session?.config?.target, S.session?.config?.draft];
      libBody.replaceChildren(h('div.table-wrap', h('table.table',
        h('thead', h('tr', ['Model', 'Arch', 'Params', 'Quant', 'Layers', 'Context', 'Size', ''].map((x, i) => h('th', { class: [2, 4, 5, 6].includes(i) ? 'r' : '' }, x)))),
        h('tbody', ms.map((m) => h('tr',
          h('td', { style: { maxWidth: '240px' } }, h('div.strong.ellipsis', { title: m.file }, m.title || m.name), h('div.tiny.muted.mono.ellipsis', { title: m.file }, m.file)),
          h('td', m.arch), h('td.r.num', fmtParams(m.n_params)), h('td', h('span.pill.outline', m.quant || '?')),
          h('td.r.num', m.n_layers), h('td.r.num', fmtNum(m.ctx_train, 0)), h('td.r.num', fmtBytes(m.size)),
          h('td.r', h('div.row', { style: { justifyContent: 'flex-end', gap: '4px' } },
            inUse.includes(m.file) && S.session?.state === 'ready' ? h('span.pill.ok', 'in use') : null,
            h('button.btn.sm.ghost', { onclick: () => inspect(m.file) }, icon('eye'), 'Inspect'),
            h('button.btn.sm.ghost.icon', { title: 'Delete', onclick: async () => {
              if (await confirmDialog('Delete model?', `${m.file} (${fmtBytes(m.size)}) will be removed from this laptop.`, 'Delete', true)) {
                act(() => api('/api/models/' + encodeURIComponent(m.file), { method: 'DELETE' }), 'Model deleted');
              }
            } }, icon('trash'))))))))));
    }

    let catKey = '';
    function renderCatalog() {
      const active = new Set(S.downloads.filter((d) => d.status === 'running' || d.status === 'queued').map((d) => d.name));
      const key = S.catalog.map((c) => [c.file, c.local, (c.on_peers || []).map((p) => p.id).join('+'), active.has(c.file)].join(',')).join('|');
      if (key === catKey) return;
      catKey = key;
      catBody.replaceChildren(...S.catalog.map((c) => {
        const lan = c.on_peers || [];
        let btn;
        if (c.local) btn = h('span.pill.ok', icon('check'), 'on this laptop');
        else if (active.has(c.file)) btn = h('span.pill.info', 'downloading…');
        else if (lan.length) btn = h('button.btn.sm.primary', { onclick: () => act(() => api('/api/models/download', { body: { file: c.file, peer_id: lan[0].id } })) }, icon('network'), `Copy from ${lan[0].name}`);
        else btn = h('button.btn.sm', { onclick: () => act(() => api('/api/models/download', { body: { file: c.file } })) }, icon('download'), `Download ${fmtBytes(c.size, 1)}`);
        return h('div.dev',
          h('div.top', h('div.ico', icon('box')), h('div', { style: { flex: 1, minWidth: 0 } }, h('div.nm', c.title), h('div.tiny.muted', `${c.family} · ${c.params} · ${c.quant}`))),
          h('div.specs', h('span.spec', fmtBytes(c.size, 1)),
            c.role !== 'target' ? h('span.spec', icon('sparkles'), 'good draft') : null,
            c.role !== 'draft' ? h('span.spec', icon('layers'), 'target') : null,
            lan.length ? h('span.spec', icon('network'), `on ${lan.map((x) => x.name).join(', ')}`) : null),
          h('div.row', h('span.tiny.muted.ellipsis', { style: { flex: 1 } }, c.repo), btn));
      }));
    }

    async function inspect(file) {
      let m;
      try { m = await api('/api/models/' + encodeURIComponent(file)); } catch (e) { return; }
      const chart = h('canvas.chart.sm');
      const meta = Object.entries(m.meta || {}).filter(([k]) => !k.startsWith('general.') || ['general.architecture', 'general.name', 'general.size_label', 'general.license', 'general.basename'].includes(k));
      const compat = S.models.filter((x) => x.file !== m.file && x.vocab_sig === m.vocab_sig && x.tokenizer === m.tokenizer);
      modal({
        title: m.title || m.name, wide: true,
        body: h('div.col', { style: { gap: '16px' } },
          h('div.grid.cols-4', { style: { gap: '10px' } },
            ...[['Parameters', fmtParams(m.n_params)], ['Layers', m.n_layers], ['Hidden size', m.n_embd], ['Heads (KV)', `${m.n_head} (${m.n_head_kv})`],
              ['Vocabulary', fmtNum(m.vocab_size, 0)], ['Train context', fmtNum(m.ctx_train, 0)], ['KV / token', fmtBytes(m.kv_bytes_per_token_layer * m.n_layers)], ['Quantisation', m.quant]]
              .map(([k, v]) => h('div.dev', { style: { padding: '10px 12px', gap: '2px' } }, h('div.tiny.muted', k), h('div.strong', String(v ?? '–'))))),
          h('div', h('div.label-sm', { style: { marginBottom: '6px' } }, 'Bytes per transformer layer: this is what each pipeline stage must hold'), chart),
          h('div.small.muted', `Embedding ${fmtBytes(m.embd_bytes)} (stays on the coordinator) · output head ${fmtBytes(m.output_bytes)} (goes to the last stage)`),
          compat.length ? h('div.callout.ok', icon('sparkles'), h('div', 'Shares a vocabulary with ', compat.map((x) => x.file).join(', '), ': usable as draft/target pair for speculative decoding.')) : null,
          h('details', h('summary.small.muted', { style: { cursor: 'pointer' } }, `GGUF metadata (${meta.length} keys)`),
            h('div.kv.mono', { style: { marginTop: '10px', fontSize: '11.5px' } }, meta.flatMap(([k, v]) => [h('span', k), h('span', typeof v === 'object' ? JSON.stringify(v) : String(v))])))),
      });
      requestAnimationFrame(() => barChart(chart, m.layer_bytes.map((_, i) => i), [{ name: 'bytes', color: 'var(--accent)', values: m.layer_bytes }], { yFmt: (v) => fmtBytes(v, 0) }));
    }

    function all() { renderRuntime(); renderDownloads(); renderLib(); renderCatalog(); }
    all();
    api('/api/models').catch(() => {});
    const offs = [on('self', renderRuntime), on('downloads', () => { renderDownloads(); renderCatalog(); }), on('models', () => { renderLib(); renderCatalog(); }),
      on('catalog', renderCatalog), on('session', renderLib)];
    return () => offs.forEach((f) => f());
  },
};
