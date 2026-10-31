'use client';
import { useMemo, useState } from 'react';
import { STAGES, canDecide } from '@vtology/core';
import type { WorkspaceData } from '../Dashboard';
import type { ActionDraft } from '../ActionDialog';

type Filter = 'all' | 'idle' | 'moving' | 'converted';

export function Journeys({ data, act }: { data: WorkspaceData; act: (d: ActionDraft) => void }) {
  const { journeys, me } = data;
  const [filter, setFilter] = useState<Filter>('idle');
  const [q, setQ] = useState('');
  const [stage, setStage] = useState<string>('');
  const [limit, setLimit] = useState(100);
  const direct = canDecide('reassign_journey', me.role);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return journeys
      .filter(j => filter === 'all' || (filter === 'idle' ? j.stalled : filter === 'converted' ? j.converted : !j.stalled && !j.converted))
      .filter(j => stage === '' || String(j.stageIndex) === stage)
      .filter(j => !s || [j.externalRef, j.party, j.partner].some(v => v?.toLowerCase().includes(s)))
      .sort((a, b) => Number(b.stalled) - Number(a.stalled) || (b.daysIdle - b.slaDays) - (a.daysIdle - a.slaDays));
  }, [journeys, filter, q, stage]);

  if (journeys.length === 0) return <div className="empty">{me.role === 'finance' ? 'Your role doesn’t see individual journeys.' : 'No journeys in your view yet.'}</div>;

  const counts = { all: journeys.length, idle: journeys.filter(j => j.stalled).length, moving: journeys.filter(j => !j.stalled && !j.converted).length, converted: journeys.filter(j => j.converted).length };

  return (
    <section style={{ display: 'grid', gap: 14 }}>
      <div className="toolbar">
        <div className="seg" role="group" aria-label="Show">
          {(['idle', 'moving', 'converted', 'all'] as Filter[]).map(f => (
            <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{{ idle: 'Idle', moving: 'Moving', converted: 'Converted', all: 'All' }[f]} {counts[f]}</button>
          ))}
        </div>
        <select className="input" style={{ width: 'auto' }} value={stage} onChange={e => setStage(e.target.value)} aria-label="Stage">
          <option value="">Every stage</option>
          {STAGES[me.industry].map(s => <option key={s.idx} value={s.idx}>{s.name}</option>)}
        </select>
        <input className="input" style={{ maxWidth: 260 }} placeholder="Search journey, customer or partner" value={q} onChange={e => setQ(e.target.value)} aria-label="Search" />
      </div>
      {rows.length === 0 ? <div className="empty">No journeys match.</div> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Journey</th><th>Customer</th><th>Partner</th><th>Stage</th><th>Time in stage</th><th>Status</th><th><span className="hidden">Action</span></th></tr></thead>
            <tbody>
              {rows.slice(0, limit).map(j => (
                <tr key={j.id}>
                  <td className="nowrap"><b>{j.externalRef}</b>{j.edited && <span className="tag plain" style={{ marginLeft: 6 }} title="Changed through an approved action">edited</span>}</td>
                  <td>{j.party ?? <span className="muted">Not matched</span>}</td>
                  <td>{j.partner ?? <span className="muted">None</span>}</td>
                  <td className="nowrap">{j.stage}</td>
                  <td>
                    {j.slaDays > 0 ? (
                      <div className="idle" title={`${j.daysIdle} days idle; limit ${j.slaDays}`}>
                        <div className={`idle-bar${j.stalled ? ' over' : ''}`}><i style={{ width: `${Math.min(100, (j.daysIdle / j.slaDays) * 100)}%` }} /></div>
                        <span className="small nowrap">{j.daysIdle} of {j.slaDays} days</span>
                      </div>
                    ) : <span className="muted small">Complete</span>}
                  </td>
                  <td>{j.converted ? <span className="tag ok">Converted</span> : j.stalled ? <span className="tag leak">Idle</span> : <span className="tag flow">Moving</span>}</td>
                  <td className="num">
                    {j.stalled && !j.converted && (
                      <button className="btn small" onClick={() => act({ type: 'reassign_journey', objectId: j.id, title: 'Reassign', subject: `${j.externalRef}${j.party ? `, ${j.party}` : ''}: ${j.daysIdle} days idle at ${j.stage}${j.partner ? ` with ${j.partner}` : ''}`, currentPartnerId: j.partnerId })}>
                        {direct ? 'Reassign' : 'Request reassignment'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > limit && <div><button className="btn" onClick={() => setLimit(l => l + 200)}>Show more ({rows.length - limit} left)</button></div>}
    </section>
  );
}
