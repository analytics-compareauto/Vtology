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
import { Growth } from './views/Growth';
import { ActionDialog, type ActionDraft } from './ActionDialog';
import { ErrorBoundary } from './ErrorBoundary';
import { BrandMark, IconApprovals, IconData, IconFindings, IconGrowth, IconJourneys, IconOverview, IconPartners, IconSocial } from './icons';

export interface WorkspaceData { me: Me; journeys: Journey[]; partners: PartnerScore[]; findings: Finding[]; actions: ActionRun[] }
type Tab = 'overview' | 'journeys' | 'findings' | 'partners' | 'social' | 'growth' | 'approvals' | 'data';
const TABS: { id: Tab; label: string; Icon: (p: React.SVGProps<SVGSVGElement>) => React.JSX.Element; lead: string }[] = [
  { id: 'overview', label: 'Overview', Icon: IconOverview, lead: 'Where every customer journey stands, and what is leaking.' },
  { id: 'journeys', label: 'Journeys', Icon: IconJourneys, lead: 'Every customer, the stage they are at, and how long they have waited.' },
  { id: 'findings', label: 'Findings', Icon: IconFindings, lead: 'Numbers that don’t add up across your systems, grouped by what to do about them.' },
  { id: 'partners', label: 'Partners', Icon: IconPartners, lead: 'How each dealer, branch or distributor handles the customers sent to them.' },
  { id: 'social', label: 'Social', Icon: IconSocial, lead: 'What your posts and paid campaigns achieve, and what to change.' },
  { id: 'growth', label: 'Growth', Icon: IconGrowth, lead: 'Followers, reach and engagement against the previous period and your competitors, with a plan to grow.' },
  { id: 'approvals', label: 'Approvals', Icon: IconApprovals, lead: 'Fixes waiting for a decision, and the ones already applied.' },
  { id: 'data', label: 'Data', Icon: IconData, lead: 'Imports from your systems and the matching that joins them into one record.' },
];

export function Dashboard({ workspaceId, email, onSwitch, onSignOut }: { workspaceId: string; email: string | null; onSwitch: (id: string | null) => void; onSignOut: () => void }) {
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => {
    try { const t = new URLSearchParams(window.location.search).get('tab'); return TABS.some(x => x.id === t) ? t as Tab : 'overview'; } catch { return 'overview'; }
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
    setToast(st === 'connected' ? `${name} connected. Fetching posts and insights now; this can take up to a minute.` : `${name} was not connected. ${q.get('message') ?? ''}`);
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

  const current = TABS.find(t => t.id === tab)!;
  const go = (t: Tab) => { setTab(t); try { window.history.replaceState(null, '', `?tab=${t}`); } catch { /* ignore */ } window.scrollTo({ top: 0 }); };
  const navItems = TABS.map(t => ({ ...t, badge: t.id === 'approvals' && pending > 0 ? pending : 0 }));

  return (
    <div className="shell">
      <aside className="side" aria-label="Main">
        <div className="brand"><BrandMark />Vtology</div>
        <label className="ws-pick"><span>Workspace</span>
          <select aria-label="Workspace" value={workspaceId} onChange={e => onSwitch(e.target.value === '__all' ? null : e.target.value)}>
            {workspaces.length === 0 && <option value={workspaceId}>{me.tenantName}</option>}
            {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            <option value="__all">All workspaces…</option>
          </select>
        </label>
        <nav className="nav">
          {navItems.map(t => (
            <button key={t.id} aria-current={tab === t.id ? 'page' : undefined} onClick={() => go(t.id)}>
              <t.Icon />{t.label}{t.badge > 0 && <span className="count" aria-label={`${t.badge} waiting for you`}>{t.badge}</span>}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <div className="who"><b>{email ?? 'Signed in'}</b>{ROLES[me.role].label}</div>
          <button className="btn small" onClick={onSignOut}>Sign out</button>
        </div>
      </aside>
      <div className="main">
        <nav className="mobile-nav" aria-label="Sections">
          <span className="brand"><BrandMark />Vtology</span>
          {navItems.map(t => <button key={t.id} aria-current={tab === t.id ? 'page' : undefined} onClick={() => go(t.id)}>{t.label}{t.badge > 0 ? ` (${t.badge})` : ''}</button>)}
        </nav>
        <header className="topbar">
          <span className="crumb"><b>{me.tenantName}</b>&ensp;{me.industry} workspace{me.isDemo && <span className="sample-flag">Sample data</span>}</span>
          <span className="grow" />
          {me.isDemo ? (
            <label className="role-pick">Viewing as
              <select className="input" value={me.role} disabled={switching} onChange={e => switchRole(e.target.value as RoleCode)}>
                {Object.values(ROLES).map(r => <option key={r.code} value={r.code}>{r.label}</option>)}
              </select>
            </label>
          ) : <span className="role-chip" title={`As ${ROLES[me.role].label.toLowerCase()} you see ${scope}.`}>{ROLES[me.role].label}</span>}
        </header>
        <main className="page">
          <div className="page-head">
            <div>
              <h1>{current.label}</h1>
              <p className="muted">{current.lead} <span className="small">As {ROLES[me.role].label.toLowerCase()} you see {scope}.</span></p>
            </div>
          </div>
          <ErrorBoundary resetKey={tab}>
          {tab === 'overview' && <Overview data={data} go={go} />}
          {tab === 'journeys' && <Journeys data={data} act={act} />}
          {tab === 'findings' && <Findings data={data} act={act} />}
          {tab === 'partners' && <Partners data={data} act={act} />}
          {tab === 'social' && (['partner_user', 'relationship_manager'].includes(me.role) ? <div className="empty">Social insights are not part of your role’s view.</div> : <Social data={data} workspaceId={workspaceId} notify={setToast} />)}
          {tab === 'growth' && (['partner_user', 'relationship_manager'].includes(me.role) ? <div className="empty">Growth insights are not part of your role’s view.</div> : <Growth data={data} workspaceId={workspaceId} notify={setToast} />)}
          {tab === 'approvals' && <Approvals data={data} workspaceId={workspaceId} reload={load} notify={setToast} />}
          {tab === 'data' && <DataView data={data} workspaceId={workspaceId} reload={load} notify={setToast} />}
          </ErrorBoundary>
        </main>
      </div>
      {draft && <ActionDialog draft={draft} data={data} workspaceId={workspaceId} onClose={changed => { setDraft(null); if (changed) load(); }} notify={setToast} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
