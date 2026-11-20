// Minimal, crisp canvas charts (sparkline, line, grouped bars, stacked bars) with hover tooltips.
import { cssVar, resolveColor } from './lib.js';

function setup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return null;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

export function alpha(color, a) {
  const c = resolveColor(color) || '#888';
  if (c.startsWith('#')) {
    let hex = c.slice(1);
    if (hex.length === 3) hex = hex.split('').map((x) => x + x).join('');
    const n = parseInt(hex, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b] = m[1].split(',').map((x) => parseFloat(x));
    return `rgba(${r},${g},${b},${a})`;
  }
  return c;
}

function niceTicks(min, max, count = 5) {
  if (!isFinite(min) || !isFinite(max)) return [0, 1];
  if (max === min) { max = min + 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(10));
  return out;
}

// ------------------------------------------------------------------ tooltip
let tip;
function showTip(html, x, y) {
  if (!tip) {
    tip = document.createElement('div');
    tip.style.cssText = 'position:fixed;z-index:300;pointer-events:none;background:var(--surface);border:1px solid var(--border-2);' +
      'border-radius:9px;padding:8px 10px;font:12px var(--font);color:var(--text);box-shadow:var(--shadow);max-width:280px;white-space:nowrap';
    document.body.append(tip);
  }
  tip.innerHTML = html;
  tip.style.display = 'block';
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.min(window.innerWidth - r.width - 8, x + 14) + 'px';
  tip.style.top = Math.max(8, y - r.height - 10) + 'px';
}
function hideTip() { if (tip) tip.style.display = 'none'; }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function bindHover(canvas) {
  if (canvas._hoverBound) return;
  canvas._hoverBound = true;
  canvas.addEventListener('mousemove', (e) => {
    const hits = canvas._hits || [];
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let best = null;
    let bd = 1e9;
    for (const hit of hits) {
      const inside = hit.rect && x >= hit.rect[0] && x <= hit.rect[0] + hit.rect[2] && y >= hit.rect[1] && y <= hit.rect[1] + hit.rect[3];
      const d = inside ? 0 : hit.px != null ? Math.hypot(hit.px - x, (hit.py - y) * 0.6) : 1e9;
      if (d < bd) { bd = d; best = hit; }
    }
    if (best && bd < 28) showTip(best.html, e.clientX, e.clientY);
    else hideTip();
  });
  canvas.addEventListener('mouseleave', hideTip);
}

// ------------------------------------------------------------------ sparkline
export function sparkline(canvas, values, { color = 'var(--accent)', max = null, min = 0, fill = true, width = 1.6 } = {}) {
  const s = setup(canvas);
  if (!s) return;
  const { ctx, w, h } = s;
  const vals = values.map((v) => (v == null || isNaN(v) ? null : v));
  const real = vals.filter((v) => v != null);
  if (real.length < 2) return;
  const mx = max ?? Math.max(...real, 1e-9);
  const mn = min ?? Math.min(...real);
  const n = vals.length;
  const c = resolveColor(color);
  ctx.beginPath();
  let started = false;
  vals.forEach((v, i) => {
    if (v == null) return;
    const x = (i / (n - 1)) * w;
    const y = h - 2 - ((v - mn) / (mx - mn || 1)) * (h - 4);
    if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
  });
  ctx.strokeStyle = c;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.stroke();
  if (fill) {
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, alpha(c, 0.28));
    g.addColorStop(1, alpha(c, 0));
    ctx.fillStyle = g;
    ctx.fill();
  }
}

// ------------------------------------------------------------------ line chart
// series: [{name, color, points: [[x, y, err?], ...], dash}]
export function lineChart(canvas, series, opts = {}) {
  const s = setup(canvas);
  if (!s) return;
  const { ctx, w, h } = s;
  const { xFmt = (v) => v, yFmt = (v) => v, xLabel = '', yLabel = '', yMin = 0, yMax = null, area = false, dots = true } = opts;
  const pts = series.flatMap((x) => x.points);
  canvas._hits = [];
  bindHover(canvas);
  const muted = cssVar('--muted');
  const grid = cssVar('--border');
  if (!pts.length) {
    ctx.fillStyle = muted;
    ctx.font = '12px ' + cssVar('--font');
    ctx.textAlign = 'center';
    ctx.fillText(opts.empty || 'No data yet', w / 2, h / 2);
    return;
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1] + (p[2] || 0));
  let x0 = Math.min(...xs), x1 = Math.max(...xs);
  if (x0 === x1) { x0 -= 1; x1 += 1; }
  const yt = niceTicks(yMin ?? Math.min(...pts.map((p) => p[1])), yMax ?? Math.max(...ys) * 1.05, 4);
  const y0 = yt[0], y1 = yt[yt.length - 1];
  const L = 48, R = 14, T = 12, B = xLabel ? 40 : 26;
  const pw = w - L - R, ph = h - T - B;
  const X = (v) => L + ((v - x0) / (x1 - x0)) * pw;
  const Y = (v) => T + ph - ((v - y0) / (y1 - y0 || 1)) * ph;
  ctx.font = '11px ' + cssVar('--font');
  ctx.strokeStyle = grid;
  ctx.fillStyle = muted;
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of yt) {
    const y = Math.round(Y(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke();
    ctx.fillText(yFmt(v), L - 8, y);
  }
  const xt = opts.xTicks || niceTicks(x0, x1, Math.max(2, Math.min(6, Math.floor(pw / 90)))).filter((v) => v >= x0 && v <= x1);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const v of xt) ctx.fillText(xFmt(v), X(v), T + ph + 7);
  if (xLabel) { ctx.fillText(xLabel, L + pw / 2, h - 14); }
  if (yLabel) {
    ctx.save(); ctx.translate(11, T + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle'; ctx.fillText(yLabel, 0, 0); ctx.restore();
  }
  for (const sr of series) {
    const c = resolveColor(sr.color);
    const P = [...sr.points].sort((a, b) => a[0] - b[0]);
    if (!P.length) continue;
    if (area) {
      ctx.beginPath();
      P.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
      ctx.lineTo(X(P[P.length - 1][0]), Y(y0)); ctx.lineTo(X(P[0][0]), Y(y0)); ctx.closePath();
      const g = ctx.createLinearGradient(0, T, 0, T + ph);
      g.addColorStop(0, alpha(c, 0.22)); g.addColorStop(1, alpha(c, 0));
      ctx.fillStyle = g; ctx.fill();
    }
    if (opts.lines !== false) {
      ctx.beginPath();
      ctx.setLineDash(sr.dash ? [5, 4] : []);
      P.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
      ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const p of P) {
      const px = X(p[0]), py = Y(p[1]);
      if (p[2]) {
        ctx.beginPath(); ctx.moveTo(px, Y(p[1] - p[2])); ctx.lineTo(px, Y(p[1] + p[2]));
        ctx.strokeStyle = alpha(c, 0.6); ctx.lineWidth = 1.5; ctx.stroke();
      }
      if (dots) {
        ctx.beginPath(); ctx.arc(px, py, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = cssVar('--surface'); ctx.fill(); ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.stroke();
      }
      canvas._hits.push({ px, py, html: `<b>${esc(sr.name)}</b><br>${esc(xLabel || 'x')}: ${esc(xFmt(p[0]))}<br>${esc(yLabel || 'y')}: <b>${esc(yFmt(p[1]))}</b>${p[2] ? ' ± ' + esc(yFmt(p[2])) : ''}` });
    }
  }
}

// ------------------------------------------------------------------ grouped bar chart
// cats: [label]; series: [{name, color, values: [v], errs: [e]}]
export function barChart(canvas, cats, series, opts = {}) {
  const s = setup(canvas);
  if (!s) return;
  const { ctx, w, h } = s;
  const { yFmt = (v) => v, yLabel = '', yMax = null, colorsPerCat = null } = opts;
  canvas._hits = [];
  bindHover(canvas);
  const muted = cssVar('--muted');
  const vals = series.flatMap((sr) => sr.values.map((v, i) => (v || 0) + ((sr.errs && sr.errs[i]) || 0)));
  if (!cats.length || !vals.length) {
    ctx.fillStyle = muted; ctx.font = '12px ' + cssVar('--font'); ctx.textAlign = 'center';
    ctx.fillText(opts.empty || 'No data yet', w / 2, h / 2);
    return;
  }
  const yt = niceTicks(0, yMax ?? Math.max(...vals, 1e-9) * 1.08, 4);
  const y1 = yt[yt.length - 1];
  const L = 48, R = 10, T = 10, B = opts.rotate ? 58 : 30;
  const pw = w - L - R, ph = h - T - B;
  const Y = (v) => T + ph - (v / (y1 || 1)) * ph;
  ctx.font = '11px ' + cssVar('--font');
  ctx.strokeStyle = cssVar('--border');
  ctx.fillStyle = muted;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of yt) {
    const y = Math.round(Y(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke();
    ctx.fillText(yFmt(v), L - 8, y);
  }
  if (yLabel) {
    ctx.save(); ctx.translate(11, T + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(yLabel, 0, 0); ctx.restore();
  }
  const gw = pw / cats.length;
  const bw = Math.min(46, Math.max(1, (gw * (cats.length > 40 ? 0.9 : 0.72)) / series.length));
  const labelEvery = Math.max(1, Math.ceil(cats.length / Math.max(1, Math.floor(pw / (opts.rotate ? 22 : 34)))));
  cats.forEach((cat, ci) => {
    const gx = L + ci * gw + (gw - bw * series.length) / 2;
    series.forEach((sr, si) => {
      const v = sr.values[ci];
      if (v == null) return;
      const c = resolveColor(colorsPerCat ? colorsPerCat[ci] : sr.color);
      const x = gx + si * bw;
      const y = Y(v);
      const g = ctx.createLinearGradient(0, y, 0, T + ph);
      g.addColorStop(0, c); g.addColorStop(1, alpha(c, 0.55));
      ctx.fillStyle = g;
      const r = Math.min(5, bw / 3);
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x + 1, y, bw - 2, T + ph - y, [r, r, 0, 0]) : ctx.rect(x + 1, y, bw - 2, T + ph - y);
      ctx.fill();
      const e = sr.errs && sr.errs[ci];
      if (e) {
        ctx.strokeStyle = cssVar('--text-2'); ctx.lineWidth = 1.3;
        const cx = x + bw / 2;
        ctx.beginPath(); ctx.moveTo(cx, Y(v + e)); ctx.lineTo(cx, Y(Math.max(0, v - e)));
        ctx.moveTo(cx - 4, Y(v + e)); ctx.lineTo(cx + 4, Y(v + e)); ctx.stroke();
      }
      canvas._hits.push({ rect: [x, y, bw, T + ph - y], html: `<b>${esc(cat)}</b>${series.length > 1 ? '<br>' + esc(sr.name) : ''}<br><b>${esc(yFmt(v))}</b>${e ? ' ± ' + esc(yFmt(e)) : ''}` });
    });
    ctx.fillStyle = muted;
    ctx.textBaseline = 'top';
    const label = String(cat);
    if (ci % labelEvery !== 0) return;
    if (opts.rotate) {
      ctx.save(); ctx.translate(L + ci * gw + gw / 2, T + ph + 6); ctx.rotate(-Math.PI / 6); ctx.textAlign = 'right';
      ctx.fillText(label.length > 26 ? label.slice(0, 25) + '…' : label, 0, 0); ctx.restore();
    } else {
      ctx.textAlign = 'center';
      const maxc = Math.max(4, Math.floor(gw / 6.5));
      ctx.fillText(label.length > maxc ? label.slice(0, maxc - 1) + '…' : label, L + ci * gw + gw / 2, T + ph + 7);
    }
  });
}

// ------------------------------------------------------------------ stacked horizontal bars
// rows: [{label, parts: [{name, value, color}]}]
export function stackedBars(canvas, rows, opts = {}) {
  const s = setup(canvas);
  if (!s) return;
  const { ctx, w, h } = s;
  const { xFmt = (v) => v } = opts;
  canvas._hits = [];
  bindHover(canvas);
  const muted = cssVar('--muted');
  if (!rows.length) {
    ctx.fillStyle = muted; ctx.font = '12px ' + cssVar('--font'); ctx.textAlign = 'center';
    ctx.fillText(opts.empty || 'No data yet', w / 2, h / 2);
    return;
  }
  const total = Math.max(...rows.map((r) => r.parts.reduce((a, p) => a + (p.value || 0), 0)), 1e-9);
  const L = Math.min(150, Math.max(70, Math.max(...rows.map((r) => r.label.length)) * 7)), R = 70, T = 6;
  const rh = Math.min(30, (h - T * 2) / rows.length);
  ctx.font = '12px ' + cssVar('--font');
  rows.forEach((row, i) => {
    const y = T + i * rh + 4;
    const bh = rh - 9;
    ctx.fillStyle = cssVar('--text-2'); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(row.label.length > 20 ? row.label.slice(0, 19) + '…' : row.label, L - 10, y + bh / 2);
    let x = L;
    let sum = 0;
    for (const p of row.parts) {
      const pw = ((p.value || 0) / total) * (w - L - R);
      if (pw <= 0) continue;
      ctx.fillStyle = resolveColor(p.color);
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x, y, Math.max(pw - 1, 1), bh, 4) : ctx.rect(x, y, pw, bh);
      ctx.fill();
      canvas._hits.push({ rect: [x, y, pw, bh], html: `<b>${esc(row.label)}</b><br>${esc(p.name)}: <b>${esc(xFmt(p.value))}</b>` });
      x += pw;
      sum += p.value || 0;
    }
    ctx.fillStyle = muted; ctx.textAlign = 'left';
    ctx.fillText(xFmt(sum), x + 8, y + bh / 2);
  });
}
