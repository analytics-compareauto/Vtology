'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import { ago, num } from '../format';
import { IconRefresh } from '../icons';

interface Source {
  id: string; name: string; template: string; base_url: string; has_key: boolean;
  status_map: Record<string, string>; seen_statuses: Record<string, number>;
  status: 'active' | 'error' | 'paused'; last_sync_at: string | null; last_error: string | null;
  stats: { dealers?: number; leadsLastPull?: number; newLeadsLastPull?: number; movedLastPull?: number };
}
interface SourcesData { canEdit: boolean; stages: string[]; defaultMap: Record<string, string>; sources: Source[] }

/** The brand's own systems (dealer dashboard, DMS, CRM feeds), pulled on a schedule. */
export function Sources({ workspaceId, notify, reload }: { workspaceId: string; notify: (m: string) => void; reload: () => Promise<void> }) {
  const [d, setD] = useState<SourcesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [mapping, setMapping] = useState<string | null>(null);
  const T = `/tenants/${workspaceId}`;

  const load = useCallback(() => api<SourcesData>('GET', `${T}/sources`).then(r => { setD(r); setError(null); }).catch(e => setError(e instanceof ApiError ? e.message : 'Could not load sources.')), [T]);
  useEffect(() => { load(); }, [load]);

  async function sync(s: Source) {
    setBusy(s.id);
    try {
      const r = await api<{ leads: number; newLeads: number; moved: number; unmapped: string[]; more: boolean }>('POST', `${T}/sources/${s.id}/sync`);
      notify(`${s.name}: ${num(r.leads)} leads read, ${num(r.newLeads)} new, ${num(r.moved)} moved to a later stage.${r.unmapped.length ? ` Map these statuses: ${r.unmapped.join(', ')}.` : ''}${r.more ? ' More on the next pull.' : ''}`);
      await Promise.all([load(), reload()]);
    } catch (e) { notify(e instanceof ApiError ? e.message : 'The pull failed.'); await load(); }
    finally { setBusy(null); }
  }
  async function remove(s: Source) {
    if (!window.confirm(`Disconnect ${s.name}? Leads already pulled stay in Vtology; no new ones will come in.`)) return;
    setBusy(s.id);
    try { await api('DELETE', `${T}/sources/${s.id}`); notify(`Disconnected ${s.name}.`); await load(); }
    catch (e) { notify(e instanceof ApiError ? e.message : 'Could not disconnect.'); }
    finally { setBusy(null); }
  }

  if (error) return <div className="error-box" role="alert">{error}</div>;
  if (!d) return <div className="progress" />;

  return (
    <section className="panel" style={{ display: 'grid', gap: 14 }}>
      <div className="panel-head" style={{ marginBottom: 0 }}>
        <div>
          <h2>Connected sources</h2>
          <p>Your own systems, such as a dealer dashboard, DMS or CRM, pulled automatically every day and whenever someone opens Vtology after an hour. Each lead joins its customer, campaign and dealer; phone numbers and emails are scrambled on arrival.</p>
        </div>
        {d.canEdit && !adding && <button className="btn primary" onClick={() => setAdding(true)}>Connect a source</button>}
      </div>

      {adding && <AddSource T={T} onDone={async (msg) => { setAdding(false); if (msg) { notify(msg); await Promise.all([load(), reload()]); } }} />}

      {d.sources.length === 0 && !adding ? (
        <div className="empty">No sources connected yet. {d.canEdit ? 'Connect your dealer dashboard to follow every lead to test drive and sale.' : 'Data stewards and marketing heads can connect them.'}</div>
      ) : (
        <div className="rows">
          {d.sources.map(s => {
            const unmapped = Object.keys(s.seen_statuses ?? {}).filter(k => !Object.keys(s.status_map ?? {}).some(m => m.toLowerCase() === k.toLowerCase()));
            return (
              <div className="row" key={s.id}>
                <div className="row-main">
                  <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <span className={`conn`} style={{ padding: '4px 10px', cursor: 'default' }}><span className={`dot ${s.status === 'error' ? 'warn' : s.status === 'paused' ? 'off' : 'ok'}`} />{s.status === 'error' ? 'Problem' : s.status === 'paused' ? 'Paused' : 'Connected'}</span>
                    <span style={{ minWidth: 0 }}><b>{s.name}</b> <span className="muted small">{new URL(s.base_url).host}</span></span>
                  </span>
                  <span className="toolbar">
                    <button className="btn small" onClick={() => sync(s)} disabled={busy === s.id}><IconRefresh />{busy === s.id ? 'Pulling…' : 'Pull now'}</button>
                    {d.canEdit && <button className="btn small" onClick={() => setMapping(mapping === s.id ? null : s.id)}>{mapping === s.id ? 'Close mapping' : 'Status mapping'}{unmapped.length ? ` (${unmapped.length} to map)` : ''}</button>}
                    {d.canEdit && <button className="btn small" onClick={() => remove(s)} disabled={busy === s.id}>Disconnect</button>}
                  </span>
                </div>
                <span className="muted small">
                  {s.last_sync_at ? `Last pulled ${ago(s.last_sync_at)}` : 'Not pulled yet'}
                  {s.stats?.leadsLastPull !== undefined ? `: ${num(s.stats.leadsLastPull)} leads read, ${num(s.stats.newLeadsLastPull ?? 0)} new, ${num(s.stats.movedLastPull ?? 0)} moved on; ${num(s.stats.dealers ?? 0)} dealers and branches.` : '.'}
                </span>
                {s.last_error && <span className="small" style={{ color: 'var(--warn)' }}>{s.last_error}</span>}
                {mapping === s.id && <Mapping T={T} source={s} stages={d.stages} onSaved={async () => { setMapping(null); notify(`Mapping saved. Pulling ${s.name} again so every lead sits at the right stage.`); await sync(s); }} />}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function AddSource({ T, onDone }: { T: string; onDone: (msg: string | null) => void }) {
  const [name, setName] = useState('Dealer dashboard');
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await api<{ dealers: number; leads: number; newLeads: number; unmapped: string[] }>('POST', `${T}/sources`, { name, template: 'lead_feed_v1', baseUrl: url, key });
      onDone(`Connected ${name}: ${num(r.dealers)} dealers and branches, ${num(r.leads)} leads.${r.unmapped.length ? ` Map these statuses to stages: ${r.unmapped.join(', ')}.` : ''}`);
    } catch (e2) { setErr(e2 instanceof ApiError ? e2.message : 'Could not connect.'); }
    finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="note-box" style={{ display: 'grid', gap: 12, background: 'var(--surface-2)', border: '1px solid var(--line)' }}>
      <b>Connect a source that speaks the Vtology lead feed</b>
      <span className="small muted">Your developer sets the feed up on your system (CompareAuto’s is at /api/vtology) and gives you its address and key. The key is stored encrypted; nobody can read it back.</span>
      <div className="grid-2" style={{ gap: 12 }}>
        <label className="field">Name<input className="input" value={name} onChange={e => setName(e.target.value)} required maxLength={80} /></label>
        <label className="field">Feed address<input className="input" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://compareauto.in/api/vtology" required /></label>
      </div>
      <label className="field">Key<input className="input" type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder="The VTOLOGY_FEED_KEY your developer set" required /></label>
      {err && <div className="error-box" role="alert">{err}</div>}
      {busy && <div><div className="progress" /><p className="muted small" style={{ marginTop: 6 }}>Checking the address and key, then pulling dealers and leads…</p></div>}
      <div className="toolbar"><button className="btn primary" type="submit" disabled={busy}>Connect and pull</button><button type="button" className="btn" onClick={() => onDone(null)} disabled={busy}>Cancel</button></div>
    </form>
  );
}

function Mapping({ T, source, stages, onSaved }: { T: string; source: Source; stages: string[]; onSaved: () => void }) {
  // every status the source has used, plus the ones already mapped
  const keys = useMemo(() => {
    const seen = Object.keys(source.seen_statuses ?? {});
    const mapped = Object.keys(source.status_map ?? {});
    return [...new Set([...seen, ...mapped.filter(m => !seen.some(s => s.toLowerCase() === m.toLowerCase()))])]
      .sort((a, b) => (source.seen_statuses[b] ?? 0) - (source.seen_statuses[a] ?? 0) || a.localeCompare(b));
  }, [source]);
  const find = (k: string) => Object.entries(source.status_map ?? {}).find(([m]) => m.toLowerCase() === k.toLowerCase())?.[1] ?? '';
  const [map, setMap] = useState<Record<string, string>>(() => Object.fromEntries(keys.map(k => [k, find(k)])));
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await api('PATCH', `${T}/sources/${source.id}`, { statusMap: Object.fromEntries(Object.entries(map).filter(([, v]) => v)) }); onSaved(); }
    finally { setBusy(false); }
  }
  return (
    <div style={{ marginTop: 8, border: '1px solid var(--line)', borderRadius: 'var(--radius-m)', padding: 14, display: 'grid', gap: 10 }}>
      <span className="small">Which Vtology stage does each of <b>{source.name}</b>’s statuses mean? A lead moves to the furthest stage any of its updates reached. Test drives given and sales with an amount are picked up on their own.</span>
      <div className="table-wrap" style={{ boxShadow: 'none' }}>
        <table>
          <thead><tr><th>Status in {source.name}</th><th className="num">Leads now</th><th>Vtology stage</th></tr></thead>
          <tbody>
            {keys.map(k => (
              <tr key={k}>
                <td><b>{k}</b>{!map[k] && <span className="tag warn" style={{ marginLeft: 8 }}>Not mapped</span>}</td>
                <td className="num">{num(source.seen_statuses?.[k] ?? 0)}</td>
                <td><select className="input" style={{ width: 'auto' }} value={map[k] ?? ''} onChange={e => setMap(m => ({ ...m, [k]: e.target.value }))}>
                  <option value="">Not mapped</option>
                  {stages.map(s => <option key={s} value={s}>{s}</option>)}
                </select></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div><button className="btn primary small" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save and pull again'}</button></div>
    </div>
  );
}
