'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RULE_OPS, parseCsv, planColumns, sha256Hex, toAudienceRows, type AttributeSummary, type ColumnPlan, type RuleOp } from '@vtology/core';
import { api, ApiError } from '../api';
import { ago, compact, num, pct } from '../format';
import { IconRefresh } from '../icons';

type Kind = 'customers' | 'buyers' | 'exclude' | 'other';
interface List { id: string; name: string; kind: Kind; status: 'uploading' | 'ready'; rows_received: number; rows_rejected: number; people: number; with_email: number; with_phone: number; attributes: Record<string, AttributeSummary>; expires_at: string; created_at: string }
interface Measured { list: string; targetedConverted: number; holdoutConverted: number; targetedRate: number; holdoutRate: number; lift: number | null }
interface Stats { candidates: number; excluded: number; people: number; holdout: number; targeted: number; withEmail: number; withPhone: number; measured?: Measured }
interface Rule { field: string; op: RuleOp; value: string }
interface Bucket { id: string; name: string; purpose: string; include_lists: string[]; exclude_lists: string[]; rules: Rule[]; holdout_pct: number; measure_list: string | null; stats: Stats; computed_at: string | null; summary: string }
interface Data { lists: List[]; buckets: Bucket[]; exports: { id: string; bucket_name: string; part: string; format: string; rows: number; created_at: string }[]; purposes: Record<string, string>; chunkMax: number }

const KIND_LABEL: Record<Kind, string> = { customers: 'People you have', buyers: 'Buyers (to measure lift)', exclude: 'Never target', other: 'Other' };
const ROLE_LABEL: Record<ColumnPlan['role'], string> = { email_hash: 'Email, already hashed', phone_hash: 'Phone, already hashed', email_raw: 'Email: hashed on this computer before upload', phone_raw: 'Phone: hashed on this computer before upload', attribute: 'Attribute, used for rules', ignore: 'Left out' };

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Who you can reach, kept apart from who you hold back: the bar every bucket is read by. */
function SplitBar({ s }: { s: Stats }) {
  const total = Math.max(1, s.candidates);
  return (
    <div className="aud-bar" role="img" aria-label={`${num(s.targeted)} to target, ${num(s.holdout)} held back, ${num(s.excluded)} excluded`}>
      <i style={{ width: `${(s.targeted / total) * 100}%`, background: 'var(--flow)' }} />
      <i style={{ width: `${(s.holdout / total) * 100}%`, background: 'var(--warn)' }} />
      <i style={{ width: `${(s.excluded / total) * 100}%`, background: 'var(--line)' }} />
    </div>
  );
}

export function Audiences({ workspaceId, notify, isDemo, canEdit }: { workspaceId: string; notify: (m: string) => void; isDemo: boolean; canEdit: boolean }) {
  const T = `/tenants/${workspaceId}`;
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState<Bucket | 'new' | null>(null);
  const [activating, setActivating] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => api<Data>('GET', `${T}/audiences`).then(r => { setD(r); setError(null); }).catch(e => setError(e instanceof ApiError ? e.message : 'Could not load audiences.')), [T]);
  useEffect(() => { load(); }, [load]);

  if (!canEdit) return <div className="empty">Audiences hold hashed customer lists, so only data stewards and marketing heads can open them.</div>;
  if (error) return <div className="error-box" role="alert">{error}</div>;
  if (!d) return <div className="progress" />;

  const ready = d.lists.filter(l => l.status === 'ready');
  const people = ready.filter(l => l.kind !== 'buyers').reduce((a, l) => a + l.people, 0);
  const reach = d.buckets.reduce((a, b) => a + (b.stats?.targeted ?? 0), 0);
  const listName = (id: string) => d.lists.find(l => l.id === id)?.name ?? 'a deleted list';

  async function removeList(l: List) {
    if (!window.confirm(`Delete ${l.name}? Every hashed key in it is deleted now; buckets built on it lose those people.`)) return;
    setBusy(l.id);
    try { await api('DELETE', `${T}/audiences/lists/${l.id}`); notify(`Deleted ${l.name}.`); await load(); }
    catch (e) { notify(e instanceof ApiError ? e.message : 'Could not delete the list.'); } finally { setBusy(null); }
  }
  async function refresh(b: Bucket) {
    setBusy(b.id);
    try { await api('POST', `${T}/audiences/buckets/${b.id}/refresh`); await load(); notify(`${b.name} counted again.`); }
    catch (e) { notify(e instanceof ApiError ? e.message : 'Could not refresh.'); } finally { setBusy(null); }
  }
  async function removeBucket(b: Bucket) {
    if (!window.confirm(`Delete the bucket ${b.name}? The lists it was built from stay.`)) return;
    setBusy(b.id);
    try { await api('DELETE', `${T}/audiences/buckets/${b.id}`); notify(`Deleted ${b.name}.`); await load(); }
    catch (e) { notify(e instanceof ApiError ? e.message : 'Could not delete.'); } finally { setBusy(null); }
  }

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <section className="kpis" aria-label="Key figures">
        <div className="kpi"><span className="label">Lists</span><span className="value">{num(ready.length)}</span><span className="sub">{d.lists.length > ready.length ? `${d.lists.length - ready.length} still uploading` : 'hashed, each with an expiry date'}</span></div>
        <div className="kpi"><span className="label">People</span><span className="value">{compact(people)}</span><span className="sub">in your lists (one person can be in several)</span></div>
        <div className="kpi"><span className="label">Buckets</span><span className="value">{num(d.buckets.length)}</span><span className="sub">each with a holdout to prove results</span></div>
        <div className="kpi ok"><span className="label">Ready to reach</span><span className="value">{compact(reach)}</span><span className="sub">people to target, holdouts left out</span></div>
      </section>

      <div className="note-box"><b>How your data is kept.</b> Emails and phone numbers are hashed with SHA-256 before they leave this computer, so Vtology never receives them in the clear. Hashed keys can be read only by the matching and export jobs: no screen shows them. Media partners such as TeCreo get a segment, never your list. Every list is deleted on its expiry date and every export is logged.</div>

      <section className="panel">
        <div className="panel-head">
          <div><h2>Lists</h2><p>Customers, buyers and people to exclude, from your CRM, app, MMP or a partner. Upload hashed files, or plain files that are hashed here first.</p></div>
          {!uploading && <div className="toolbar"><SampleFiles /><button className="btn primary" onClick={() => setUploading(true)}>Upload a list</button></div>}
        </div>
        {uploading && <UploadList T={T} chunkMax={d.chunkMax} onDone={async msg => { setUploading(false); if (msg) { notify(msg); await load(); } }} />}
        {d.lists.length === 0 && !uploading ? <div className="empty">No lists yet. Upload one, or download a sample file to see how it works.</div> : d.lists.length > 0 && (
          <div className="table-wrap" style={{ boxShadow: 'none' }}>
            <table>
              <thead><tr><th>List</th><th>Use</th><th className="num">People</th><th className="num">With email</th><th className="num">With phone</th><th>Attributes</th><th>Deleted on</th><th /></tr></thead>
              <tbody>
                {d.lists.map(l => (
                  <tr key={l.id}>
                    <td><b>{l.name}</b>{l.status === 'uploading' && <span className="tag warn" style={{ marginLeft: 8 }}>Upload not finished</span>}{l.rows_rejected > 0 && <div className="small muted">{num(l.rows_rejected)} rows had no usable email or phone</div>}</td>
                    <td><span className={`tag ${l.kind === 'exclude' ? 'leak' : l.kind === 'buyers' ? 'ok' : 'plain'}`}>{KIND_LABEL[l.kind]}</span></td>
                    <td className="num">{num(l.people)}</td>
                    <td className="num">{l.people ? pct(l.with_email / l.people) : '–'}</td>
                    <td className="num">{l.people ? pct(l.with_phone / l.people) : '–'}</td>
                    <td className="small">{Object.keys(l.attributes ?? {}).join(', ') || <span className="muted">none</span>}</td>
                    <td className="small">{new Date(l.expires_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                    <td><button className="btn small danger" onClick={() => removeList(l)} disabled={busy === l.id}>Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div><h2>Buckets</h2><p>Who to reach, built from your lists with simple rules. A share of each bucket is held back and never targeted, so every result can be checked against people who saw nothing.</p></div>
          {!editing && <button className="btn primary" onClick={() => setEditing('new')} disabled={!ready.some(l => l.kind !== 'buyers')}>New bucket</button>}
        </div>
        {editing && <BucketForm T={T} lists={ready} purposes={d.purposes} bucket={editing === 'new' ? null : editing} onDone={async msg => { setEditing(null); if (msg) { notify(msg); await load(); } }} />}
        {d.buckets.length === 0 && !editing ? <div className="empty">{ready.length ? 'No buckets yet. Build one from your lists.' : 'Upload a list first, then build buckets from it.'}</div> : (
          <div className="rows">
            {d.buckets.map(b => {
              const s = b.stats ?? { candidates: 0, excluded: 0, people: 0, holdout: 0, targeted: 0, withEmail: 0, withPhone: 0 };
              const m = s.measured;
              return (
                <div className="row" key={b.id} style={{ gap: 10 }}>
                  <div className="row-main">
                    <span><b style={{ fontSize: 16 }}>{b.name}</b> <span className="tag flow">{d.purposes[b.purpose] ?? b.purpose}</span></span>
                    <span className="toolbar">
                      <button className="btn small primary" onClick={() => setActivating(activating === b.id ? null : b.id)}>{activating === b.id ? 'Close' : 'Activate'}</button>
                      <button className="btn small" onClick={() => setEditing(b)}>Edit</button>
                      <button className="btn small" onClick={() => refresh(b)} disabled={busy === b.id}><IconRefresh />Count again</button>
                      <button className="btn small danger" onClick={() => removeBucket(b)} disabled={busy === b.id}>Delete</button>
                    </span>
                  </div>
                  <span className="small muted">From {b.include_lists.map(listName).join(' + ')}{b.summary ? `, where ${b.summary}` : ''}{b.exclude_lists.length ? `, leaving out ${b.exclude_lists.map(listName).join(' and ')}` : ''}.</span>
                  <div className="aud-figures">
                    <div><span className="label">To target</span><b>{num(s.targeted)}</b></div>
                    <div><span className="label">Held back ({b.holdout_pct}%)</span><b>{num(s.holdout)}</b></div>
                    <div><span className="label">Excluded</span><b>{num(s.excluded)}</b></div>
                    <div><span className="label">Have email / phone</span><b>{s.people ? `${pct(s.withEmail / s.people)} / ${pct(s.withPhone / s.people)}` : '–'}</b></div>
                  </div>
                  <SplitBar s={s} />
                  <div className="legend"><span><i style={{ background: 'var(--flow)' }} />to target</span><span><i style={{ background: 'var(--warn)' }} />held back</span><span><i style={{ background: 'var(--line)' }} />excluded (already in a list to leave out)</span></div>
                  {m && (
                    <div className="aud-lift">
                      <span className="small"><b>Measured against {m.list}:</b> {pct(m.targetedRate)} of the people targeted converted, against {pct(m.holdoutRate)} of those held back{m.lift ? <>, so the campaign made people <b>{m.lift.toFixed(1)}×</b> as likely to convert.</> : '. The holdout is too small to call a lift yet (it needs at least 30 people).'}</span>
                      <div className="aud-compare">
                        <span>Targeted</span><div className="share-bar"><i style={{ width: `${Math.min(100, m.targetedRate * 100 / Math.max(m.targetedRate, m.holdoutRate, 0.0001))}%` }} /></div><b>{pct(m.targetedRate)}</b>
                        <span>Held back</span><div className="share-bar"><i style={{ width: `${Math.min(100, m.holdoutRate * 100 / Math.max(m.targetedRate, m.holdoutRate, 0.0001))}%`, background: 'var(--warn)' }} /></div><b>{pct(m.holdoutRate)}</b>
                      </div>
                    </div>
                  )}
                  {activating === b.id && <Activate T={T} bucket={b} isDemo={isDemo} chunkMax={d.chunkMax} onChanged={load} notify={notify} />}
                  {b.computed_at && <span className="small muted">Counted {ago(b.computed_at)}</span>}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {d.exports.length > 0 && (
        <section className="panel">
          <div className="panel-head"><div><h2>Export log</h2><p>Every file that left Vtology: when, which bucket, which part and how many people.</p></div></div>
          <div className="table-wrap" style={{ boxShadow: 'none' }}>
            <table>
              <thead><tr><th>When</th><th>Bucket</th><th>Part</th><th>Format</th><th className="num">People</th></tr></thead>
              <tbody>{d.exports.map(x => <tr key={x.id}><td>{ago(x.created_at)}</td><td>{x.bucket_name}</td><td>{x.part === 'holdout' ? <span className="tag warn">Holdout, for measurement</span> : 'To target'}</td><td>{FORMAT_LABEL[x.format] ?? x.format}</td><td className="num">{num(x.rows)}</td></tr>)}</tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- uploading
function UploadList({ T, chunkMax, onDone }: { T: string; chunkMax: number; onDone: (msg: string | null) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('customers');
  const [days, setDays] = useState(90);
  const [rows, setRows] = useState<Record<string, string>[] | null>(null);
  const [plan, setPlan] = useState<ColumnPlan[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function pick(f: File | undefined) {
    setErr(null); setRows(null);
    if (!f) return;
    if (!name) setName(f.name.replace(/\.(csv|txt)$/i, '').slice(0, 80));
    try {
      const parsed = parseCsv(await f.text());
      if (!parsed.length) { setErr('The file has no rows under its header.'); return; }
      setRows(parsed);
      setPlan(planColumns(Object.keys(parsed[0]!), parsed.slice(0, 300)));
    } catch { setErr('Could not read the file. Save it as CSV (comma-separated, with a header row) and try again.'); }
  }
  const hasId = plan.some(p => p.role !== 'attribute' && p.role !== 'ignore');
  const hashesHere = plan.some(p => p.role === 'email_raw' || p.role === 'phone_raw');

  async function upload() {
    if (!rows) return;
    setErr(null); setProgress(0);
    let listId: string | null = null;
    try {
      const l = await api<{ id: string }>('POST', `${T}/audiences/lists`, { name, kind, expiresDays: days });
      listId = l.id;
      for (let i = 0; i < rows.length; i += chunkMax) {
        const { rows: out, rejected } = await toAudienceRows(rows.slice(i, i + chunkMax), plan);
        await api('POST', `${T}/audiences/lists/${l.id}/rows`, { rows: out, rejected });
        setProgress(Math.min(1, (i + chunkMax) / rows.length));
      }
      const r = await api<{ people: number }>('POST', `${T}/audiences/lists/${l.id}/finish`);
      onDone(`${name}: ${num(r.people)} people uploaded, hashed.`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'The upload stopped.');
      if (listId) await api('DELETE', `${T}/audiences/lists/${listId}`).catch(() => undefined);
      setProgress(null);
    }
  }

  return (
    <div className="note-box" style={{ display: 'grid', gap: 12, background: 'var(--surface-2)', border: '1px solid var(--line)', marginBottom: 16 }}>
      <div className="grid-2" style={{ gap: 12 }}>
        <label className="field">File (CSV with a header row)<input className="input" type="file" accept=".csv,text/csv,.txt" onChange={e => pick(e.target.files?.[0])} /></label>
        <label className="field">Name<input className="input" value={name} onChange={e => setName(e.target.value)} maxLength={80} placeholder="Premium subscribers, Nov" /></label>
        <label className="field">What is this list?
          <select className="input" value={kind} onChange={e => setKind(e.target.value as Kind)}>{(Object.keys(KIND_LABEL) as Kind[]).map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select>
        </label>
        <label className="field">Delete it after
          <select className="input" value={days} onChange={e => setDays(Number(e.target.value))}>{[30, 90, 180, 365].map(n => <option key={n} value={n}>{n} days</option>)}</select>
        </label>
      </div>
      {rows && (
        <>
          <span className="small"><b>{num(rows.length)} rows.</b> This is how each column will be used:</span>
          <div className="table-wrap" style={{ boxShadow: 'none' }}>
            <table>
              <thead><tr><th>Column</th><th>Used as</th></tr></thead>
              <tbody>{plan.map(p => <tr key={p.column}><td><b>{p.column}</b></td><td>{ROLE_LABEL[p.role]}{p.problem && <div className="small" style={{ color: 'var(--warn)' }}>{p.problem}</div>}</td></tr>)}</tbody>
            </table>
          </div>
          {!hasId && <div className="error-box">No email or phone column was found. The file needs one, either plain or hashed with SHA-256.</div>}
          {hashesHere && <span className="small">Plain emails and phone numbers are hashed with SHA-256 on this computer, then only the hashes are sent.</span>}
        </>
      )}
      {err && <div className="error-box" role="alert">{err}</div>}
      {progress !== null && <div><div className="share-bar"><i style={{ width: `${progress * 100}%` }} /></div><p className="small muted" style={{ marginTop: 6 }}>Hashing and uploading… {pct(progress)}</p></div>}
      <div className="toolbar">
        <button className="btn primary" disabled={!rows || !hasId || !name.trim() || progress !== null} onClick={upload}>Upload {rows ? num(rows.length) : ''} rows</button>
        <button className="btn" onClick={() => onDone(null)} disabled={progress !== null}>Cancel</button>
      </div>
    </div>
  );
}

/** Made-up people, hashed the standard way, to try the flow without real data. */
function SampleFiles() {
  const [busy, setBusy] = useState(false);
  async function make() {
    setBusy(true);
    const lines = ['email_sha256,phone_sha256,status,plan,months,activity,city_tier'];
    for (let i = 0; i < 2000; i++) {
      const status = i % 4 === 0 ? 'paying' : i % 5 === 0 ? 'lapsed' : 'free';
      const activity = i % 3 === 0 ? 'rising' : i % 7 === 0 ? 'falling' : 'steady';
      lines.push([await sha256Hex(`person${i}@example.in`), await sha256Hex(`+9198${String(10000000 + i * 37).slice(0, 8)}`), status, status === 'free' ? '' : i % 2 ? 'individual' : 'family', String(1 + (i % 36)), activity, `tier ${1 + (i % 3)}`].join(','));
    }
    download('sample-customers-hashed.csv', lines.join('\n'));
    setBusy(false);
  }
  return <button className="btn" onClick={make} disabled={busy}>{busy ? 'Making…' : 'Download a sample file'}</button>;
}

// ---------------------------------------------------------------- buckets
function BucketForm({ T, lists, purposes, bucket, onDone }: { T: string; lists: List[]; purposes: Record<string, string>; bucket: Bucket | null; onDone: (msg: string | null) => void }) {
  const [name, setName] = useState(bucket?.name ?? '');
  const [purpose, setPurpose] = useState(bucket?.purpose ?? 'upgrade');
  const [include, setInclude] = useState<string[]>(bucket?.include_lists ?? lists.filter(l => l.kind === 'customers').slice(0, 1).map(l => l.id));
  const [exclude, setExclude] = useState<string[]>(bucket?.exclude_lists ?? lists.filter(l => l.kind === 'exclude').map(l => l.id));
  const [rules, setRules] = useState<Rule[]>(bucket?.rules ?? []);
  const [holdout, setHoldout] = useState(bucket?.holdout_pct ?? 10);
  const [measure, setMeasure] = useState(bucket?.measure_list ?? '');
  const [preview, setPreview] = useState<{ candidates: number; excluded: number; people: number; holdout: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // attributes of the chosen lists, merged
  const attrs = useMemo(() => {
    const out: Record<string, AttributeSummary> = {};
    for (const l of lists.filter(x => include.includes(x.id))) for (const [k, v] of Object.entries(l.attributes ?? {})) {
      const prev = out[k];
      out[k] = prev ? { ...prev, filled: prev.filled + v.filled, numeric: prev.numeric && v.numeric, min: Math.min(prev.min ?? Infinity, v.min ?? Infinity), max: Math.max(prev.max ?? -Infinity, v.max ?? -Infinity), top: [...prev.top, ...v.top.filter(t => !prev.top.some(p => p[0] === t[0]))] } : v;
    }
    return out;
  }, [lists, include]);
  const body = () => ({ name, purpose, includeLists: include, excludeLists: exclude, rules: rules.filter(r => r.field && r.value), holdoutPct: holdout, measureList: measure || null });
  useEffect(() => { setPreview(null); }, [include, exclude, rules, holdout]);

  async function count() {
    setErr(null);
    try { setPreview(await api('POST', `${T}/audiences/buckets/preview`, body())); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not count.'); }
  }
  async function save() {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ stats: Stats }>(bucket ? 'PATCH' : 'POST', bucket ? `${T}/audiences/buckets/${bucket.id}` : `${T}/audiences/buckets`, body());
      onDone(`${name}: ${num(r.stats.targeted)} people to target, ${num(r.stats.holdout)} held back.`);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not save.'); } finally { setBusy(false); }
  }
  const toggle = (arr: string[], set: (v: string[]) => void, id: string) => set(arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id]);
  const fields = Object.keys(attrs);

  return (
    <div className="note-box" style={{ display: 'grid', gap: 14, background: 'var(--surface-2)', border: '1px solid var(--line)', marginBottom: 16 }}>
      <div className="grid-2" style={{ gap: 12 }}>
        <label className="field">Name<input className="input" value={name} onChange={e => setName(e.target.value)} maxLength={80} placeholder="Likely to upgrade" /></label>
        <label className="field">What it's for<select className="input" value={purpose} onChange={e => setPurpose(e.target.value)}>{Object.entries(purposes).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      </div>
      <div className="grid-2" style={{ gap: 12 }}>
        <fieldset className="aud-pick"><legend>Build it from</legend>
          {lists.filter(l => l.kind !== 'buyers').map(l => <label key={l.id}><input type="checkbox" checked={include.includes(l.id)} onChange={() => toggle(include, setInclude, l.id)} /> {l.name} <span className="muted small">{num(l.people)}</span></label>)}
        </fieldset>
        <fieldset className="aud-pick"><legend>Leave out anyone in</legend>
          {lists.filter(l => !include.includes(l.id) && l.kind !== 'buyers').map(l => <label key={l.id}><input type="checkbox" checked={exclude.includes(l.id)} onChange={() => toggle(exclude, setExclude, l.id)} /> {l.name} <span className="muted small">{num(l.people)}</span></label>)}
          {!lists.some(l => !include.includes(l.id) && l.kind !== 'buyers') && <span className="small muted">Upload a list of current customers to leave them out.</span>}
        </fieldset>
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        <b className="small">Only people where</b>
        {rules.map((r, i) => {
          const a = attrs[r.field];
          return (
            <div className="toolbar" key={i}>
              <select className="input" style={{ width: 'auto' }} value={r.field} onChange={e => setRules(rules.map((x, j) => j === i ? { ...x, field: e.target.value, value: '' } : x))}>{fields.map(f => <option key={f} value={f}>{f.replace(/_/g, ' ')}</option>)}</select>
              <select className="input" style={{ width: 'auto' }} value={r.op} onChange={e => setRules(rules.map((x, j) => j === i ? { ...x, op: e.target.value as RuleOp } : x))}>
                {(Object.keys(RULE_OPS) as RuleOp[]).filter(o => a?.numeric || (o !== 'at_least' && o !== 'at_most')).map(o => <option key={o} value={o}>{RULE_OPS[o]}</option>)}
              </select>
              {a && !a.numeric && r.op !== 'in' && r.op !== 'contains' && a.top.length ? (
                <select className="input" style={{ width: 'auto' }} value={r.value} onChange={e => setRules(rules.map((x, j) => j === i ? { ...x, value: e.target.value } : x))}>
                  <option value="">Choose…</option>{a.top.map(([v, n]) => <option key={v} value={v}>{v} ({num(n)})</option>)}
                </select>
              ) : <input className="input" style={{ width: 200 }} value={r.value} placeholder={a?.numeric ? `${a.min ?? ''} to ${a.max ?? ''}` : r.op === 'in' ? 'a, b, c' : 'value'} onChange={e => setRules(rules.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />}
              <button className="btn small link" onClick={() => setRules(rules.filter((_, j) => j !== i))}>Remove</button>
            </div>
          );
        })}
        {fields.length ? <div><button className="btn small" onClick={() => setRules([...rules, { field: fields[0]!, op: 'is', value: '' }])}>Add a rule</button></div> : <span className="small muted">The chosen lists have no attributes, so the bucket takes everyone in them.</span>}
      </div>
      <div className="grid-2" style={{ gap: 12 }}>
        <label className="field">Hold back, never targeted: {holdout}%<input type="range" min={0} max={50} step={5} value={holdout} onChange={e => setHoldout(Number(e.target.value))} /><span className="small muted" style={{ fontWeight: 400 }}>10% is usual. 0% means results can't be proved.</span></label>
        <label className="field">Measure against a list of buyers (optional)
          <select className="input" value={measure} onChange={e => setMeasure(e.target.value)}><option value="">Not yet</option>{lists.filter(l => l.kind === 'buyers').map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        </label>
      </div>
      {preview && <div className="small"><b>{num(preview.people - preview.holdout)}</b> people to target and about <b>{num(preview.holdout)}</b> held back, out of {num(preview.candidates)} who match{preview.excluded ? `; ${num(preview.excluded)} left out because they're in an exclusion list` : ''}.</div>}
      {err && <div className="error-box" role="alert">{err}</div>}
      <div className="toolbar">
        <button className="btn primary" onClick={save} disabled={busy || !name.trim() || !include.length}>{busy ? 'Saving…' : bucket ? 'Save and count' : 'Create bucket'}</button>
        <button className="btn" onClick={count} disabled={!include.length}>Count people</button>
        <button className="btn" onClick={() => onDone(null)}>Cancel</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- activation
const FORMAT_LABEL: Record<string, string> = { google: 'Google Customer Match', meta: 'Meta custom audience', plain: 'Plain hashed list' };

function Activate({ T, bucket, isDemo, chunkMax, onChanged, notify }: { T: string; bucket: Bucket; isDemo: boolean; chunkMax: number; onChanged: () => Promise<void>; notify: (m: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  async function pull(format: string, part: 'target' | 'holdout') {
    const first = await api<{ total: number; pages: number; header: string; csv: string; fileName: string }>('GET', `${T}/audiences/buckets/${bucket.id}/export?format=${format}&part=${part}&page=0`);
    const parts = [first.csv];
    for (let p = 1; p < first.pages; p++) parts.push((await api<{ csv: string }>('GET', `${T}/audiences/buckets/${bucket.id}/export?format=${format}&part=${part}&page=${p}`)).csv);
    return { ...first, rows: parts.filter(Boolean).join('\n') };
  }
  async function get(format: string, part: 'target' | 'holdout') {
    setBusy(`${format}:${part}`);
    try { const r = await pull(format, part); download(r.fileName, `${r.header}\n${r.rows}`); notify(`Downloaded ${num(r.total)} hashed ${part === 'holdout' ? 'holdout keys' : 'keys'}. The export is logged.`); await onChanged(); }
    catch (e) { notify(e instanceof ApiError ? e.message : 'The export failed.'); } finally { setBusy(null); }
  }
  /** Sample workspaces only: pretend a month passed, so the lift view can be seen. Clearly labelled. */
  async function simulate() {
    setBusy('sim');
    try {
      const [t, h] = await Promise.all([pull('plain', 'target'), pull('plain', 'holdout')]);
      const pick = (csv: string, everyN: number) => csv.split('\n').filter(Boolean).filter((_, i) => i % everyN === 0).map(l => { const [e, p] = l.split(','); return { ...(e ? { e } : {}), ...(p ? { p } : {}) }; });
      const rows = [...pick(t.rows, 11), ...pick(h.rows, 25)];
      const name = `Simulated buyers for ${bucket.name}`.slice(0, 80);
      const old = (await api<Data>('GET', `${T}/audiences`)).lists.find(l => l.name === name);
      if (old) await api('DELETE', `${T}/audiences/lists/${old.id}`);
      const l = await api<{ id: string }>('POST', `${T}/audiences/lists`, { name, kind: 'buyers', expiresDays: 30 });
      for (let i = 0; i < rows.length; i += chunkMax) await api('POST', `${T}/audiences/lists/${l.id}/rows`, { rows: rows.slice(i, i + chunkMax) });
      await api('POST', `${T}/audiences/lists/${l.id}/finish`);
      await api('PATCH', `${T}/audiences/buckets/${bucket.id}`, { name: bucket.name, purpose: bucket.purpose, includeLists: bucket.include_lists, excludeLists: bucket.exclude_lists, rules: bucket.rules, holdoutPct: bucket.holdout_pct, measureList: l.id });
      notify('Simulated a month of results (sample data only): about 9% of the targeted people and 4% of the held-back people bought.');
      await onChanged();
    } catch (e) { notify(e instanceof ApiError ? e.message : 'Could not simulate.'); } finally { setBusy(null); }
  }
  const b = (f: string, p: 'target' | 'holdout', label: string) => <button className="btn small" disabled={!!busy} onClick={() => get(f, p)}>{busy === `${f}:${p}` ? 'Preparing…' : label}</button>;
  return (
    <div className="aud-activate">
      <div>
        <b>Reach these {num(bucket.stats?.targeted ?? 0)} people</b>
        <p className="small muted">Hashed keys for the people to target. The holdout is never in these files.</p>
        <div className="toolbar">{b('google', 'target', 'For DV360 / Google Ads (Customer Match)')}{b('meta', 'target', 'For Meta')}{b('plain', 'target', 'For an SSP or TeCreo deal')}</div>
        <p className="small muted" style={{ marginTop: 8 }}>Next: pushing straight into your DV360 account, once Google approves Vtology's API access. TeCreo receives a segment ID made from this file by the SSP, never the file itself.</p>
      </div>
      <div>
        <b>Measure results</b>
        <p className="small muted">The {num(bucket.stats?.holdout ?? 0)} held-back people, as a plain hashed list, only for a clean room or measurement partner. Never upload it for targeting.</p>
        <div className="toolbar">{b('plain', 'holdout', 'Holdout list (measurement only)')}{isDemo && <button className="btn small" disabled={!!busy} onClick={simulate}>{busy === 'sim' ? 'Simulating…' : 'Simulate a month of results (sample)'}</button>}</div>
        <p className="small muted" style={{ marginTop: 8 }}>After the campaign, upload a list of who bought (as "Buyers") and choose it under the bucket's Edit: Vtology compares targeted with held back.</p>
      </div>
    </div>
  );
}
