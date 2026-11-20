import { S, act, api, confirmDialog, copyText, fmtAgo, fmtBytes, fmtMs, fmtNum, h, icon, nodeColor, on, shortGpu, toast } from '../lib.js';
import { empty } from './common.js';

function specs(hw, extra = {}) {
  if (!hw) return h('div.specs');
  const gpus = (hw.gpus || []).filter((g) => !g.integrated).map((g) => (typeof g === 'string' ? g : g.name));
  return h('div.specs',
    hw.cpu ? h('span.spec', icon('cpu'), hw.cpu.replace(/\(R\)|\(TM\)|CPU|@.*$|\d+(th|nd|rd|st) Gen /g, '').replace(/\s+/g, ' ').trim()) : null,
    hw.ram ? h('span.spec', icon('memory'), fmtBytes(hw.ram, 0)) : null,
    ...gpus.map((g) => h('span.spec', icon('gpu'), shortGpu(g))),
    extra.runtime === false ? h('span.spec', icon('download'), 'runtime not installed') : null);
}

export default {
  title: 'Devices',
  subtitle: 'Discover laptops on your network and pair them into the cluster',
  mount(root) {
    // ---------------------------------------------------------------- nearby
    const radar = h('div.radar');
    const scanInfo = h('div.col', { style: { gap: '4px' } });
    const nearbyList = h('div.grid.cols-auto', { style: { gap: '12px' } });
    const nearbyCard = h('div.card',
      h('div.card-h', h('h3', 'Nearby'), h('span.hint', 'multicast + broadcast beacons every 2 s'),
        h('div.actions', h('button.btn.sm', { onclick: () => toast('Scanning continuously: devices appear within a few seconds', 'info') }, icon('refresh'), 'Scan'))),
      h('div.card-b', h('div.row', { style: { gap: '22px', alignItems: 'center', marginBottom: '16px' } }, radar, scanInfo), nearbyList));

    // ---------------------------------------------------------------- paired
    const pairedBody = h('div');
    const pairedCard = h('div.card', h('div.card-h', h('h3', 'Paired devices'), h('span.hint', 'HMAC-authenticated · liveness every 1 s · NTP-style clock offset')), pairedBody);

    // ---------------------------------------------------------------- manual + invite
    const ipIn = h('input.input', { placeholder: 'e.g. 192.168.1.42 or 192.168.1.42:7470' });
    const addBtn = h('button.btn.primary', { onclick: addManual }, icon('plus'), 'Add');
    ipIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') addManual(); });
    async function addManual() {
      const v = ipIn.value.trim();
      if (!v) return;
      addBtn.disabled = true;
      const r = await act(() => api('/api/discovery/add', { body: { host: v } }));
      addBtn.disabled = false;
      if (r) { toast(`Found ${r.name}`, 'success'); ipIn.value = ''; }
    }
    const manualCard = h('div.card', h('div.card-h', h('h3', 'Add by IP')),
      h('div.card-b.col', h('div.small.muted', 'If your Wi-Fi blocks discovery (common on campus networks with client isolation), enter the other laptop’s address shown in its terminal.'),
        h('div.row', ipIn, addBtn)));

    const inviteBody = h('div.card-b.col');
    const inviteCard = h('div.card', h('div.card-h', h('h3', 'Invite another laptop'), h('span.hint', 'no USB stick needed')), inviteBody);

    const diagBody = h('div.card-b');
    const diagCard = h('div.card', h('div.card-h', h('h3', 'Network diagnostics')), diagBody);

    root.append(nearbyCard, pairedCard, h('div.grid.cols-3', manualCard, inviteCard, diagCard));

    let nearbyKey = '';
    function renderNearby() {
      const disc = S.self?.discovery || {};
      const unpaired = S.nearby.filter((n) => !n.paired);
      const key = JSON.stringify([disc.listening, (disc.interfaces || []).join(), S.nearby.filter((n) => n.paired).length,
        unpaired.map((n) => [n.id, n.name, n.host, n.port, n.online, n.via, n.state, n.runtime]),
        Object.values(S.outgoing).filter((o) => o.status === 'waiting').map((o) => o.id)]);
      if (key === nearbyKey) return;
      nearbyKey = key;
      radar.replaceChildren(...unpaired.filter((n) => n.online).slice(0, 6).map((n, i) => {
        const a = (i * 137 + 40) * (Math.PI / 180);
        const r = 26 + (i % 3) * 14;
        return h('span.blip', { style: { left: `${60 + Math.cos(a) * r - 3}px`, top: `${60 + Math.sin(a) * r - 3}px` } });
      }));
      scanInfo.replaceChildren(
        h('div.strong', disc.listening ? 'Scanning your network' : 'Discovery port unavailable'),
        h('div.small.muted', disc.listening ? `Listening on UDP ${disc.port} (group ${disc.group})` : (disc.errors || []).join('; ')),
        h('div.small.muted', `Interfaces: ${(disc.interfaces || []).join(', ') || 'none'}`),
        h('div.small', `${unpaired.filter((n) => n.online).length} unpaired · ${S.nearby.filter((n) => n.paired).length} paired in range`));
      if (!unpaired.length) {
        nearbyList.replaceChildren(h('div', { style: { gridColumn: '1 / -1' } }, empty('radar', 'Looking for other Lattice nodes…',
          'Run start.bat on another laptop connected to the same network. It will appear here automatically.')));
        return;
      }
      nearbyList.replaceChildren(...unpaired.map((n) => {
        const out = Object.values(S.outgoing).find((o) => o.to?.id === n.id && o.status === 'waiting');
        let action;
        if (out) {
          action = h('div.col', { style: { gap: '6px' } },
            h('div.small.muted', `Waiting for approval on ${n.name}. Confirm the code matches:`),
            h('div.row', h('span.code-digits', { style: { fontSize: '20px', padding: '6px 12px', flex: 1 } }, `${out.code.slice(0, 3)} ${out.code.slice(3)}`),
              h('button.btn.ghost.sm', { onclick: () => api('/api/pair/cancel', { body: { request_id: out.id } }) }, 'Cancel')));
        } else {
          action = h('button.btn.primary', { disabled: !n.online, onclick: async (e) => {
            e.currentTarget.disabled = true;
            await act(() => api('/api/pair/request', { body: { id: n.id } }));
          } }, icon('link'), 'Connect');
        }
        return h('div.dev',
          h('div.top', h('div.ico', icon('laptop')),
            h('div', { style: { minWidth: 0, flex: 1 } }, h('div.nm.ellipsis', n.name), h('div.small.muted.mono', `${n.host}:${n.port}`)),
            h('span.pill', { class: n.online ? 'ok' : '' }, h('span.dot', { class: n.online ? 'ok' : '' }), n.online ? (n.via === 'manual' ? 'added by IP' : 'nearby') : fmtAgo(n.last_seen * 1000))),
          specs({ cpu: n.cpu, ram: n.ram, gpus: (n.gpus || []).map((g) => ({ name: g })) }, { runtime: n.runtime }),
          n.state && n.state !== 'idle' ? h('div.small.muted', `currently ${n.state}`) : null,
          action);
      }));
    }

    let pairedKey = '';
    const liveCells = new Map();
    function renderPaired() {
      if (!S.peers.length) {
        pairedKey = '';
        pairedBody.replaceChildren(empty('link', 'No paired devices yet', 'Press Connect on a nearby laptop, then approve the request on that laptop’s screen.'));
        return;
      }
      const key = S.peers.map((p) => [p.id, p.name, p.online, p.info?.role, p.info?.serving_for, p.info?.runtime, p.host].join(',')).join('|');
      if (key === pairedKey) {
        for (const p of S.peers) {
          const c = liveCells.get(p.id);
          if (!c) continue;
          c.rtt.textContent = fmtMs(p.rtt_best_ms);
          c.off.textContent = p.offset_ms != null ? `${p.offset_ms >= 0 ? '+' : ''}${fmtNum(p.offset_ms, 2)} ms ± ${fmtNum(p.offset_err_ms, 2)}` : '–';
        }
        return;
      }
      pairedKey = key;
      liveCells.clear();
      pairedBody.replaceChildren(h('div.table-wrap', h('table.table',
        h('thead', h('tr', ['Device', 'Address', 'Hardware', 'Status', 'RTT', 'Clock offset', 'Paired', ''].map((x, i) => h('th', { class: i >= 4 && i <= 5 ? 'r' : '' }, x)))),
        h('tbody', S.peers.map((p) => {
          const hw = p.hw || {};
          const info = p.info || {};
          const status = !p.online ? h('span.pill.err', 'offline') : info.role === 'worker' ? h('span.pill.ok', 'worker' + (info.serving_for ? ' · ' + info.serving_for : ''))
            : info.role === 'coordinator' ? h('span.pill.accent', 'coordinating') : h('span.pill.ok', 'online');
          const rtt = h('td.r.num', fmtMs(p.rtt_best_ms));
          const off = h('td.r.num', p.offset_ms != null ? `${p.offset_ms >= 0 ? '+' : ''}${fmtNum(p.offset_ms, 2)} ms ± ${fmtNum(p.offset_err_ms, 2)}` : '–');
          liveCells.set(p.id, { rtt, off });
          return h('tr',
            h('td', h('div.row', h('span.dot', { style: { background: nodeColor(p.id) } }), h('div', h('div.strong', p.name), h('div.tiny.muted.mono', p.id)))),
            h('td.mono.small', `${p.host}:${p.port}`),
            h('td', specs(hw, { runtime: info.runtime })),
            h('td', status, p.error && !p.online ? h('div.tiny.muted', p.error) : null),
            rtt,
            off,
            h('td.muted.small', fmtAgo((p.paired_at || 0) * 1000)),
            h('td.r', h('button.btn.sm.ghost', { title: 'Unpair', onclick: async () => {
              if (await confirmDialog('Unpair device?', `${p.name} will no longer be able to use this laptop and vice versa. You can pair again any time.`, 'Unpair', true)) {
                act(() => api(`/api/peers/${p.id}/unpair`, { body: {} }));
              }
            } }, icon('unlink'), 'Unpair')));
        })))));
    }

    function renderInvite() {
      const s = S.self;
      const url = `http://${s.lan_ip}:${s.ports.http}/get`;
      inviteBody.replaceChildren(
        h('div.small.muted', 'On the new laptop, open this address in a browser. It downloads Lattice from this laptop; llama.cpp and models then come over the LAN too.'),
        h('div.copy-box', h('span', url), h('button.btn.sm', { onclick: () => copyText(url) }, icon('copy'), 'Copy')),
        h('div.small', h('b', '1. '), 'Extract the zip   ', h('b', '2. '), 'run ', h('span.kbd', 'start.bat'), '   ', h('b', '3. '), 'press Connect here'));
    }

    function renderDiag() {
      const s = S.self;
      const d = s.discovery || {};
      diagBody.replaceChildren(h('div.kv',
        h('span', 'This node'), h('span.mono', `${s.lan_ip}:${s.ports.http}`),
        h('span', 'Discovery'), h('span', d.listening ? `UDP ${d.port} · ${d.group}` : 'not listening'),
        h('span', 'RPC gate'), h('span.mono', `TCP ${s.ports.gate} (paired peers only)`),
        h('span', 'Interfaces'), h('span.mono', (d.interfaces || []).join(', ')),
        h('span', 'Peers'), h('span', `${S.peers.filter((p) => p.online).length} online / ${S.peers.length} paired`)),
        h('div.callout', { style: { marginTop: '12px' } }, icon('shield'),
          h('div', 'Nothing showing up? Allow Python on ', h('b', 'Private'), ' networks when Windows asks, or run ', h('span.kbd', 'tools\\allow-firewall.bat'), ' as administrator once on each laptop.')));
    }

    function all() { renderNearby(); renderPaired(); renderInvite(); renderDiag(); }
    all();
    const offs = [on('nearby', renderNearby), on('peers', () => { renderPaired(); renderDiag(); }), on('pairing', renderNearby), on('self', () => { renderInvite(); renderDiag(); })];
    return () => offs.forEach((f) => f());
  },
};
