'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CHANNEL_LABEL, detectMediaColumns, isReachReport, squeezeMediaRows, sampleMediaCsv, streamCsv, toMediaRows, toReachRows, type Channel, type MediaColumns, type MediaField, type MediaRow, type ReachRow } from '@vtology/core';
import { readXlsx } from '../xlsx';
import { gunzipSync, unzipSync } from 'fflate';
import { api, ApiError } from '../api';
import { BarChart, LineChart, Sparkline } from '../charts';
import { DateRangePicker, previousText, rangeQuery, rangeText, todayIST, type Range } from '../DateRange';
import { compact, num, pct } from '../format';

interface M { impressions: number; clicks: number; cost: number; completes: number; starts: number; cpm: number | null; completion: number | null; costPerComplete: number | null; viewability: number | null; audibleViewable: number | null; costPerQualityComplete: number | null; qualityCompletes: number }
interface Finding { tone: 'good' | 'bad' | 'info'; channel?: Channel; title: string; detail: string; action?: string; names?: string[] }
interface Report { id: string; name: string; kind?: string; currency: string; date_from: string; date_to: string; rows: number; status: string }
interface Freq { campaign: string; channel: Channel; days: number; impressions: number; cost: number; dailyReach: number; dailyFrequency: number; maxFrequency: number }
interface Data {
  reports: Report[]; coverage: { from: string; to: string } | null; currencies: string[]; empty: boolean; mixed?: boolean; frequency?: Freq[]; frequencyFindings?: Finding[]; reachCurrency?: string;
  currency?: string; range?: { from: string; to: string }; weekly?: boolean; total?: M; previous?: M;
  channels?: (M & { channel: Channel; label: string; quartiles: { at: string; share: number }[] | null })[];
  trend?: { x: string; cost: number; completes: number; impressions: number }[];
  supply?: (M & { channel: Channel; supply: string; deal: boolean })[]; sites?: (M & { channel: Channel; site: string })[];
  lineItems?: (M & { channel: Channel; campaign: string; line_item: string })[]; creatives?: (M & { channel: Channel; creative: string })[];
  devices?: (M & { channel: Channel; device: string })[];
  creativeTrend?: { creative: string; channel: Channel; measure: string; weeks: number; cost: number; series: { week: string; value: number }[]; early: number; late: number; change: number | null; status: string }[]; regions?: (M & { region: string })[]; findings?: Finding[];
}

function money(currency: string) {
  return (v: number | null | undefined) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return '–';
    const digits = Math.abs(v) < 1 ? 3 : Math.abs(v) < 10 ? 2 : 0;
    if (Math.abs(v) >= 100_000) return `${new Intl.NumberFormat('en', { style: 'currency', currency: currency || 'USD', currencyDisplay: 'narrowSymbol', notation: 'compact', maximumFractionDigits: 1 }).format(v)}`;
    try { return new Intl.NumberFormat('en', { style: 'currency', currency: currency || 'USD', currencyDisplay: 'narrowSymbol', maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v); }
    catch { return v.toFixed(digits); }
  };
}
const rate = (x: number | null | undefined) => (x === null || x === undefined ? '–' : pct(x));
const short = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** A headline number against the same days before. `lowerIsBetter` for costs. */
function Kpi({ label, now, before, fmt, lowerIsBetter, sub }: { label: string; now: number | null | undefined; before: number | null | undefined; fmt: (x: number) => string; lowerIsBetter?: boolean; sub?: string }) {
  const has = now !== null && now !== undefined;
  const cmp = has && before !== null && before !== undefined && before > 0;
  const up = cmp && now! >= before!;
  const good = cmp && (lowerIsBetter ? now! <= before! : now! >= before!);
  return (
    <div className="kpi" style={{ padding: '14px 16px' }}>
      <span className="label">{label}</span>
      <span className="value" style={{ fontSize: 26 }}>{has ? fmt(now!) : '–'}</span>
      {cmp ? <span className="sub"><b style={{ color: good ? 'var(--ok)' : 'var(--leak)' }}>{up ? '▲' : '▼'} {Math.abs(Math.round((now! / before! - 1) * 100))}%</b> vs {fmt(before!)}</span>
        : <span className="sub">{sub ?? 'no earlier data'}</span>}
    </div>
  );
}

export function Media({ workspaceId, notify, range, onRange, canEdit }: { workspaceId: string; notify: (m: string) => void; range: Range; onRange: (r: Range) => void; canEdit: boolean }) {
  const T = `/tenants/${workspaceId}`;
  const [channel, setChannel] = useState<Channel | 'all'>('all');
  const [report, setReport] = useState<string>('');
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const load = useCallback(() => {
    const q = `${rangeQuery(range)}${channel !== 'all' ? `&channel=${channel}` : ''}${report ? `&report=${report}` : ''}`;
    return api<Data>('GET', `${T}/media?${q}`).then(r => { setD(r); setErr(null); }).catch(e => setErr(e instanceof ApiError ? e.message : 'Could not load media reports.'));
  }, [T, range, channel, report]);
  useEffect(() => { load(); }, [load]);

  if (err) return <div className="error-box" role="alert">{err}</div>;
  if (!d) return <div className="progress" />;
  const fm = money(d.currency ?? d.currencies[0] ?? d.reachCurrency ?? '');
  const ready = d.reports.filter(r => r.status === 'ready');
  const freq = d.frequency ?? [];
  const allFindings = [...(d.frequencyFindings ?? []), ...(d.findings ?? [])];

  const importer = importing && <ImportReport T={T} onDone={async (msg, cov) => { setImporting(false); if (msg) { notify(msg); if (cov) onRange({ preset: 'custom', from: cov.from, to: cov.to }); else await load(); } }} />;
  if (!ready.length && !freq.length) return (
    <div style={{ display: 'grid', gap: 16 }}>
      {importer}
      {!importing && <div className="empty" style={{ display: 'grid', gap: 12, justifyItems: 'center' }}>
        <b style={{ color: 'var(--ink)', fontSize: 16 }}>Bring in a delivery report from DV360 or another DSP</b>
        <span>CTV, audio and video awareness campaigns are judged here on attention: completion, viewability, cost per completed view and the supply behind them. Reports hold campaign numbers only, no personal data.</span>
        {canEdit ? <div className="toolbar"><button className="btn primary" onClick={() => setImporting(true)}>Import a report</button><SampleReport /></div> : <span className="small">Marketing heads and data stewards can import reports.</span>}
      </div>}
    </div>
  );

  const outside = d.coverage && (range.to < d.coverage.from || range.from > d.coverage.to);
  const t = d.total, p = d.previous;
  const video = (d.channels ?? []).some(c => c.viewability !== null);
  const insights = (
    <>
      {allFindings.length > 0 && (
        <section className="panel">
          <div className="panel-head"><div><h2>What to change</h2><p>Found by comparing every deal, site, creative, device and region with the rest of the same campaign, and by how often the same people saw each line.</p></div></div>
          <div className="insight-grid">{allFindings.map((f, i) => <FindingCard key={i} f={f} />)}</div>
        </section>
      )}
      {freq.length > 0 && (
        <section className="panel">
          <div className="panel-head"><div><h2>Reach and frequency</h2><p>From the reach report: on an average day, how many people each line reached and how many times each of them saw the ad. Reach can’t be added across days, so these are daily figures.</p></div></div>
          <FrequencyChart lines={freq} />
          <details style={{ marginTop: 12 }}><summary className="small">The numbers behind it</summary>
          <Table head={['Line', 'Spend', 'Impressions', 'People reached a day', 'Ads per person a day', 'Worst day']} rows={freq.map(l => [
            <span key="n"><b>{l.campaign}</b><div className="small muted">{CHANNEL_LABEL[l.channel]}, {l.days} days</div></span>, fm(l.cost), compact(l.impressions), compact(l.dailyReach),
            <b key="f" style={{ color: l.dailyFrequency >= 4 ? 'var(--leak)' : l.dailyFrequency >= 3 ? 'var(--warn)' : undefined }}>{l.dailyFrequency.toFixed(1)}</b>, l.maxFrequency.toFixed(1)])} />
          </details>
        </section>
      )}
    </>
  );
  const presentChannels = (['ctv', 'video', 'audio', 'display'] as Channel[]).filter(c => (d.supply ?? []).some(x => x.channel === c) || (d.channels ?? []).some(x => x.channel === c));

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div className="toolbar no-print" style={{ justifyContent: 'space-between' }}>
        <div className="toolbar">
          <DateRangePicker value={range} onChange={onRange} />
          <div className="seg" role="group" aria-label="Channel">
            <button aria-pressed={channel === 'all'} onClick={() => setChannel('all')}>All channels</button>
            {presentChannels.map(c => <button key={c} aria-pressed={channel === c} onClick={() => setChannel(c)}>{CHANNEL_LABEL[c]}</button>)}
          </div>
          {ready.filter(r => r.kind !== 'reach').length > 1 && <select className="input" style={{ width: 'auto' }} value={report} onChange={e => setReport(e.target.value)} aria-label="Report"><option value="">All reports</option>{ready.filter(r => r.kind !== 'reach').map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>}
        </div>
        {canEdit && !importing && <button className="btn" onClick={() => setImporting(true)}>Import a report</button>}
      </div>
      {importer}
      {d.mixed && <div className="note-box">These reports are in different currencies ({d.currencies.join(', ')}), so they can't be added together. Choose one report above.</div>}
      {outside && d.coverage && <div className="note-box">Your reports cover {rangeText(d.coverage)}, outside the dates chosen. <button className="btn small link" onClick={() => onRange({ preset: 'custom', from: d.coverage!.from, to: d.coverage!.to })}>Show {rangeText(d.coverage)}</button></div>}
      {d.empty && insights}
      {!d.empty && t && p && (
        <>
          <section className="kpis" aria-label="Key figures" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
            <Kpi label="Spend" now={t.cost} before={p.cost} fmt={x => fm(x)} />
            <Kpi label="Impressions" now={t.impressions} before={p.impressions} fmt={compact} sub={t.cpm ? `${fm(t.cpm)} CPM` : undefined} />
            <Kpi label="Completed views" now={t.completes} before={p.completes} fmt={compact} />
            <Kpi label="Completion rate" now={t.completion} before={p.completion} fmt={pct} />
            <Kpi label="Cost per completed view" now={t.costPerComplete} before={p.costPerComplete} fmt={x => fm(x)} lowerIsBetter />
            {video && <Kpi label="Viewable (video, display)" now={t.viewability} before={p.viewability} fmt={pct} sub="CTV and audio can't be measured" />}
          </section>
          <p className="small muted" style={{ marginTop: -10 }}>{rangeText(range)}, against {previousText(range)}. Amounts in {d.currency || 'the report currency'}.</p>
          <div className="grid-2">
            <section className="panel"><div className="panel-head"><div><h2>Where the money went</h2><p>Share of spend by channel, with what each completed view cost.</p></div></div><SpendSplit channels={d.channels ?? []} fm={fm} /></section>
            <section className="panel"><div className="panel-head"><div><h2>Which supply buys attention cheapest</h2><p>Cost per completed view against the channel average (100). Green is cheaper; bar length is spend.</p></div></div><SupplyChart rows={d.supply ?? []} channels={d.channels ?? []} fm={fm} /></section>
          </div>
          {insights}


          <div className="grid-2">
            <section className="panel">
              <div className="panel-head"><div><h2>Spend</h2><p>{d.weekly ? 'Per week' : 'Per day'}</p></div></div>
              <BarChart x={d.trend!.map(x => x.x)} values={d.trend!.map(x => x.cost)} xFormat={short} format={x => fm(x)} label="spend" />
            </section>
            <section className="panel">
              <div className="panel-head"><div><h2>Completed views</h2><p>{d.weekly ? 'Per week' : 'Per day'}, all channels in view</p></div></div>
              <LineChart x={d.trend!.map(x => x.x)} series={[{ key: 'c', label: 'completed views', color: 'var(--flow)', values: d.trend!.map(x => x.completes) }]} xFormat={short} height={220} />
            </section>
          </div>

          <section className="panel">
            <div className="panel-head"><div><h2>Channels</h2><p>Cost per completed view counts only views that were also viewable, where viewability can be measured.</p></div></div>
            <Table head={['Channel', 'Spend', 'Share', 'Impressions', 'CPM', 'Completion', 'Viewable', 'Cost per completed view']} rows={(d.channels ?? []).map(c => [
              <b key="n">{c.label}</b>, fm(c.cost), pct(c.cost / Math.max(1, t.cost)), compact(c.impressions), fm(c.cpm), rate(c.completion), c.viewability === null ? <span className="muted" key="v">not measurable</span> : pct(c.viewability), <b key="q">{fm(c.costPerQualityComplete)}</b>])} />
            <div className="aud-quartiles">
              {(d.channels ?? []).filter(c => c.quartiles).map(c => (
                <div key={c.channel}>
                  <b className="small">{c.label}: who is still {c.channel === 'audio' ? 'listening' : 'watching'}</b>
                  <BarChart x={c.quartiles!.map(q => q.at)} values={c.quartiles!.map(q => q.share)} format={pct} height={160} color={c.channel === 'ctv' ? 'var(--flow)' : c.channel === 'audio' ? 'var(--ok)' : 'var(--warn)'} label="of starts" />
                </div>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head"><div><h2>Supply: deals and open auction</h2><p>Each inventory source against the average of its channel. Below 100 is cheaper attention.</p></div></div>
            <IndexTable fm={fm} rows={(d.supply ?? []).map(s => ({ name: s.supply, tag: s.deal ? 'Deal' : 'Open auction', channel: s.channel, m: s }))} channels={d.channels ?? []} />
          </section>

          <div className="grid-2">
            <section className="panel">
              <div className="panel-head"><div><h2>Line items</h2></div></div>
              <Table head={['Line item', 'Spend', 'Completion', 'Cost per completed view']} rows={(d.lineItems ?? []).slice(0, 15).map(l => [<span key="n"><b>{l.line_item || '(none)'}</b><div className="small muted">{CHANNEL_LABEL[l.channel]}</div></span>, fm(l.cost), rate(l.completion), fm(l.costPerQualityComplete)])} />
            </section>
            <section className="panel">
              <div className="panel-head"><div><h2>Creatives</h2></div></div>
              <Table head={['Creative', 'Spend', 'Completion', 'Cost per completed view']} rows={(d.creatives ?? []).slice(0, 15).map(c => [<span key="n"><b>{c.creative || '(none)'}</b><div className="small muted">{CHANNEL_LABEL[c.channel]}</div></span>, fm(c.cost), rate(c.completion), fm(c.costPerQualityComplete)])} />
            </section>
          </div>

          {(d.creativeTrend?.length ?? 0) > 0 && (
            <section className="panel">
              <div className="panel-head"><div><h2>Creative fatigue</h2><p>Week by week, how each creative holds attention: completion for video and audio, click rate for display. A creative is wearing out when its last two weeks fall more than 12% below its first two.</p></div></div>
              <div className="fatigue-grid">{d.creativeTrend!.map(c => (
                <div key={`${c.channel}${c.creative}`} className={`fatigue ${c.status.replace(' ', '-')}`}>
                  <span className="ht-head"><b className="sc-name" title={c.creative}>{c.creative}</b><span className={`tag ${c.status === 'wearing out' ? 'leak' : c.status === 'slipping' ? 'warn' : c.status === 'steady' ? 'ok' : 'plain'}`}>{c.status === 'new' ? 'too new to judge' : c.status}</span></span>
                  <span className="small muted">{CHANNEL_LABEL[c.channel]} · {c.weeks} weeks · {fm(c.cost)}</span>
                  {c.series.length > 1 && <Sparkline values={c.series.map(x => x.value)} color={c.status === 'wearing out' ? 'var(--leak)' : c.status === 'slipping' ? 'var(--warn)' : 'var(--flow)'} height={44} />}
                  <span className="small">{c.measure === 'completion' ? 'Completion' : 'Click rate'} {c.measure === 'completion' ? pct(c.early) : `${(c.early * 100).toFixed(2)}%`} → <b>{c.measure === 'completion' ? pct(c.late) : `${(c.late * 100).toFixed(2)}%`}</b>{c.change !== null ? ` (${c.change >= 0 ? '+' : '−'}${Math.abs(Math.round(c.change * 100))}%)` : ''}</span>
                  {c.status === 'wearing out' && <span className="small"><b>Do:</b> rotate in a fresh cut, or cap frequency on this creative.</span>}
                </div>
              ))}</div>
            </section>
          )}

          <section className="panel">
            <div className="panel-head"><div><h2>Sites and apps</h2><p>The 30 with the most spend. Red marks completion under 60% of its channel, or viewability under half.</p></div></div>
            <IndexTable fm={fm} rows={(d.sites ?? []).slice(0, 30).map(s => ({ name: s.site || '(not reported)', channel: s.channel, m: s }))} channels={d.channels ?? []} flag />
          </section>

          <div className="grid-2">
            <section className="panel">
              <div className="panel-head"><div><h2>Devices</h2></div></div>
              <Table head={['Device', 'Spend', 'Completion', 'Cost per completed view']} rows={(d.devices ?? []).slice(0, 12).map(x => [<span key="n"><b>{x.device || '(not reported)'}</b><div className="small muted">{CHANNEL_LABEL[x.channel]}</div></span>, fm(x.cost), rate(x.completion), fm(x.costPerQualityComplete)])} />
            </section>
            <section className="panel">
              <div className="panel-head"><div><h2>Regions</h2></div></div>
              <Table head={['Region', 'Spend', 'Share', 'Cost per completed view']} rows={(d.regions ?? []).slice(0, 15).map(x => [<b key="n">{x.region || '(not reported)'}</b>, fm(x.cost), pct(x.cost / Math.max(1, t.cost)), fm(x.costPerQualityComplete)])} />
            </section>
          </div>
        </>
      )}

      <section className="panel">
        <div className="panel-head"><div><h2>Reports</h2><p>Each import is kept as it arrived. Two reports covering the same days would count the same delivery twice, so keep one per flight.</p></div></div>
        <Table head={['Report', 'Dates', 'Rows', 'Currency', '']} rows={d.reports.map(r => [<b key="n">{r.name}{r.status !== 'ready' && <span className="tag warn" style={{ marginLeft: 8 }}>Import not finished</span>}</b>,
          r.date_from ? rangeText({ from: r.date_from, to: r.date_to }) : '–', num(r.rows), r.currency || '–',
          canEdit ? <button key="x" className="btn small danger" onClick={async () => { if (!window.confirm(`Delete ${r.name}?`)) return; await api('DELETE', `${T}/media/reports/${r.id}`); notify(`Deleted ${r.name}.`); load(); }}>Delete</button> : ''])} />
      </section>
    </div>
  );
}

const CH_COLOR: Record<string, string> = { ctv: 'var(--flow)', video: 'var(--warn)', audio: 'var(--ok)', display: 'var(--muted)' };

function FindingCard({ f }: { f: Finding & { figure?: string; figureLabel?: string } }) {
  const [copied, setCopied] = useState(false);
  const tone = f.tone === 'bad' ? 'leak' : f.tone === 'good' ? 'ok' : 'flow';
  return (
    <div className={`insight ${tone}`}>
      <div className="fig"><b>{f.figure ?? (f.tone === 'bad' ? '!' : '✓')}</b>{f.figureLabel && <span>{f.figureLabel}</span>}</div>
      <div className="txt">
        <span className={`tag ${f.tone === 'bad' ? 'leak' : f.tone === 'good' ? 'ok' : 'plain'}`}>{f.tone === 'bad' ? 'Fix' : f.tone === 'good' ? 'Working' : 'Worth a look'}{f.channel ? ` · ${CHANNEL_LABEL[f.channel]}` : ''}</span>
        <b>{f.title.replace(/^(Connected TV|Online video|Audio|Display): /, '')}</b>
        <span className="small">{f.detail}</span>
        {f.action && <span className="small"><b>Do:</b> {f.action}</span>}
        {f.names && f.names.length > 0 && <div className="toolbar" style={{ gap: 6 }}>{f.names.slice(0, 6).map(n => <span key={n} className="tag plain">{n}</span>)}{f.names.length > 6 && <span className="small muted">+{f.names.length - 6}</span>}
          <button className="btn small" onClick={() => { navigator.clipboard?.writeText(f.names!.join('\n')).then(() => setCopied(true)).catch(() => undefined); }}>{copied ? 'Copied' : 'Copy list'}</button></div>}
      </div>
    </div>
  );
}

function SpendSplit({ channels, fm }: { channels: (M & { channel: Channel; label: string })[]; fm: (v: number | null) => string }) {
  const total = channels.reduce((a, c) => a + c.cost, 0) || 1;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="split-bar">{channels.map(c => <i key={c.channel} style={{ width: `${(c.cost / total) * 100}%`, background: CH_COLOR[c.channel] }} title={`${c.label}: ${fm(c.cost)}`} />)}</div>
      <div className="split-legend">{channels.map(c => (
        <div key={c.channel}><i style={{ background: CH_COLOR[c.channel] }} /><span><b>{c.label}</b> {pct(c.cost / total)} · {fm(c.cost)}</span><span className="small muted">{c.completion !== null ? `${pct(c.completion)} complete · ` : ''}{fm(c.costPerQualityComplete)} per completed view</span></div>
      ))}</div>
    </div>
  );
}

function SupplyChart({ rows, channels, fm }: { rows: (M & { channel: Channel; supply: string; deal: boolean })[]; channels: (M & { channel: Channel })[]; fm: (v: number | null) => string }) {
  const avg = new Map(channels.map(c => [c.channel, c.costPerQualityComplete]));
  const items = rows.filter(r => r.costPerQualityComplete && avg.get(r.channel)).slice(0, 10).map(r => ({ r, idx: (r.costPerQualityComplete! / avg.get(r.channel)!) * 100 }));
  const maxCost = Math.max(1, ...items.map(x => x.r.cost));
  if (!items.length) return <div className="empty">No supply with completed views in these dates.</div>;
  return (
    <div className="supply-chart">{items.map(({ r, idx }) => {
      const dev = Math.max(-40, Math.min(40, idx - 100));
      return (
        <div key={`${r.channel}${r.supply}`} className="sc-row" title={`${fm(r.cost)} spend · ${fm(r.costPerQualityComplete)} per completed view`}>
          <span className="sc-name">{r.supply}<span className="muted"> · {CHANNEL_LABEL[r.channel]}{r.deal ? ', deal' : ''}</span></span>
          <span className="sc-track"><i className="sc-mid" /><i className="sc-bar" style={{ left: dev < 0 ? `${50 + (dev / 40) * 50}%` : '50%', width: `${(Math.abs(dev) / 40) * 50}%`, background: dev <= 0 ? 'var(--ok)' : 'var(--leak)', opacity: 0.35 + 0.65 * (r.cost / maxCost) }} /></span>
          <b className="sc-val">{Math.round(idx)}</b>
        </div>
      );
    })}</div>
  );
}

function FrequencyChart({ lines }: { lines: Freq[] }) {
  const max = Math.max(6, ...lines.map(l => l.maxFrequency));
  return (
    <div className="freq-chart">
      {lines.slice(0, 14).map(l => (
        <div key={l.campaign} className="fq-row">
          <span className="sc-name">{l.campaign}<span className="muted"> · {CHANNEL_LABEL[l.channel]}</span></span>
          <span className="fq-track">
            <i className="fq-ok" style={{ width: `${(3 / max) * 100}%` }} />
            <i className="fq-bar" style={{ width: `${(l.dailyFrequency / max) * 100}%`, background: l.dailyFrequency >= 4 ? 'var(--leak)' : l.dailyFrequency >= 3 ? 'var(--warn)' : 'var(--flow)' }} />
            <i className="fq-max" style={{ left: `${(l.maxFrequency / max) * 100}%` }} title={`worst day ${l.maxFrequency.toFixed(1)}`} />
          </span>
          <b className="sc-val">{l.dailyFrequency.toFixed(1)}</b>
        </div>
      ))}
      <div className="legend" style={{ marginTop: 8 }}><span><i style={{ background: 'var(--ok-soft)' }} />healthy zone, up to 3 a day</span><span><i className="line" style={{ background: 'var(--ink)' }} />worst day</span></div>
    </div>
  );
}

function FindingRow({ f }: { f: Finding }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="row" style={{ gap: 6 }}>
      <div className="row-main"><span><span className={`tag ${f.tone === 'bad' ? 'leak' : f.tone === 'good' ? 'ok' : 'plain'}`} style={{ marginRight: 8 }}>{f.tone === 'bad' ? 'Fix' : f.tone === 'good' ? 'Working' : 'Worth a look'}</span><b>{f.title}</b></span></div>
      <span className="small">{f.detail}</span>
      {f.action && <span className="small"><b>Do:</b> {f.action}</span>}
      {f.names && f.names.length > 0 && (
        <div className="toolbar" style={{ gap: 6 }}>
          {f.names.slice(0, 12).map(n => <span key={n} className="tag plain">{n}</span>)}{f.names.length > 12 && <span className="small muted">and {f.names.length - 12} more</span>}
          <button className="btn small" onClick={() => { navigator.clipboard?.writeText(f.names!.join('\n')).then(() => setCopied(true)).catch(() => undefined); }}>{copied ? 'Copied' : 'Copy list'}</button>
        </div>
      )}
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="table-wrap" style={{ boxShadow: 'none' }}>
      <table>
        <thead><tr>{head.map((h, i) => <th key={i} className={i > 0 && h ? 'num' : undefined}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={j > 0 ? 'num' : undefined}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

/** Rows against their channel's average cost per completed view: 100 = average, lower is cheaper attention. */
function IndexTable({ rows, channels, fm, flag }: { rows: { name: string; tag?: string; channel: Channel; m: M }[]; channels: (M & { channel: Channel })[]; fm: (v: number | null) => string; flag?: boolean }) {
  const avg = (c: Channel) => channels.find(x => x.channel === c);
  return (
    <div className="table-wrap" style={{ boxShadow: 'none' }}>
      <table>
        <thead><tr><th>Name</th><th>Channel</th><th className="num">Spend</th><th className="num">Completion</th><th className="num">Viewable</th><th className="num">Cost per completed view</th><th style={{ width: 180 }}>Against channel average</th></tr></thead>
        <tbody>{rows.map((r, i) => {
          const a = avg(r.channel);
          const idx = a?.costPerQualityComplete && r.m.costPerQualityComplete ? Math.round((r.m.costPerQualityComplete / a.costPerQualityComplete) * 100) : null;
          const weak = flag && a && ((r.m.completion !== null && a.completion !== null && r.m.completion < a.completion * 0.6) || (r.m.viewability !== null && r.m.viewability < 0.5));
          return (
            <tr key={i}>
              <td><b style={{ color: weak ? 'var(--leak)' : undefined }}>{r.name}</b>{r.tag && <span className={`tag ${r.tag === 'Deal' ? 'flow' : 'plain'}`} style={{ marginLeft: 8 }}>{r.tag}</span>}</td>
              <td className="small">{CHANNEL_LABEL[r.channel]}</td>
              <td className="num">{fm(r.m.cost)}</td><td className="num">{rate(r.m.completion)}</td><td className="num">{r.m.viewability === null ? '–' : pct(r.m.viewability)}</td>
              <td className="num"><b>{fm(r.m.costPerQualityComplete)}</b></td>
              <td>{idx !== null && <div className="aud-index" title={`${idx} (100 = channel average)`}><i style={{ width: `${Math.min(100, idx / 2)}%`, background: idx <= 100 ? 'var(--ok)' : 'var(--leak)' }} /><span>{idx}</span></div>}</td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- importing
const FIELD_NAME: Partial<Record<MediaField, string>> = {
  day: 'Date', campaign: 'Campaign or insertion order', lineItem: 'Line item', lineItemType: 'Line item type', creative: 'Creative', exchange: 'Exchange', inventorySource: 'Inventory source (deal)',
  site: 'App or site', device: 'Device', region: 'Region', currency: 'Currency', advertiser: 'Advertiser', reach: 'People reached', impressions: 'Impressions', cost: 'Media cost', viewable: 'Viewable impressions', measurable: 'Measurable impressions',
  starts: 'Starts', q1: '25% views', q2: '50% views', q3: '75% views', completes: 'Completed views or listens', audible: 'Audible and visible at completion', clicks: 'Clicks', conversions: 'Conversions',
};
const NEEDED: MediaField[] = ['day', 'impressions', 'cost'];

/** What went wrong with an import, in words that say what to do next. */
function explain(e: unknown, rows: number): string {
  if (!(e instanceof ApiError)) return 'The connection dropped during the upload. Nothing was saved; check the internet connection and press Import again.';
  if (e.status === 413 || /413/.test(e.message)) return 'Part of the file was too big to send in one go. Untick lines you don’t need, or export the report without App/URL, then import again.';
  if (e.status === 409) return e.message;
  if (e.status === 401) return 'Your sign-in expired during the upload. Sign in again and import the file once more.';
  if (e.status === 504 || e.status === 502 || /timed? ?out/i.test(e.message)) return `The server took too long with ${rows.toLocaleString('en-IN')} rows. Nothing was saved. Try again; if it repeats, import a shorter date range or fewer lines.`;
  if (e.status >= 500) return `Vtology couldn’t save the report, and nothing was kept. Reason: ${e.message.replace(/^Something went wrong on our side ?\(?|\)?\. The error has been logged\.$/g, '') || 'unknown'}. Try again; if it repeats, send this message to support.`;
  return e.message;
}

function ImportReport({ T, onDone }: { T: string; onDone: (msg: string | null, coverage?: { from: string; to: string }) => void }) {
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('');
  const [reading, setReading] = useState<number | null>(null);
  const [parsed, setParsed] = useState<{ kind: 'delivery' | 'reach'; rows: MediaRow[]; reach: ReachRow[]; skipped: number; cols: MediaColumns; header: string[]; squeezed?: { before: number; tailSites: number } } | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  async function choose(f0: File | undefined) {
    setErr(null); setParsed(null);
    if (!f0) return;
    // zipped or gzipped exports are opened here, in the browser
    let f: File = f0;
    try {
      if (/\.gz$/i.test(f0.name)) f = new File([gunzipSync(new Uint8Array(await f0.arrayBuffer())) as BlobPart], f0.name.replace(/\.gz$/i, ''));
      else if (/\.zip$/i.test(f0.name)) {
        const files = unzipSync(new Uint8Array(await f0.arrayBuffer()), { filter: x => /\.(csv|xlsx)$/i.test(x.name) && !x.name.startsWith('__MACOSX') });
        const [name0, data] = Object.entries(files)[0] ?? [];
        if (!name0 || !data) { setErr('The zip has no CSV or Excel file inside.'); return; }
        f = new File([data as BlobPart], name0.split('/').pop()!);
      }
    } catch { setErr('Could not open the compressed file.'); return; }
    if (!name) setName(f.name.replace(/\.(csv|txt|xlsx)$/i, '').slice(0, 100));
    setReading(0);
    try {
      // rows are turned into compact records as they're read, so files of hundreds of MB fit in the browser
      let cols: MediaColumns | null = null, header: string[] = [], reachMode = false, skipped = 0, seen = 0;
      const rows: MediaRow[] = [], reach: ReachRow[] = [];
      const take = (r: Record<string, string>) => {
        if (!cols) { header = Object.keys(r); cols = detectMediaColumns(header); reachMode = isReachReport(cols); }
        if (reachMode) { const o = toReachRows([r], cols); reach.push(...o.rows); skipped += o.skipped; }
        else { const o = toMediaRows([r], cols, currency); rows.push(...o.rows); skipped += o.skipped; }
        if (++seen % 20000 === 0) setReading(seen);
      };
      if (/\.xlsx$/i.test(f.name)) (await readXlsx(f)).forEach(take);
      else await streamCsv(f, take);
      if (!cols) { setErr('The file has no rows under its header.'); setReading(null); return; }
      // squeeze delivery rows before upload: same totals, far fewer rows
      const sq = reachMode ? null : squeezeMediaRows(rows);
      const result = { kind: reachMode ? 'reach' as const : 'delivery' as const, rows: sq ? sq.rows : rows, reach, skipped, cols, header, squeezed: sq ? { before: sq.before, tailSites: sq.tailSites } : undefined };
      setParsed(result);
      setPick(new Set(reachMode ? reach.map(r => r.campaign) : rows.map(r => r.campaign)));
      const cur = rows.find(r => r.currency)?.currency;
      if (cur && !currency) setCurrency(cur);
      // a file that stops in the middle of a line was cut short (a size limit on the way)
      if (f.size >= 50 * 1024 * 1024 && !/\.xlsx$/i.test(f.name)) {
        const tail = await f.slice(Math.max(0, f.size - 2)).text();
        if (!tail.endsWith('\n')) setErr(`This file ends in the middle of a line, so it was probably cut short (it is ${Math.round(f.size / 1048576)} MB). Check that it holds everything, or export it in smaller parts (for example without App/URL).`);
      }
    } catch { setErr('Could not read the file. Export the report as CSV (or Excel) and try again.'); }
    finally { setReading(null); }
  }

  const missing = parsed ? (parsed.kind === 'reach' ? (['day', 'impressions'] as MediaField[]) : NEEDED).filter(f => !parsed.cols[f]?.length) : [];
  // the lines in the file (insertion orders), with spend, so another client's campaigns can be left out
  const lines = useMemo(() => {
    const m = new Map<string, { cost: number; rows: number; advertiser: string }>();
    if (parsed?.kind === 'reach') for (const r of parsed.reach) { const x = m.get(r.campaign) ?? { cost: 0, rows: 0, advertiser: '' }; x.cost += r.cost; x.rows++; m.set(r.campaign, x); }
    else for (const r of parsed?.rows ?? []) { const x = m.get(r.campaign) ?? { cost: 0, rows: 0, advertiser: r.advertiser }; x.cost += r.cost; x.rows++; m.set(r.campaign, x); }
    return [...m.entries()].sort((a, b) => b[1].cost - a[1].cost);
  }, [parsed]);
  const chosenRows = parsed ? (parsed.kind === 'reach' ? parsed.reach.filter(r => pick.has(r.campaign)).length : parsed.rows.filter(r => pick.has(r.campaign)).length) : 0;
  const dates = useMemo(() => {
    const ds = parsed ? (parsed.kind === 'reach' ? parsed.reach.map(r => r.day) : parsed.rows.map(r => r.day)) : [];
    return ds.length ? { from: ds.reduce((a, b) => (b < a ? b : a)), to: ds.reduce((a, b) => (b > a ? b : a)) } : null;
  }, [parsed]);
  const byChannel = useMemo(() => { const c: Record<string, number> = {}; for (const r of parsed?.rows ?? []) if (pick.has(r.campaign)) c[r.channel] = (c[r.channel] ?? 0) + r.cost; return c; }, [parsed, pick]);

  async function upload() {
    if (!parsed) return;
    setErr(null); setProgress(0);
    let id: string | null = null;
    try {
      const r = await api<{ id: string; chunkMax: number }>('POST', `${T}/media/reports`, { name, currency, columns: parsed.cols, kind: parsed.kind });
      id = r.id;
      const rows: object[] = parsed.kind === 'reach' ? parsed.reach.filter(x => pick.has(x.campaign)) : parsed.rows.filter(x => pick.has(x.campaign)).map(x => ({ ...x, currency: x.currency || currency }));
      const size = parsed.kind === 'reach' ? 5000 : 2500;
      // four chunks at a time; each is retried once if the network drops
      const starts = Array.from({ length: Math.ceil(rows.length / size) }, (_, k) => k * size);
      let done = 0;
      const send = async (i: number) => { try { await api('POST', `${T}/media/reports/${id}/rows`, { rows: rows.slice(i, i + size) }); } catch (e) { if (e instanceof ApiError && e.status < 500) throw e; await api('POST', `${T}/media/reports/${id}/rows`, { rows: rows.slice(i, i + size) }); } done++; setProgress(done / starts.length); };
      for (let k = 0; k < starts.length; k += 4) await Promise.all(starts.slice(k, k + 4).map(send));
      const f = await api<{ rows: number; from: string; to: string; overlaps: string[] }>('POST', `${T}/media/reports/${id}/finish`);
      onDone(`${name}: ${num(f.rows)} rows from ${rangeText(f)}.${f.overlaps.length ? ` It covers the same days as ${f.overlaps.join(', ')}; delete one so delivery isn't counted twice.` : ''}`, { from: f.from, to: f.to });
    } catch (e) {
      setErr(explain(e, parsed.kind === 'reach' ? parsed.reach.length : parsed.rows.length));
      if (id) await api('DELETE', `${T}/media/reports/${id}`).catch(() => undefined);
      setProgress(null);
    }
  }

  return (
    <div className="note-box" style={{ display: 'grid', gap: 12, background: 'var(--surface-2)', border: '1px solid var(--line)' }}>
      <b>Import a report</b>
      <span className="small muted">A DV360 delivery report (Reporting, New report, Standard, by Date) or a reach report with Unique Reach, as CSV or Excel. Other DSPs work too if each row has a date, impressions and cost.</span>
      <div className="grid-2" style={{ gap: 12 }}>
        <label className={`dropzone${over ? ' over' : ''}`} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); choose(e.dataTransfer.files?.[0]); }}>
          <b>Drop the report here, or click to choose</b>
          <span className="small muted">CSV, Excel, or a .zip of either. Large files are fine: they are read and squeezed on this computer.</span>
          <input type="file" accept=".csv,text/csv,.xlsx,.zip,.gz" style={{ display: 'none' }} onChange={e => choose(e.target.files?.[0])} />
        </label>
        <label className="field">Name<input className="input" value={name} onChange={e => setName(e.target.value)} maxLength={100} placeholder="Lincoln CTV and audio, Q4" /></label>
        <label className="field">Currency<input className="input" value={currency} onChange={e => setCurrency(e.target.value.toUpperCase().slice(0, 3))} placeholder="CAD" /></label>
      </div>
      {reading !== null && <div><div className="progress" /><p className="small muted" style={{ marginTop: 6 }}>Reading the file… {reading ? `${num(reading)} rows so far` : ''}</p></div>}
      {parsed && (
        <>
          <span className="small"><b>{parsed.kind === 'reach' ? 'Reach report' : 'Delivery report'}: {num(parsed.kind === 'reach' ? parsed.reach.length : parsed.rows.length)} rows</b>{dates ? `, ${rangeText(dates)}` : ''}{parsed.skipped ? `; ${num(parsed.skipped)} lines without a date left out (report notes and totals)` : ''}.
            {parsed.squeezed && parsed.squeezed.before > parsed.rows.length && <> Squeezed from {num(parsed.squeezed.before)} rows ({Math.round((1 - parsed.rows.length / parsed.squeezed.before) * 100)}% smaller){parsed.squeezed.tailSites ? `, with ${num(parsed.squeezed.tailSites)} tiny sites grouped as “Other sites (small)”` : ''}; every total is unchanged.</>}
            {parsed.kind === 'delivery' && <> Spend by channel in the chosen lines: {Object.entries(byChannel).map(([c, v]) => `${CHANNEL_LABEL[c as Channel]} ${money(currency)(v)}`).join(', ') || 'none'}.</>}</span>
          {lines.length > 1 && (
            <div style={{ display: 'grid', gap: 6 }}>
              <span className="small"><b>Which lines belong to this brand?</b> The file has {lines.length}. Untick other clients’ campaigns.
                <button className="btn small link" onClick={() => setPick(new Set(lines.map(l => l[0])))}>All</button><button className="btn small link" onClick={() => setPick(new Set())}>None</button></span>
              <div className="aud-pick" style={{ maxHeight: 220, overflow: 'auto' }}>
                {lines.map(([c, x]) => <label key={c}><input type="checkbox" checked={pick.has(c)} onChange={() => { const n = new Set(pick); if (n.has(c)) n.delete(c); else n.add(c); setPick(n); }} /> {c} <span className="muted small">{money(currency)(x.cost)}, {num(x.rows)} rows</span></label>)}
              </div>
            </div>
          )}
          <details><summary className="small">Which column Vtology reads for each figure</summary>
            <div className="table-wrap" style={{ boxShadow: 'none', marginTop: 8 }}>
              <table>
                <thead><tr><th>Vtology reads</th><th>From your column</th></tr></thead>
                <tbody>{(Object.keys(FIELD_NAME) as MediaField[]).map(f => <tr key={f}><td>{FIELD_NAME[f]}</td><td>{parsed.cols[f]?.join(' + ') ?? <span className="muted">{NEEDED.includes(f) && parsed.kind === 'delivery' ? <b style={{ color: 'var(--leak)' }}>missing</b> : 'not in this report'}</span>}</td></tr>)}</tbody>
              </table>
            </div>
          </details>
          {missing.length > 0 && <div className="error-box">The report needs {missing.map(m => FIELD_NAME[m] ?? m).join(', ')} to be read.</div>}
        </>
      )}
      {err && <div className="error-box" role="alert">{err}</div>}
      {progress !== null && <div><div className="share-bar"><i style={{ width: `${progress * 100}%` }} /></div><p className="small muted" style={{ marginTop: 6 }}>Importing… {pct(progress)}</p></div>}
      <div className="toolbar">
        <button className="btn primary" disabled={!parsed || missing.length > 0 || !chosenRows || !name.trim() || progress !== null} onClick={upload}>Import {chosenRows ? num(chosenRows) : ''} rows</button>
        <button className="btn" onClick={() => onDone(null)} disabled={progress !== null}>Cancel</button>
      </div>
    </div>
  );
}

/** A made-up DV360 report (a fictional car brand in Canada) to try the tab with. */
function SampleReport() {
  return <button className="btn" onClick={() => {
    const url = URL.createObjectURL(new Blob([sampleMediaCsv(todayIST())], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = 'sample-dv360-awareness-report.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }}>Download a sample report</button>;
}
