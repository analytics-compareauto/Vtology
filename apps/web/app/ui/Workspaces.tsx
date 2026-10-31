'use client';
import { useEffect, useState } from 'react';
import type { Industry } from '@vtology/core';
import { api, ApiError, type Workspace } from './api';
import { ROLES } from '@vtology/core';

const INDUSTRIES: { id: Industry; label: string; hint: string; sample: string }[] = [
  { id: 'Automotive', label: 'Automotive', hint: 'Inquiry to retail, through dealers', sample: 'Vegaa Motors' },
  { id: 'BFSI', label: 'BFSI', hint: 'Lead to disbursal, through branches and DSAs', sample: 'Northstar Finance' },
  { id: 'FMCG', label: 'FMCG', hint: 'Engagement to loyalty, through distributors', sample: 'Gharelu Foods' },
];

export function Workspaces({ email, onOpen, onSignOut }: { email: string | null; onOpen: (id: string) => void; onSignOut: () => void }) {
  const [data, setData] = useState<{ workspaces: Workspace[]; canCreate: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [industry, setIndustry] = useState<Industry>('Automotive');
  const [name, setName] = useState('');
  const [sample, setSample] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api<{ workspaces: Workspace[]; canCreate: boolean }>('GET', '/workspaces').then(setData).catch(e => setError(e.message)); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const finalName = name.trim() || `${INDUSTRIES.find(i => i.id === industry)!.sample}${sample ? ' (sample)' : ''}`;
    try {
      const r = await api<{ workspace: Workspace }>('POST', '/workspaces', { name: finalName, industry, sample });
      onOpen(r.workspace.id);
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not create the workspace.'); setBusy(false); }
  }

  return (
    <main className="ws-page">
      <div className="page-head">
        <div>
          <div className="wordmark">Vtology</div>
          <p className="muted small">Signed in as {email ?? 'you'}</p>
        </div>
        <button className="btn" onClick={onSignOut}>Sign out</button>
      </div>
      {!data && !error && <div className="progress" />}
      {error && <div className="error-box" role="alert">{error}</div>}
      {data && data.workspaces.length > 0 && (
        <section>
          <h1 style={{ marginBottom: 14 }}>Your workspaces</h1>
          <div className="ws-list">
            {data.workspaces.map(w => (
              <button key={w.id} className="ws-item" onClick={() => onOpen(w.id)}>
                <span><b>{w.name}</b>{w.isDemo && <span className="sample-flag">Sample data</span>}<br /><span className="muted small">{w.industry} workspace where you are {ROLES[w.role].label.toLowerCase()}</span></span>
                <span className="muted">Open</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {data && !data.canCreate && data.workspaces.length === 0 && (
        <section className="empty">
          <h2 style={{ marginBottom: 8 }}>You’re not in a workspace yet</h2>
          <p>Ask your Vtology admin to add {email ?? 'your email'} to a workspace, then sign in again.</p>
        </section>
      )}
      {data?.canCreate && (
        <form onSubmit={create} style={{ display: 'grid', gap: 18 }}>
          <div>
            <h1>{data.workspaces.length ? 'Create another workspace' : 'Create your first workspace'}</h1>
            <p className="muted" style={{ marginTop: 6 }}>A workspace holds one brand’s data. Start with sample data to see how Vtology works before loading real exports.</p>
          </div>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="small" style={{ fontWeight: 550, marginBottom: 8 }}>Industry</legend>
            <div className="industry-pick">
              {INDUSTRIES.map(i => (
                <label key={i.id}>
                  <input type="radio" name="industry" value={i.id} checked={industry === i.id} onChange={() => setIndustry(i.id)} />
                  <b>{i.label}</b><span className="muted small">{i.hint}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="field">Workspace name
            <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder={`${INDUSTRIES.find(i => i.id === industry)!.sample}${sample ? ' (sample)' : ''}`} maxLength={80} />
          </label>
          <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={sample} onChange={e => setSample(e.target.checked)} style={{ marginTop: 4 }} />
            <span><b>Fill it with sample data</b><br /><span className="muted">About 230 fictional customers, their journeys, partners, campaigns and sales, with realistic data problems for Vtology to find. In a sample workspace you can switch roles to see what each person sees.</span></span>
          </label>
          {busy && <div><div className="progress" /><p className="muted small" style={{ marginTop: 8 }}>{sample ? 'Loading sample data and matching customers. This takes up to a minute.' : 'Creating the workspace…'}</p></div>}
          <div><button className="btn primary" type="submit" disabled={busy}>{sample ? 'Create sample workspace' : 'Create empty workspace'}</button></div>
        </form>
      )}
    </main>
  );
}
