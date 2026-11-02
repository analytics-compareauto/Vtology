'use client';
// Hand-built SVG charts: thin marks, recessive grid, one axis, hover readouts.
import { useEffect, useMemo, useRef, useState } from 'react';
import { compact } from './format';

export function useWidth<T extends HTMLElement>(fallback = 640) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

export interface Series { key: string; label: string; color: string; values: number[] }

/** Multi-series line chart over shared x labels, with a crosshair that reads every series. */
export function LineChart({ x, series, height = 260, format = compact, xFormat = (s: string) => s }: { x: string[]; series: Series[]; height?: number; format?: (n: number) => string; xFormat?: (s: string) => string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 44, r: 16, t: 12, b: 28 };
  const iw = w - pad.l - pad.r, ih = height - pad.t - pad.b;
  const max = niceMax(Math.max(1, ...series.flatMap(s => s.values)));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * max);
  const X = (i: number) => pad.l + (x.length <= 1 ? iw / 2 : (i / (x.length - 1)) * iw);
  const Y = (v: number) => pad.t + ih - (v / max) * ih;
  const every = Math.max(1, Math.ceil(x.length / Math.max(2, Math.floor(iw / 80))));
  function move(e: React.PointerEvent<SVGRectElement>) {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const px = e.clientX - r.left;
    setHover(Math.max(0, Math.min(x.length - 1, Math.round((px / r.width) * (x.length - 1)))));
  }
  const tipLeft = hover === null ? 0 : Math.min(Math.max(X(hover) + 12, 0), w - 170);
  return (
    <div className="chart" ref={ref}>
      <svg viewBox={`0 0 ${w} ${height}`} height={height} role="img" aria-label={series.map(s => s.label).join(', ')}>
        {ticks.map(t => (
          <g key={t} className="axis">
            <line className="gridline" x1={pad.l} x2={w - pad.r} y1={Y(t)} y2={Y(t)} />
            <text x={pad.l - 8} y={Y(t) + 4} textAnchor="end">{format(t)}</text>
          </g>
        ))}
        {x.map((l, i) => i % every === 0 && <text key={l} className="axis" x={X(i)} y={height - 8} textAnchor="middle">{xFormat(l)}</text>)}
        {series.map(s => {
          const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
          return (
            <g key={s.key}>
              <path d={`${d}L${X(s.values.length - 1)},${Y(0)}L${X(0)},${Y(0)}Z`} fill={s.color} opacity={series.length === 1 ? 0.1 : 0.04} />
              <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            </g>
          );
        })}
        {hover !== null && (
          <g>
            <line x1={X(hover)} x2={X(hover)} y1={pad.t} y2={pad.t + ih} stroke="var(--ink-2)" strokeWidth={1} strokeDasharray="3 3" />
            {series.map(s => <circle key={s.key} cx={X(hover)} cy={Y(s.values[hover] ?? 0)} r={4.5} fill={s.color} stroke="var(--surface)" strokeWidth={2} />)}
          </g>
        )}
        <rect x={pad.l} y={pad.t} width={iw} height={ih} fill="transparent" onPointerMove={move} onPointerLeave={() => setHover(null)} />
      </svg>
      {hover !== null && (
        <div className="chart-tip" style={{ left: tipLeft, top: 8 }}>
          <div className="t">{xFormat(x[hover]!)}</div>
          {[...series].sort((a, b) => (b.values[hover] ?? 0) - (a.values[hover] ?? 0)).map(s => (
            <div className="r" key={s.key}><span className="k" style={{ background: s.color }} /><b>{format(s.values[hover] ?? 0)}</b><span className="muted">{s.label}</span></div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Tiny trend line for a tile. */
export function Sparkline({ values, color, height = 40 }: { values: number[]; color: string; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>(200);
  if (values.length < 2) return <div ref={ref} style={{ height }} />;
  const max = Math.max(1, ...values);
  const X = (i: number) => (i / (values.length - 1)) * (w - 4) + 2;
  const Y = (v: number) => height - 3 - (v / max) * (height - 8);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  return (
    <div className="chart" ref={ref} aria-hidden="true">
      <svg viewBox={`0 0 ${w} ${height}`} height={height}>
        <path d={`${d}L${X(values.length - 1)},${height}L${X(0)},${height}Z`} fill={color} opacity={0.12} />
        <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={X(values.length - 1)} cy={Y(values[values.length - 1]!)} r={3} fill={color} />
      </svg>
    </div>
  );
}

export interface EffortPoint { key: string; label: string; share: number; lift: number; posts: number }

/** Effort vs return: share of posts (x) against engagement relative to usual (y, log scale, 1x line). */
export function EffortMap({ points, height = 340 }: { points: EffortPoint[]; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const pad = { l: 46, r: 18, t: 18, b: 34 };
  const iw = w - pad.l - pad.r, ih = height - pad.t - pad.b;
  const xmax = Math.min(1, niceMax(Math.max(0.1, ...points.map(p => p.share)) * 1.1));
  const lo = Math.min(0.25, ...points.map(p => p.lift * 0.8)), hi = Math.max(4, ...points.map(p => p.lift * 1.25));
  const L = (v: number) => Math.log(Math.max(v, 0.05));
  const X = (s: number) => pad.l + (s / xmax) * iw;
  const Y = (v: number) => pad.t + ih - ((L(v) - L(lo)) / (L(hi) - L(lo))) * ih;
  const yt = [0.25, 0.5, 1, 2, 4, 8].filter(t => t >= lo && t <= hi);
  const xt = [0, 0.25, 0.5, 0.75, 1].map(f => f * xmax);
  const mid = xmax / 2;
  const sorted = useMemo(() => [...points].sort((a, b) => b.posts - a.posts), [points]);
  const maxPosts = Math.max(1, ...points.map(p => p.posts));
  const h = points.find(p => p.key === hover);
  // keep labels on the same side at least 15px apart so they never overlap
  const labelY = new Map<string, number>();
  for (const side of [true, false]) {
    const items = points.map(p => ({ p, cx: X(p.share), cy: Y(p.lift), r: 6 + Math.sqrt(p.posts / Math.max(1, ...points.map(q => q.posts))) * 14 }))
      .filter(o => (o.cx < pad.l + iw * 0.7) === side).sort((a, b) => a.cy - b.cy);
    let last = -Infinity;
    for (const o of items) { const y = Math.max(o.cy + 4, last + 15); labelY.set(o.p.key, y); last = y; }
  }
  return (
    <div className="chart" ref={ref}>
      <svg viewBox={`0 0 ${w} ${height}`} height={height} role="img" aria-label="Share of posts against engagement compared with usual">
        <rect x={pad.l} y={pad.t} width={X(mid) - pad.l} height={Y(1) - pad.t} fill="var(--ok)" opacity={0.06} />
        <rect x={X(mid)} y={Y(1)} width={X(xmax) - X(mid)} height={pad.t + ih - Y(1)} fill="var(--leak)" opacity={0.06} />
        {yt.map(t => (
          <g key={t} className="axis">
            <line className={t === 1 ? 'baseline' : 'gridline'} x1={pad.l} x2={w - pad.r} y1={Y(t)} y2={Y(t)} />
            <text x={pad.l - 8} y={Y(t) + 4} textAnchor="end">{t}×</text>
          </g>
        ))}
        {xt.map(t => <text key={t} className="axis" x={X(t)} y={height - 12} textAnchor="middle">{Math.round(t * 100)}%</text>)}
        <line className="gridline" x1={X(mid)} x2={X(mid)} y1={pad.t} y2={pad.t + ih} strokeDasharray="4 4" />
        <text className="quad-label" x={pad.l + 8} y={pad.t + 16}>Do more of this</text>
        <text className="quad-label" x={w - pad.r - 8} y={pad.t + 16} textAnchor="end">Working, keep it</text>
        <text className="quad-label" x={w - pad.r - 8} y={pad.t + ih - 8} textAnchor="end">Cut back</text>
        <text className="quad-label" x={pad.l + 8} y={pad.t + ih - 8}>Minor, low return</text>
        <text className="axis" x={pad.l + iw / 2} y={height} textAnchor="middle">Share of your posts</text>
        {sorted.map(p => {
          const r = 6 + Math.sqrt(p.posts / maxPosts) * 14;
          const c = p.lift >= 1.15 ? 'var(--ok)' : p.lift <= 0.85 ? 'var(--leak)' : 'var(--muted)';
          const cx = X(p.share), cy = Y(p.lift);
          const right = cx < pad.l + iw * 0.7;
          return (
            <g key={p.key} onPointerEnter={() => setHover(p.key)} onPointerLeave={() => setHover(null)} tabIndex={0} onFocus={() => setHover(p.key)} onBlur={() => setHover(null)} style={{ outline: 'none' }}>
              <circle cx={cx} cy={cy} r={Math.max(r, 14)} fill="transparent" />
              <circle cx={cx} cy={cy} r={r} fill={c} fillOpacity={hover === p.key ? 0.55 : 0.28} stroke={c} strokeWidth={1.5} />
              <text x={right ? cx + r + 5 : cx - r - 5} y={labelY.get(p.key) ?? cy + 4} textAnchor={right ? 'start' : 'end'} fontSize={12} fontWeight={600} fill="var(--ink-2)">{p.label}</text>
            </g>
          );
        })}
      </svg>
      {h && (
        <div className="chart-tip" style={{ left: Math.min(Math.max(X(h.share) + 14, 0), w - 200), top: Math.max(Y(h.lift) - 30, 0) }}>
          <div className="t">{h.label}</div>
          <div className="r"><b>{h.lift.toFixed(1)}×</b><span className="muted">usual engagement</span></div>
          <div className="r"><b>{Math.round(h.share * 100)}%</b><span className="muted">of posts ({h.posts})</span></div>
        </div>
      )}
    </div>
  );
}
