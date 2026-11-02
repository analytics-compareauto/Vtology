'use client';
import { canDecide } from '@vtology/core';
import type { WorkspaceData } from '../Dashboard';
import type { ActionDraft } from '../ActionDialog';
import { pct } from '../format';

export function Partners({ data, act }: { data: WorkspaceData; act: (d: ActionDraft) => void }) {
  const { partners, me } = data;
  if (partners.length === 0) return <div className="empty">No partners in your view.</div>;
  const direct = canDecide('escalate_partner', me.role);
  return (
    <section style={{ display: 'grid', gap: 14 }}>
      <div className="kpis" style={{ marginBottom: 6 }}>
        <div className="kpi"><span className="label">Partners</span><span className="value">{partners.length}</span><span className="sub">handling {partners.reduce((s, p) => s + p.journeys, 0)} journeys</span></div>
        <div className="kpi leak"><span className="label">Above the 38% limit</span><span className="value">{partners.filter(p => p.stalledShare > 0.38 && p.journeys >= 10).length}</span><span className="sub">can be escalated</span></div>
        <div className="kpi"><span className="label">Idle share overall</span><span className="value">{pct(partners.reduce((s, p) => s + p.stalled, 0) / Math.max(1, partners.reduce((s, p) => s + p.journeys, 0)))}</span><span className="sub">of journeys past their limit</span></div>
        <div className="kpi"><span className="label">Slowest partner</span><span className="value" style={{ fontSize: 20, lineHeight: 1.25, paddingTop: 6 }}>{[...partners].sort((a, b) => b.stalledShare - a.stalledShare)[0]!.name}</span><span className="sub">{pct([...partners].sort((a, b) => b.stalledShare - a.stalledShare)[0]!.stalledShare)} idle</span></div>
      </div>
      <p className="muted small" style={{ maxWidth: '72ch' }}>Share of each partner’s journeys sitting past the stage time limit. The black mark is the 38% line: above it, with at least 10 journeys, a partner is flagged and can be escalated.</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Partner</th><th className="num">Journeys</th><th className="num">Idle</th><th>Idle share</th><th>Status</th><th><span className="hidden">Action</span></th></tr></thead>
          <tbody>
            {partners.map(p => {
              const over = p.stalledShare > 0.38 && p.journeys >= 10;
              return (
                <tr key={p.partnerId}>
                  <td><b>{p.name}</b></td>
                  <td className="num">{p.journeys}</td>
                  <td className="num">{p.stalled}</td>
                  <td>
                    <div className="share">
                      <div className={`share-bar${p.stalledShare > 0.38 ? ' over' : ''}`}><i style={{ width: `${Math.min(100, p.stalledShare * 100)}%` }} /><span className="limit" /></div>
                      <span className="small">{pct(p.stalledShare)}</span>
                    </div>
                  </td>
                  <td>{over ? <span className="tag leak">Above limit</span> : p.stalledShare > 0.25 ? <span className="tag warn">Watch</span> : <span className="tag ok">Healthy</span>}</td>
                  <td className="num">{over && <button className="btn small" onClick={() => act({ type: 'escalate_partner', objectId: p.partnerId, title: 'Escalate', subject: `${p.name}: ${p.stalled} of ${p.journeys} journeys idle (${pct(p.stalledShare)})` })}>{direct ? 'Escalate' : 'Request escalation'}</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
