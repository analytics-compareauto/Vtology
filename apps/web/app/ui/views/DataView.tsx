'use client';
import { useState } from 'react';
import { CANONICAL, parseCsv, type Entity } from '@vtology/core';
import type { WorkspaceData } from '../Dashboard';
import { api, ApiError, type ImportResult, type PipelineStats } from '../api';
import { ago, num } from '../format';

const ENTITIES: { id: Entity; label: string; hint: string }[] = [
  { id: 'partner', label: 'Partners', hint: 'Dealers, branches, DSAs or distributors. Import these first.' },
  { id: 'campaign', label: 'Campaigns', hint: 'Campaigns with their channel and spend.' },
  { id: 'lead', label: 'Leads and customers', hint: 'People from your CRM, website or walk-in registers.' },
  { id: 'journey_event', label: 'Journey events', hint: 'Stage changes per inquiry or application, with dates.' },
  { id: 'transaction', label: 'Sales', hint: 'Invoices, disbursals or bills from partner systems.' },
  { id: 'consent', label: 'Consents', hint: 'Marketing consents per person and channel.' },
];

const FIELD_LABEL: Record<string, string> = {
  external_id: 'Lead ID', name: 'Name', phone: 'Mobile number', email: 'Email', gov_id: 'PAN or other ID', pincode: 'PIN code', city: 'City',
  created_at: 'Created on', book_code: 'RM book code', is_existing_customer: 'Existing customer (Y/N)', journey_ref: 'Inquiry / application ID',
  stage: 'Stage or status', occurred_at: 'Date', person_ref: 'Lead ID', partner_code: 'Partner code', campaign_code: 'Campaign code',
  crm_converted: 'Marked won in CRM (Y/N)', value_inr: 'Amount (₹)', external_ref: 'Invoice / reference', evidence: 'Evidence', external_code: 'Code',
  channel: 'Channel', start_date: 'Start date', end_date: 'End date', spend_inr: 'Spend (₹)', platform_reported_conversions: 'Conversions reported by platform',
  partner_type: 'Partner type', purpose: 'Purpose', granted: 'Granted (Y/N)', recorded_at: 'Recorded on', expires_at: 'Expires on',
};
const SYNONYMS: Record<string, string[]> = {
  external_id: ['lead id', 'lead', 'id', 'lead no', 'customer id'], name: ['name', 'customer name', 'customer', 'full name'],
  phone: ['mobile', 'phone', 'mobile number', 'phone number', 'contact', 'contact number'], email: ['email', 'e-mail', 'email id'],
  gov_id: ['pan', 'pan number', 'aadhaar', 'id number'], pincode: ['pin', 'pincode', 'pin code', 'zip', 'postal code'], city: ['city', 'town'],
  created_at: ['created', 'created on', 'created at', 'date', 'lead date'], book_code: ['book', 'book code', 'rm', 'rm code'],
  is_existing_customer: ['existing customer', 'existing'], journey_ref: ['enquiry', 'enquiry id', 'inquiry', 'journey', 'opportunity', 'application', 'application id'],
  stage: ['status', 'stage'], occurred_at: ['date', 'event date', 'updated on', 'status date'], person_ref: ['lead', 'lead id', 'customer id'],
  partner_code: ['partner', 'dealer', 'dealer code', 'branch', 'dsa', 'distributor', 'partner code'], campaign_code: ['campaign', 'campaign id', 'campaign code', 'utm campaign'],
  crm_converted: ['crm won', 'won', 'converted', 'crm converted'], value_inr: ['amount', 'value', 'price', 'invoice amount', 'loan amount'],
  external_ref: ['invoice', 'ref', 'reference', 'bill', 'bill no', 'loan account', 'lan'], external_code: ['code', 'campaign id', 'id'],
  channel: ['channel', 'platform', 'source'], start_date: ['start', 'start date'], end_date: ['end', 'end date'], spend_inr: ['spend', 'cost', 'spend (₹)', 'cost (₹)'],
  platform_reported_conversions: ['platform conversions', 'conversions'], partner_type: ['type', 'partner type'], purpose: ['purpose'], granted: ['granted', 'consent'],
  recorded_at: ['recorded', 'recorded on', 'date'], expires_at: ['expires', 'expiry'],
};
const TRANSFORM: Record<string, 'date' | 'number' | 'bool'> = {
  created_at: 'date', occurred_at: 'date', start_date: 'date', end_date: 'date', recorded_at: 'date', expires_at: 'date',
  value_inr: 'number', spend_inr: 'number', platform_reported_conversions: 'number', crm_converted: 'bool', is_existing_customer: 'bool', granted: 'bool',
};

function guess(field: string, columns: string[], taken: Set<string>): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9₹ ]/g, ' ').replace(/\s+/g, ' ').trim();
  const cols = columns.filter(c => !taken.has(c));
  for (const syn of SYNONYMS[field] ?? []) { const hit = cols.find(c => norm(c) === norm(syn)); if (hit) return hit; }
  for (const syn of SYNONYMS[field] ?? []) { const hit = cols.find(c => norm(c).includes(norm(syn))); if (hit) return hit; }
  return '';
}

export function DataView({ data, workspaceId, reload, notify }: { data: WorkspaceData; workspaceId: string; reload: () => Promise<void>; notify: (m: string) => void }) {
  const { me } = data;
  const canImport = me.role === 'data_steward' || me.role === 'marketing_head';
  const canRun = canImport || me.role === 'sales_ops';
  const [running, setRunning] = useState(false);
  const [entity, setEntity] = useState<Entity>('lead');
  const [file, setFile] = useState<{ name: string; text: string; columns: string[]; rows: number } | null>(null);
  const [map, setMap] = useState<Record<string, string>>({});
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stats = me.lastRun?.stats as PipelineStats | undefined;
  const spec = CANONICAL[entity];

  async function run() {
    setRunning(true);
    try {
      const r = await api<{ stats: PipelineStats }>('POST', `/tenants/${workspaceId}/pipeline/run`);
      notify(`Matching finished: ${num(r.stats.parties)} customers, ${num(r.stats.findings)} findings.`);
      await reload();
    } catch (e) { notify(e instanceof ApiError ? e.message : 'Matching failed.'); }
    finally { setRunning(false); }
  }

  function remap(cols: string[], ent: Entity) {
    const taken = new Set<string>(), next: Record<string, string> = {};
    for (const f of [...CANONICAL[ent].required, ...CANONICAL[ent].optional]) { const g = guess(f, cols, taken); if (g) { next[f] = g; taken.add(g); } }
    setMap(next);
  }

  async function pick(f: File | undefined) {
    setResult(null); setError(null);
    if (!f) { setFile(null); return; }
    if (f.size > 15_000_000) { setError('That file is larger than 15 MB. Split it into smaller files.'); return; }
    const text = await f.text();
    const rows = parseCsv(text);
    const columns = rows.length ? Object.keys(rows[0]!) : [];
    if (!columns.length) { setError('No rows found. The first line of the file should hold the column names.'); return; }
    setFile({ name: f.name, text, columns, rows: rows.length });
    if (!source) setSource(f.name.replace(/\.[^.]+$/, ''));
    remap(columns, entity);
  }

  async function submit() {
    if (!file) return;
    const missing = spec.required.filter(f => !map[f]);
    if (missing.length) { setError(`Choose a column for: ${missing.map(f => FIELD_LABEL[f] ?? f).join(', ')}.`); return; }
    setBusy(true); setError(null);
    const fields: Record<string, string | { column: string; transform: string }> = {};
    for (const [f, col] of Object.entries(map)) if (col) fields[f] = TRANSFORM[f] ? { column: col, transform: TRANSFORM[f]! } : col;
    try {
      const r = await api<ImportResult>('POST', `/tenants/${workspaceId}/imports`, { mapping: { entity, sourceSystem: source || 'Upload', fields }, csv: file.text, fileName: file.name });
      setResult(r);
      notify(`Imported ${num(r.imported)} of ${num(r.rowCount)} rows. Run matching to update findings.`);
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Import failed.'); }
    finally { setBusy(false); }
  }

  return (
    <>
      <section style={{ display: 'grid', gap: 12 }}>
        <div className="section-title"><h2>Matching</h2>{canRun && <button className="btn primary" onClick={run} disabled={running}>{running ? 'Matching…' : 'Run matching again'}</button>}</div>
        {running && <div className="progress" />}
        {stats ? (
          <p style={{ maxWidth: '72ch' }}>
            Last run {ago(me.lastRun!.finishedAt)}: <b>{num(stats.records)}</b> records from your systems resolved to <b>{num(stats.parties)}</b> customers.{' '}
            {stats.heldForReview > 0 && <><b>{num(stats.heldForReview)}</b> records share a phone or email with too many different names, so they were held back instead of merged. </>}
            {stats.journeys !== undefined
              ? <><b>{num(stats.journeysWithCustomer ?? 0)}</b> of {num(stats.journeys)} journeys are linked to a customer{stats.journeysLinked > 0 ? ` (${num(stats.journeysLinked)} newly linked in this run)` : ''}, and </>
              : <><b>{num(stats.journeysLinked)}</b> journeys newly linked to a customer, and </>}<b>{num(stats.findings)}</b> findings raised.
          </p>
        ) : <p className="muted">Matching hasn’t run yet. Import your data, then run it to resolve customers and raise findings.</p>}
      </section>

      <section style={{ display: 'grid', gap: 16 }}>
        <div>
          <h2>Import a file</h2>
          <p className="muted small" style={{ marginTop: 4, maxWidth: '72ch' }}>Upload a CSV export from any system. Phone numbers, emails and IDs are scrambled (hashed) on arrival; the raw values are never stored.</p>
        </div>
        {!canImport ? <div className="empty">Only data stewards and marketing heads can import data.</div> : (
          <>
            <div className="choices" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', display: 'grid', maxHeight: 'none' }}>
              {ENTITIES.map(e => (
                <label className="choice" key={e.id}>
                  <span><b>{e.label}</b><br /><span className="muted small">{e.hint}</span></span>
                  <input type="radio" name="entity" checked={entity === e.id} onChange={() => { setEntity(e.id); setResult(null); if (file) remap(file.columns, e.id); }} />
                </label>
              ))}
            </div>
            <label className="field">CSV file
              <input className="input" type="file" accept=".csv,text/csv" onChange={e => pick(e.target.files?.[0])} />
            </label>
            {file && (
              <div style={{ display: 'grid', gap: 12 }}>
                <p className="small">{file.name}: {num(file.rows)} rows, {file.columns.length} columns. Check which column holds each field.</p>
                <label className="field" style={{ maxWidth: 420 }}><span>Source system name <span className="muted small" style={{ fontWeight: 400 }}>(for example Dealer DMS or Salesforce)</span></span>
                  <input className="input" value={source} onChange={e => setSource(e.target.value)} />
                </label>
                <div className="map-grid">
                  {[...spec.required, ...spec.optional].map(f => (
                    <div key={f} style={{ display: 'contents' }}>
                      <span className="small">{FIELD_LABEL[f] ?? f}{spec.required.includes(f) ? <b title="Required"> *</b> : <span className="muted"> (optional)</span>}</span>
                      <select className="input" value={map[f] ?? ''} onChange={e => setMap(m => ({ ...m, [f]: e.target.value }))} aria-label={FIELD_LABEL[f] ?? f}>
                        <option value="">Not in this file</option>
                        {file.columns.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
                {error && <div className="error-box" role="alert">{error}</div>}
                <div><button className="btn primary" onClick={submit} disabled={busy}>{busy ? 'Importing…' : `Import ${num(file.rows)} rows`}</button></div>
              </div>
            )}
            {!file && error && <div className="error-box" role="alert">{error}</div>}
            {result && (
              <div style={{ display: 'grid', gap: 10 }}>
                <div className="note-box">Imported {num(result.imported)} of {num(result.rowCount)} rows.{result.errors.length ? ` ${result.errors.length} rows need attention:` : ' No problems found.'} Run matching to update customers and findings.</div>
                {result.errors.length > 0 && (
                  <div className="table-wrap" style={{ maxHeight: 280, overflowY: 'auto' }}>
                    <table><thead><tr><th className="num">Row</th><th>Problem</th></tr></thead>
                      <tbody>{result.errors.slice(0, 200).map((e, i) => <tr key={i}><td className="num">{e.row}</td><td>{e.message}</td></tr>)}</tbody></table>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </>
  );
}
