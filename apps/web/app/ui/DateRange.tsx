'use client';
import { useEffect, useRef, useState } from 'react';

/** Calendar days in IST, both ends included. */
export interface Range { preset: Preset; from: string; to: string }
export type Preset = 'last7' | 'last30' | 'last90' | 'last180' | 'thisMonth' | 'lastMonth' | 'custom';

const DAY = 86_400_000;
export const todayIST = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10);

export const PRESETS: { id: Exclude<Preset, 'custom'>; label: string }[] = [
  { id: 'last7', label: 'Last 7 days' }, { id: 'last30', label: 'Last 30 days' }, { id: 'last90', label: 'Last 90 days' },
  { id: 'last180', label: 'Last 6 months' }, { id: 'thisMonth', label: 'This month' }, { id: 'lastMonth', label: 'Last month' },
];

export function presetRange(p: Exclude<Preset, 'custom'>): Range {
  const t = todayIST();
  const first = t.slice(0, 8) + '01';
  switch (p) {
    case 'last7': return { preset: p, from: addDays(t, -6), to: t };
    case 'last30': return { preset: p, from: addDays(t, -29), to: t };
    case 'last90': return { preset: p, from: addDays(t, -89), to: t };
    case 'last180': return { preset: p, from: addDays(t, -179), to: t };
    case 'thisMonth': return { preset: p, from: first, to: t };
    case 'lastMonth': { const end = addDays(first, -1); return { preset: p, from: end.slice(0, 8) + '01', to: end }; }
  }
}

export const daysIn = (r: { from: string; to: string }) => Math.round((Date.parse(r.to) - Date.parse(r.from)) / DAY) + 1;
const fmt = (iso: string, year = false) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' });
export const rangeText = (r: { from: string; to: string }) => `${fmt(r.from, r.from.slice(0, 4) !== r.to.slice(0, 4))} – ${fmt(r.to, true)}`;
export const previousText = (r: { from: string; to: string }) => { const n = daysIn(r); return rangeText({ from: addDays(r.from, -n), to: addDays(r.from, -1) }); };
export const rangeQuery = (r: Range) => `from=${r.from}&to=${r.to}`;

const KEY = 'vtology.range';
/** The viewer's last choice (presets are recomputed so "Last 30 days" stays current). */
export function loadRange(fallback: Exclude<Preset, 'custom'> = 'last90'): Range {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Range | null;
    if (r?.preset && r.preset !== 'custom') return presetRange(r.preset);
    if (r?.from && r?.to && r.from <= r.to) return r;
  } catch { /* storage unavailable */ }
  return presetRange(fallback);
}
export function saveRange(r: Range) { try { localStorage.setItem(KEY, JSON.stringify(r)); } catch { /* ignore */ } }

/** One control, above the content it scopes: presets as rows, a custom range below a hairline. */
export function DateRangePicker({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(value.from);
  const [to, setTo] = useState(value.to);
  const box = useRef<HTMLDivElement>(null);
  const today = todayIST();
  useEffect(() => { setFrom(value.from); setTo(value.to); }, [value.from, value.to]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  const label = value.preset === 'custom' ? 'Custom' : PRESETS.find(p => p.id === value.preset)!.label;
  const valid = from && to && from <= to && to <= today && daysIn({ from, to }) <= 400;
  const pick = (r: Range) => { onChange(r); saveRange(r); setOpen(false); };

  return (
    <div className="daterange" ref={box}>
      <button className="btn daterange-btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>
        <span><b>{label}</b> <span className="muted">{rangeText(value)}</span></span>
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" style={{ width: 14, height: 14 }}><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="daterange-pop" role="dialog" aria-label="Choose dates">
          <ul>
            {PRESETS.map(p => {
              const r = presetRange(p.id);
              return (
                <li key={p.id}>
                  <button aria-pressed={value.preset === p.id} onClick={() => pick(r)}>
                    <span className="check" aria-hidden="true">{value.preset === p.id ? '✓' : ''}</span>
                    <span>{p.label}</span><span className="muted small">{rangeText(r)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <form className="daterange-custom" onSubmit={e => { e.preventDefault(); if (valid) pick({ preset: 'custom', from, to }); }}>
            <span className="small" style={{ fontWeight: 650 }}>Custom dates</span>
            <div className="toolbar" style={{ gap: 8 }}>
              <label className="small">From <input className="input" type="date" value={from} max={to || today} onChange={e => setFrom(e.target.value)} /></label>
              <label className="small">To <input className="input" type="date" value={to} min={from} max={today} onChange={e => setTo(e.target.value)} /></label>
            </div>
            {!valid && from && to && <span className="small" style={{ color: 'var(--leak)' }}>{from > to ? 'The start date is after the end date.' : to > today ? 'Pick dates up to today.' : 'Pick up to 400 days.'}</span>}
            <div><button className="btn primary small" type="submit" disabled={!valid}>Apply</button></div>
          </form>
        </div>
      )}
    </div>
  );
}
