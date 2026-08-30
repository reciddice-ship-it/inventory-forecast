/**
 * charts.js — inline SVG charts, no libraries.
 *
 * Two forms only, each with a single measure on a single axis:
 *   barChart()  magnitude over discrete periods (spend per week / per month)
 *   lineChart() change over time, actual vs forecast of the SAME measure
 *
 * Deliberately no dual-axis chart anywhere: units and dollars are different
 * scales and get their own panels.
 */

const NS = 'http://www.w3.org/2000/svg';

/* ------------------------------ tooltip ---------------------------- */

let tip;
function tooltip() {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tooltip';
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  return tip;
}
function showTip(html, evt) {
  const t = tooltip();
  t.innerHTML = html;
  t.hidden = false;
  const pad = 14;
  const r = t.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY - r.height - pad;
  if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y < 8) y = evt.clientY + pad;
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}
function hideTip() { if (tip) tip.hidden = true; }

/* ------------------------------ scales ----------------------------- */

/** A "nice" upper bound and tick step for 0..max. */
export function niceScale(max, targetTicks = 5) {
  if (!(max > 0)) return { max: 1, step: 1, ticks: [0, 1] };
  const rough = max / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { max: top, step, ticks };
}

function el(name, attrs = {}, text) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}

/** Bar with rounded top corners, square on the baseline. */
function barPath(x, y, w, h, r) {
  const rad = Math.min(r, w / 2, Math.max(0, h));
  if (h <= 0.5) return `M${x} ${y + h}h${w}`;
  return `M${x} ${y + h}V${y + rad}a${rad} ${rad} 0 0 1 ${rad} ${-rad}h${w - 2 * rad}a${rad} ${rad} 0 0 1 ${rad} ${rad}V${y + h}Z`;
}

/* ----------------------------- bar chart --------------------------- */

/**
 * @param {HTMLElement} host
 * @param {{labels:string[], values:number[], format?:fn, labelFormat?:fn,
 *          tipTitle?:fn, height?:number, everyNthLabel?:number}} o
 */
export function barChart(host, o) {
  const values = o.values || [];
  const labels = o.labels || [];
  const fmt = o.format || ((v) => String(v));
  const H = o.height || 240;
  const W = Math.max(host.clientWidth || 640, 320);
  const m = { top: 14, right: 8, bottom: 34, left: 62 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;

  host.textContent = '';
  if (!values.length) { host.innerHTML = '<p class="empty">No data to plot yet.</p>'; return; }

  const scale = niceScale(Math.max(...values, 0));
  const y = (v) => m.top + ih - (v / scale.max) * ih;
  const step = iw / values.length;
  const bw = Math.max(2, Math.min(56, step - 4)); // >= 2px surface gap between bars

  const svg = el('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, width: '100%', height: H,
                          role: 'img', 'aria-label': o.ariaLabel || 'Bar chart' });

  for (const t of scale.ticks) {
    svg.appendChild(el('line', { class: t === 0 ? 'axis-line' : 'grid-line', x1: m.left, x2: W - m.right, y1: y(t), y2: y(t) }));
    svg.appendChild(el('text', { class: 'tick y', x: m.left - 10, y: y(t) + 4 }, fmt(t)));
  }

  // Thin the x labels by available width, not just by count: a narrow panel
  // needs a bigger stride than a wide one for the same number of bars.
  const nth = o.everyNthLabel || Math.max(1, Math.ceil(52 / step));
  values.forEach((v, i) => {
    const x = m.left + i * step + (step - bw) / 2;
    const h = Math.max(0, (v / scale.max) * ih);
    const hit = el('rect', { class: 'bar-hit', x: m.left + i * step, y: m.top, width: step, height: ih, tabindex: 0 });
    const bar = el('path', { class: 'bar', d: barPath(x, y(v), bw, h, 4) });
    const tipHtml = `<b>${o.tipTitle ? o.tipTitle(labels[i], i) : labels[i]}</b><br>${fmt(v)}`;
    hit.addEventListener('mousemove', (e) => showTip(tipHtml, e));
    hit.addEventListener('mouseleave', hideTip);
    hit.addEventListener('focus', (e) => {
      const r = hit.getBoundingClientRect();
      showTip(tipHtml, { clientX: r.left + r.width / 2, clientY: r.top + 20 });
    });
    hit.addEventListener('blur', hideTip);
    svg.appendChild(hit);
    svg.appendChild(bar);

    if (i % nth === 0) {
      svg.appendChild(el('text', { class: 'tick', x: m.left + i * step + step / 2, y: H - 12, 'text-anchor': 'middle' },
        o.labelFormat ? o.labelFormat(labels[i], i) : labels[i]));
    }
  });

  host.appendChild(svg);
}

/* ---------------------------- line chart --------------------------- */

/**
 * @param {{labels:string[], series:{name:string, values:(number|null)[], dashed?:boolean}[],
 *          format?:fn, labelFormat?:fn, height?:number}} o
 */
export function lineChart(host, o) {
  const series = (o.series || []).filter((s) => s.values?.length);
  const labels = o.labels || [];
  const fmt = o.format || ((v) => String(v));
  const H = o.height || 240;
  const W = Math.max(host.clientWidth || 640, 320);
  const m = { top: 14, right: 12, bottom: 34, left: 56 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;

  host.textContent = '';
  if (!series.length || !labels.length) { host.innerHTML = '<p class="empty">No data to plot yet.</p>'; return; }

  const all = series.flatMap((s) => s.values).filter((v) => v != null && Number.isFinite(v));
  const scale = niceScale(Math.max(...all, 0));
  const x = (i) => m.left + (labels.length === 1 ? iw / 2 : (i / (labels.length - 1)) * iw);
  const y = (v) => m.top + ih - (v / scale.max) * ih;

  const svg = el('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, width: '100%', height: H,
                          role: 'img', 'aria-label': o.ariaLabel || 'Line chart' });

  for (const t of scale.ticks) {
    svg.appendChild(el('line', { class: t === 0 ? 'axis-line' : 'grid-line', x1: m.left, x2: W - m.right, y1: y(t), y2: y(t) }));
    svg.appendChild(el('text', { class: 'tick y', x: m.left - 10, y: y(t) + 4 }, fmt(t)));
  }

  for (const s of series) {
    let d = '';
    let pen = false;
    s.values.forEach((v, i) => {
      if (v == null || !Number.isFinite(v)) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(2)} ${y(v).toFixed(2)}`;
      pen = true;
    });
    if (d) svg.appendChild(el('path', { class: `line${s.dashed ? ' forecast' : ''}`, d }));
  }

  const nth = Math.max(1, Math.ceil(58 / (iw / Math.max(1, labels.length - 1))));
  labels.forEach((lb, i) => {
    if (i % nth === 0) {
      svg.appendChild(el('text', { class: 'tick', x: x(i), y: H - 12, 'text-anchor': 'middle' },
        o.labelFormat ? o.labelFormat(lb, i) : lb));
    }
  });

  // Crosshair + shared tooltip across all series at the hovered index.
  const cross = el('line', { class: 'crosshair', y1: m.top, y2: m.top + ih, x1: 0, x2: 0, opacity: 0 });
  svg.appendChild(cross);
  const dots = series.map(() => {
    const c = el('circle', { class: 'dot', r: 4.5, opacity: 0 });
    svg.appendChild(c);
    return c;
  });

  const overlay = el('rect', { x: m.left, y: m.top, width: iw, height: ih, fill: 'transparent' });
  overlay.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(labels.length - 1,
      labels.length === 1 ? 0 : Math.round(((px - m.left) / iw) * (labels.length - 1))));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('opacity', 1);
    const rows = series.map((s, k) => {
      const v = s.values[i];
      if (v == null || !Number.isFinite(v)) { dots[k].setAttribute('opacity', 0); return null; }
      dots[k].setAttribute('cx', x(i)); dots[k].setAttribute('cy', y(v)); dots[k].setAttribute('opacity', 1);
      return `${s.name}: ${fmt(v)}`;
    }).filter(Boolean);
    showTip(`<b>${o.labelFormat ? o.labelFormat(labels[i], i) : labels[i]}</b><br>${rows.join('<br>')}`, e);
  });
  overlay.addEventListener('mouseleave', () => {
    cross.setAttribute('opacity', 0);
    dots.forEach((d) => d.setAttribute('opacity', 0));
    hideTip();
  });
  svg.appendChild(overlay);

  host.appendChild(svg);
}

/** Redraw charts on resize without recomputing data. */
export function onResize(fn) {
  let t;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(fn, 150); });
}
