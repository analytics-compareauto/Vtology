'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ROLES, canDecide, type ActionCode, type RoleCode } from '@vtology/core';
import { api, ApiError, type ActionRun, type Finding, type Journey, type Me, type PartnerScore, type Workspace } from './api';
import { ROLE_SCOPE } from './format';
import { Overview } from './views/Overview';
import { Journeys } from './views/Journeys';
import { Findings } from './views/Findings';
import { Partners } from './views/Partners';
import { Approvals } from './views/Approvals';
import { DataView } from './views/DataView';
import { Social } from './views/Social';
import { ActionDialog, type ActionDraft } from './ActionDialog';

export interface WorkspaceData { me: Me; journeys: Journey[]; partners: PartnerScore[]; findings: Finding[]; actions: ActionRun[] }
type Tab = 'overview' | 'journeys' | 'findings' | 'partners' | 'social' | 'approvals' | 'data';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' }, { id: 'journeys', label: 'Journeys' }, { id: 'findings', label: 'Findings' },
  { id: 'partners', label: 'Partners' }, { id: 'social', label: 'Social' }, { id: 'approvals', label: 'Approvals' }, { id: 'data', label: 'Data' },
];

export function Dashboard({ workspaceId, email, onSwitch, onSignOut }: { workspaceId: string; email: string | null; onSwitch: (id: string | null) => void; onSignOut: () => void }) {
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => {
    try { return new URLSearchParams(window.location.search).get('tab') === 'social' ? 'social' : 'overview'; } catch { return 'overview'; }
  });
  const [draft, setDraft] = useState<ActionDraft | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const T = `/tenants/${workspaceId}`;

  const load = useCallback(async () => {
    try {
      const [me, journeys, partners, findings, actions] = await Promise.all([
        api<Me>('GET', `${T}/me`), api<Journey[]>('GET', `${T}/journeys`), api<PartnerScore[]>('GET', `${T}/partners`),
        api<Finding[]>('GET', `${T}/violations`), api<ActionRun[]>('GET', `${T}/actions`),
      ]);
      setData({ me, journeys, partners, findings, actions });
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) { onSwitch(null); return; }
      setError(e instanceof Error ? e.message : 'Could not load this workspace.');
    }
  }, [T, onSwitch]);

  useEffect(() => { load(); api<{ workspaces: Workspace[] }>('GET', '/workspaces').then(r => setWorkspaces(r.workspaces)).catch(() => undefined); }, [load]);
  // coming back from Meta or Google after connecting an account
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const st = q.get('social');
    if (!st) return;
    const name = q.get('provider') === 'youtube' ? 'YouTube' : 'Instagram and Facebook';
    setToast(st === 'connected' ? `${name} connected: ${q.get('accounts') ?? 0} accounts, ${q.get('posts') ?? 0} posts synced.` : `${name} was not connected. ${q.get('message') ?? ''}`);
    window.history.replaceState(null, '', window.location.pathname);
  }, []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 6000); return () => clearTimeout(t); }, [toast]);

  const pending = useMemo(() => data?.actions.filter(a => a.status === 'awaiting_approval' && canDecide(a.type_code as ActionCode, data.me.role)).length ?? 0, [data]);

  async function switchRole(role: RoleCode) {
    setSwitching(true);
    try { await api('POST', `${T}/sample/role`, { role }); await load(); setToast(`You are now viewing as ${ROLES[role].label.toLowerCase()}.`); }
    catch (e) { setToast(e instanceof Error ? e.message : 'Could not switch role.'); }
    finally { setSwitching(false); }
  }

  if (error) return <div className="page"><div className="error-box" role="alert">{error}</div><div><button className="btn" onClick={load}>Try again</button> <button className="btn link" onClick={() => onSwitch(null)}>Back to workspaces</button></div></div>;
  if (!data) return <div className="loading"><div style={{ width: 200 }}><div className="progress" /><p className="small" style={{ marginTop: 10, textAlign: 'center' }}>Loading workspace…</p></div></div>;

  const { me } = data;
  const act = (d: ActionDraft) => setDraft(d);
  const scope = me.role === 'partner_user' && me.partner ? `only journeys assigned to ${me.partner}; money is hidden`
    : me.role === 'relationship_manager' && me.bookCode ? `only customers in book ${me.bookCode}; money is hidden` : ROLE_SCOPE[me.role];

  return (
    <>
      <header className="topbar">
        <span className="wordmark">Vtology</span>
        <div className="ws-switch">
          <select className="input" aria-label="Workspace" value={workspaceId} onChange={e => onSwitch(e.target.value === '__all' ? null : e.target.value)}>
            {workspaces.length === 0 && <option value={workspaceId}>{me.tenantName}</option>}
            {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            <option value="__all">All workspaces…</option>
          </select>
        </div>
        <span className="grow" />
        {me.isDemo ? (
          <label className="role-pick">Viewing as
            <select className="input" value={me.role} disabled={switching} onChange={e => switchRole(e.target.value as RoleCode)} style={{ width: 'auto' }}>
              {Object.values(ROLES).map(r => <option key={r.code} value={r.code}>{r.label}</option>)}
            </select>
          </label>
        ) : <span className="small muted">{ROLES[me.role].label}</span>}
        <button className="btn small" onClick={onSignOut} title={email ?? undefined}>Sign out</button>
      </header>
      <nav className="tabs" role="tablist" aria-label="Sections">
        {TABS.map(t => (
          <button key={t.id} role="tab" className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}{t.id === 'approvals' && pending > 0 && <span className="count" aria-label={`${pending} waiting for you`}>{pending}</span>}
          </button>
        ))}
      </nav>
      <main className="page">
        <div className="page-head">
          <div>
            <h1>{me.tenantName}{me.isDemo && <span className="sample-flag">Sample data</span>}</h1>
            <p className="muted">{me.industry}. As {ROLES[me.role].label.toLowerCase()} you see {scope}.</p>
          </div>
        </div>
        {tab === 'overview' && <Overview data={data} go={setTab} />}
        {tab === 'journeys' && <Journeys data={data} act={act} />}
        {tab === 'findings' && <Findings data={data} act={act} />}
        {tab === 'partners' && <Partners data={data} act={act} />}
        {tab === 'social' && (['partner_user', 'relationship_manager'].includes(me.role) ? <div className="empty">Social insights are not part of your role’s view.</div> : <Social data={data} workspaceId={workspaceId} notify={setToast} />)}
        {tab === 'approvals' && <Approvals data={data} workspaceId={workspaceId} reload={load} notify={setToast} />}
        {tab === 'data' && <DataView data={data} workspaceId={workspaceId} reload={load} notify={setToast} />}
      </main>
      {draft && <ActionDialog draft={draft} data={data} workspaceId={workspaceId} onClose={changed => { setDraft(null); if (changed) load(); }} notify={setToast} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}
