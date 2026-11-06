'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { ago } from '../format';

type FeatureKey = 'social' | 'media' | 'audiences' | 'journeys';
interface Client {
  id: string; name: string; industry: string; is_demo: boolean; plan: string; features: Record<FeatureKey, boolean>; margin_pct: number | null; admin_note: string | null; created_at: string;
  members: number; leads: number; sources: number; source_errors: number; social: number; dv360: number; ads: number; offline: number; audiences: number; last_data: string | null;
}
interface AdminData { plans: { id: string; label: string; features: FeatureKey[] }[]; features: FeatureKey[]; clients: Client[]; audit: { at: string; admin_email: string; tenant_name: string | null; action: string; detail: { before?: Summary; after?: Summary; note?: boolean } }[] }
interface Summary { plan: string; features: Record<string, boolean>; marginPct: number | null }

const PART: Record<FeatureKey, { label: string; what: string }> = {
  social: { label: 'Social', what: 'Growth, posts and ads, content and YouTube search' },
  media: { label: 'Media', what: 'All media, awareness, search and social ads, from ad to car' },
  audiences: { label: 'Audiences', what: 'Hashed customer lists and buckets' },
  journeys: { label: 'Dealer and leads', what: 'Journeys, findings, partners and approvals' },
};

/** Vanaya's admin panel: every client, its plan, the parts switched on, the margin, and a record of every change. */
export function Admin({ notify }: { notify: (m: string) => void }) {
  const [d, setD] = useState<AdminData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [showSamples, setShowSamples] = useState(false);
  const load = useCallback(() => api<AdminData>('GET', '/admin').then(r => { setD(r); setErr(null); }).catch(e => setErr(e instanceof ApiError ? e.message : 'Could not load the admin panel.')), []);
  useEffect(() => { load(); }, [load]);
  if (err) return <div className="error-box" role="alert">{err}</div>;
  if (!d) return <div className="progress" />;
  const real = d.clients.filter(c => !c.is_demo), samples = d.clients.filter(c => c.is_demo);
  const planLabel = (id: string) => d.plans.find(p => p.id === id)?.label ?? id;
  const stale = real.filter(c => !c.last_data || Date.now() - Date.parse(c.last_data) > 7 * 86_400_000);

  const Row = ({ c }: { c: Client }) => {
    const data = [c.sources ? `Dealer feed${c.source_errors ? ' (problem)' : ''}` : '', c.social ? 'Social' : '', c.dv360 ? 'DV360' : '', c.ads ? 'Google/Meta' : '', c.offline ? 'TV, print, radio' : '', c.audiences ? 'Audiences' : ''].filter(Boolean);
    return (
      <div className={`adm-row ${open === c.id ? 'open' : ''}`}>
        <div className="adm-main">
          <span className="plan-name"><b className="clamp1">{c.name}</b><span className="small muted">{c.industry} · since {new Date(c.created_at).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}</span></span>
          <span><span className={`tag ${c.plan === 'enterprise' ? 'ok' : c.plan === 'custom' ? 'warn' : 'flow'}`}>{planLabel(c.plan)}</span>{c.margin_pct !== null && <span className="small muted"> · {c.margin_pct}% margin</span>}</span>
          <span className="adm-parts">{d.features.map(f => <span key={f} className={`adm-part ${c.features[f] ? 'on' : ''}`} title={`${PART[f].label}: ${c.features[f] ? 'on' : 'off'}`}>{PART[f].label}</span>)}</span>
          <span className="small">{data.length ? data.join(' · ') : <span className="muted">No data yet</span>}{c.source_errors > 0 && <b style={{ color: 'var(--leak)' }}> !</b>}</span>
          <span className="small num">{c.leads.toLocaleString('en-IN')} leads · {c.members} {c.members === 1 ? 'person' : 'people'}<br /><span className="muted">{c.last_data ? `data ${ago(c.last_data)}` : 'no data'}</span></span>
          <button className="btn small" onClick={() => setOpen(open === c.id ? null : c.id)}>{open === c.id ? 'Close' : 'Manage'}</button>
        </div>
        {open === c.id && <Manage c={c} d={d} onSaved={msg => { notify(msg); setOpen(null); load(); }} />}
      </div>
    );
  };

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div className="adm-note small">Only Vanaya’s owners see this page. Clients and partners never see it, its plans, or the margin.</div>
      <div className="picture-nums">
        <div><span>Clients</span><b>{real.length}</b></div>
        <div><span>Leads across clients</span><b>{real.reduce((a, c) => a + c.leads, 0).toLocaleString('en-IN')}</b></div>
        <div><span>Need attention</span><b style={{ color: stale.length || real.some(c => c.source_errors) ? 'var(--leak)' : undefined }}>{stale.length + real.filter(c => c.source_errors).length}</b></div>
      </div>
      {(stale.length > 0 || real.some(c => c.source_errors)) && (
        <section className="panel"><div className="panel-head"><div><h2>Needs attention</h2></div></div>
          <ul className="adm-alerts">
            {real.filter(c => c.source_errors).map(c => <li key={`e${c.id}`}><b>{c.name}</b>: the dealer feed has a problem; check it under Data in their workspace.</li>)}
            {stale.map(c => <li key={`s${c.id}`}><b>{c.name}</b>: {c.last_data ? `no new data for ${ago(c.last_data).replace(' ago', '')}` : 'no data added yet'}.</li>)}
          </ul>
        </section>
      )}
      <section className="panel">
        <div className="panel-head"><div><h2>Clients</h2><p>Plan, the parts switched on, the data each has shared, and when it last came in.</p></div></div>
        <div className="adm-head"><span>Client</span><span>Plan</span><span>Parts on</span><span>Data shared</span><span className="num">Size</span><span /></div>
        {real.map(c => <Row key={c.id} c={c} />)}
        {samples.length > 0 && <button className="btn small link" style={{ marginTop: 10 }} onClick={() => setShowSamples(x => !x)}>{showSamples ? 'Hide' : 'Show'} {samples.length} sample and test {samples.length === 1 ? 'workspace' : 'workspaces'}</button>}
        {showSamples && samples.map(c => <Row key={c.id} c={c} />)}
      </section>
      <section className="panel">
        <div className="panel-head"><div><h2>Plans</h2><p>What each plan switches on. Switching parts by hand makes a client’s plan Custom.</p></div></div>
        <div className="get-grid">{d.plans.filter(p => p.id !== 'custom').map(p => (
          <div key={p.id} className="get-card"><b>{p.label}</b>{d.features.map(f => <span key={f} className="small">{p.features.includes(f) ? '✓' : '–'} {PART[f].label}<span className="muted"> · {PART[f].what}</span></span>)}</div>
        ))}</div>
      </section>
      <section className="panel">
        <div className="panel-head"><div><h2>Changes</h2><p>Every change made here: who, when, and what.</p></div></div>
        {d.audit.length ? <div className="rows">{d.audit.map((a, i) => (
          <div className="row" key={i}>
            <div className="row-main"><span><b>{a.tenant_name ?? 'A client'}</b>: {a.action.toLowerCase()}{a.detail.before && a.detail.after ? `, ${planLabel(a.detail.before.plan)} → ${planLabel(a.detail.after.plan)}` : ''}{a.detail.after && a.detail.before && a.detail.after.marginPct !== a.detail.before.marginPct ? `, margin ${a.detail.before.marginPct ?? 'none'} → ${a.detail.after.marginPct ?? 'none'}%` : ''}</span><span className="small muted">{ago(a.at)}</span></div>
            <span className="small muted">by {a.admin_email}</span>
          </div>
        ))}</div> : <div className="empty">No changes yet.</div>}
      </section>
    </div>
  );
}

function Manage({ c, d, onSaved }: { c: Client; d: AdminData; onSaved: (msg: string) => void }) {
  const [plan, setPlan] = useState(c.plan);
  const [features, setFeatures] = useState<Record<FeatureKey, boolean>>({ ...c.features });
  const [margin, setMargin] = useState(c.margin_pct === null ? '' : String(c.margin_pct));
  const [note, setNote] = useState(c.admin_note ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const choosePlan = (id: string) => { setPlan(id); const p = d.plans.find(x => x.id === id); if (p && id !== 'custom') setFeatures(Object.fromEntries(d.features.map(f => [f, p.features.includes(f)])) as Record<FeatureKey, boolean>); };
  async function save() {
    setBusy(true); setErr(null);
    try {
      await api('PATCH', `/admin/tenants/${c.id}`, { plan, marginPct: margin === '' ? null : Number(margin), note });
      if (plan === 'custom' || d.features.some(f => features[f] !== (d.plans.find(p => p.id === plan)?.features.includes(f) ?? false))) await api('PATCH', `/admin/tenants/${c.id}`, { features });
      onSaved(`Saved ${c.name}.`);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not save.'); } finally { setBusy(false); }
  }
  return (
    <div className="adm-manage">
      <div><span className="small muted">Plan</span>
        <div className="seg" role="group" aria-label="Plan">{d.plans.map(p => <button key={p.id} aria-pressed={plan === p.id} onClick={() => choosePlan(p.id)}>{p.label}</button>)}</div></div>
      <div><span className="small muted">Parts switched on</span>
        <div className="adm-toggles">{d.features.map(f => (
          <label key={f} className={`dealer-opt ${features[f] ? 'on' : ''}`}><input type="checkbox" checked={features[f]} onChange={e => { setFeatures(x => ({ ...x, [f]: e.target.checked })); setPlan('custom'); }} />
            <span><b>{PART[f].label}</b><span className="small muted" style={{ display: 'block' }}>{PART[f].what}</span></span></label>
        ))}</div></div>
      <div className="toolbar" style={{ alignItems: 'flex-end' }}>
        <label className="field" style={{ maxWidth: 200 }}>Activation margin (%)<input className="input" inputMode="decimal" value={margin} onChange={e => setMargin(e.target.value.replace(/[^\d.]/g, ''))} placeholder="Not set" /></label>
        <label className="field" style={{ flex: 1, minWidth: 220 }}>Note for the team<input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. pilot until December, Meta only" maxLength={1000} /></label>
      </div>
      {err && <div className="error-box" role="alert">{err}</div>}
      <div className="toolbar"><button className="btn primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button><span className="small muted">The client sees the change the next time they open Vtology. The margin is never shown to them.</span></div>
    </div>
  );
}
