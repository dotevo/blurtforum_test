/**
 * mini-charts — a small, dependency-free SVG charting library that replaces
 * apexcharts/vue3-apexcharts for the three chart shapes this app actually
 * uses: a donut, a zoomable stacked/grouped bar chart, and a dual-axis
 * combo (bar + line) chart with click-to-select and an annotation line.
 *
 * Framework-agnostic on purpose: each `render*` function takes a plain
 * HTMLElement and returns `{ update(opts), destroy() }`. The thin Vue
 * wrapper components in this folder just call these from onMounted /
 * watch / onBeforeUnmount, the same lifecycle shape the old
 * `new ApexCharts(el, options); chart.updateOptions(...); chart.destroy()`
 * pattern used, so call sites barely changed.
 *
 * Ported from a demo that was hand-tested (incl. on a real phone) for:
 *  - the y-axis "top gridline < tallest bar" bug niceTicks() fixes below,
 *  - legend toggle actually staying visually greyed out after re-render,
 *  - touch pan/pinch-zoom that doesn't get cancelled mid-gesture (this is
 *    why the bar chart never removes/recreates its <rect> nodes — see the
 *    long comment inside renderBars),
 *  - clip-path living on a *static* wrapper so zoomed content doesn't
 *    spill out of the chart box.
 */

// ────────────────────────────────────────────────────────────────────────
// shared helpers
// ────────────────────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {}
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  for (const k in attrs) node.setAttribute(k, String(attrs[k]));
  return node;
}

export interface TooltipRow {
  color: string;
  label: string;
  value: string;
}

/** One tooltip element shared by every chart on the page (lazily created). */
let sharedTooltipEl: HTMLDivElement | null = null;
function getTooltipEl(): HTMLDivElement {
  if (sharedTooltipEl) return sharedTooltipEl;
  const el = document.createElement('div');
  el.className = 'mini-chart-tooltip';
  Object.assign(el.style, {
    position: 'fixed',
    pointerEvents: 'none',
    zIndex: '2000',
    background: '#0c0e12',
    border: '1px solid var(--border-main)',
    borderRadius: '6px',
    padding: '8px 10px',
    fontSize: '11px',
    color: 'var(--text)',
    boxShadow: '0 6px 18px rgba(0,0,0,.4)',
    opacity: '0',
    transform: 'translateY(4px)',
    transition: 'opacity .1s ease',
    minWidth: '120px',
  } as CSSStyleDeclaration);
  document.body.appendChild(el);
  sharedTooltipEl = el;
  return el;
}

function showTooltip(x: number, y: number, title: string | null, rows: TooltipRow[], html?: string): void {
  const el = getTooltipEl();
  el.innerHTML = html ?? (
    (title ? `<div style="font-weight:600;margin-bottom:4px;color:var(--text-muted);font-size:10px;text-transform:uppercase;letter-spacing:.02em;">${title}</div>` : '') +
    rows.map(r => `<div style="display:flex;align-items:center;gap:6px;white-space:nowrap;"><span style="width:8px;height:8px;border-radius:2px;flex:none;background:${r.color}"></span>${r.label}<span style="margin-left:auto;font-variant-numeric:tabular-nums;padding-left:14px;font-weight:600;">${r.value}</span></div>`).join('')
  );
  el.style.left = x + 14 + 'px';
  el.style.top = y + 14 + 'px';
  el.style.opacity = '1';
  el.style.transform = 'translateY(0)';
}
function hideTooltip(): void {
  if (!sharedTooltipEl) return;
  sharedTooltipEl.style.opacity = '0';
  sharedTooltipEl.style.transform = 'translateY(4px)';
}

/**
 * Pick ~`count` round gridline values covering [0, max]. The tick count is
 * computed up front with Math.ceil so the LAST tick is always >= max — an
 * earlier floating `for (v=0; v<=max; v+=step)` version could stop one
 * step short of the real max and let bars render above the top gridline.
 */
function niceTicks(max: number, count: number): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const n = Math.ceil(max / step - 1e-9);
  const ticks: number[] = [];
  for (let i = 0; i <= n; i++) ticks.push(+(i * step).toFixed(6));
  return ticks;
}

function buildLegend(
  container: HTMLElement,
  items: { label?: string; name?: string; color: string; hidden: boolean; dashed?: boolean }[],
  onToggle: (index: number) => void
): void {
  const legend = document.createElement('div');
  legend.className = 'mini-chart-legend';
  Object.assign(legend.style, { display: 'flex', flexWrap: 'wrap', gap: '10px 16px', padding: '8px 0 2px', fontSize: '11px', color: 'var(--text-muted)' } as CSSStyleDeclaration);
  items.forEach((it, i) => {
    const item = document.createElement('div');
    item.className = 'mini-chart-legend-item' + (it.hidden ? ' off' : '');
    Object.assign(item.style, { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', userSelect: 'none', opacity: it.hidden ? '.35' : '1' } as CSSStyleDeclaration);
    const swatch = it.dashed
      ? `<span style="background:none;border-bottom:2px dashed ${it.color};height:0;width:12px;display:inline-block;"></span>`
      : `<span style="width:9px;height:9px;border-radius:2px;flex:none;display:inline-block;background:${it.color}"></span>`;
    item.innerHTML = `${swatch}${it.label ?? it.name ?? ''}`;
    item.addEventListener('click', () => {
      it.hidden = !it.hidden;
      item.style.opacity = it.hidden ? '.35' : '1';
      onToggle(i);
    });
    legend.appendChild(item);
  });
  container.appendChild(legend);
}

// ────────────────────────────────────────────────────────────────────────
// DONUT
// ────────────────────────────────────────────────────────────────────────

export interface DonutOptions {
  labels: string[];
  colors: string[];
  totalLabel?: string;
}
export interface ChartHandle<TSeries, TOptions> {
  update(series: TSeries, opts?: Partial<TOptions>): void;
  destroy(): void;
}

export function renderDonut(
  container: HTMLElement,
  series: number[],
  opts: DonutOptions
): ChartHandle<number[], DonutOptions> {
  const W = 260, H = 220, cx = W / 2, cy = 92, r = 70, thickness = 26;
  let currentSeries = series;
  let currentOpts = opts;
  const items = opts.labels.map((label, i) => ({ label, color: opts.colors[i], hidden: false }));

  function draw(): void {
    container.innerHTML = '';
    const total = items.reduce((s, it, i) => s + (it.hidden ? 0 : currentSeries[i] || 0), 0) || 1;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: '100%' });
    (svg.style as CSSStyleDeclaration).display = 'block';
    const circumference = 2 * Math.PI * r;
    let acc = 0;

    svg.appendChild(svgEl('circle', { cx, cy, r, fill: 'none', stroke: 'var(--border-main)', 'stroke-width': thickness }));

    items.forEach((it, i) => {
      const value = currentSeries[i] || 0;
      if (it.hidden || value <= 0) return;
      const frac = value / total;
      const len = frac * circumference;
      const c = svgEl('circle', {
        cx, cy, r, fill: 'none', stroke: it.color, 'stroke-width': thickness,
        'stroke-dasharray': `${len} ${circumference - len}`,
        'stroke-dashoffset': -acc,
        transform: `rotate(-90 ${cx} ${cy})`,
      });
      (c.style as CSSStyleDeclaration).cursor = 'pointer';
      (c.style as CSSStyleDeclaration).transition = 'opacity .15s';
      c.addEventListener('mousemove', e => {
        svg.querySelectorAll('circle[data-slice]').forEach(o => ((o as SVGElement).style.opacity = o === c ? '1' : '.35'));
        showTooltip(e.clientX, e.clientY, null, [{ color: it.color, label: it.label, value: `${value.toFixed(2)} (${(frac * 100).toFixed(1)}%)` }]);
      });
      c.addEventListener('mouseleave', () => {
        svg.querySelectorAll('circle[data-slice]').forEach(o => ((o as SVGElement).style.opacity = '1'));
        hideTooltip();
      });
      c.setAttribute('data-slice', '1');
      svg.appendChild(c);
      acc += len;
    });

    const centerLabel = svgEl('text', { x: cx, y: cy - 4, 'text-anchor': 'middle' });
    centerLabel.setAttribute('style', 'fill:var(--text-muted);font-size:10px;');
    centerLabel.textContent = currentOpts.totalLabel ?? 'RAZEM';
    const centerVal = svgEl('text', { x: cx, y: cy + 14, 'text-anchor': 'middle' });
    centerVal.setAttribute('style', 'fill:var(--text);font-size:16px;font-weight:600;');
    centerVal.textContent = total.toFixed(2);
    svg.appendChild(centerLabel);
    svg.appendChild(centerVal);

    container.appendChild(svg);
    buildLegend(container, items, draw);
  }
  draw();

  return {
    update(newSeries, newOpts) {
      currentSeries = newSeries;
      if (newOpts) currentOpts = { ...currentOpts, ...newOpts };
      draw();
    },
    destroy() {
      container.innerHTML = '';
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// BAR (grouped or stacked, with pinch/wheel zoom + drag/touch pan)
// ────────────────────────────────────────────────────────────────────────

export interface BarSeriesInput {
  name: string;
  color: string;
  data: number[];
}
export interface BarOptions {
  categories: string[];
  series: BarSeriesInput[];
  stacked?: boolean;
  height?: number;
  zoomable?: boolean;
}

export function renderBars(container: HTMLElement, opts: BarOptions): ChartHandle<BarOptions, BarOptions> {
  // Preserve the user's current zoom window across data refreshes
  // (update()) rather than snapping back to fully-zoomed-out every time —
  // stored outside build() so it survives re-renders.
  let winLen = -1; // -1 sentinel = "not initialized yet" (first build defaults to full range)
  let winStart = 0;

  function build(o: BarOptions): void {
    const items = o.series.map(s => ({ ...s, hidden: false }));
    const W = 640, H = o.height || 260;
    const padL = 34, padR = 8, padT = 10, padB = 26;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const fullLen = o.categories.length;
    const zoomable = !!o.zoomable;
    const MIN_WINDOW = Math.min(5, fullLen);
    if (winLen < 0 || winLen > fullLen) winLen = fullLen;
    winStart = Math.max(0, Math.min(fullLen - winLen, winStart));

    const clampWindow = () => {
      winLen = Math.max(MIN_WINDOW, Math.min(fullLen, winLen));
      winStart = Math.max(0, Math.min(fullLen - winLen, winStart));
    };

    const maxValFull = o.stacked
      ? Math.max(1, ...o.categories.map((_, ci) => items.reduce((s, ser) => s + (ser.data[ci] || 0), 0)))
      : Math.max(1, ...items.flatMap(s => s.data));
    const ticks = niceTicks(maxValFull, 4);
    const yMax = ticks[ticks.length - 1] || 1;
    const y = (v: number) => padT + plotH - (v / yMax) * plotH;

    const virtualUnitW = plotW / fullLen;
    const groupGap = virtualUnitW * 0.28;
    const barsInGroup = o.stacked ? 1 : Math.max(1, items.length);
    const barW = (virtualUnitW - groupGap) / barsInGroup;
    const clipId = 'clip_' + Math.random().toString(36).slice(2, 9);

    container.innerHTML = '';
    container.classList.toggle('mini-chart-zoomable', zoomable);

    let minimapThumb: HTMLDivElement | null = null, resetBtn: HTMLButtonElement | null = null;
    if (zoomable) {
      const bar = document.createElement('div');
      Object.assign(bar.style, { display: 'flex', alignItems: 'center', gap: '8px', margin: '-4px 0 6px' } as CSSStyleDeclaration);
      const minimap = document.createElement('div');
      Object.assign(minimap.style, { flex: '1', height: '6px', background: 'var(--bg-r2)', borderRadius: '3px', position: 'relative', overflow: 'hidden' } as CSSStyleDeclaration);
      minimapThumb = document.createElement('div');
      Object.assign(minimapThumb.style, { position: 'absolute', top: '0', bottom: '0', background: 'var(--primary)', borderRadius: '3px', minWidth: '3px' } as CSSStyleDeclaration);
      minimap.appendChild(minimapThumb);
      bar.appendChild(minimap);
      const mkBtn = (label: string, title: string, fn: () => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.title = title;
        Object.assign(b.style, { background: 'var(--bg-r2)', border: '1px solid var(--border-main)', color: 'var(--text-muted)', borderRadius: '5px', width: '22px', height: '22px', cursor: 'pointer', fontSize: '13px', lineHeight: '1', flex: 'none' } as CSSStyleDeclaration);
        b.addEventListener('click', fn);
        return b;
      };
      bar.appendChild(mkBtn('+', 'Przybliż', () => { winLen *= 0.7; clampWindow(); applyTransform(); }));
      bar.appendChild(mkBtn('−', 'Oddal', () => { winLen /= 0.7; clampWindow(); applyTransform(); }));
      resetBtn = mkBtn('⤢', 'Resetuj widok', () => { winLen = fullLen; winStart = 0; applyTransform(); });
      resetBtn.style.visibility = 'hidden';
      bar.appendChild(resetBtn);
      container.appendChild(bar);
    }

    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: '100%' });
    (svg.style as CSSStyleDeclaration).display = 'block';
    container.appendChild(svg);

    const defs = svgEl('defs', {});
    const clip = svgEl('clipPath', { id: clipId });
    clip.appendChild(svgEl('rect', { x: padL, y: padT, width: plotW, height: plotH }));
    defs.appendChild(clip);
    svg.appendChild(defs);

    ticks.forEach(t => {
      const line = svgEl('line', { x1: padL, x2: W - padR, y1: y(t), y2: y(t) });
      line.setAttribute('style', 'stroke:var(--border-main);stroke-dasharray:4 4;');
      svg.appendChild(line);
      const lbl = svgEl('text', { x: padL - 6, y: y(t) + 3, 'text-anchor': 'end' });
      lbl.setAttribute('style', 'fill:var(--text-muted);font-size:9px;');
      lbl.textContent = String(t);
      svg.appendChild(lbl);
    });

    // Clip lives on a STATIC wrapper — clip-path is evaluated in its own
    // element's local coordinates, so if it sat on the same <g> we
    // zoom/pan, the clip box would scale/slide with the content, which is
    // exactly why zoomed bars used to spill outside the chart.
    const plotClip = svgEl('g', { 'clip-path': `url(#${clipId})` });
    svg.appendChild(plotClip);
    const viewport = svgEl('g', {});
    plotClip.appendChild(viewport);

    // All bars for the FULL dataset are built exactly once and never
    // removed from the DOM again — see the note above renderBars for why
    // (touch gestures get silently cancelled the instant their original
    // target node is detached).
    const rectRefs: SVGRectElement[][] = items.map(() => []);
    o.categories.forEach((cat, ci) => {
      const slotX = padL + ci * virtualUnitW + groupGap / 2;
      items.forEach((s, si) => {
        const bx = o.stacked ? slotX : slotX + si * barW;
        const rect = svgEl('rect', {
          x: bx, y: 0, width: Math.max(1, barW - (o.stacked ? 0 : 2)), height: 0,
          fill: s.color, rx: 1.5,
        });
        rect.style.cursor = 'pointer';
        rect.setAttribute('data-bar', '1');
        rect.setAttribute('data-cat', String(ci));
        rect.addEventListener('mousemove', e => {
          rectRefs.forEach(row => row.forEach(r => (r.style.opacity = '.35')));
          rectRefs.forEach(row => { if (row[ci]) row[ci].style.opacity = '1'; });
          const rows: TooltipRow[] = o.stacked
            ? items.filter(it => !it.hidden).map(it => ({ color: it.color, label: it.name, value: (it.data[ci] || 0).toFixed(2) }))
            : [{ color: s.color, label: s.name, value: (s.data[ci] || 0).toFixed(2) }];
          showTooltip(e.clientX, e.clientY, cat, rows);
        });
        rect.addEventListener('mouseleave', () => {
          rectRefs.forEach(row => row.forEach(r => (r.style.opacity = '1')));
          hideTooltip();
        });
        viewport.appendChild(rect);
        rectRefs[si][ci] = rect;
      });
    });

    const LABEL_COUNT = Math.min(7, fullLen);
    const labelEls: SVGTextElement[] = [];
    for (let i = 0; i < LABEL_COUNT; i++) {
      const t = svgEl('text', { x: 0, y: H - 8, 'text-anchor': 'middle' });
      t.setAttribute('style', 'fill:var(--text-muted);font-size:9px;');
      svg.appendChild(t);
      labelEls.push(t);
    }
    function updateLabels(): void {
      for (let i = 0; i < LABEL_COUNT; i++) {
        const idx = Math.max(0, Math.min(fullLen - 1, Math.round(winStart + (i + 0.5) * (winLen / LABEL_COUNT))));
        const screenX = padL + (idx + 0.5 - winStart) * (plotW / winLen);
        labelEls[i].setAttribute('x', String(screenX));
        labelEls[i].textContent = o.categories[idx];
      }
    }

    function recomputeBars(): void {
      o.categories.forEach((_cat, ci) => {
        let stackY = padT + plotH;
        items.forEach((s, si) => {
          const rect = rectRefs[si][ci];
          rect.style.display = s.hidden ? 'none' : '';
          if (s.hidden) return;
          const v = s.data[ci] || 0;
          const bh = plotH - (y(v) - padT);
          if (o.stacked) {
            rect.setAttribute('y', String(stackY - bh));
            rect.setAttribute('height', String(Math.max(0, bh)));
            stackY -= bh;
          } else {
            rect.setAttribute('y', String(y(v)));
            rect.setAttribute('height', String(Math.max(0, bh)));
          }
        });
      });
    }
    recomputeBars();

    function applyTransform(): void {
      clampWindow();
      const S = fullLen / winLen;
      const T = padL * (1 - S) - S * winStart * virtualUnitW;
      viewport.setAttribute('transform', `translate(${T} 0) scale(${S} 1)`);
      updateLabels();
      if (minimapThumb) {
        minimapThumb.style.left = (100 * winStart) / fullLen + '%';
        minimapThumb.style.width = (100 * winLen) / fullLen + '%';
      }
      if (resetBtn) resetBtn.style.visibility = winLen < fullLen - 0.01 ? 'visible' : 'hidden';
    }
    applyTransform();

    buildLegend(container, items, recomputeBars);

    if (zoomable) {
      let rafPending = false;
      const scheduleTransform = () => {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => { rafPending = false; applyTransform(); });
      };

      container.addEventListener('wheel', e => {
        const rect = svg.getBoundingClientRect();
        if (!rect.width) return;
        e.preventDefault();
        const relX = (e.clientX - rect.left) / rect.width;
        const centerCat = winStart + relX * winLen;
        const factor = e.deltaY < 0 ? 0.88 : 1 / 0.88;
        const newLen = Math.max(MIN_WINDOW, Math.min(fullLen, winLen * factor));
        winStart = centerCat - (centerCat - winStart) * (newLen / winLen);
        winLen = newLen;
        scheduleTransform();
      }, { passive: false });

      let dragging = false, dragStartX = 0, dragStartWin = 0;
      container.addEventListener('mousedown', e => {
        if ((e.target as HTMLElement).tagName === 'BUTTON') return;
        dragging = true; dragStartX = e.clientX; dragStartWin = winStart;
        container.classList.add('dragging');
      });
      window.addEventListener('mousemove', e => {
        if (!dragging) return;
        const rect = svg.getBoundingClientRect();
        if (!rect.width) return;
        winStart = dragStartWin - ((e.clientX - dragStartX) / rect.width) * winLen;
        scheduleTransform();
      });
      window.addEventListener('mouseup', () => { dragging = false; container.classList.remove('dragging'); });

      let pinching = false, pinchStartDist = 0, pinchStartLen = 0, pinchStartWinAtGesture = 0, pinchCenterCat = 0;
      const touchDist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

      container.addEventListener('touchstart', e => {
        const rect = svg.getBoundingClientRect();
        if (!rect.width) return;
        if (e.touches.length === 2) {
          dragging = false; pinching = true;
          pinchStartDist = touchDist(e.touches);
          pinchStartLen = winLen;
          pinchStartWinAtGesture = winStart;
          const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          pinchCenterCat = winStart + ((midX - rect.left) / rect.width) * winLen;
        } else if (e.touches.length === 1) {
          pinching = false;
          dragging = true; dragStartX = e.touches[0].clientX; dragStartWin = winStart;
          container.classList.add('dragging');
        }
      }, { passive: false });

      container.addEventListener('touchmove', e => {
        const rect = svg.getBoundingClientRect();
        if (!rect.width) return;
        if (pinching && e.touches.length === 2) {
          e.preventDefault();
          const ratio = pinchStartDist / touchDist(e.touches);
          const newLen = Math.max(MIN_WINDOW, Math.min(fullLen, pinchStartLen * ratio));
          winStart = pinchCenterCat - (pinchCenterCat - pinchStartWinAtGesture) * (newLen / pinchStartLen);
          winLen = newLen;
          scheduleTransform();
        } else if (dragging && e.touches.length === 1) {
          e.preventDefault();
          winStart = dragStartWin - ((e.touches[0].clientX - dragStartX) / rect.width) * winLen;
          scheduleTransform();
        }
      }, { passive: false });

      container.addEventListener('touchend', e => {
        if (e.touches.length < 2) pinching = false;
        if (e.touches.length === 0) { dragging = false; container.classList.remove('dragging'); }
      });
    }
  }

  build(opts);

  return {
    update(newOpts) { build(newOpts); },
    destroy() { container.innerHTML = ''; },
  };
}

// ────────────────────────────────────────────────────────────────────────
// COMBO (bar + line, optional dual y-axis, click-to-select, annotation)
// ────────────────────────────────────────────────────────────────────────

export interface ComboSeriesInput {
  name: string;
  type: 'bar' | 'line';
  data: (number | null)[];
  color: string;
  dashed?: boolean;
  /** Which y-axis this series scales against. Defaults to 'primary'. */
  axis?: 'primary' | 'secondary';
}
export interface ComboOptions {
  categories: string[];
  series: ComboSeriesInput[];
  height?: number;
  /** Index to draw a vertical annotation line + label at (e.g. "selected day"). */
  selectedIndex?: number | null;
  /** Index whose x-axis label should render in the accent color (e.g. "today"). */
  highlightIndex?: number | null;
  /** Called when the user clicks/taps a category column. */
  onSelect?: (index: number) => void;
  /** Override the default row-list tooltip with fully custom HTML. */
  tooltipHtml?: (index: number) => string;
  primaryAxisLabel?: string;
  secondaryAxisLabel?: string;
}

export function renderCombo(container: HTMLElement, opts: ComboOptions): ChartHandle<ComboOptions, ComboOptions> {
  function build(o: ComboOptions): void {
    const items = o.series.map(s => ({ ...s, hidden: false }));
    const W = 900, H = o.height || 280;
    const padL = 38, padR = 44, padT = 14, padB = 28;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const fullLen = o.categories.length;

    container.innerHTML = '';
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: '100%' });
    (svg.style as CSSStyleDeclaration).display = 'block';

    const visible = () => items.filter(s => !s.hidden);
    const primaryOf = () => visible().filter(s => (s.axis ?? 'primary') === 'primary');
    const secondaryOf = () => visible().filter(s => s.axis === 'secondary');

    const numOnly = (arr: (number | null)[]) => arr.filter((v): v is number => v != null);
    const maxPrimary = Math.max(1e-6, ...primaryOf().flatMap(s => numOnly(s.data)));
    const maxSecondary = Math.max(1e-6, ...(secondaryOf().length ? secondaryOf().flatMap(s => numOnly(s.data)) : [1]));
    const primaryTicks = niceTicks(maxPrimary, 4);
    const primaryYMax = primaryTicks[primaryTicks.length - 1] || 1;
    const yP = (v: number) => padT + plotH - (v / primaryYMax) * plotH;
    const yS = (v: number) => padT + plotH - (v / (maxSecondary * 1.15)) * plotH; // 15% headroom, matches old apex config

    const catW = plotW / fullLen;
    const x = (i: number) => padL + i * catW + catW / 2;

    // primary gridlines (left axis)
    primaryTicks.forEach(t => {
      const line = svgEl('line', { x1: padL, x2: W - padR, y1: yP(t), y2: yP(t) });
      line.setAttribute('style', 'stroke:var(--border-main);stroke-dasharray:4 4;');
      svg.appendChild(line);
      const lbl = svgEl('text', { x: padL - 6, y: yP(t) + 3, 'text-anchor': 'end' });
      lbl.setAttribute('style', 'fill:var(--text-muted);font-size:9px;');
      lbl.textContent = String(t);
      svg.appendChild(lbl);
      // secondary axis label at the SAME height, showing the secondary
      // scale's own value at that fraction — the standard way to share
      // gridlines between two independently-scaled axes.
      if (secondaryOf().length) {
        const frac = t / primaryYMax;
        const lblS = svgEl('text', { x: W - padR + 6, y: yP(t) + 3, 'text-anchor': 'start' });
        lblS.setAttribute('style', 'fill:var(--text-muted);font-size:9px;');
        lblS.textContent = (frac * maxSecondary * 1.15).toFixed(2);
        svg.appendChild(lblS);
      }
    });

    if (o.primaryAxisLabel) {
      const t = svgEl('text', { x: padL, y: 10, 'text-anchor': 'start' });
      t.setAttribute('style', 'fill:var(--text-muted);font-size:9px;');
      t.textContent = o.primaryAxisLabel;
      svg.appendChild(t);
    }
    if (o.secondaryAxisLabel && secondaryOf().length) {
      const t = svgEl('text', { x: W - padR, y: 10, 'text-anchor': 'end' });
      t.setAttribute('style', 'fill:var(--text-muted);font-size:9px;');
      t.textContent = o.secondaryAxisLabel;
      svg.appendChild(t);
    }

    // per-column invisible hit-areas: hover tooltip + click-to-select
    o.categories.forEach((_cat, ci) => {
      const hit = svgEl('rect', { x: padL + ci * catW, y: padT, width: catW, height: plotH, fill: 'transparent' });
      hit.style.cursor = o.onSelect ? 'pointer' : 'crosshair';
      hit.addEventListener('mousemove', e => hoverCol(ci, e.clientX, e.clientY));
      hit.addEventListener('mouseleave', hideTooltip);
      hit.addEventListener('click', () => o.onSelect?.(ci));
      svg.appendChild(hit);
    });

    function hoverCol(ci: number, clientX: number, clientY: number): void {
      if (o.tooltipHtml) {
        showTooltip(clientX, clientY, null, [], o.tooltipHtml(ci));
        return;
      }
      const rows: TooltipRow[] = visible().map(s => ({
        color: s.color, label: s.name,
        value: s.data[ci] == null ? '—' : (s.data[ci] as number).toFixed(3),
      }));
      showTooltip(clientX, clientY, o.categories[ci], rows);
    }

    // bar series (behind lines)
    const barSeries = visible().filter(s => s.type === 'bar');
    const barW = catW * 0.55 / Math.max(1, barSeries.length);
    o.categories.forEach((_cat, ci) => {
      barSeries.forEach((s, si) => {
        const v = s.data[ci];
        if (v == null) return;
        const scale = (s.axis ?? 'primary') === 'secondary' ? yS : yP;
        const bx = x(ci) - (barSeries.length * barW) / 2 + si * barW;
        const rect = svgEl('rect', {
          x: bx, y: scale(v), width: Math.max(1, barW - 2), height: plotH - (scale(v) - padT),
          fill: s.color, rx: 2,
        });
        rect.setAttribute('opacity', '.85');
        svg.appendChild(rect);
      });
    });

    // line series
    visible().filter(s => s.type === 'line').forEach(s => {
      const scale = (s.axis ?? 'primary') === 'secondary' ? yS : yP;
      const pts: string[] = [];
      s.data.forEach((v, i) => { if (v != null) pts.push(`${x(i)},${scale(v)}`); });
      const line = svgEl('polyline', { points: pts.join(' '), fill: 'none', stroke: s.color, 'stroke-width': 2 });
      if (s.dashed) line.setAttribute('stroke-dasharray', '6 4');
      svg.appendChild(line);
      s.data.forEach((v, i) => {
        if (v == null) return;
        const c = svgEl('circle', { cx: x(i), cy: scale(v), r: 3, fill: s.color });
        svg.appendChild(c);
      });
    });

    // annotation: vertical line + small pill label at selectedIndex
    if (o.selectedIndex != null && o.selectedIndex >= 0 && o.selectedIndex < fullLen) {
      const ax = x(o.selectedIndex);
      const line = svgEl('line', { x1: ax, x2: ax, y1: padT, y2: padT + plotH });
      line.setAttribute('style', 'stroke:var(--primary);stroke-width:1.5;');
      svg.appendChild(line);
      const label = svgEl('text', { x: ax, y: padT - 4, 'text-anchor': 'middle' });
      label.setAttribute('style', 'fill:var(--primary);font-size:9px;font-weight:600;');
      label.textContent = '▼';
      svg.appendChild(label);
    }

    // x-axis category labels (today/highlightIndex gets accent color)
    const labelEvery = Math.ceil(fullLen / 10 || 1);
    o.categories.forEach((cat, ci) => {
      if (ci % labelEvery !== 0 && ci !== o.highlightIndex) return;
      const lbl = svgEl('text', { x: x(ci), y: H - 8, 'text-anchor': 'middle' });
      const isHighlighted = ci === o.highlightIndex;
      lbl.setAttribute('style', `font-size:9px;fill:${isHighlighted ? 'var(--primary)' : 'var(--text-muted)'};${isHighlighted ? 'font-weight:600;' : ''}`);
      lbl.textContent = cat;
      svg.appendChild(lbl);
    });

    container.appendChild(svg);
    buildLegend(container, items, draw);
  }

  function draw(): void { build(currentOpts); }
  let currentOpts = opts;
  build(opts);

  return {
    update(newOpts) { currentOpts = newOpts; build(newOpts); },
    destroy() { container.innerHTML = ''; },
  };
}
