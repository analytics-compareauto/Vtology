'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { detectPerfColumns, headerLineIndex, perfPlatform, streamCsv, toPerfRows, type PerfColumns, type PerfField, type PerfPlatform } from '@vtology/core';
import { unzipSync } from 'fflate';
import { readXlsx } from '../xlsx';
import { api, ApiError } from '../api';
import { DateRangePicker, rangeQuery, type Range } from '../DateRange';
import { compact, pct } from '../format';

interface Line { name: string; type: string; platform: string; cost: number; clicks: number; conversions: number; value: number; lostBudget: number | null; brand: boolean; cpa: number | null }
interface PlanLine { name: string; type: string; now: number; next: number; change: 'raise' | 'cut' | 'pause' | 'keep'; why: string; convNow: number; convNext: number }
interface Finding { tone: 'good' | 'bad' | 'neutral'; title: string; detail: string; action?: string; figure?: string; figureLabel?: string; names?: string[] }
interface Report { id: string; name: string; platform: PerfPlatform; kind: 'campaigns' | 'terms'; currency: string; status: string; rows: number; date_from: string | null; date_to: string | null }
interface Data {
  currency: string; canEdit: boolean; reports: Report[]; hasTerms: boolean; mainline: string | null;
  totals: { cost: number; conversions: number; value: number; cpa: number | null; roas: number | null; clicks: number };
  types: { type: string; cost: number; conversions: number; value: number; cpa: number | null }[];
  campaigns: Line[]; plan: { plan: PlanLine[]; convNow: number; convNext: number; budget: number; freed: number }; findings: Finding[];
}

const TYPE_COLOR: Record<string, string> = { Search: '#3b5bdb', 'Performance Max': '#7048e8', YouTube: '#e03131', Display: '#868e96', 'Demand Gen': '#f08c00', Shopping: '#2f9e44', Meta: '#1c7ed6' };
const PLATFORM: Record<PerfPlatform, string> = { google: 'Google Ads', meta: 'Meta', other: 'Other' };
function money(currency: string) {
  return (v: number | null | undefined) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return '–';
    try { return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en', { style: 'currency', currency, currencyDisplay: 'narrowSymbol', notation: Math.abs(v) >= 1e5 ? 'compact' : 'standard', maximumFractionDigits: Math.abs(v) >= 1e5 ? 1 : 0 }).format(v); }
    catch { return `${currency} ${Math.round(v)}`; }
  };
}

export function Performance({ workspaceId, notify, range, onRange }: { workspaceId: string; notify: (m: string) => void; range: Range; onRange: (r: Range) => void }) {
  const T = `/tenants/${workspaceId}`;
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => api<Data>('GET', `${T}/performance?${rangeQuery(range)}`).then(r => { setD(r); setErr(null); }).catch(e => setErr(e instanceof ApiError ? e.message : 'Could not load performance.')), [T, range]);
  useEffect(() => { load(); }, [load]);
  if (err) return <div className="error-box" role="alert">{err}</div>;
  if (!d) return <div className="progress" />;
  const fm = money(d.currency);
  const t = d.totals, p = d.plan;
  const gain = p.convNow ? (p.convNext - p.convNow) / p.convNow : 0;
  const has = t.cost > 0;

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div className="toolbar no-print">
        <DateRangePicker value={range} onChange={onRange} />
        {d.canEdit && <button className="btn primary" onClick={() => setAdding(a => !a)}>{adding ? 'Close' : 'Add a Google Ads or Meta report'}</button>}
      </div>
      {(adding || (!d.reports.length && d.canEdit)) && <ImportPerf T={T} onDone={msg => { if (msg) notify(msg); setAdding(false); load(); }} />}

      {!has ? (
        <section className="panel"><div className="empty">{d.reports.length ? 'No campaign spend in these dates. Try a longer range.' : 'Add a Google Ads campaign report (with Day), a search terms report, or a Meta Ads Manager export. Vtology shows where the money converts, where it is wasted, and next month’s plan at the same budget.'}</div></section>
      ) : (
        <>
          {p.plan.length > 0 && (
            <section className="panel plan-hero">
              <div className="plan-head">
                <div>
                  <h2>Next month, same budget</h2>
                  <p>Move {fm(p.freed)} of the {fm(p.budget)} a month from what isn’t converting to what is.</p>
                </div>
                <div className="plan-big"><b>+{Math.round(p.convNext - p.convNow).toLocaleString('en-IN')}</b><span>conversions a month (+{pct(gain)})</span></div>
                <div className="plan-cpa"><span>Cost per conversion</span><b>{fm(p.budget / p.convNow)} → {fm(p.budget / p.convNext)}</b></div>
              </div>
              <div className="plan-rows">{p.plan.map(x => (
                <div className="plan-row" key={x.name}>
                  <span className={`tag ${x.change === 'raise' ? 'ok' : x.change === 'pause' ? 'leak' : 'warn'}`}>{x.change === 'raise' ? 'Add' : x.change === 'pause' ? 'Pause' : 'Cut'}</span>
                  <span className="plan-name"><b className="clamp1" title={x.name}>{x.name}</b><span className="small muted">{x.type} · {x.why}</span></span>
                  <span className="plan-money"><span className="muted">{fm(x.now)}</span> → <b>{fm(x.next)}</b></span>
                  <span className="small plan-conv">{Math.round(x.convNow)} → {Math.round(x.convNext)} conv.</span>
                </div>
              ))}</div>
              <p className="small muted" style={{ margin: '10px 0 0' }}>An estimate from these dates: added money is assumed to convert 25% less well than each campaign does today, and money taken away to have converted at that campaign’s own rate.</p>
            </section>
          )}

          <div className="kpis">
              <div className="kpi"><span className="label">Spend</span><b>{fm(t.cost)}</b></div>
              <div className="kpi"><span className="label">Conversions</span><b>{Math.round(t.conversions).toLocaleString('en-IN')}</b></div>
              <div className="kpi"><span className="label">Cost per conversion</span><b>{fm(t.cpa)}</b></div>
              {t.roas !== null && <div className="kpi"><span className="label">Return on spend</span><b>{t.roas.toFixed(1)}×</b></div>}
              <div className="kpi"><span className="label">Clicks</span><b>{compact(t.clicks)}</b></div>
          </div>

          {d.findings.length > 0 && (
            <section className="panel">
              <div className="panel-head"><div><h2>What it means</h2><p>{d.mainline ? `Includes how ${d.mainline} changed what search costs, from the All media tab.` : 'Add TV, print, radio or outdoor on the All media tab to see how they change what search costs.'}</p></div></div>
              <div className="insight-grid">{d.findings.map((f, i) => <Card key={i} f={f} />)}</div>
            </section>
          )}

          <section className="panel">
            <div className="panel-head"><div><h2>By kind of campaign</h2><p>Share of spend, and what a conversion costs on each.</p></div></div>
            <div className="split-bar">{d.types.map(x => <i key={x.type} style={{ width: `${(x.cost / t.cost) * 100}%`, background: TYPE_COLOR[x.type] ?? 'var(--muted)' }} title={`${x.type}: ${fm(x.cost)}`} />)}</div>
            <div className="medium-tiles">{d.types.map(x => (
              <div key={x.type} className="medium-tile">
                <span><span className="dot" style={{ background: TYPE_COLOR[x.type] ?? 'var(--muted)' }} /><b>{x.type}</b></span>
                <span className="big">{fm(x.cpa)}</span>
                <span className="small muted">per conversion · {pct(x.cost / t.cost)} of spend · {Math.round(x.conversions).toLocaleString('en-IN')} conv.</span>
              </div>
            ))}</div>
          </section>

          <section className="panel">
            <div className="panel-head"><div><h2>Top {d.campaigns.length} campaigns by spend</h2><p>Bar length is spend; the colour shows cost per conversion against your average (green cheaper, red dearer).</p></div></div>
            <div className="camp-rows">{d.campaigns.map(c => {
              const idx = c.cpa && t.cpa ? c.cpa / t.cpa : null;
              const col = c.conversions === 0 ? 'var(--leak)' : idx! <= 0.8 ? 'var(--ok)' : idx! >= 1.5 ? 'var(--leak)' : idx! >= 1.1 ? 'var(--warn)' : 'var(--flow)';
              return (
                <div className="camp-row" key={c.name}>
                  <span className="plan-name"><b className="clamp1" title={c.name}>{c.name}</b><span className="small muted">{c.type}{c.brand ? ' · brand' : ''}{c.lostBudget && c.lostBudget >= 0.1 ? ` · ${pct(c.lostBudget)} of searches missed for budget` : ''}</span></span>
                  <span className="camp-bar"><i style={{ width: `${(c.cost / d.campaigns[0]!.cost) * 100}%`, background: col }} /></span>
                  <span className="small">{fm(c.cost)}</span>
                  <span className="small"><b style={{ color: col }}>{c.conversions ? fm(c.cpa) : 'No conv.'}</b>{idx ? ` · ${idx.toFixed(1)}×` : ''}</span>
                </div>
              );
            })}</div>
          </section>
        </>
      )}

      {d.reports.length > 0 && (
        <section className="panel">
          <div className="panel-head"><div><h2>Reports added</h2><p>Only daily totals per campaign and ad group, and search terms, are kept.</p></div></div>
          <div className="rows">{d.reports.map(r => (
            <div className="row" key={r.id}>
              <div className="row-main"><span><b>{r.name}</b> <span className="tag plain">{PLATFORM[r.platform]} · {r.kind === 'terms' ? 'search terms' : 'campaigns'}</span></span>
                {d.canEdit && <button className="btn small link" onClick={async () => { if (!window.confirm(`Delete "${r.name}"?`)) return; await api('DELETE', `${T}/performance/reports/${r.id}`); load(); }}>Delete</button>}</div>
              <span className="small muted">{r.status !== 'ready' ? 'Upload did not finish' : r.kind === 'terms' ? `${r.rows.toLocaleString('en-IN')} search terms` : `${r.rows.toLocaleString('en-IN')} daily totals, ${r.date_from} to ${r.date_to}`}</span>
            </div>
          ))}</div>
        </section>
      )}
    </div>
  );
}

function Card({ f }: { f: Finding }) {
  const [copied, setCopied] = useState(false);
  const tone = f.tone === 'bad' ? 'leak' : f.tone === 'good' ? 'ok' : 'flow';
  return (
    <div className={`insight ${tone}`}>
      <div className="fig"><b>{f.figure ?? '•'}</b>{f.figureLabel && <span>{f.figureLabel}</span>}</div>
      <div className="txt">
        <span className={`tag ${f.tone === 'bad' ? 'leak' : f.tone === 'good' ? 'ok' : 'plain'}`}>{f.tone === 'bad' ? 'Fix' : f.tone === 'good' ? 'Working' : 'Worth a look'}</span>
        <b>{f.title}</b><span className="small">{f.detail}</span>{f.action && <span className="small"><b>Do:</b> {f.action}</span>}
        {f.names && f.names.length > 0 && <div><button className="btn small" onClick={() => navigator.clipboard?.writeText(f.names!.join('\n')).then(() => setCopied(true)).catch(() => undefined)}>{copied ? 'Copied' : `Copy ${f.names.length} ${f.names.length === 1 ? 'name' : 'names'}`}</button></div>}
      </div>
    </div>
  );
}

const FIELDS: { f: PerfField; label: string }[] = [
  { f: 'day', label: 'Day' }, { f: 'campaign', label: 'Campaign' }, { f: 'campaignType', label: 'Campaign type' }, { f: 'adGroup', label: 'Ad group or ad set' }, { f: 'term', label: 'Search term' },
  { f: 'cost', label: 'Cost' }, { f: 'impressions', label: 'Impressions' }, { f: 'clicks', label: 'Clicks' }, { f: 'conversions', label: 'Conversions or results' }, { f: 'value', label: 'Conversion value' }, { f: 'lostBudget', label: 'Lost impression share (budget)' },
];

/** Google Ads exports can be UTF-16 and start with title lines; both are handled here. */
async function fileText(f: File): Promise<string> {
  const buf = new Uint8Array(await f.arrayBuffer());
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  return new TextDecoder('utf-8').decode(buf).replace(/^﻿/, '');
}

function ImportPerf({ T, onDone }: { T: string; onDone: (msg: string | null) => void }) {
  const [name, setName] = useState('');
  const [raw, setRaw] = useState<Record<string, string>[] | null>(null);
  const [cols, setCols] = useState<PerfColumns>({});
  const [platform, setPlatform] = useState<PerfPlatform>('other');
  const [currency, setCurrency] = useState('INR');
  const [err, setErr] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const header = raw?.[0] ? Object.keys(raw[0]) : [];
  const kind: 'campaigns' | 'terms' = cols.term && !cols.day ? 'terms' : 'campaigns';
  const parsed = useMemo(() => (raw ? toPerfRows(raw, cols, platform) : null), [raw, cols, platform]);
  const problem = !raw ? null : !cols.cost ? 'Choose the cost column.' : kind === 'campaigns' && !cols.day ? 'This report has no Day column. In Google Ads add Segment → Time → Day (in Meta, Breakdown → By time → Day) and download again; a search terms report doesn’t need it.' : !cols.campaign && !cols.term ? 'Choose the campaign column.' : null;

  async function choose(f0: File | undefined) {
    setErr(null); setRaw(null);
    if (!f0) return;
    try {
      let f = f0;
      if (/\.zip$/i.test(f0.name)) {
        const [n, data] = Object.entries(unzipSync(new Uint8Array(await f0.arrayBuffer()), { filter: x => /\.(csv|xlsx|tsv)$/i.test(x.name) && !x.name.startsWith('__MACOSX') }))[0] ?? [];
        if (!n || !data) { setErr('The zip has no CSV or Excel file inside.'); return; }
        f = new File([data as BlobPart], n.split('/').pop()!);
      }
      if (!name) setName(f.name.replace(/\.(csv|tsv|txt|xlsx)$/i, '').slice(0, 100));
      let rows: Record<string, string>[] = [];
      if (/\.xlsx$/i.test(f.name)) {
        rows = await readXlsx(f);
        // a title line above the header: the first row whose values look like a header becomes the header
        const keys = Object.keys(rows[0] ?? {});
        if (!detectPerfColumns(keys).cost) { const i = rows.findIndex(r => detectPerfColumns(Object.values(r)).cost); if (i >= 0) { const h = Object.values(rows[i]!); rows = rows.slice(i + 1).map(r => Object.fromEntries(Object.values(r).map((v, j) => [h[j] ?? `col${j}`, v]))); } }
      } else {
        const text = await fileText(f);
        const lines = text.split(/\r?\n/);
        const body = lines.slice(headerLineIndex(lines)).join('\n');
        await streamCsv(body, r => { rows.push(r); });
      }
      if (!rows.length) { setErr('The file has no rows under its header.'); return; }
      const h = Object.keys(rows[0]!);
      const c = detectPerfColumns(h);
      setCols(c); setPlatform(perfPlatform(h));
      const cur = c.currency ? rows.find(r => r[c.currency!])?.[c.currency] : h.find(x => /\((inr|usd|cad|aed|gbp|eur)\)/i.test(x))?.match(/\((\w{3})\)/)?.[1];
      if (cur) setCurrency(cur.toUpperCase());
      setRaw(rows);
    } catch { setErr('Could not read the file. Download it from Google Ads or Meta as CSV (or Excel) and try again.'); }
  }

  async function upload() {
    if (!parsed) return;
    setErr(null); setProgress(0);
    let id: string | null = null;
    try {
      id = (await api<{ id: string }>('POST', `${T}/performance/reports`, { name, platform, kind, currency })).id;
      const rows = parsed.rows;
      for (let i = 0; i < rows.length; i += 2500) {
        const part = rows.slice(i, i + 2500);
        await api('POST', `${T}/performance/reports/${id}/rows`, { rows: part }).catch(() => api('POST', `${T}/performance/reports/${id}/rows`, { rows: part }));
        setProgress(Math.min(1, (i + 2500) / rows.length));
      }
      const r = await api<{ rows: number; from: string | null; to: string | null }>('POST', `${T}/performance/reports/${id}/finish`);
      onDone(kind === 'terms' ? `Added ${r.rows.toLocaleString('en-IN')} search terms.` : `Added ${PLATFORM[platform]} campaigns: ${r.from} to ${r.to}.`);
    } catch (e) {
      if (id) await api('DELETE', `${T}/performance/reports/${id}`).catch(() => undefined);
      setErr(e instanceof ApiError ? e.message : 'The connection dropped during the upload. Nothing was saved; try again.');
    } finally { setProgress(null); }
  }

  return (
    <section className="panel">
      <div className="panel-head"><div><h2>Add a report</h2><p>From Google Ads: a campaign or ad group report with <b>Day</b>, and a search terms report. From Meta Ads Manager: an export by campaign or ad set with <b>Day</b>. CSV or Excel, as downloaded.</p></div></div>
      <div style={{ display: 'grid', gap: 12, maxWidth: 760 }}>
        <label className={`dropzone ${over ? 'over' : ''}`} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); choose(e.dataTransfer.files[0]); }}>
          <input type="file" accept=".csv,.tsv,.txt,.xlsx,.zip" onChange={e => choose(e.target.files?.[0])} style={{ display: 'none' }} />
          <b>Drop the report here, or click to choose</b><span className="small muted">CSV, Excel, or zipped</span>
        </label>
        {raw && (
          <>
            <div className="kind-pick"><b>{PLATFORM[platform]} · {kind === 'terms' ? 'search terms' : 'campaigns by day'}</b><span className="small muted">{raw.length.toLocaleString('en-IN')} rows read; {parsed?.rows.length.toLocaleString('en-IN')} usable{parsed?.skipped ? ` (${parsed.skipped.toLocaleString('en-IN')} totals or unreadable rows skipped)` : ''}.</span></div>
            <div className="toolbar">
              <input className="input" style={{ maxWidth: 320 }} value={name} onChange={e => setName(e.target.value)} placeholder="Name, e.g. Google Ads October" maxLength={100} />
              <input className="input" style={{ width: 80 }} value={currency} onChange={e => setCurrency(e.target.value.toUpperCase().slice(0, 3))} aria-label="Currency" />
            </div>
            <details><summary className="small">Check the columns</summary>
              <div className="map-grid" style={{ marginTop: 8 }}>{FIELDS.map(x => (
                <label key={x.f} className="small"><span>{x.label}</span>
                  <select className="input" value={cols[x.f] ?? ''} onChange={e => setCols(c => ({ ...c, [x.f]: e.target.value || undefined }))}>
                    <option value="">Not in this file</option>{header.map(h => <option key={h} value={h}>{h}</option>)}
                  </select></label>
              ))}</div>
            </details>
            {problem && <div className="note-box">{problem}</div>}
            <div><button className="btn primary" disabled={!!problem || !name.trim() || !parsed?.rows.length || progress !== null} onClick={upload}>{progress !== null ? `Adding… ${Math.round(progress * 100)}%` : 'Add this report'}</button></div>
          </>
        )}
        {err && <div className="error-box" role="alert">{err}</div>}
      </div>
    </section>
  );
}
