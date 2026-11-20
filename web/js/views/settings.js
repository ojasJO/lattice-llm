import { S, act, api, copyText, fmtDur, h, icon, on } from '../lib.js';

export default {
  title: 'Settings',
  subtitle: 'This node’s identity, worker defaults and diagnostics',
  mount(root) {
    const body = h('div.grid.cols-2');
    root.append(body);
    function render() {
      const s = S.self;
      const st = s.settings || {};
      const nameIn = h('input.input', { value: s.name, maxlength: 40 });
      const devSel = h('select.input', h('option', { value: 'auto', selected: st.worker_device === 'auto' }, 'Automatic (best GPU with ≥ 3 GB, else CPU)'),
        (s.devices || []).map((d) => h('option', { value: d.name, selected: st.worker_device === d.name }, `${d.name}: ${d.desc}`)));
      const thIn = h('input.input', { type: 'number', min: 0, max: 128, value: st.worker_threads || 0 });
      const disc = h('input', { type: 'checkbox', checked: st.allow_discovery !== false });
      body.replaceChildren(
        h('div.card', h('div.card-h', h('h3', 'This node')), h('div.card-b.col', { style: { gap: '14px' } },
          h('div.field', h('label', 'Display name (shown to other laptops)'), nameIn),
          h('div.field', h('label', 'Device to lend when another laptop uses this one as a worker'), devSel),
          h('div.field', h('label', 'Worker CPU threads (0 = automatic)'), thIn),
          h('label.check', disc, 'Announce this laptop on the local network'),
          h('div.row', h('div.spacer'), h('button.btn.primary', { onclick: () => act(() => api('/api/settings', { body: {
            name: nameIn.value, worker_device: devSel.value, worker_threads: Math.max(0, +thIn.value || 0), allow_discovery: disc.checked } }), 'Settings saved') }, icon('check'), 'Save')))),
        h('div.card', h('div.card-h', h('h3', 'About this node')), h('div.card-b',
          h('div.kv',
            h('span', 'Node ID'), h('span.mono', s.id),
            h('span', 'Version'), h('span', `Lattice ${s.version} · ${s.runtime_status?.label || ''}`),
            h('span', 'Dashboard'), h('span.mono', `http://127.0.0.1:${s.ports.http}`),
            h('span', 'LAN address'), h('span.mono', `${s.lan_ip}:${s.ports.http}`),
            h('span', 'Ports'), h('span.mono', `http ${s.ports.http} · gate ${s.ports.gate} · rpc ${s.ports.rpc} (loopback) · llama ${s.ports.llama} (loopback) · discovery udp 7471`),
            h('span', 'Data folder'), h('span.mono', s.home),
            h('span', 'CPU'), h('span', s.hw?.cpu),
            h('span', 'OS'), h('span', s.hw?.os),
            h('span', 'Uptime'), h('span', fmtDur(s.uptime))),
          h('div.callout', { style: { marginTop: '14px' } }, icon('shield'), h('div',
            'Security model: the dashboard only answers this computer; node-to-node calls are HMAC-signed with a per-pair secret; ',
            'the llama.cpp RPC server listens on loopback only and is reachable solely through the gate, which admits the coordinator that holds a lease.')),
          h('div.callout.warn', { style: { marginTop: '10px' } }, icon('alert'), h('div',
            'Other laptops cannot see this one? Run ', h('span.kbd', 'tools\\allow-firewall.bat'), ' as administrator once (opens TCP 7470-7499 and UDP 7471 on private networks), or approve the Windows Firewall prompt for Python.')),
          h('div.row', { style: { marginTop: '12px' } }, h('button.btn.sm', { onclick: () => copyText(`http://${s.lan_ip}:${s.ports.http}/get`) }, icon('copy'), 'Copy invite link')))),
      );
    }
    render();
    const off = on('self', () => { if (!root.contains(document.activeElement) || document.activeElement === document.body) render(); });
    return off;
  },
};
