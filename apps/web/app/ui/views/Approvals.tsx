'use client';
import { useState } from 'react';
import { ROLES, canDecide, type ActionCode } from '@vtology/core';
import type { WorkspaceData } from '../Dashboard';
import { api, ApiError } from '../api';
import { ACTION_LABEL, ago } from '../format';

const STATUS: Record<string, [string, string]> = { done: ['Done', 'ok'], awaiting_approval: ['Waiting', 'warn'], rejected: ['Rejected', 'plain'], blocked: ['Blocked', 'leak'] };

export function Approvals({ data, workspaceId, reload, notify }: { data: WorkspaceData; workspaceId: string; reload: () => Promise<void>; notify: (m: string) => void }) {
  const { actions, me } = data;
  const [busy, setBusy] = useState<string | null>(null);
  const pending = actions.filter(a => a.status === 'awaiting_approval');
  const history = actions.filter(a => a.status !== 'awaiting_approval');

  async function decide(id: string, approve: boolean, label: string) {
    setBusy(id);
    try {
      const r = await api<{ status: string }>('POST', `/tenants/${workspaceId}/actions/${id}/${approve ? 'approve' : 'reject'}`);
      notify(r.status === 'done' ? `${label}: approved and applied.` : r.status === 'blocked' ? `${label}: a check now fails, so it was blocked.` : `${label}: rejected.`);
      await reload();
    } catch (e) { notify(e instanceof ApiError ? e.message : 'Could not record the decision.'); }
    finally { setBusy(null); }
  }

  return (
    <>
      <section>
        <div className="section-title"><h2>Waiting for a decision</h2></div>
        {pending.length === 0 ? <div className="empty">Nothing is waiting. Requests from people who can’t act directly appear here for the right role to approve.</div> : (
          <div className="rows">
            {pending.map(a => {
              const mine = canDecide(a.type_code as ActionCode, me.role);
              const label = ACTION_LABEL[a.type_code] ?? a.type_code;
              return (
                <div className="row" key={a.id}>
                  <div className="row-main">
                    <span><b>{label}</b>: {a.object_label}</span>
                    <span className="toolbar">
                      {mine ? (
                        <>
                          <button className="btn small" disabled={busy === a.id} onClick={() => decide(a.id, false, label)}>Reject</button>
                          <button className="btn small primary" disabled={busy === a.id} onClick={() => decide(a.id, true, label)}>Approve</button>
                        </>
                      ) : <span className="muted small">Waiting for {a.approver_role ? ROLES[a.approver_role].label.toLowerCase() : 'approver'}</span>}
                    </span>
                  </div>
                  <span className="muted small">Requested by {ROLES[a.requested_role].label.toLowerCase()} {ago(a.created_at)}{a.reason ? `: “${a.reason}”` : ''}</span>
                  <ul className="checks small" style={{ marginTop: 4 }}>{a.rules.map(r => <li key={r.label} className={r.pass ? '' : 'fail'}>{r.label}</li>)}</ul>
                  {a.effects.length > 0 && <span className="small">On approval: {a.effects.join('; ')}.</span>}
                </div>
              );
            })}
          </div>
        )}
      </section>
      <section>
        <div className="section-title"><h2>Action log</h2><span className="muted small">Every request and decision, kept for audit</span></div>
        {history.length === 0 ? <div className="empty">No actions yet.</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Action</th><th>On</th><th>Requested by</th><th>Decided by</th><th>Result</th></tr></thead>
              <tbody>
                {history.map(a => (
                  <tr key={a.id}>
                    <td className="nowrap small">{ago(a.decided_at ?? a.created_at)}</td>
                    <td className="nowrap">{ACTION_LABEL[a.type_code] ?? a.type_code}</td>
                    <td>{a.object_label}</td>
                    <td className="small">{ROLES[a.requested_role].label}</td>
                    <td className="small">{a.decided_role ? ROLES[a.decided_role].label : a.status === 'done' ? 'Applied directly' : '—'}</td>
                    <td><span className={`tag ${STATUS[a.status]?.[1] ?? 'plain'}`}>{STATUS[a.status]?.[0] ?? a.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
