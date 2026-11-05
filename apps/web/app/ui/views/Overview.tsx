'use client';
import { useEffect, useState } from 'react';
import { STAGES } from '@vtology/core';
import { api } from '../api';
import type { WorkspaceData } from '../Dashboard';
import { RULES, inr, num, pct } from '../format';

type Tab = 'overview' | 'journeys' | 'findings' | 'partners' | 'social' | 'growth' | 'content' | 'media' | 'audiences' | 'approvals' | 'data';

export function Overview({ data, go }: { data: WorkspaceData; go: (t: Tab) => void }) {
  const { me, journeys, findings, partners } = data;
  const stages = STAGES[me.industry];
  const per = stages.map(s => {
    const js = journeys.filter(j => j.stageIndex === s.idx);
    return { ...s, moving: js.filter(j => !j.stalled).length, idle: js.filter(j => j.stalled).length };
  });
  const maxUp = Math.max(1, ...per.map(p => p.moving));
  const maxDown = Math.max(1, ...per.map(p => p.idle));
  const idle = journeys.filter(j => j.stalled).length;
  const converted = journeys.filter(j => j.converted).length;
  const seesMoney = findings.some(f => f.value_inr !== null);
  const atRisk = findings.reduce((s, f) => s + Number(f.value_inr ?? 0), 0);
  const high = findings.filter(f => f.severity === 'high').length;
  const groups = Object.entries(findings.reduce<Record<string, { n: number; value: number; high: boolean }>>((acc, f) => {
    const g = acc[f.rule] ?? { n: 0, value: 0, high: false };
    g.n++; g.value += Number(f.value_inr ?? 0); g.high ||= f.severity === 'high';
    acc[f.rule] = g; return acc;
  }, {})).sort((a, b) => Number(b[1].high) - Number(a[1].high) || b[1].value - a[1].value || b[1].n - a[1].n);
  const watch = [...partners].filter(p => p.journeys >= 5).sort((a, b) => b.stalledShare - a.stalledShare).slice(0, 5);
  const worstStage = [...per].filter(p => p.slaDays).sort((a, b) => b.idle - a.idle)[0];
  const maxGroup = Math.max(1, ...groups.map(([, g]) => g.n));

  return (
    <>
      <Health tenantId={me.tenantId} go={go} />
      <section className="kpis" aria-label="Key figures">
        {journeys.length > 0 ? (
          <>
            <div className="kpi"><span className="label">Journeys</span><span className="value">{num(journeys.length)}</span><span className="sub">customers in your view</span></div>
            <div className="kpi leak"><span className="label">Idle past limit</span><span className="value">{num(idle)}</span><span className="sub">{pct(idle / journeys.length)} of journeys are going cold</span></div>
            <div className="kpi ok"><span className="label">Converted</span><span className="value">{pct(converted / journeys.length)}</span><span className="sub">{num(converted)} reached the final stage</span></div>
          </>
        ) : (
          <>
            <div className="kpi"><span className="label">Findings</span><span className="value">{num(findings.length)}</span><span className="sub">in your view</span></div>
            <div className="kpi leak"><span className="label">High severity</span><span className="value">{num(high)}</span><span className="sub">need attention first</span></div>
            <div className="kpi"><span className="label">Fixes applied</span><span className="value">{num(data.actions.filter(a => a.status === 'done').length)}</span><span className="sub">approved and done</span></div>
          </>
        )}
        <div className={`kpi${seesMoney && atRisk > 0 ? ' leak' : ''}`}><span className="label">Money at stake</span><span className="value">{seesMoney ? inr(atRisk) : 'Hidden'}</span><span className="sub">{seesMoney ? `tied up in ${num(findings.length)} findings` : 'money isn’t shown to your role'}</span></div>
      </section>

      {journeys.length > 0 ? (
        <section className="pipeline" aria-labelledby="pipe-title">
          <div className="pipeline-head">
            <div>
              <h2 id="pipe-title">{worstStage && worstStage.idle > 0 ? `${worstStage.name} is where customers wait longest: ${num(worstStage.idle)} idle` : idle === 0 ? 'Every journey is moving within its time limit' : 'Where journeys are right now'}</h2>
              <p className="muted small" style={{ marginTop: 4 }}>Above the line: moving within the stage time limit. Below: idle past it, the customers you are losing.</p>
            </div>
            <div className="legend"><span><i style={{ background: 'var(--flow)' }} />Moving</span><span><i style={{ background: 'var(--ok)' }} />Converted</span><span><i style={{ background: 'var(--leak)' }} />Idle past limit</span></div>
          </div>
          <div className="stages">
            {per.map(p => (
              <div className="stage" key={p.idx}>
                <div className="name">{p.name}</div>
                <div className="up">
                  <div className="val">{num(p.moving)}</div>
                  <div className={`bar-up${p.converted ? ' converted' : ''}`} style={{ height: `${(p.moving / maxUp) * 128}px` }} />
                </div>
                <div className="baseline" />
                <div className="down">
                  {p.idle > 0 && <div className="bar-down" style={{ height: `${(p.idle / maxDown) * 66}px` }} />}
                  {p.idle > 0 && <div className="val leak">{num(p.idle)} idle</div>}
                </div>
                <div className="foot">{p.slaDays ? `Limit ${p.slaDays} days` : 'Final stage'}</div>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <section className="empty">
          {me.role === 'finance' ? 'Finance works from findings and money rather than individual journeys. Your findings are below.' : 'No journeys yet. Import journey events on the Data tab, then run matching.'}
        </section>
      )}

      <div className="grid-main">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>{groups.length ? `${num(findings.length)} things don’t add up` : 'Nothing out of line'}</h2>
              <p>{groups.length ? `${num(high)} are high severity.${seesMoney && atRisk ? ` ${inr(atRisk)} involved.` : ''}` : me.lastRun ? 'All checks passed on the last run.' : 'Run matching on the Data tab to check your data.'}</p>
            </div>
            <button className="btn small" onClick={() => go('findings')}>All findings</button>
          </div>
          {groups.length > 0 && (
            <div className="rows">
              {groups.map(([rule, g]) => (
                <div className="row" key={rule}>
                  <div className="row-main">
                    <span><span className={`sev ${g.high ? 'high' : 'medium'}`} /><b style={{ fontWeight: 600 }}>{RULES[rule]?.title ?? rule}</b></span>
                    <b className="nowrap num-display" style={{ fontSize: 18 }}>{g.n}</b>
                  </div>
                  <div className="share-bar" style={{ height: 5, marginTop: 4 }}><i style={{ width: `${(g.n / maxGroup) * 100}%`, background: g.high ? 'var(--leak)' : 'var(--signal)' }} /></div>
                  <span className="muted small">{seesMoney && g.value > 0 ? `${inr(g.value)} involved. ` : ''}{RULES[rule]?.who}</span>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>{watch[0] && watch[0].stalledShare > 0.38 ? `${watch[0].name} lets ${pct(watch[0].stalledShare)} go idle` : 'Partners to watch'}</h2>
              <p>Share of each partner’s journeys past the time limit. The line marks 38%, where a partner is flagged.</p>
            </div>
            <button className="btn small" onClick={() => go('partners')}>All partners</button>
          </div>
          {watch.length === 0 ? <div className="empty">No partner data in your view.</div> : (
            <div className="rows">
              {watch.map(p => (
                <div className="row" key={p.partnerId}>
                  <div className="row-main"><span style={{ fontWeight: 600 }}>{p.name}</span><b className={p.stalledShare > 0.38 ? 'nowrap' : 'nowrap'} style={{ color: p.stalledShare > 0.38 ? 'var(--leak)' : p.stalledShare > 0.25 ? 'var(--warn)' : 'var(--ok)' }}>{pct(p.stalledShare)}</b></div>
                  <div className={`share-bar${p.stalledShare > 0.38 ? ' over' : ''}`} style={{ marginTop: 4 }}><i style={{ width: `${Math.min(100, p.stalledShare * 100)}%` }} /><span className="limit" /></div>
                  <span className="muted small">{p.stalled} of {p.journeys} journeys idle</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}

interface Tile { area: string; tab: Tab; status: 'good' | 'watch' | 'fix' | 'none'; figure: string; label: string; detail: string }
const WORD = { good: 'Healthy', watch: 'Watch', fix: 'Needs action', none: 'Not set up' } as const;

/** One tile per area: the brand's health report at a glance. */
function Health({ tenantId, go }: { tenantId: string; go: (t: Tab) => void }) {
  const [h, setH] = useState<{ score: number | null; tiles: Tile[] } | null>(null);
  useEffect(() => { api<{ score: number | null; tiles: Tile[] }>('GET', `/tenants/${tenantId}/summary`).then(setH).catch(() => setH(null)); }, [tenantId]);
  if (!h) return null;
  const fix = h.tiles.filter(t => t.status === 'fix').length;
  return (
    <section className="panel health">
      <div className="panel-head">
        <div><h2>Brand health</h2><p>Every part of Vtology in one view: what is healthy, what to watch, and what needs action now. Click a tile to open that section.</p></div>
        {h.score !== null && <div className="health-score" data-tone={h.score >= 70 ? 'good' : h.score >= 45 ? 'watch' : 'fix'}><b>{h.score}</b><span>of 100{fix ? ` · ${fix} to fix` : ''}</span></div>}
      </div>
      <div className="health-grid">{h.tiles.map(t => (
        <button key={t.area} className={`health-tile ${t.status}`} onClick={() => go(t.tab)}>
          <span className="ht-head"><b>{t.area}</b><span className={`tag ${t.status === 'good' ? 'ok' : t.status === 'watch' ? 'warn' : t.status === 'fix' ? 'leak' : 'plain'}`}>{WORD[t.status]}</span></span>
          <span className="ht-fig">{t.figure}</span>
          <span className="small">{t.label}</span>
          <span className="small muted">{t.detail}</span>
        </button>
      ))}</div>
    </section>
  );
}
