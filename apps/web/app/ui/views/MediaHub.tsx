'use client';
import { useCallback, useEffect, useState } from 'react';
import { guessMedium, headerLineIndex, perfPlatform, detectPerfColumns } from '@vtology/core';
import { readXlsx } from '../xlsx';
import { api, ApiError } from '../api';
import { DateRangePicker, rangeQuery, type Range } from '../DateRange';
import { ImportOffline, MediaSummary, type MediaData, type MediaView, type Shared } from './AllMedia';
import { ImportPerf, Performance } from './Performance';
import { ImportReport, Media } from './Media';

/**
 * The Media tab: everything a brand spends on, main and digital, in one place. It opens on the summary
 * (how the money moved people, every medium's verdict, what to do next); the detail views appear
 * only for the kinds of data the brand has shared. One "Add data" takes any report and files it.
 */
export function MediaHub({ workspaceId, notify, range, onRange, canEdit, initialView }: { workspaceId: string; notify: (m: string) => void; range: Range; onRange: (r: Range) => void; canEdit: boolean; initialView?: MediaView }) {
  const T = `/tenants/${workspaceId}`;
  const [view, setView] = useState<MediaView>(initialView ?? 'summary');
  const [d, setD] = useState<MediaData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [v, setV] = useState(0); // bumps when data changes, so embedded views reload
  const load = useCallback(() => api<MediaData>('GET', `${T}/crossmedia?${rangeQuery(range)}`).then(r => { setD(r); setErr(null); }).catch(e => setErr(e instanceof ApiError ? e.message : 'Could not load media.')), [T, range]);
  useEffect(() => { load(); }, [load, v]);
  useEffect(() => { try { const u = new URL(window.location.href); u.searchParams.set('tab', 'media'); if (view === 'summary') u.searchParams.delete('view'); else u.searchParams.set('view', view); window.history.replaceState(null, '', u); } catch { /* ignore */ } }, [view]);
  if (err) return <div className="error-box" role="alert">{err}</div>;
  if (!d) return <div className="progress" />;
  const sh = d.picture.shared;
  const anything = Object.values(sh).some(Boolean);
  const views: { id: MediaView; label: string; show: boolean }[] = [
    { id: 'summary', label: 'Summary', show: true },
    { id: 'awareness', label: 'Awareness media', show: sh.mainline || sh.programmatic },
    { id: 'search', label: 'Search and social ads', show: sh.search || sh.meta || sh.terms },
    { id: 'files', label: canEdit ? 'Data and files' : 'Files', show: true },
  ];
  const go = (x: MediaView) => { setView(x); window.scrollTo({ top: 0, behavior: 'smooth' }); };

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div className="toolbar no-print media-nav">
        <div className="seg" role="tablist" aria-label="Media views">
          {views.filter(x => x.show).map(x => <button key={x.id} role="tab" aria-selected={view === x.id} aria-pressed={view === x.id} onClick={() => go(x.id)}>{x.label}</button>)}
        </div>
        <div className="toolbar">
          {view !== 'files' && <DateRangePicker value={range} onChange={onRange} />}
          {canEdit && view !== 'files' && <button className="btn primary" onClick={() => go('files')}>Add data</button>}
        </div>
      </div>
      {d.leftOut.length > 0 && view === 'summary' && <div className="note-box">Reports in {d.leftOut.join(', ')} are left out: amounts are compared in {d.currency} only.</div>}

      {view === 'summary' && (anything ? <>
        <MediaSummary d={d} part="summary" onView={go} />
        <WhatYouGet shared={sh} compact onAdd={canEdit ? () => go('files') : undefined} />
      </> : <WhatYouGet shared={sh} onAdd={canEdit ? () => go('files') : undefined} />)}

      {view === 'awareness' && <>
        <MediaSummary d={d} part="awareness" onView={go} />
        {sh.programmatic && <Media key={v} workspaceId={workspaceId} notify={notify} range={range} onRange={onRange} canEdit={canEdit} embedded onAdd={() => go('files')} />}
      </>}

      {view === 'search' && <Performance key={v} workspaceId={workspaceId} notify={notify} range={range} onRange={onRange} embedded />}

      {view === 'files' && <>
        {canEdit && <AddData T={T} workspace={d.workspace} isDemo={d.isDemo} onDone={msg => { if (msg) notify(msg); setV(x => x + 1); }} />}
        <Files T={T} canEdit={canEdit} version={v} onChange={() => setV(x => x + 1)} />
        <WhatYouGet shared={sh} />
      </>}
    </div>
  );
}

type Kind = 'search' | 'programmatic' | 'offline';
const KIND_LABEL: Record<Kind, string> = { search: 'Google Ads or Meta', programmatic: 'DV360, programmatic or YouTube', offline: 'TV, print, radio, outdoor or results' };

interface FileCheck { kind: Kind; sample: boolean; brands: string[] }
const BRAND_COL = /^(advertiser|advertiser name|account|account name|customer name|brand|client)$/i;

/** Reads a file's header (and first rows) to tell what it is, who it is for, and whether it is one of Vtology's made-up samples. */
async function whatIs(f: File): Promise<FileCheck> {
  let header: string[] = [];
  let firstRows: string[][] = [];
  if (/\.xlsx$/i.test(f.name)) {
    const rows = await readXlsx(f);
    header = Object.keys(rows[0] ?? {});
    firstRows = rows.slice(0, 200).map(r => header.map(h => String(r[h] ?? '')));
    if (!detectPerfColumns(header).cost) { const r = rows.find(x => detectPerfColumns(Object.values(x)).cost); if (r) header = Object.values(r); }
  } else if (!/\.(zip|gz)$/i.test(f.name)) {
    const buf = new Uint8Array(await f.slice(0, 65536).arrayBuffer());
    const text = buf[0] === 0xff && buf[1] === 0xfe ? new TextDecoder('utf-16le').decode(buf.subarray(2)) : new TextDecoder().decode(buf).replace(/^﻿/, '');
    const lines = text.split(/\r?\n/);
    const hi = headerLineIndex(lines);
    const line = lines[hi] ?? '';
    const split = (l: string) => l.split(l.includes('\t') ? '\t' : /,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(x => x.replace(/^"|"$/g, '').trim());
    header = split(line);
    firstRows = lines.slice(hi + 1, hi + 200).filter(Boolean).map(split);
  }
  const sample = header.some(h => /^vtology sample$/i.test(h)) || /^sample-/i.test(f.name);
  const bi = header.findIndex(h => BRAND_COL.test(h));
  const brands = bi >= 0 ? [...new Set(firstRows.map(r => r[bi] ?? '').filter(Boolean))].slice(0, 8) : [];
  const pf = perfPlatform(header), pc = detectPerfColumns(header);
  const kind: Kind = pf !== 'other' || (pc.term && pc.cost) ? 'search' : guessMedium(header, f.name) === 'digital' ? 'programmatic'
    : /google.?ads|adwords|meta|facebook|search.?terms/i.test(f.name) ? 'search' : /dv360|programmatic|dsp|youtube|ctv/i.test(f.name) ? 'programmatic' : 'offline';
  return { kind, sample, brands };
}

/** Does a name in the file look like this workspace's brand? ("CompareAuto" matches "Compare Auto India", "compareauto.in") */
function sameBrand(workspace: string, name: string): boolean {
  const n = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const w = n(workspace), x = n(name);
  if (!w || !x) return true;
  const first = n(workspace.split(/\s+/)[0] ?? '');
  return x.includes(w) || w.includes(x) || (first.length >= 4 && x.includes(first));
}

function AddData({ T, onDone, workspace, isDemo }: { T: string; onDone: (msg: string | null) => void; workspace: string; isDemo: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<Kind | null>(null);
  const [over, setOver] = useState(false);
  const [n, setN] = useState(0);
  const [stop, setStop] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ f: File; kind: Kind; brands: string[] } | null>(null);
  async function choose(f: File | undefined) {
    if (!f) return;
    setFile(null); setKind(null); setStop(null); setAsk(null);
    const c = await whatIs(f).catch((): FileCheck => ({ kind: 'offline', sample: false, brands: [] }));
    // made-up sample files never go into a real workspace
    if (c.sample && !isDemo) { setStop(`${f.name} is one of Vtology's made-up sample files, so it can't be added to ${workspace}, a real workspace. Add it to a sample workspace instead (create one with “Sample data” ticked).`); return; }
    // a report for another advertiser or account asks first
    const other = c.brands.filter(b => !sameBrand(workspace, b));
    if (other.length && other.length === c.brands.length && !isDemo) { setAsk({ f, kind: c.kind, brands: other }); return; }
    setN(x => x + 1); setFile(f); setKind(c.kind);
  }
  const done = (msg: string | null) => { setFile(null); setKind(null); onDone(msg); };
  return (
    <section className="panel">
      <div className="panel-head"><div><h2>Add data to {workspace}</h2><p>Drop any report: Vtology tells what it is from its columns and files it in the right place. One file at a time; CSV, Excel or zipped, as downloaded. Only reports for {workspace} belong here.</p></div></div>
      {stop && <div className="error-box" role="alert">{stop}</div>}
      {ask && (
        <div className="note-box" style={{ display: 'grid', gap: 10, borderColor: 'var(--warn)' }}>
          <span><b>{ask.f.name}</b> is for <b>{ask.brands.join(', ')}</b>, not {workspace}. Reports for another brand belong in that brand’s own workspace, so its numbers never mix with {workspace}’s.</span>
          <div className="toolbar"><button className="btn primary" onClick={() => setAsk(null)}>Don’t add it</button>
            <button className="btn" onClick={() => { const a = ask; setAsk(null); setN(x => x + 1); setFile(a.f); setKind(a.kind); }}>It is for {workspace}: add it</button></div>
        </div>
      )}
      {!file && !ask && (
        <label className={`dropzone big ${over ? 'over' : ''}`} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); choose(e.dataTransfer.files[0]); }}>
          <input type="file" accept=".csv,.tsv,.txt,.xlsx,.zip,.gz" onChange={e => choose(e.target.files?.[0])} style={{ display: 'none' }} />
          <b>Drop a report here, or click to choose</b>
          <span className="small muted">TV, print, radio or outdoor schedules · your leads or sales · DV360, programmatic or YouTube · Google Ads · Meta Ads Manager</span>
        </label>
      )}
      {file && kind && (
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="kind-pick">
            <span><b>{file.name}</b> looks like a <b>{KIND_LABEL[kind]}</b> report, to be added to <b>{workspace}</b>.</span>
            <div className="toolbar" style={{ gap: 6 }}><span className="small muted">Not right?</span>{(Object.keys(KIND_LABEL) as Kind[]).filter(k => k !== kind).map(k => <button key={k} className="btn small" onClick={() => { setKind(k); setN(x => x + 1); }}>It’s {KIND_LABEL[k]}</button>)}
              <button className="btn small link" onClick={() => { setFile(null); setKind(null); }}>Choose another file</button></div>
          </div>
          {kind === 'search' && <ImportPerf key={n} T={T} initialFile={file} onDone={done} />}
          {kind === 'programmatic' && <ImportReport key={n} T={T} initialFile={file} onDone={msg => done(msg)} />}
          {kind === 'offline' && <ImportOffline key={n} T={T} initialFile={file} onDone={done} />}
        </div>
      )}
    </section>
  );
}

interface FileRow { id: string; name: string; kind: string; dates: string; rows: string; del: string; ok: boolean }
const fmtDate = (x: string | null) => (x ? new Date(`${x.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');

/** Every report the brand has added, whatever its kind, in one list. */
function Files({ T, canEdit, version, onChange }: { T: string; canEdit: boolean; version: number; onChange: () => void }) {
  const [rows, setRows] = useState<FileRow[] | null>(null);
  useEffect(() => {
    const OFF: Record<string, string> = { tv: 'TV', print: 'Print', radio: 'Radio', ooh: 'Outdoor', results: 'Results (leads, sales)' };
    Promise.all([
      api<{ id: string; name: string; medium: string; status: string; rows: number; date_from: string | null; date_to: string | null }[]>('GET', `${T}/crossmedia/reports`).catch(() => []),
      api<{ id: string; name: string; kind: string; status: string; rows: number; date_from: string | null; date_to: string | null }[]>('GET', `${T}/media/reports`).catch(() => []),
      api<{ id: string; name: string; platform: string; kind: string; status: string; rows: number; date_from: string | null; date_to: string | null }[]>('GET', `${T}/performance/reports`).catch(() => []),
    ]).then(([o, m, p]) => setRows([
      ...o.map(r => ({ id: r.id, name: r.name, kind: OFF[r.medium] ?? r.medium, dates: `${fmtDate(r.date_from)} – ${fmtDate(r.date_to)}`, rows: `${r.rows.toLocaleString('en-IN')} daily totals`, del: `${T}/crossmedia/reports/${r.id}`, ok: r.status === 'ready' })),
      ...m.map(r => ({ id: r.id, name: r.name, kind: r.kind === 'reach' ? 'DV360 reach' : 'DV360 or programmatic', dates: `${fmtDate(r.date_from)} – ${fmtDate(r.date_to)}`, rows: `${Number(r.rows).toLocaleString('en-IN')} rows`, del: `${T}/media/reports/${r.id}`, ok: r.status === 'ready' })),
      ...p.map(r => ({ id: r.id, name: r.name, kind: `${r.platform === 'meta' ? 'Meta' : r.platform === 'google' ? 'Google Ads' : 'Ads'}${r.kind === 'terms' ? ' search terms' : ''}`, dates: r.kind === 'terms' ? '' : `${fmtDate(r.date_from)} – ${fmtDate(r.date_to)}`, rows: r.kind === 'terms' ? `${r.rows.toLocaleString('en-IN')} searches` : `${r.rows.toLocaleString('en-IN')} daily totals`, del: `${T}/performance/reports/${r.id}`, ok: r.status === 'ready' })),
    ]));
  }, [T, version]);
  if (!rows) return <div className="progress" />;
  if (!rows.length) return null;
  return (
    <section className="panel">
      <div className="panel-head"><div><h2>Reports added</h2><p>Only totals are kept (by day, and by campaign, region or vehicle); the files themselves aren’t stored.</p></div></div>
      <div className="file-rows">{rows.map(r => (
        <div className="file-row" key={r.id}>
          <b className="clamp1" title={r.name}>{r.name}</b>
          <span className="tag plain">{r.kind}</span>
          <span className="small muted">{r.ok ? r.dates : 'Upload did not finish'}</span>
          <span className="small muted">{r.ok ? r.rows : ''}</span>
          {canEdit ? <button className="btn small link" onClick={async () => { if (!window.confirm(`Delete "${r.name}"? Its numbers leave every view.`)) return; await api('DELETE', r.del); onChange(); }}>Delete</button> : <span />}
        </div>
      ))}</div>
    </section>
  );
}

const SOURCES: { key: keyof Shared | null; share: string; how: string; get: string; example: string }[] = [
  { key: 'results', share: 'Your leads or sales', how: 'A weekly export from your CRM or dealer system: date, city, leads or bookings', get: 'The one yardstick every medium is judged on, by week and city.', example: 'Telangana brings 15% of leads with no local media.' },
  { key: 'mainline', share: 'TV, print, radio and outdoor', how: 'Your agency’s schedule or post-buy report (channel, paper, station, date, cost, GRPs)', get: 'Which media and regions moved your leads, and what an extra lead cost on each.', example: 'TV weeks brought 14% more leads, at ₹23,887 per extra lead.' },
  { key: 'programmatic', share: 'DV360, programmatic, YouTube and CTV', how: 'A DV360 delivery report by day (or read access to the advertiser)', get: 'Attention: completion, viewability, cost per completed view, frequency waste, sites to block, tired creatives.', example: 'Two CTV lines reach the same homes 6 times a day: cap at 3.' },
  { key: 'search', share: 'Google Ads campaigns', how: 'A campaign report with Day (or read access to the account)', get: 'Cost per lead by campaign, money spent with nothing to show, and next month’s plan at the same budget.', example: 'Same budget, +490 conversions a month.' },
  { key: 'terms', share: 'Google Ads search terms', how: 'The search terms report for the same dates', get: 'Searches to block, and the words that bring buyers.', example: 'Searches for free car racing games cost ₹48,000 and never converted.' },
  { key: 'meta', share: 'Meta Ads Manager', how: 'An export by campaign or ad set, with Day', get: 'Lead cost on Facebook and Instagram next to Google, in the same plan.', example: 'Lookalike leads cost half of interest targeting.' },
  { key: null, share: 'TV spot log and website visits by minute (coming)', how: 'The as-run spot log from your agency, and Google Analytics', get: 'Visits and leads in the minutes after each spot, by channel and programme.', example: 'Star Plus 9 pm spots bring 3× more visits per rupee than afternoons.' },
];

/** What a brand gets for each report or access it shares: the reason to share it. */
function WhatYouGet({ shared, compact: small, onAdd }: { shared: Shared; compact?: boolean; onAdd?: () => void }) {
  const list = small ? SOURCES.filter(s => s.key && !shared[s.key]) : SOURCES;
  if (!list.length) return null;
  return (
    <section className="panel">
      <div className="panel-head"><div><h2>{small ? 'Share more to see more' : 'What you get for what you share'}</h2><p>{small ? 'Each report below adds a piece of the picture.' : 'Each report or access unlocks a part of the analysis. Nothing personal is needed: campaign numbers and totals only.'}</p></div>
        {onAdd && <button className="btn primary" onClick={onAdd}>Add data</button>}</div>
      <div className="get-grid">{list.map(s => {
        const on = s.key ? shared[s.key] : false;
        return (
          <div key={s.share} className={`get-card ${on ? 'on' : ''} ${s.key ? '' : 'soon'}`}>
            <span className={`tag ${on ? 'ok' : s.key ? 'plain' : 'flow'}`}>{on ? 'Shared' : s.key ? 'Not shared yet' : 'Coming'}</span>
            <b>{s.share}</b>
            <span className="small muted">{s.how}</span>
            <span className="small">{s.get}</span>
            <span className="get-example">“{s.example}”</span>
          </div>
        );
      })}</div>
    </section>
  );
}
