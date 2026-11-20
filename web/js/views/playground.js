import { S, fmtBytes, fmtMs, fmtNum, fmtPct, h, icon, nodeColor, on, toast } from '../lib.js';
import { barChart, stackedBars } from '../charts.js';
import { empty } from './common.js';

const KEY = 'lattice-chat-v1';
const chat = (() => {
  try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; }
})() || { messages: [], system: '', params: { max_tokens: 512, temperature: 0.7, top_p: 0.95, seed: '' } };
const saveChat = () => { try { localStorage.setItem(KEY, JSON.stringify({ ...chat, messages: chat.messages.slice(-40) })); } catch { /* ignore */ } };
let busy = null;

const SUGGEST = [
  'Explain pipeline parallelism vs tensor parallelism in 5 bullet points.',
  'Write a Python function that merges two sorted lists, with tests.',
  'Return a JSON array of the first 20 prime numbers.',
  'Summarise the CAP theorem for a 2nd-year student.',
];

// tiny, safe markdown: ``` fences, `code`, **bold**
function renderMd(text) {
  const out = [];
  const parts = text.split(/```/);
  parts.forEach((p, i) => {
    if (i % 2 === 1) {
      const nl = p.indexOf('\n');
      out.push(h('pre', nl >= 0 && nl < 20 ? p.slice(nl + 1) : p));
    } else {
      const toks = p.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/);
      for (const t of toks) {
        if (!t) continue;
        if (t.startsWith('`') && t.endsWith('`') && t.length > 2) out.push(h('code', t.slice(1, -1)));
        else if (t.startsWith('**') && t.endsWith('**') && t.length > 4) out.push(h('b', t.slice(2, -2)));
        else out.push(t);
      }
    }
  });
  return out;
}

export default {
  title: 'Playground',
  subtitle: 'Chat with the cluster and see where every millisecond goes',
  mount(root) {
    const msgs = h('div.msgs');
    const ta = h('textarea.input', { rows: 2, placeholder: 'Message the cluster…  (Enter to send, Shift+Enter for a new line)' });
    const sendBtn = h('button.btn.primary.lg', { onclick: send }, icon('send'), 'Send');
    const stopBtn = h('button.btn.danger.lg.hidden', { onclick: () => busy?.abort() }, icon('stop'), 'Stop');
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    const sysIn = h('textarea.input', { rows: 2, placeholder: 'Optional system prompt', value: chat.system, oninput: (e) => { chat.system = e.target.value; saveChat(); } });
    const num = (k, label, step, min, max) => h('div.field', h('label', label), h('input.input.sm', { type: 'number', step, min, max, value: chat.params[k],
      onchange: (e) => { chat.params[k] = e.target.value === '' ? '' : +e.target.value; saveChat(); } }));
    const settings = h('details', { style: { padding: '0 18px 12px' } }, h('summary.small.muted', { style: { cursor: 'pointer' } }, 'Generation settings'),
      h('div.col', { style: { marginTop: '10px' } }, sysIn,
        h('div.grid.cols-4', { style: { gap: '10px' } }, num('max_tokens', 'Max tokens', 1, 1, 8192), num('temperature', 'Temperature', 0.05, 0, 2),
          num('top_p', 'Top-p', 0.05, 0, 1), num('seed', 'Seed (blank = random)', 1, 0, 2 ** 31))));
    const chatCard = h('div.card.chat',
      h('div.card-h', h('h3', 'Conversation'), h('span.hint.sessionHint'),
        h('div.actions', h('button.btn.sm.ghost', { onclick: () => { chat.messages = []; saveChat(); renderMsgs(); } }, icon('trash'), 'Clear'))),
      msgs, settings, h('div.composer', ta, sendBtn, stopBtn));

    const side = h('div.col', { style: { gap: '20px' } });
    root.append(h('div.split-r', chatCard, side));
    root.style.maxWidth = 'none';

    function sessionReady() { return S.session?.state === 'ready'; }

    function renderHint() {
      const hint = chatCard.querySelector('.sessionHint');
      const s = S.session;
      hint.textContent = sessionReady() ? `${s.config.target}${s.config.draft ? ' + draft' : ''} · ${s.plan.length} stage(s)` : 'no cluster running';
      sendBtn.disabled = !sessionReady() || !!busy;
    }

    function msgEl(m) {
      const txt = h('div.txt', renderMd(m.content || ''));
      if (m.streaming) txt.append(h('span.cursor'));
      const think = m.reasoning ? h('div.think', m.reasoning) : null;
      const metrics = m.metrics ? h('div.metrics',
        h('span.spec', icon('zap'), `${fmtNum(m.metrics.gen_tps, 1)} tok/s`),
        h('span.spec', icon('clock'), `TTFT ${fmtMs(m.metrics.ttft_ms)}`),
        h('span.spec', `${m.metrics.gen_tokens} tokens`),
        m.metrics.accept_rate != null ? h('span.spec', icon('sparkles'), `accept ${fmtPct(m.metrics.accept_rate)}`) : null,
        m.metrics.net_bytes ? h('span.spec', icon('network'), `${fmtBytes(m.metrics.net_bytes)} over network`) : null,
        m.metrics.joules_per_token ? h('span.spec', `${fmtNum(m.metrics.joules_per_token, 2)} J/token`) : null,
        h('span.spec', m.mode || '')) : null;
      const err = m.error ? h('div.callout.err', icon('alert'), h('div', m.error)) : null;
      return h('div.msg', { class: m.role },
        h('div.av', m.role === 'user' ? 'You' : 'AI'),
        h('div.bubble', h('div.who', m.role === 'user' ? 'You' : 'Lattice'), think, txt, metrics, err));
    }

    function renderMsgs() {
      if (!chat.messages.length) {
        msgs.replaceChildren(h('div', { style: { margin: 'auto', textAlign: 'center' } },
          sessionReady() ? empty('chat', 'Ask the cluster anything', 'Every reply is measured: TTFT, decode speed, draft acceptance and bytes moved per node.',
            h('div.suggests', SUGGEST.map((s) => h('button', { onclick: () => { ta.value = s; send(); } }, s))))
            : empty('rocket', 'No cluster is running', 'Launch one first. The playground talks to the coordinator on this laptop.', h('a.btn.primary', { href: '#/launch' }, icon('rocket'), 'Go to Launch'))));
        return;
      }
      msgs.replaceChildren(...chat.messages.map(msgEl));
      msgs.scrollTop = msgs.scrollHeight;
    }

    async function send() {
      const text = ta.value.trim();
      if (!text || busy || !sessionReady()) return;
      ta.value = '';
      chat.messages.push({ role: 'user', content: text });
      const am = { role: 'assistant', content: '', reasoning: '', streaming: true, times: [] };
      chat.messages.push(am);
      renderMsgs();
      const live = msgs.lastChild;
      const ctrl = new AbortController();
      busy = ctrl;
      sendBtn.classList.add('hidden'); stopBtn.classList.remove('hidden');
      const history = chat.messages.filter((m) => !m.error && (m.role === 'user' || (m.role === 'assistant' && !m.streaming)))
        .map((m) => ({ role: m.role, content: m.content }));
      if (chat.system.trim()) history.unshift({ role: 'system', content: chat.system.trim() });
      const params = { ...chat.params };
      if (params.seed === '' || params.seed == null) delete params.seed;
      let pending = '';
      let raf = 0;
      const flush = () => {
        raf = 0;
        const bubble = live.querySelector('.bubble');
        if (!bubble) return;
        bubble.replaceWith(msgEl(am).querySelector('.bubble'));
        if (msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 160) msgs.scrollTop = msgs.scrollHeight;
      };
      try {
        const r = await fetch('/api/chat', { method: 'POST', signal: ctrl.signal, headers: { 'X-Lattice-UI': '1', 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: history, params }) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += dec.decode(value, { stream: true });
          let idx;
          while ((idx = pending.indexOf('\n\n')) >= 0) {
            const line = pending.slice(0, idx).trim();
            pending = pending.slice(idx + 2);
            if (!line.startsWith('data:')) continue;
            const ev = JSON.parse(line.slice(5));
            if (ev.type === 'token') { am.content += ev.text; am.times.push(ev.t); }
            else if (ev.type === 'reasoning') { am.reasoning += ev.text; am.times.push(ev.t); }
            else if (ev.type === 'done') { am.metrics = ev.run.metrics; am.mode = ev.run.config.mode; am.content = ev.run.text || am.content; renderSide(am); }
            else if (ev.type === 'error') { am.error = ev.error; }
          }
          if (!raf) raf = requestAnimationFrame(flush);
        }
      } catch (e) {
        if (e.name !== 'AbortError') am.error = e.message;
        else am.error = am.content ? null : 'Stopped.';
      } finally {
        am.streaming = false;
        busy = null;
        sendBtn.classList.remove('hidden'); stopBtn.classList.add('hidden');
        if (raf) cancelAnimationFrame(raf);
        flush();
        saveChat();
        renderHint();
      }
    }

    // ------------------------------------------------------------ side panel
    const liveVal = h('div.value', '–');
    const liveSub = h('div.sub', 'idle');
    const liveCard = h('div.card.stat', h('div.label', icon('zap'), 'Live decode speed'), liveVal, liveSub);
    const lastBody = h('div.card-b');
    const itl = h('canvas.chart.sm');
    const acc = h('canvas.chart.xs');
    const attrib = h('canvas.chart.xs');
    const accWrap = h('div', h('div.label-sm', 'Acceptance by draft position'), acc);
    const attribWrap = h('div', h('div.label-sm', 'Where the time went (estimated per node)'), attrib, h('div.legend', h('span', h('i', { style: { background: 'var(--accent)' } }), 'compute'), h('span', h('i', { style: { background: 'var(--warn)' } }), 'network')));
    const lastCard = h('div.card', h('div.card-h', h('h3', 'Last reply'), h('div.actions', h('a.btn.sm.ghost', { href: '#/runs' }, 'All runs'))), lastBody,
      h('div.card-b.col', { style: { paddingTop: 0, gap: '14px' } }, h('div', h('div.label-sm', 'Inter-token latency (bursts = accepted drafts)'), itl), accWrap, attribWrap));
    side.append(liveCard, lastCard);

    function renderLive() {
      if (S.gen) { liveVal.textContent = `${fmtNum(S.gen.tps, 1)} tok/s`; liveSub.textContent = `${S.gen.tokens} tokens so far`; }
      else { liveVal.textContent = '–'; liveSub.textContent = sessionReady() ? 'waiting for a prompt' : 'no cluster'; }
    }

    function renderSide(m) {
      const last = m || [...chat.messages].reverse().find((x) => x.metrics);
      if (!last) { lastBody.replaceChildren(h('div.small.muted', 'Send a message to see measurements.')); accWrap.classList.add('hidden'); attribWrap.classList.add('hidden'); barChart(itl, [], []); return; }
      const x = last.metrics;
      lastBody.replaceChildren(h('div.kv',
        h('span', 'Decode'), h('span.strong', `${fmtNum(x.gen_tps, 1)} tok/s`),
        h('span', 'Prefill'), h('span', `${fmtNum(x.prompt_tps, 0)} tok/s · ${x.prompt_tokens ?? '–'} tokens`),
        h('span', 'TTFT'), h('span', fmtMs(x.ttft_ms)),
        h('span', 'End-to-end'), h('span', `${fmtMs(x.total_ms)} · ${fmtNum(x.e2e_tps, 1)} tok/s`),
        h('span', 'ITL p50 / p95'), h('span', `${fmtMs(x.itl_p50)} / ${fmtMs(x.itl_p95)}`),
        x.accept_rate != null ? h('span', 'Draft acceptance') : null, x.accept_rate != null ? h('span', `${fmtPct(x.accept_rate, 1)} (${x.draft_accepted}/${x.draft_n}) · ${fmtNum(x.tokens_per_step, 2)} tok/step`) : null,
        h('span', 'Network'), h('span', `${fmtBytes(x.net_bytes)} · ${fmtBytes(x.bytes_per_token)}/token`),
        x.gpu_energy_j ? h('span', 'GPU energy') : null, x.gpu_energy_j ? h('span', `${fmtNum(x.gpu_energy_j, 1)} J · ${fmtNum(x.joules_per_token, 3)} J/token · ${fmtNum(x.gpu_power_w, 1)} W`) : null));
      const t = last.times || [];
      const gaps = t.slice(1).map((v, i) => v - t[i]);
      requestAnimationFrame(() => {
        barChart(itl, gaps.map((_, i) => i + 1), [{ name: 'gap', color: 'var(--accent)', values: gaps }], { yFmt: (v) => fmtMs(v), empty: 'reload-safe: shown for new replies' });
        if (x.accept_by_pos?.length) {
          accWrap.classList.remove('hidden');
          barChart(acc, x.accept_by_pos.map((_, i) => '#' + (i + 1)), [{ name: 'P(accept)', color: 'var(--accent-2)', values: x.accept_by_pos }], { yFmt: (v) => fmtPct(v), yMax: 1 });
        } else accWrap.classList.add('hidden');
        const nodes = Object.values(x.nodes || {});
        if (nodes.length) {
          attribWrap.classList.remove('hidden');
          stackedBars(attrib, nodes.map((n) => ({ label: n.name, parts: [
            { name: 'compute + server', value: n.est_compute_ms, color: 'var(--accent)' },
            { name: 'network (RTT + injected)', value: n.est_network_ms, color: 'var(--warn)' }] })), { xFmt: (v) => fmtMs(v) });
        } else attribWrap.classList.add('hidden');
      });
    }

    renderHint(); renderMsgs(); renderLive(); renderSide();
    const offs = [on('session', () => { renderHint(); if (!chat.messages.length) renderMsgs(); }), on('gen', renderLive)];
    return () => offs.forEach((f) => f());
  },
};
