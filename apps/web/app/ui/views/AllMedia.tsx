'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { OFFLINE_LABEL, detectOfflineColumns, guessMedium, streamCsv, toOfflineRows, type OfflineColumns, type OfflineField, type OfflineMedium, type OfflineRow } from '@vtology/core';
import { gunzipSync, unzipSync } from 'fflate';
import { readXlsx } from '../xlsx';
import { api, ApiError } from '../api';
import { BarChart } from '../charts';

import { compact, pct } from '../format';

interface Total { medium: string; label: string; kind: 'offline' | 'digital'; spend: number; reach: number; units: number; weeks: number }
interface Lift { medium: string; label: string; spend: number; weeksOn: number; weeksOff: number; on: number | null; off: number | null; lift: number | null; extra: number | null; costPerExtra: number | null; overlap: number; verdict: 'lift' | 'none' | 'too_few_weeks' }
interface Region { region: string; results: number; spend: number; resultShare: number; spendShare: number; byMedium: Record<string, number> }
interface Finding { tone: 'good' | 'bad' | 'neutral'; title: string; detail: string; action?: string; figure?: string; figureLabel?: string }
export interface Report { id: string; name: string; medium: OfflineMedium; currency: string; status: string; rows: number; date_from: string | null; date_to: string | null }
interface Glance { medium: string; label: string; group: string; tab: string; spend: number; did: string; measure: string; verdict: 'add' | 'keep' | 'cut' | 'test' | 'unknown' }
interface Picture { spend: number; results: number; perResult: number | null; resultsFrom: 'file' | 'platforms' | 'none'; glance: Glance[]; next: { tone: 'good' | 'bad' | 'neutral'; text: string; tab: string }[] }
interface Data { picture: Picture; currency: string; leftOut: string[]; measure: 'leads' | 'sales'; hasResults: boolean; hasDigital: boolean; weeks: string[]; series: { medium: string; label: string; values: number[] }[]; results: number[]; totals: Total[]; lifts: Lift[]; regions: Region[]; findings: Finding[]; reports: Report[]; canEdit: boolean }

/** one colour per medium, kept the same wherever it appears */
export const MEDIUM_COLOR: Record<string, string> = { tv: '#3b5bdb', print: '#e8590c', radio: '#2f9e44', ooh: '#ae3ec9', ctv: '#1098ad', video: '#f59f00', audio: '#74b816', display: '#868e96', 'perf:Search': '#364fc7', 'perf:Performance Max': '#7048e8', 'perf:YouTube': '#e03131', 'perf:Display': '#a61e4d', 'perf:Demand Gen': '#f76707', 'perf:Shopping': '#37b24d', 'perf:Meta': '#1c7ed6' };
const VERDICT: Record<Glance['verdict'], { text: string; tone: string }> = { add: { text: 'Put more in', tone: 'ok' }, keep: { text: 'Keep', tone: 'flow' }, cut: { text: 'Cut or move', tone: 'leak' }, test: { text: 'Test', tone: 'plain' }, unknown: { text: 'Needs results', tone: 'plain' } };
const REACH_NAME: Record<string, string> = { tv: 'GRPs', print: 'readership', radio: 'listeners', ooh: 'footfall', ctv: 'impressions', video: 'impressions', audio: 'impressions', display: 'impressions' };
const short = (w: string) => new Date(`${w}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

function money(currency: string) {
  return (v: number) => {
    try { return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en', { style: 'currency', currency, currencyDisplay: 'narrowSymbol', notation: Math.abs(v) >= 1e5 ? 'compact' : 'standard', maximumFractionDigits: Math.abs(v) >= 1e5 ? 1 : 0 }).format(v); }
    catch { return `${currency} ${Math.round(v)}`; }
  };
}

export interface Chain {
  aware: { spend: number; media: { medium: string; label: string; spend: number }[]; grps: number; readers: number; impressions: number; completes: number };
  look: { burst: string; brandOn: number; brandOff: number; cpaOn: number | null; cpaOff: number | null } | null;
  lead: { medium: string; lift: number | null } | null;
  convert: { spend: number; media: { medium: string; label: string; spend: number }[]; results: number; perResult: number | null; platformConversions: number | null; platformCpa: number | null };
}
export interface Shared { mainline: boolean; results: boolean; programmatic: boolean; search: boolean; meta: boolean; terms: boolean }
export type MediaData = Data & { picture: Picture & { chain: Chain; shared: Shared }; from: string; to: string };
export type MediaView = 'summary' | 'awareness' | 'search' | 'files';

/** The summary (and the awareness part) of the Media tab, from data the Media tab loads once. */
export function MediaSummary({ d, part, onView }: { d: MediaData; part: 'summary' | 'awareness'; onView: (v: MediaView) => void }) {
  const fm = money(d.currency);
  const unit = d.measure;
  const p = d.picture;
  if (part === 'awareness') {
    const aware = d.totals.filter(t => p.chain.aware.media.some(m => m.medium === t.medium) && !t.medium.startsWith('perf:') && !['ctv', 'video', 'audio', 'display'].includes(t.medium));
    const total = aware.reduce((a, t) => a + t.spend, 0);
    const awareLifts = d.findings.filter(f => !/region|Spend is heavy/i.test(f.title));
    if (!aware.length) return null;
    return (
      <>
        <section className="panel">
          <div className="panel-head"><div><h2>TV, print, radio and outdoor</h2><p>What each bought, in {d.currency}. Judged on how {unit} moved in the weeks it ran.</p></div></div>
          <div className="split-bar">{aware.map(t => <i key={t.medium} style={{ width: `${(t.spend / (total || 1)) * 100}%`, background: MEDIUM_COLOR[t.medium] ?? 'var(--muted)' }} title={`${t.label}: ${fm(t.spend)}`} />)}</div>
          <div className="medium-tiles">{aware.map(t => (
            <div key={t.medium} className="medium-tile">
              <span><span className="dot" style={{ background: MEDIUM_COLOR[t.medium] ?? 'var(--muted)' }} /><b>{t.label}</b></span>
              <span className="big">{fm(t.spend)}</span>
              <span className="small muted">{t.weeks} {t.weeks === 1 ? 'week' : 'weeks'}{t.reach ? ` · ${compact(t.reach)} ${REACH_NAME[t.medium] ?? 'reach'}` : ''}{t.units ? ` · ${compact(t.units)} ${t.medium === 'print' ? 'insertions' : t.medium === 'ooh' ? 'sites' : 'spots'}` : ''}</span>
            </div>
          ))}</div>
        </section>
        {awareLifts.length > 0 && <section className="panel"><div className="panel-head"><div><h2>What they did</h2><p>{unit[0]!.toUpperCase() + unit.slice(1)} a week when each ran against when it didn’t: lift, not exact credit, since offline media have no clicks.</p></div></div>
          <div className="insight-grid">{awareLifts.map((f, i) => <Card key={i} f={f} />)}</div></section>}
      </>
    );
  }
  return (
    <>
      <ChainView c={p.chain} fm={fm} unit={p.resultsFrom === 'platforms' ? 'online conversions' : unit} resultsFrom={p.resultsFrom} onView={onView} shared={p.shared} />
      <Glance p={p} fm={fm} onView={onView} />
      {d.weeks.length > 1 && <WeekTable d={d} fm={fm} unit={p.resultsFrom === 'platforms' ? 'online conversions' : unit} />}
      {d.hasResults && d.lifts.length > 0 && (
        <section className="panel">
          <div className="panel-head"><div><h2>Each awareness medium: {unit} a week with it and without it</h2><p>The darker bar is weeks it ran; the lighter, weeks it didn’t.</p></div></div>
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
          <div className="panel-head"><div><h2>Where media ran, against where {unit} came from</h2><p>Share of regional spend (top bar) against share of {unit} (bottom bar). National buys are left out here.</p></div></div>
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
  );
}

const pctChange = (a: number, b: number) => (b > 0 ? (a - b) / b : null);

/**
 * Week by week as a readable table: each week's spend (and which media ran), results, and what a
 * result cost, with the best and worst weeks named above it.
 */
function WeekTable({ d, fm, unit }: { d: MediaData; fm: (v: number) => string; unit: string }) {
  const rows = d.weeks.map((w, i) => {
    const parts = d.series.map(s => ({ medium: s.medium, label: s.label, v: s.values[i]! })).filter(x => x.v > 0).sort((a, b) => b.v - a.v);
    const spend = parts.reduce((a, x) => a + x.v, 0);
    // a week cut by the date range (starting before it, or not over yet) is shown but not judged
    const partial = w < d.from || Date.parse(w) + 6 * 86_400_000 > Date.parse(d.to);
    const res = d.hasResults ? d.results[i]! : null;
    return { w, parts, spend, res, partial, per: res && !partial ? spend / res : null };
  });
  const maxSpend = Math.max(...rows.map(r => r.spend), 1), maxRes = Math.max(...rows.map(r => r.res ?? 0), 1);
  const priced = rows.filter(r => r.per !== null && r.spend > 0);
  const best = priced.length > 1 ? priced.reduce((a, b) => (b.per! < a.per! ? b : a)) : null;
  const worst = priced.length > 1 ? priced.reduce((a, b) => (b.per! > a.per! ? b : a)) : null;
  const most = rows.filter(r => r.res && !r.partial).reduce<typeof rows[number] | null>((a, b) => (!a || b.res! > a.res! ? b : a), null);
  const one = unit.replace(/s$/, '').replace(/s /, ' ');
  const wk = (w: string) => `week of ${short(w)}`;
  const many = rows.length > 12;
  return (
    <section className="panel">
      <div className="panel-head"><div><h2>Week by week</h2>
        <p>{best && worst ? <>Cheapest {one}: <b>{wk(best.w)}</b>, {fm(best.per!)} each with {best.parts.slice(0, 2).map(x => x.label).join(' and ')} leading. Dearest: <b>{wk(worst.w)}</b>, {fm(worst.per!)} each.{most ? <> Most {unit}: {wk(most.w)} ({Math.round(most.res!).toLocaleString('en-IN')}).</> : null}</> : `What was spent each week, on what, and the ${unit} that came in.`}</p></div></div>
      <div className={`week-table ${many ? 'many' : ''}`}>
        <div className="week-row head"><span>Week of</span><span>Spend, and what ran</span><span className="num">{unit[0]!.toUpperCase() + unit.slice(1)}</span><span className="num">Cost per {one}</span></div>
        {rows.map(r => (
          <div className={`week-row ${r === best ? 'best' : r === worst ? 'worst' : ''}`} key={r.w}>
            <span className="week-date"><b>{short(r.w)}</b>{r.partial && <span className="small muted">part week</span>}{r === best && <span className="tag ok">Cheapest</span>}{r === worst && <span className="tag leak">Dearest</span>}</span>
            <span className="week-spend">
              <span className="week-bar" style={{ width: `${Math.max(2, (r.spend / maxSpend) * 100)}%` }} title={r.parts.map(x => `${x.label}: ${fm(x.v)}`).join('\n')}>{r.parts.map(x => <i key={x.medium} style={{ flexGrow: x.v, background: MEDIUM_COLOR[x.medium] ?? 'var(--muted)' }} />)}</span>
              <span className="small"><b>{r.spend ? fm(r.spend) : 'Nothing'}</b>{r.parts.length ? <span className="muted"> · {r.parts.slice(0, 3).map(x => x.label.replace(/ \(.*\)$/, '')).join(', ')}{r.parts.length > 3 ? ` +${r.parts.length - 3}` : ''}</span> : null}</span>
            </span>
            <span className="num week-res">{r.res !== null ? <><span className="week-rbar"><i style={{ width: `${(r.res / maxRes) * 100}%` }} /></span><b>{Math.round(r.res).toLocaleString('en-IN')}</b></> : <span className="muted">–</span>}</span>
            <span className="num"><b style={{ color: r === best ? 'var(--ok)' : r === worst ? 'var(--leak)' : undefined }}>{r.per !== null && r.spend ? fm(r.per) : '–'}</b></span>
          </div>
        ))}
      </div>
      <div className="wstack-legend" style={{ marginTop: 10 }}>{d.series.map(s => <span key={s.medium}><i style={{ background: MEDIUM_COLOR[s.medium] ?? 'var(--muted)' }} />{s.label}</span>)}</div>
    </section>
  );
}

/** Aware → look for you → lead or sale: the money at each step, what it bought, and what moved between them. */
function ChainView({ c, fm, unit, resultsFrom, onView, shared }: { c: Chain; fm: (v: number) => string; unit: string; resultsFrom: string; onView: (v: MediaView) => void; shared: Shared }) {
  const hasAwareOffline = shared.mainline || shared.programmatic;
  const brandUp = c.look ? pctChange(c.look.brandOn, c.look.brandOff) : null;
  const cpaDown = c.look && c.look.cpaOn && c.look.cpaOff ? pctChange(c.look.cpaOn, c.look.cpaOff) : null;
  const reach = [c.aware.grps ? `${compact(c.aware.grps)} TV GRPs` : '', c.aware.readers ? `${compact(c.aware.readers)} readers and listeners` : '', c.aware.impressions ? `${compact(c.aware.impressions)} digital impressions` : '', c.aware.completes ? `${compact(c.aware.completes)} completed views` : ''].filter(Boolean);
  const Stage = ({ n, title, children, cls }: { n: number; title: string; children: React.ReactNode; cls: string }) => (
    <div className={`chain-stage ${cls}`}><span className="chain-n">{n}</span><span className="chain-title">{title}</span>{children}</div>
  );
  const Chips = ({ media, total }: { media: Chain['aware']['media']; total: number }) => (
    <div className="chain-chips">
      <div className="split-bar thin">{media.map(m => <i key={m.medium} style={{ width: `${(m.spend / (total || 1)) * 100}%`, background: MEDIUM_COLOR[m.medium] ?? 'var(--muted)' }} title={`${m.label}: ${fm(m.spend)}`} />)}</div>
      <div className="chain-legend">{media.slice(0, 8).map(m => <span key={m.medium} title={`${m.label}: ${fm(m.spend)}`}><i style={{ background: MEDIUM_COLOR[m.medium] ?? 'var(--muted)' }} />{m.label.replace(/ \(.*\)$/, '')}<b>{pct(m.spend / (total || 1))}</b></span>)}{media.length > 8 && <span className="muted">+{media.length - 8} more</span>}</div>
    </div>
  );
  return (
    <section className="panel chain">
      <div className="panel-head"><div><h2>How your money moved people</h2><p>Every medium has a job: make people aware of you, make them look for you, or get the lead or sale. Here is what each step cost and what it did for the next.</p></div></div>
      <div className="chain-row">
        <Stage n={1} title="Make people aware" cls="s1">
          <b className="chain-big">{c.aware.spend ? fm(c.aware.spend) : '–'}</b>
          {c.aware.media.length ? <Chips media={c.aware.media} total={c.aware.spend} /> : <button className="btn small" onClick={() => onView('files')}>Add TV, print, DV360 or YouTube reports</button>}
          {reach.length > 0 && <span className="small muted">{reach.join(' · ')}</span>}
        </Stage>
        <div className="chain-link">{brandUp !== null && c.look ? <><b className={brandUp >= 0 ? 'up' : 'down'}>{brandUp >= 0 ? '+' : '−'}{Math.round(Math.abs(brandUp) * 100)}%</b><span>brand searches in {c.look.burst} weeks</span></> : <span className="muted">{!shared.search ? 'Add Google Ads to see searches rise' : !hasAwareOffline ? 'Add TV, print or video to see searches rise' : ''}</span>}</div>
        <Stage n={2} title="Make them look for you" cls="s2">
          {c.look ? <><b className="chain-big">{compact(c.look.brandOn)}</b><span className="small">brand searches clicked a week in {c.look.burst} weeks, against {compact(c.look.brandOff)} without</span></>
            : <span className="small muted">{!shared.search ? 'Brand searches rise when awareness media run. Add a Google Ads report (with your brand campaigns) to see by how much.' : !hasAwareOffline ? 'Brand searches rise when TV, print, radio, outdoor or video run. Add those reports to see by how much, and which medium does it best.' : 'Your awareness media ran almost every week, so there are no weeks without them to compare against.'}</span>}
        </Stage>
        <div className="chain-link">{cpaDown !== null && c.look ? <><b className={cpaDown <= 0 ? 'up' : 'down'}>{cpaDown <= 0 ? '−' : '+'}{Math.round(Math.abs(cpaDown) * 100)}%</b><span>cost per online lead in {c.look.burst} weeks</span></> : c.lead && c.lead.lift ? <><b className="up">+{Math.round(c.lead.lift * 100)}%</b><span>{unit} in {c.lead.medium} weeks</span></> : null}</div>
        <Stage n={3} title="Get the lead or sale" cls="s3">
          <b className="chain-big">{c.convert.results ? Math.round(c.convert.results).toLocaleString('en-IN') : '–'}</b>
          <span className="small">{c.convert.results ? `${unit}${c.convert.perResult ? `, ${fm(c.convert.perResult)} each across all media` : ''}` : resultsFrom === 'none' ? 'Add your leads or sales, or a Google Ads or Meta report' : ''}</span>
          {c.convert.media.length > 0 && <><Chips media={c.convert.media} total={c.convert.spend} /><span className="small muted">{fm(c.convert.spend)} on search and social ads{c.convert.platformCpa ? `, ${fm(c.convert.platformCpa)} per conversion they report` : ''}</span></>}
        </Stage>
      </div>
    </section>
  );
}

/** Every medium in one line: its job, its spend, what it did, and the verdict. */
function Glance({ p, fm, onView }: { p: Picture; fm: (v: number) => string; onView: (v: MediaView) => void }) {
  if (!p.glance.length) return null;
  const max = Math.max(...p.glance.map(g => g.spend), 1);
  const groups = [...new Set(p.glance.map(g => g.group))];
  return (
    <section className="panel">
      <div className="panel-head"><div><h2>Every medium, and what to do with it</h2><p>Awareness media are judged on how results moved in the weeks they ran; search and social ads on what a conversion costs against your average.</p></div></div>
      <div className="glance">{groups.map(gr => (
        <div key={gr} className="glance-group">
          <span className="small muted glance-title">{gr}</span>
          {p.glance.filter(g => g.group === gr).map(g => (
            <div className="glance-row" key={g.medium}>
              <span className="clamp1"><span className="dot" style={{ background: MEDIUM_COLOR[g.medium] ?? 'var(--muted)' }} /><b>{g.label}</b></span>
              <span className="glance-spend"><span className="camp-bar"><i style={{ width: `${(g.spend / max) * 100}%`, background: MEDIUM_COLOR[g.medium] ?? 'var(--muted)' }} /></span><span className="small">{fm(g.spend)} · {pct(g.spend / (p.spend || 1))}</span></span>
              <span className="small glance-did"><b>{g.did}</b>{g.measure && <span className="muted"> · {g.measure}</span>}</span>
              <span className={`tag ${VERDICT[g.verdict].tone}`}>{VERDICT[g.verdict].text}</span>
              <button className="btn small link" onClick={() => onView(g.tab as MediaView)}>Details</button>
            </div>
          ))}
        </div>
      ))}</div>
      {p.next.length > 0 && (
        <div className="next-steps">
          <h3>What to do next</h3>
          <ol>{p.next.map((n, i) => <li key={i} className={n.tone}><span>{n.text}</span>{n.tab !== 'summary' && <button className="btn small link" onClick={() => onView(n.tab as MediaView)}>See how</button>}</li>)}</ol>
        </div>
      )}
    </section>
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

export function ImportOffline({ T, onDone, initialFile }: { T: string; onDone: (msg: string | null) => void; initialFile?: File }) {
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

  useEffect(() => { if (initialFile) choose(initialFile); }, [initialFile]); // eslint-disable-line react-hooks/exhaustive-deps
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
