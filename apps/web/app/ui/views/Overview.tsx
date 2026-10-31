'use client';
import { STAGES } from '@vtology/core';
import type { WorkspaceData } from '../Dashboard';
import { RULES, inr, num, pct } from '../format';

type Tab = 'overview' | 'journeys' | 'findings' | 'partners' | 'approvals' | 'data';

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
  const groups = Object.entries(findings.reduce<Record<string, { n: number; value: number; high: boolean }>>((acc, f) => {
    const g = acc[f.rule] ?? { n: 0, value: 0, high: false };
    g.n++; g.value += Number(f.value_inr ?? 0); g.high ||= f.severity === 'high';
    acc[f.rule] = g; return acc;
  }, {})).sort((a, b) => Number(b[1].high) - Number(a[1].high) || b[1].value - a[1].value || b[1].n - a[1].n);
  const watch = partners.filter(p => p.journeys >= 5).slice(0, 4);

  return (
    <>
      {journeys.length > 0 ? (
        <section className="pipeline" aria-labelledby="pipe-title">
          <div className="pipeline-head">
            <div>
              <h2 id="pipe-title">Where journeys are right now</h2>
              <p className="muted small" style={{ marginTop: 4 }}>Above the line: moving within the stage time limit. Below: idle past it, the customers you are losing.</p>
            </div>
            <div className="legend"><span><i style={{ background: 'var(--flow)' }} />Moving</span><span><i style={{ background: 'var(--ok)' }} />Converted</span><span><i style={{ background: 'var(--leak)' }} />Idle</span></div>
          </div>
          <div className="stages">
            {per.map(p => (
              <div className="stage" key={p.idx}>
                <div className="name">{p.name}</div>
                <div className="up">
                  <div className="val">{num(p.moving)}</div>
                  <div className={`bar-up${p.converted ? ' converted' : ''}`} style={{ height: `${(p.moving / maxUp) * 124}px` }} />
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

      <section className="figures" aria-label="Key figures">
        {journeys.length > 0 ? (
          <>
            <div className="figure"><b>{num(journeys.length)}</b><span>journeys in your view</span></div>
            <div className="figure leak"><b>{num(idle)}</b><span>idle past their limit, {pct(idle / journeys.length)}</span></div>
            <div className="figure"><b>{pct(converted / journeys.length)}</b><span>converted</span></div>
          </>
        ) : (
          <>
            <div className="figure"><b>{num(findings.length)}</b><span>findings in your view</span></div>
            <div className="figure leak"><b>{num(findings.filter(f => f.severity === 'high').length)}</b><span>high severity</span></div>
            <div className="figure"><b>{num(data.actions.filter(a => a.status === 'done').length)}</b><span>actions applied</span></div>
          </>
        )}
        <div className={`figure${seesMoney ? ' leak' : ''}`}><b>{seesMoney ? inr(atRisk) : 'Hidden'}</b><span>{seesMoney ? 'tied up in findings' : 'money isn’t shown to your role'}</span></div>
      </section>

      <div className="split">
        <section>
          <div className="section-title"><h2>What doesn’t add up</h2><button className="btn link" onClick={() => go('findings')}>All findings</button></div>
          {groups.length === 0 ? <div className="empty">No findings in your view. {me.lastRun ? '' : 'Run matching on the Data tab to check your data.'}</div> : (
            <div className="rows">
              {groups.map(([rule, g]) => (
                <div className="row" key={rule}>
                  <div className="row-main">
                    <span><span className={`sev ${g.high ? 'high' : 'medium'}`} />{RULES[rule]?.title ?? rule}</span>
                    <b className="nowrap">{g.n}</b>
                  </div>
                  <span className="muted small">{seesMoney && g.value > 0 ? `${inr(g.value)} involved. ` : ''}{RULES[rule]?.who}</span>
                </div>
              ))}
            </div>
          )}
        </section>
        <section>
          <div className="section-title"><h2>Partners to watch</h2><button className="btn link" onClick={() => go('partners')}>All partners</button></div>
          {watch.length === 0 ? <div className="empty">No partner data in your view.</div> : (
            <div className="rows">
              {watch.map(p => (
                <div className="row" key={p.partnerId}>
                  <div className="row-main"><span>{p.name}</span><span className={p.stalledShare > 0.38 ? 'tag leak' : p.stalledShare > 0.25 ? 'tag warn' : 'tag ok'}>{pct(p.stalledShare)} idle</span></div>
                  <span className="muted small">{p.stalled} of {p.journeys} journeys past their limit</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
