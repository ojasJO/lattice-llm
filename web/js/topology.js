// Live cluster topology: star around this node, rings = CPU/GPU load, particles = real RPC bytes.
import { fmtMs, fmtRate, h, resolveColor } from './lib.js';

const LAPTOP = 'M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16';

export class Topology {
  constructor(svg) {
    this.svg = svg;
    this.W = 1000; this.H = 400;
    svg.setAttribute('viewBox', `0 0 ${this.W} ${this.H}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    this.gEdges = h('g');
    this.gParticles = h('g');
    this.gNodes = h('g');
    const defs = h('defs', h('radialGradient', { id: 'nodeGlow' },
      h('stop', { offset: '0%', 'stop-color': 'var(--accent)', 'stop-opacity': '0.28' }),
      h('stop', { offset: '100%', 'stop-color': 'var(--accent)', 'stop-opacity': '0' })));
    svg.append(defs, this.gEdges, this.gParticles, this.gNodes);
    this.nodes = new Map();
    this.edges = new Map();
    this.particles = [];
    this.key = '';
    this.last = performance.now();
    this.alive = true;
    const loop = (t) => {
      if (!this.alive) return;
      if (!this.svg.isConnected) { this.alive = false; return; }
      this.tick(t);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  destroy() { this.alive = false; }

  layout(model) {
    const W = this.W, H = this.H;
    const n = model.nodes.length;
    const pos = new Map();
    if (!n) return pos;
    const center = model.nodes[0];
    if (n === 1) { pos.set(center.id, [W / 2, H / 2 - 20]); return pos; }
    if (n === 2) {
      pos.set(center.id, [W * 0.22, H / 2 - 20]);
      pos.set(model.nodes[1].id, [W * 0.78, H / 2 - 20]);
      return pos;
    }
    pos.set(center.id, [W / 2, H / 2 - 20]);
    const others = model.nodes.slice(1);
    others.forEach((nd, i) => {
      const a = -Math.PI / 2 + (i / others.length) * Math.PI * 2 + (others.length % 2 ? 0 : Math.PI / others.length);
      pos.set(nd.id, [W / 2 + Math.cos(a) * Math.min(W * 0.36, 420), H / 2 - 20 + Math.sin(a) * 130]);
    });
    return pos;
  }

  update(model) {
    this.model = model;
    const cw = Math.round(this.svg.clientWidth || 0);
    if (cw > 300 && Math.abs(cw - this.W) > 4) {
      this.W = cw;
      this.svg.setAttribute('viewBox', `0 0 ${this.W} ${this.H}`);
      this.key = '';
    }
    const key = model.nodes.map((n) => n.id).join('|');
    if (key !== this.key) this.rebuild(model);
    for (const nd of model.nodes) {
      const v = this.nodes.get(nd.id);
      if (!v) continue;
      const C = 2 * Math.PI * 40, C2 = 2 * Math.PI * 31;
      v.cpu.setAttribute('stroke-dasharray', `${Math.max(0.001, (nd.cpu || 0) / 100) * C} ${C}`);
      v.gpu.setAttribute('stroke-dasharray', `${Math.max(0.001, (nd.gpu || 0) / 100) * C2} ${C2}`);
      v.cpu.setAttribute('stroke', nd.color);
      v.name.textContent = nd.name;
      v.sub.textContent = nd.sub || '';
      v.sub2.textContent = nd.sub2 || '';
      v.g.style.opacity = nd.online ? 1 : 0.38;
      v.glow.style.opacity = nd.active ? 1 : 0;
      v.icon.setAttribute('stroke', nd.active ? 'var(--accent)' : 'var(--text-2)');
    }
    for (const e of model.edges) {
      const v = this.edges.get(e.b);
      if (!v) continue;
      v.e = e;
      v.line.setAttribute('stroke', e.active ? 'var(--accent)' : 'var(--border-2)');
      v.line.setAttribute('stroke-dasharray', e.active ? '' : '5 6');
      v.line.setAttribute('stroke-opacity', e.active ? 0.55 : 1);
      v.line.setAttribute('stroke-width', e.active ? 2 : 1.5);
      const flowing = e.active || e.up > 512 || e.down > 512;
      v.label.textContent = flowing ? `↑ ${fmtRate(e.up)}   ↓ ${fmtRate(e.down)}` : (e.online ? 'paired' : 'offline');
      const bb = v.label.getBBox ? v.label.getBBox() : { width: 120, height: 14 };
      v.bg.setAttribute('x', bb.x - 9); v.bg.setAttribute('y', bb.y - 4);
      v.bg.setAttribute('width', bb.width + 18); v.bg.setAttribute('height', bb.height + 8);
      const sub = [];
      if (e.rtt != null) sub.push(`rtt ${fmtMs(e.rtt)}`);
      if (e.delay) sub.push(`+${e.delay} ms injected`);
      if (e.phase && e.phase !== 'idle' && e.phase !== 'connected') sub.push(e.phase);
      v.phase.textContent = sub.join(' · ');
    }
  }

  rebuild(model) {
    this.key = model.nodes.map((n) => n.id).join('|');
    this.gEdges.replaceChildren(); this.gNodes.replaceChildren(); this.gParticles.replaceChildren();
    this.nodes.clear(); this.edges.clear(); this.particles = [];
    this.pos = this.layout(model);
    const [cx, cy] = this.pos.get(model.nodes[0]?.id) || [this.W / 2, this.H / 2];
    for (const nd of model.nodes.slice(1)) {
      const [x, y] = this.pos.get(nd.id);
      const line = h('line', { x1: cx, y1: cy, x2: x, y2: y, 'stroke-linecap': 'round' });
      const mx = (cx + x) / 2, my = (cy + y) / 2;
      const label = h('text.edge-lbl', { x: mx, y: my - 24, 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
      const phase = h('text.sub', { x: mx, y: my + 26, 'text-anchor': 'middle' });
      const bg = h('rect.edge-bg', { rx: 8 });
      this.gEdges.append(line, bg, label, phase);
      this.edges.set(nd.id, { line, label, bg, phase, a: [cx, cy], b: [x, y], acc: { up: 0, down: 0 } });
    }
    for (const nd of model.nodes) {
      const [x, y] = this.pos.get(nd.id);
      const glow = h('circle', { r: 66, fill: 'url(#nodeGlow)' });
      const ringBg = h('circle', { r: 40, fill: 'none', stroke: 'var(--surface-3)', 'stroke-width': 7 });
      const cpu = h('circle', { r: 40, fill: 'none', 'stroke-width': 7, 'stroke-linecap': 'round', transform: 'rotate(-90)', style: { transition: 'stroke-dasharray .6s ease' } });
      const ring2 = h('circle', { r: 31, fill: 'none', stroke: 'var(--surface-3)', 'stroke-width': 4 });
      const gpu = h('circle', { r: 31, fill: 'none', stroke: 'var(--accent-2)', 'stroke-width': 4, 'stroke-linecap': 'round', transform: 'rotate(-90)', style: { transition: 'stroke-dasharray .6s ease' } });
      const core = h('circle', { r: 25, fill: 'var(--surface)', stroke: nd.self ? 'var(--accent)' : 'var(--border-2)', 'stroke-width': 1.5, 'stroke-dasharray': nd.self ? '3 3' : '' });
      const icon = h('path', { d: LAPTOP, fill: 'none', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', transform: 'translate(-12,-12)' });
      const name = h('text.lbl', { y: 66, 'text-anchor': 'middle' });
      const sub = h('text.sub', { y: 83, 'text-anchor': 'middle' });
      const sub2 = h('text.sub', { y: 98, 'text-anchor': 'middle' });
      const g = h('g', { transform: `translate(${x},${y})`, style: { transition: 'opacity .3s' } },
        h('title', nd.self ? 'This node' : nd.name), glow, ringBg, cpu, ring2, gpu, core, icon, name, sub, sub2);
      this.gNodes.append(g);
      this.nodes.set(nd.id, { g, cpu, gpu, name, sub, sub2, glow, icon });
    }
  }

  tick(t) {
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    if (!this.model) return;
    for (const [, v] of this.edges) {
      const e = v.e;
      if (!e) continue;
      for (const dir of ['up', 'down']) {
        const rate = e[dir] || 0;
        if (rate < 64) continue;
        const perSec = Math.min(26, Math.max(1.5, (Math.log10(rate) - 1.5) * 4.5));
        v.acc[dir] += perSec * dt;
        while (v.acc[dir] >= 1 && this.particles.length < 400) {
          v.acc[dir] -= 1;
          const r = Math.min(4.2, 1.6 + Math.max(0, Math.log10(rate) - 3) * 0.7);
          const c = h('circle', { r, fill: dir === 'up' ? 'var(--up)' : 'var(--down)' });
          c.style.filter = `drop-shadow(0 0 4px ${resolveColor(dir === 'up' ? 'var(--up)' : 'var(--down)')})`;
          this.gParticles.append(c);
          const speed = 0.85 / (1 + (e.delay || 0) / 40);
          this.particles.push({ c, v, dir, t: 0, speed: speed * (0.85 + Math.random() * 0.3), off: (Math.random() - 0.5) * 6 });
        }
      }
    }
    const keep = [];
    for (const p of this.particles) {
      p.t += p.speed * dt;
      if (p.t >= 1) { p.c.remove(); continue; }
      const [ax, ay] = p.dir === 'up' ? p.v.a : p.v.b;
      const [bx, by] = p.dir === 'up' ? p.v.b : p.v.a;
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const nx = -(by - ay) / len, ny = (bx - ax) / len;
      const side = p.dir === 'up' ? -4 : 4;
      const x = ax + (bx - ax) * p.t + nx * (side + p.off);
      const y = ay + (by - ay) * p.t + ny * (side + p.off);
      p.c.setAttribute('cx', x);
      p.c.setAttribute('cy', y);
      p.c.setAttribute('opacity', Math.min(1, Math.sin(p.t * Math.PI) * 1.6));
      keep.push(p);
    }
    this.particles = keep;
  }
}
