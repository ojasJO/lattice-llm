import { S, fmtTime, h, icon, on } from '../lib.js';

const TABS = [['events', 'Events'], ['llama-server', 'llama-server'], ['rpc-server', 'rpc-server']];

export default {
  title: 'Logs',
  subtitle: 'Cluster events and raw process output',
  mount(root) {
    let tab = 'events';
    let follow = true;
    const box = h('div.log');
    const filter = h('input.input.sm', { placeholder: 'Filter…', style: { width: '220px' }, oninput: () => render() });
    const followBtn = h('label.check', h('input', { type: 'checkbox', checked: true, onchange: (e) => { follow = e.target.checked; } }), 'Follow');
    const tabs = h('div.tabs');
    root.append(h('div.card', h('div.row', { style: { paddingRight: '14px' } }, tabs, h('div.spacer'), filter, followBtn), box));

    function renderTabs() {
      tabs.replaceChildren(...TABS.map(([id, label]) => h('button', { class: tab === id ? 'on' : '', onclick: () => { tab = id; renderTabs(); render(); } }, label)));
    }
    function line(text) {
      const cls = / E |error|failed|exited/i.test(text) ? 'e' : / W |warn/i.test(text) ? 'w' : text.startsWith('$ ') ? 'c' : '';
      return h('div', { class: cls }, text);
    }
    function render() {
      const q = filter.value.trim().toLowerCase();
      let lines;
      if (tab === 'events') lines = S.events.map((e) => `${fmtTime(e.ts)}  [${e.kind}] ${e.text}`);
      else lines = S.logs[tab] || [];
      if (q) lines = lines.filter((l) => l.toLowerCase().includes(q));
      box.replaceChildren(...(lines.length ? lines.slice(-1500).map(line) : [h('div.muted', tab === 'events' ? 'No events yet.' : `${tab} has not run on this laptop yet.`)]));
      if (follow) box.scrollTop = box.scrollHeight;
    }
    function append(text) {
      const q = filter.value.trim().toLowerCase();
      if (q && !text.toLowerCase().includes(q)) return;
      if (box.firstChild?.classList?.contains('muted')) box.replaceChildren();
      box.append(line(text));
      while (box.childNodes.length > 1500) box.firstChild.remove();
      if (follow) box.scrollTop = box.scrollHeight;
    }
    renderTabs();
    render();
    const offs = [
      on('log', (d) => { if (d.proc === tab) append(d.line); }),
      on('event', (e) => { if (tab === 'events') append(`${fmtTime(e.ts)}  [${e.kind}] ${e.text}`); }),
    ];
    return () => offs.forEach((f) => f());
  },
};
