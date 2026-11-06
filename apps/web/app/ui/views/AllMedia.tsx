'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { OFFLINE_LABEL, detectOfflineColumns, guessMedium, streamCsv, toOfflineRows, type OfflineColumns, type OfflineField, type OfflineMedium, type OfflineRow } from '@vtology/core';
import { gunzipSync, unzipSync } from 'fflate';
import { readXlsx } from '../xlsx';
import { api, ApiError } from '../api';
import { BarChart } from '../charts';
import { DateRangePicker, presetRange, rangeQuery, type Range } from '../DateRange';
import { compact, pct } from '../format';

interface Total { medium: string; label: string; kind: 'offline' | 'digital'; spend: number; reach: number; units: number; weeks: number }
interface Lift { medium: string; label: string; spend: number; weeksOn: number; weeksOff: number; on: number | null; off: number | null; lift: number | null; extra: number | null; costPerExtra: number | null; overlap: number; verdict: 'lift' | 'none' | 'too_few_weeks' }
interface Region { region: string; results: number; spend: number; resultShare: number; spendShare: number; byMedium: Record<string, number> }
interface Finding { tone: 'good' | 'bad' | 'neutral'; title: string; detail: string; action?: string; figure?: string; figureLabel?: string }
interface Report { id: string; name: string; medium: OfflineMedium; currency: string; status: string; rows: number; date_from: string | null; date_to: string | null }
interface Data { currency: string; leftOut: string[]; measure: 'leads' | 'sales'; hasResults: boolean; hasDigital: boolean; weeks: string[]; series: { medium: string; label: string; values: number[] }[]; results: number[]; totals: Total[]; lifts: Lift[]; regions: Region[]; findings: Finding[]; reports: Report[]; canEdit: boolean }

/** one colour per medium, kept the same wherever it appears */
export const MEDIUM_COLOR: Record<string, string> = { tv: '#3b5bdb', print: '#e8590c', radio: '#2f9e44', ooh: '#ae3ec9', ctv: '#1098ad', video: '#f59f00', audio: '#74b816', display: '#868e96' };
const REACH_NAME: Record<string, string> = { tv: 'GRPs', print: 'readership', radio: 'listeners', ooh: 'footfall', ctv: 'impressions', video: 'impressions', audio: 'impressions', display: 'impressions' };
const short = (w: string) => new Date(`${w}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

function money(currency: string) {
  return (v: number) => {
    try { return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en', { style: 'currency', currency, currencyDisplay: 'narrowSymbol', notation: Math.abs(v) >= 1e5 ? 'compact' : 'standard', maximumFractionDigits: Math.abs(v) >= 1e5 ? 1 : 0 }).format(v); }
    catch { return `${currency} ${Math.round(v)}`; }
  };
}

export function AllMedia({ workspaceId, notify }: { workspaceId: string; notify: (m: string) => void }) {
  const T = `/tenants/${workspaceId}`;
  const [range, setRange] = useState<Range>(() => presetRange('last180'));
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => api<Data>('GET', `${T}/crossmedia?${rangeQuery(range)}`).then(r => { setD(r); setErr(null); }).catch(e => setErr(e instanceof ApiError ? e.message : 'Could not load media.')), [T, range]);
  useEffect(() => { load(); }, [load]);
  if (err) return <div className="error-box" role="alert">{err}</div>;
  if (!d) return <div className="progress" />;
  const fm = money(d.currency);
  const total = d.totals.reduce((a, t) => a + t.spend, 0);
  const unit = d.measure;
  const empty = !d.totals.length && !d.hasResults;

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div className="toolbar no-print">
        <DateRangePicker value={range} onChange={setRange} />
        {d.canEdit && <button className="btn primary" onClick={() => setAdding(a => !a)}>{adding ? 'Close' : 'Add TV, print, radio or results'}</button>}
      </div>
      {adding && <ImportOffline T={T} onDone={msg => { if (msg) notify(msg); setAdding(false); load(); }} />}

      {empty ? (
        <section className="panel"><div className="empty">
          Add your TV, print, radio or outdoor reports, and a results file (leads, bookings or sales by week and city). Digital campaigns imported on the Media tab appear here on their own.
          Vtology lines them all up week by week and shows which media moved your results, and where.
        </div></section>
      ) : (
        <>
          <section className="panel">
            <div className="panel-head"><div><h2>Where the money went</h2><p>Every medium in these dates, in {d.currency}.{d.leftOut.length ? ` Reports in ${d.leftOut.join(', ')} are left out of the comparison.` : ''}{!d.hasDigital ? ' Digital campaigns imported on the Media tab appear here too.' : ''}</p></div></div>
            {total > 0 && <>
              <div className="split-bar">{d.totals.map(t => <i key={t.medium} style={{ width: `${(t.spend / total) * 100}%`, background: MEDIUM_COLOR[t.medium] ?? 'var(--muted)' }} title={`${t.label}: ${fm(t.spend)}`} />)}</div>
              <div className="medium-tiles">{d.totals.map(t => (
                <div key={t.medium} className="medium-tile">
                  <span className="dot" style={{ background: MEDIUM_COLOR[t.medium] ?? 'var(--muted)' }} /><b>{t.label}</b>
                  <span className="big">{fm(t.spend)}</span>
                  <span className="small muted">{pct(t.spend / total)} of spend · {t.weeks} {t.weeks === 1 ? 'week' : 'weeks'}{t.reach ? ` · ${compact(t.reach)} ${REACH_NAME[t.medium] ?? 'reach'}` : ''}</span>
                </div>
              ))}</div>
            </>}
          </section>

          <section className="panel">
            <div className="panel-head"><div><h2>Week by week: spend and {unit}</h2><p>Spend by medium on top, {unit} below, on the same weeks, so you can see what moved when each medium ran.</p></div></div>
            <WeeklyStack weeks={d.weeks} series={d.series} fm={fm} />
            {d.hasResults ? <BarChart x={d.weeks} values={d.results} height={150} color="var(--ink-2)" xFormat={short} label={unit} />
              : <div className="note-box" style={{ marginTop: 10 }}>Add a results file (leads, bookings or sales by week, ideally by city) to see what each medium did for them.</div>}
          </section>

          {d.findings.length > 0 && (
            <section className="panel">
              <div className="panel-head"><div><h2>What it means</h2><p>Each medium compared with itself: {unit} a week when it ran against when it didn’t. Offline media have no clicks, so this is lift, not exact credit.</p></div></div>
              <div className="insight-grid">{d.findings.map((f, i) => <Card key={i} f={f} />)}</div>
            </section>
          )}

          {d.hasResults && d.lifts.length > 0 && (
            <section className="panel">
              <div className="panel-head"><div><h2>Each medium: {unit} a week with it and without it</h2><p>The darker bar is weeks it ran; the lighter, weeks it didn’t.</p></div></div>
              <div className="lift-rows">{d.lifts.map(l => {
                const max = Math.max(...d.lifts.flatMap(x => [x.on ?? 0, x.off ?? 0]), 1);
                return (
                  <div className="lift-row" key={l.medium}>
                    <span><span className="dot" style={{ background: MEDIUM_COLOR[l.medium] ?? 'var(--muted)' }} /><b>{l.label}</b></span>
                    <span className="lift-bars">
                      <span><i style={{ width: `${((l.on ?? 0) / max) * 100}%`, background: MEDIUM_COLOR[l.medium] }} /><em>{l.on !== null ? Math.round(l.on) : '–'} with ({l.weeksOn} wk)</em></span>
                      <span><i style={{ width: `${((l.off ?? 0) / max) * 100}%`, background: MEDIUM_COLOR[l.medium], opacity: 0.35 }} /><em>{l.off !== null ? Math.round(l.off) : '–'} without ({l.weeksOff} wk)</em></span>
                    </span>
                    <span className={`tag ${l.verdict === 'lift' ? 'ok' : l.verdict === 'none' ? 'leak' : 'plain'}`}>{l.verdict === 'lift' ? `+${Math.round(l.lift! * 100)}%` : l.verdict === 'none' ? 'No clear rise' : 'Too few weeks'}</span>
                    <span className="small muted">{l.costPerExtra ? `${fm(l.costPerExtra)} per extra ${unit.slice(0, -1)}` : ''}</span>
                  </div>
                );
              })}</div>
            </section>
          )}

          {d.regions.length > 0 && (
            <section className="panel">
              <div className="panel-head"><div><h2>Where media ran, against where {unit} came from</h2><p>Share of regional spend (top bar) against share of {unit} (bottom bar), by city or state. National buys are left out here.</p></div></div>
              <div className="region-rows">{d.regions.map(r => (
                <div className="region-row" key={r.region}>
                  <b className="clamp1">{r.region}</b>
                  <span className="region-bars">
                    <span className="seg-bar" title={`${pct(r.spendShare)} of regional spend`}>{Object.entries(r.byMedium).map(([m, v]) => <i key={m} style={{ width: `${(v / (d.regions.reduce((a, x) => a + x.spend, 0) || 1)) * 100}%`, background: MEDIUM_COLOR[m] }} />)}</span>
                    <span className="seg-bar" title={`${pct(r.resultShare)} of ${unit}`}><i style={{ width: `${r.resultShare * 100}%`, background: 'var(--ink-2)' }} /></span>
                  </span>
                  <span className="small">{pct(r.spendShare)} spend · <b>{pct(r.resultShare)}</b> {unit}</span>
                </div>
              ))}</div>
            </section>
          )}
        </>
      )}

      {d.reports.length > 0 && (
        <section className="panel">
          <div className="panel-head"><div><h2>Files added</h2><p>Only daily totals are kept; the file itself isn’t stored.</p></div></div>
          <div className="rows">{d.reports.map(r => (
            <div className="row" key={r.id}>
              <div className="row-main"><span><b>{r.name}</b> <span className="tag plain">{OFFLINE_LABEL[r.medium]}</span></span>
                {d.canEdit && <button className="btn small link" onClick={async () => { if (!window.confirm(`Delete "${r.name}"? Its numbers leave every view.`)) return; await api('DELETE', `${T}/crossmedia/reports/${r.id}`); load(); }}>Delete</button>}</div>
              <span className="small muted">{r.status === 'ready' ? `${r.rows.toLocaleString('en-IN')} daily totals, ${r.date_from?.slice(0, 10)} to ${r.date_to?.slice(0, 10)}` : 'Upload did not finish'}</span>
            </div>
          ))}</div>
        </section>
      )}
    </div>
  );
}

function Card({ f }: { f: Finding }) {
  const tone = f.tone === 'bad' ? 'leak' : f.tone === 'good' ? 'ok' : 'flow';
  return (
    <div className={`insight ${tone}`}>
      <div className="fig"><b>{f.figure ?? '•'}</b>{f.figureLabel && <span>{f.figureLabel}</span>}</div>
      <div className="txt">
        <span className={`tag ${f.tone === 'bad' ? 'leak' : f.tone === 'good' ? 'ok' : 'plain'}`}>{f.tone === 'bad' ? 'Fix' : f.tone === 'good' ? 'Working' : 'Worth a look'}</span>
        <b>{f.title}</b><span className="small">{f.detail}</span>{f.action && <span className="small"><b>Do:</b> {f.action}</span>}
      </div>
    </div>
  );
}

/** Weekly spend as stacked columns, one colour per medium; hover a column for the split. */
function WeeklyStack({ weeks, series, fm }: { weeks: string[]; series: { medium: string; label: string; values: number[] }[]; fm: (v: number) => string }) {
  const totals = weeks.map((_, i) => series.reduce((a, s) => a + s.values[i]!, 0));
  const max = Math.max(...totals, 1);
  const every = Math.max(1, Math.ceil(weeks.length / 10));
  return (
    <div className="wstack">
      <div className="wstack-legend">{series.map(s => <span key={s.medium}><i style={{ background: MEDIUM_COLOR[s.medium] ?? 'var(--muted)' }} />{s.label}</span>)}</div>
      <div className="wstack-cols">{weeks.map((w, i) => (
        <div key={w} className="wstack-col" title={`Week of ${short(w)}: ${fm(totals[i]!)}\n${series.filter(s => s.values[i]! > 0).map(s => `${s.label}: ${fm(s.values[i]!)}`).join('\n')}`}>
          <div className="wstack-bar" style={{ height: `${(totals[i]! / max) * 100}%` }}>{series.map(s => s.values[i]! > 0 && <i key={s.medium} style={{ flexGrow: s.values[i]!, background: MEDIUM_COLOR[s.medium] ?? 'var(--muted)' }} />)}</div>
          <span className="wstack-x">{i % every === 0 ? short(w) : ''}</span>
        </div>
      ))}</div>
    </div>
  );
}

const FIELDS: Record<OfflineMedium, { f: OfflineField; label: string; need?: boolean }[]> = {
  tv: [{ f: 'day', label: 'Date', need: true }, { f: 'spend', label: 'Cost', need: true }, { f: 'vehicle', label: 'Channel' }, { f: 'region', label: 'Market or state' }, { f: 'reach', label: 'GRPs' }, { f: 'units', label: 'Spots' }, { f: 'seconds', label: 'Duration (seconds)' }],
  print: [{ f: 'day', label: 'Date', need: true }, { f: 'spend', label: 'Cost', need: true }, { f: 'vehicle', label: 'Publication' }, { f: 'region', label: 'Edition or city' }, { f: 'reach', label: 'Readership or circulation' }, { f: 'units', label: 'Insertions' }, { f: 'seconds', label: 'Size (sq cm)' }],
  radio: [{ f: 'day', label: 'Date', need: true }, { f: 'spend', label: 'Cost', need: true }, { f: 'vehicle', label: 'Station' }, { f: 'region', label: 'City' }, { f: 'reach', label: 'Listeners' }, { f: 'units', label: 'Spots' }, { f: 'seconds', label: 'Duration (seconds)' }],
  ooh: [{ f: 'day', label: 'Date', need: true }, { f: 'spend', label: 'Cost', need: true }, { f: 'vehicle', label: 'Site or format' }, { f: 'region', label: 'City' }, { f: 'reach', label: 'Footfall or impressions' }, { f: 'units', label: 'Sites' }],
  results: [{ f: 'day', label: 'Date or week', need: true }, { f: 'region', label: 'City or state' }, { f: 'leads', label: 'Leads or enquiries' }, { f: 'sales', label: 'Bookings or sales' }, { f: 'value', label: 'Revenue' }],
};

function ImportOffline({ T, onDone }: { T: string; onDone: (msg: string | null) => void }) {
  const [medium, setMedium] = useState<OfflineMedium | null>(null);
  const [guessed, setGuessed] = useState(false);
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [raw, setRaw] = useState<Record<string, string>[] | null>(null);
  const [cols, setCols] = useState<OfflineColumns>({});
  const [err, setErr] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const header = raw?.[0] ? Object.keys(raw[0]) : [];
  useEffect(() => { if (header.length && medium) setCols(detectOfflineColumns(header, medium)); }, [medium, raw]); // eslint-disable-line react-hooks/exhaustive-deps
  const parsed = useMemo(() => (raw ? toOfflineRows(raw, cols) : null), [raw, cols]);
  const missing = medium ? FIELDS[medium].filter(x => x.need && !cols[x.f]).map(x => x.label) : [];
  const needsResult = medium === 'results' && !cols.leads && !cols.sales;

  async function choose(f0: File | undefined) {
    setErr(null); setRaw(null);
    if (!f0) return;
    let f = f0;
    try {
      if (/\.gz$/i.test(f0.name)) f = new File([gunzipSync(new Uint8Array(await f0.arrayBuffer())) as BlobPart], f0.name.replace(/\.gz$/i, ''));
      else if (/\.zip$/i.test(f0.name)) {
        const [n, data] = Object.entries(unzipSync(new Uint8Array(await f0.arrayBuffer()), { filter: x => /\.(csv|xlsx)$/i.test(x.name) && !x.name.startsWith('__MACOSX') }))[0] ?? [];
        if (!n || !data) { setErr('The zip has no CSV or Excel file inside.'); return; }
        f = new File([data as BlobPart], n.split('/').pop()!);
      }
      if (!name) setName(f.name.replace(/\.(csv|txt|xlsx)$/i, '').slice(0, 100));
      // a digital report is told from its header line, before a large file is read
      if (!/\.xlsx$/i.test(f.name)) {
        const first = (await f.slice(0, 65536).text()).replace(/^\uFEFF/, '').split(/\r?\n/)[0] ?? '';
        if (guessMedium(first.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(x => x.replace(/^"|"$/g, '').trim()), f.name) === 'digital') { setErr('This is a digital report (DV360 or another ad platform). Import it on the Media tab: it appears here on its own once imported.'); return; }
      }
      const rows: Record<string, string>[] = [];
      if (/\.xlsx$/i.test(f.name)) rows.push(...await readXlsx(f)); else await streamCsv(f, r => { rows.push(r); });
      if (!rows.length) { setErr('The file has no rows under its header.'); return; }
      const g = guessMedium(Object.keys(rows[0]!), f.name);
      if (g === 'digital') { setErr('This is a digital report (DV360 or another ad platform). Import it on the Media tab: it appears here on its own once imported.'); return; }
      setMedium(g); setGuessed(!!g);
      setRaw(rows);
    } catch { setErr('Could not read the file. Save it as CSV or Excel (.xlsx) and try again.'); }
  }

  async function upload() {
    if (!parsed || !medium) return;
    setErr(null); setProgress(0);
    let id: string | null = null;
    try {
      id = (await api<{ id: string }>('POST', `${T}/crossmedia/reports`, { name, medium, currency })).id;
      // the same day, place and vehicle are added up here first: far fewer rows to send
      const m = new Map<string, OfflineRow>();
      for (const r of parsed.rows) {
        const k = `${r.day}|${r.region}|${r.vehicle}`, e = m.get(k);
        if (e) (['spend', 'reach', 'units', 'seconds', 'leads', 'sales', 'value'] as const).forEach(x => { e[x] += r[x]; }); else m.set(k, { ...r });
      }
      const rows = [...m.values()];
      for (let i = 0; i < rows.length; i += 2500) {
        const part = rows.slice(i, i + 2500);
        await api('POST', `${T}/crossmedia/reports/${id}/rows`, { rows: part }).catch(() => api('POST', `${T}/crossmedia/reports/${id}/rows`, { rows: part }));
        setProgress(Math.min(1, (i + 2500) / rows.length));
      }
      const r = await api<{ rows: number; from: string; to: string }>('POST', `${T}/crossmedia/reports/${id}/finish`);
      onDone(`Added ${OFFLINE_LABEL[medium]}: ${r.from} to ${r.to}.${parsed.skipped ? ` ${parsed.skipped.toLocaleString('en-IN')} rows without a readable date or number were skipped.` : ''}`);
    } catch (e) {
      if (id) await api('DELETE', `${T}/crossmedia/reports/${id}`).catch(() => undefined);
      setErr(e instanceof ApiError ? e.message : 'The connection dropped during the upload. Nothing was saved; try again.');
    } finally { setProgress(null); }
  }

  return (
    <section className="panel">
      <div className="panel-head"><div><h2>Add a report</h2><p>One file at a time: TV, print, radio, outdoor or results. Digital reports (DV360, Google Ads) go on the Media tab and show here on their own. Agency schedules and post-buy reports as CSV or Excel, one row per spot, insertion, day or week. For results, a row per week (or day) and city with leads, bookings or sales.</p></div></div>
      <div style={{ display: 'grid', gap: 12, maxWidth: 760 }}>
        <label className={`dropzone ${over ? 'over' : ''}`} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); choose(e.dataTransfer.files[0]); }}>
          <input type="file" accept=".csv,.txt,.xlsx,.zip,.gz" onChange={e => choose(e.target.files?.[0])} style={{ display: 'none' }} />
          <b>Drop the file here, or click to choose</b><span className="small muted">CSV, Excel, or either zipped</span>
        </label>
        {raw && (
          <>
            <div className="kind-pick">
              <b>What does this file hold?</b>
              <div className="seg" role="group" aria-label="What the file holds">
                {(Object.keys(OFFLINE_LABEL) as OfflineMedium[]).map(m => <button key={m} aria-pressed={medium === m} onClick={() => { setMedium(m); setGuessed(false); }}>{m === 'results' ? 'Results (leads, sales)' : OFFLINE_LABEL[m]}</button>)}
              </div>
              <span className="small muted">{!medium ? 'Choose one: Vtology could not tell from the columns.' : guessed ? `Looks like ${medium === 'results' ? 'results (leads or sales)' : OFFLINE_LABEL[medium]} from its columns. Change it if that’s wrong.` : ''}</span>
            </div>
            {medium && <>
            <div className="toolbar">
              <input className="input" style={{ maxWidth: 320 }} value={name} onChange={e => setName(e.target.value)} placeholder="Name, e.g. TV Diwali burst" maxLength={100} />
              {medium !== 'results' && <input className="input" style={{ width: 80 }} value={currency} onChange={e => setCurrency(e.target.value.toUpperCase().slice(0, 3))} aria-label="Currency" />}
            </div>
            <div className="map-grid">{FIELDS[medium].map(x => (
              <label key={x.f} className="small"><span>{x.label}{x.need ? ' *' : ''}</span>
                <select className="input" value={cols[x.f] ?? ''} onChange={e => setCols(c => ({ ...c, [x.f]: e.target.value || undefined }))}>
                  <option value="">Not in this file</option>{header.map(h => <option key={h} value={h}>{h}</option>)}
                </select></label>
            ))}</div>
            <span className="small muted">{raw.length.toLocaleString('en-IN')} rows read; {parsed?.rows.length.toLocaleString('en-IN')} usable{parsed?.skipped ? `, ${parsed.skipped.toLocaleString('en-IN')} without a readable date or number (totals rows are usually these)` : ''}.</span>
            {(missing.length > 0 || needsResult) && <div className="note-box">{missing.length ? `Choose the column for ${missing.join(' and ')}.` : 'Choose a column for leads or for sales.'}</div>}
            <div><button className="btn primary" disabled={!medium || !name.trim() || missing.length > 0 || needsResult || !parsed?.rows.length || progress !== null} onClick={upload}>{progress !== null ? `Adding… ${Math.round(progress * 100)}%` : `Add as ${medium === 'results' ? 'results' : OFFLINE_LABEL[medium]}`}</button></div>
            </>}
          </>
        )}
        {err && <div className="error-box" role="alert">{err}</div>}
      </div>
    </section>
  );
}
