'use client';
import { useEffect, useRef, useState } from 'react';
import { ROLES, ACTION_TYPES, canDecide, type ActionCode } from '@vtology/core';
import { api, ApiError, type ActionResult } from './api';
import { ACTION_LABEL, REQUEST_LABEL, pct } from './format';
import type { WorkspaceData } from './Dashboard';

export interface ActionDraft { type: ActionCode; objectId: string; title: string; subject: string; currentPartnerId?: string | null }

const STATUS_TEXT: Record<string, string> = {
  done: 'Done. The change is recorded and queued for the source systems.',
  awaiting_approval: 'Requested. It now waits for approval.',
  blocked: 'Blocked. One of the checks below failed, so nothing changed.',
};

export function ActionDialog({ draft, data, workspaceId, onClose, notify }: { draft: ActionDraft; data: WorkspaceData; workspaceId: string; onClose: (changed: boolean) => void; notify: (m: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState('');
  const [partner, setPartner] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const direct = canDecide(draft.type, data.me.role);

  const needsPartner = draft.type === 'reassign_journey';
  const [directory, setDirectory] = useState<{ id: string; name: string; city: string | null }[] | null>(null);
  const approver = ACTION_TYPES[draft.type].roles[0]!;

  useEffect(() => { ref.current?.showModal(); }, []);
  // roles that can't see every partner's figures pick from the names-only directory
  const fromDirectory = needsPartner && data.partners.length <= 1;
  useEffect(() => { if (fromDirectory) api<{ id: string; name: string; city: string | null }[]>('GET', `/tenants/${workspaceId}/partners/directory`).then(setDirectory).catch(() => setDirectory([])); }, [fromDirectory, workspaceId]);

  const candidates = fromDirectory
    ? (directory ?? []).filter(p => p.id !== draft.currentPartnerId).map(p => ({ id: p.id, name: p.name, note: p.city ?? '' }))
    : data.partners.filter(p => p.partnerId !== draft.currentPartnerId).sort((a, b) => a.stalledShare - b.stalledShare).map(p => ({ id: p.partnerId, name: p.name, note: `${p.journeys} journeys, ${pct(p.stalledShare)} idle` }));

  async function submit() {
    setBusy(true); setError(null);
    try {
      const r = await api<ActionResult>('POST', `/tenants/${workspaceId}/actions`, { type: draft.type, objectId: draft.objectId, newPartnerId: needsPartner ? partner : undefined, reason: reason || undefined });
      setResult(r);
      notify(r.status === 'done' ? `${ACTION_LABEL[draft.type]}: done.` : r.status === 'awaiting_approval' ? `${ACTION_LABEL[draft.type]}: sent for approval.` : `${ACTION_LABEL[draft.type]}: blocked by a check.`);
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not send the request.'); }
    finally { setBusy(false); }
  }

  return (
    <dialog ref={ref} onClose={() => onClose(!!result)} aria-labelledby="action-title">
      <div className="dialog-body">
        <div>
          <h2 id="action-title">{direct ? ACTION_LABEL[draft.type] : REQUEST_LABEL[draft.type]}</h2>
          <p className="muted small" style={{ marginTop: 4 }}>{draft.subject}</p>
        </div>
        {!result && (
          <>
            {!direct && <div className="note-box">As {ROLES[data.me.role].label.toLowerCase()} you can request this. It goes to {ROLES[approver].label.toLowerCase()} for approval.</div>}
            {needsPartner && (
              <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="small" style={{ fontWeight: 550, marginBottom: 8 }}>Move to which partner?</legend>
                {fromDirectory && directory === null && <div className="progress" />}
                <div className="choices">
                  {candidates.map(p => (
                    <label className="choice" key={p.id}>
                      <span>{p.name}<br /><span className="muted small">{p.note}</span></span>
                      <input type="radio" name="p" value={p.id} checked={partner === p.id} onChange={() => setPartner(p.id)} />
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <label className="field"><span>Reason <span className="muted small" style={{ fontWeight: 400 }}>(kept in the audit log)</span></span>
              <textarea className="input" rows={2} value={reason} onChange={e => setReason(e.target.value)} maxLength={500} />
            </label>
            {error && <div className="error-box" role="alert">{error}</div>}
          </>
        )}
        {result && (
          <>
            <div className={result.status === 'blocked' ? 'error-box' : 'note-box'}>{STATUS_TEXT[result.status] ?? result.status}{result.status === 'awaiting_approval' && result.approverRole ? ` Approver: ${ROLES[result.approverRole].label.toLowerCase()}.` : ''}</div>
            <div>
              <h3 style={{ marginBottom: 8 }}>Checks</h3>
              <ul className="checks">{result.rules.map(r => <li key={r.label} className={r.pass ? '' : 'fail'}>{r.label}</li>)}</ul>
            </div>
            {result.status !== 'blocked' && result.effects.length > 0 && (
              <div>
                <h3 style={{ marginBottom: 8 }}>{result.status === 'done' ? 'What changed' : 'What happens on approval'}</h3>
                <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{result.effects.map(e => <li key={e}>{e}</li>)}</ul>
              </div>
            )}
          </>
        )}
      </div>
      <div className="dialog-actions">
        {result ? <button className="btn primary" onClick={() => ref.current?.close()}>Close</button> : (
          <>
            <button className="btn" onClick={() => ref.current?.close()}>Cancel</button>
            <button className="btn primary" onClick={submit} disabled={busy || (needsPartner && !partner)}>{busy ? 'Sending…' : direct ? ACTION_LABEL[draft.type] : 'Send request'}</button>
          </>
        )}
      </div>
    </dialog>
  );
}
