/**
 * Audiences: hashed lists a brand shares with us, and the rules that turn them into buckets.
 *
 * Match keys follow the industry standard, so a list can be matched with Google Customer Match,
 * Meta, SSPs and clean rooms:
 * - email: trimmed and lowercased, then SHA-256, as 64 lowercase hex characters
 * - phone: E.164 (+91 and 10 digits for India), then SHA-256
 * These are different from Vtology's internal salted hashes (hashing.ts), which never leave a workspace.
 *
 * Runs in the browser too: a raw file is hashed on the brand's own computer before upload.
 */
import { normalizeEmail, normalizePhone } from './hashing';

export async function sha256Hex(value: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function standardEmail(raw: string | null | undefined): string | null { return normalizeEmail(raw); }
/** E.164: Indian mobiles as +91XXXXXXXXXX; other numbers already written with + and a country code are kept. */
export function standardPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  const india = normalizePhone(s);
  if (india) return `+91${india}`;
  const d = s.replace(/[^\d+]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(d) ? d : null;
}
export async function emailMatchKey(raw: string | null | undefined) { const e = standardEmail(raw); return e ? sha256Hex(e) : null; }
export async function phoneMatchKey(raw: string | null | undefined) { const p = standardPhone(raw); return p ? sha256Hex(p) : null; }

export type ValueKind = 'sha256' | 'md5' | 'sha1' | 'email' | 'phone' | 'empty' | 'other';
export function valueKind(v: string | null | undefined): ValueKind {
  const s = String(v ?? '').trim();
  if (!s) return 'empty';
  if (/^[0-9a-f]{64}$/i.test(s)) return 'sha256';
  if (/^[0-9a-f]{40}$/i.test(s)) return 'sha1';
  if (/^[0-9a-f]{32}$/i.test(s)) return 'md5';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'email';
  if (/^\+?[\d\s()-]{10,16}$/.test(s) && s.replace(/\D/g, '').length >= 10) return 'phone';
  return 'other';
}

export type ColumnRole = 'email_hash' | 'phone_hash' | 'email_raw' | 'phone_raw' | 'attribute' | 'ignore';
export interface ColumnPlan { column: string; role: ColumnRole; field: string; kinds: Partial<Record<ValueKind, number>>; problem?: string }

const EMAIL_NAME = /(^|_)(e-?mail|em|hashed_?email|email_?sha256|sha256_?email)(_|$)/i;
const PHONE_NAME = /(^|_)(phone|mobile|ph|msisdn|hashed_?phone|phone_?sha256|sha256_?phone)(_|$)/i;
const fieldName = (c: string) => c.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'field';

/**
 * Work out what each column of an uploaded file holds, from its name and a sample of its values.
 * A column of emails or phone numbers that is not hashed is marked raw (to be hashed in the browser);
 * MD5 or SHA-1 hashes are refused, because no partner can match them.
 */
export function planColumns(header: string[], sample: Record<string, string>[]): ColumnPlan[] {
  const plans: ColumnPlan[] = header.map(column => {
    const kinds: Partial<Record<ValueKind, number>> = {};
    for (const r of sample) { const k = valueKind(r[column]); kinds[k] = (kinds[k] ?? 0) + 1; }
    const filled = sample.length - (kinds.empty ?? 0);
    const share = (k: ValueKind) => filled ? (kinds[k] ?? 0) / filled : 0;
    const byName = EMAIL_NAME.test(fieldName(column)) ? 'email' : PHONE_NAME.test(fieldName(column)) ? 'phone' : null;
    const plan: ColumnPlan = { column, role: 'attribute', field: fieldName(column), kinds };
    if (!filled) plan.role = 'ignore';
    else if (share('sha256') > 0.9) plan.role = byName === 'phone' ? 'phone_hash' : 'email_hash';
    else if (share('md5') + share('sha1') > 0.5) { plan.role = 'ignore'; plan.problem = `${column} looks hashed with ${share('md5') > share('sha1') ? 'MD5' : 'SHA-1'}. Partners match only SHA-256, so this column can't be used: hash the original values with SHA-256 instead.`; }
    else if (share('email') > 0.5) plan.role = 'email_raw';
    else if (share('phone') > 0.5 && byName !== null) plan.role = 'phone_raw';
    return plan;
  });
  // two SHA-256 columns and only one named: the other one is the other kind
  const hashes = plans.filter(p => p.role === 'email_hash' || p.role === 'phone_hash');
  if (hashes.length === 2 && hashes.every(h => h.role === 'email_hash')) {
    const phoneish = hashes.find(h => PHONE_NAME.test(h.field)) ?? hashes[1]!;
    phoneish.role = 'phone_hash';
  }
  // only one email and one phone column count; extras are left out
  for (const role of ['email_hash', 'phone_hash', 'email_raw', 'phone_raw'] as const) {
    plans.filter(p => p.role === role).slice(1).forEach(p => { p.role = 'ignore'; p.problem = `Only one ${role.startsWith('email') ? 'email' : 'phone'} column is used; ${p.column} is left out.`; });
  }
  if (plans.some(p => p.role === 'email_hash') && plans.some(p => p.role === 'email_raw')) plans.filter(p => p.role === 'email_raw').forEach(p => { p.role = 'ignore'; });
  if (plans.some(p => p.role === 'phone_hash') && plans.some(p => p.role === 'phone_raw')) plans.filter(p => p.role === 'phone_raw').forEach(p => { p.role = 'ignore'; });
  // attributes never carry identifiers in the clear
  for (const p of plans) if (p.role === 'attribute' && ((p.kinds.email ?? 0) + (p.kinds.phone ?? 0)) > 0) {
    p.role = 'ignore'; p.problem = `${p.column} holds emails or phone numbers, so it is left out. Only one email and one phone column are used, and they are hashed.`;
  }
  return plans.slice(0, 64).map((p, i) => (i >= 24 && p.role === 'attribute' ? { ...p, role: 'ignore' as const, problem: 'At most 24 attribute columns are kept.' } : p));
}

/** One row ready to send: hashes plus a few plain attributes (no identifiers). */
export interface AudienceRow { e?: string; p?: string; a?: Record<string, string> }

/** Turn parsed rows into upload rows following a plan; raw emails and phones are hashed here. */
export async function toAudienceRows(rows: Record<string, string>[], plans: ColumnPlan[]): Promise<{ rows: AudienceRow[]; rejected: number }> {
  const col = (r: ColumnRole) => plans.find(p => p.role === r)?.column;
  const eh = col('email_hash'), ph = col('phone_hash'), er = col('email_raw'), pr = col('phone_raw');
  const attrs = plans.filter(p => p.role === 'attribute');
  const out: AudienceRow[] = [];
  let rejected = 0;
  for (const r of rows) {
    const e = eh ? (valueKind(r[eh]) === 'sha256' ? r[eh]!.trim().toLowerCase() : null) : er ? await emailMatchKey(r[er]) : null;
    const p = ph ? (valueKind(r[ph]) === 'sha256' ? r[ph]!.trim().toLowerCase() : null) : pr ? await phoneMatchKey(r[pr]) : null;
    if (!e && !p) { rejected++; continue; }
    const a: Record<string, string> = {};
    for (const x of attrs) { const v = String(r[x.column] ?? '').trim(); if (v) a[x.field] = v.slice(0, 80); }
    out.push({ ...(e ? { e } : {}), ...(p ? { p } : {}), ...(Object.keys(a).length ? { a } : {}) });
  }
  return { rows: out, rejected };
}

// ---------------------------------------------------------------- bucket rules
export type RuleOp = 'is' | 'is_not' | 'in' | 'at_least' | 'at_most' | 'contains';
export interface BucketRule { field: string; op: RuleOp; value: string }
export const RULE_OPS: Record<RuleOp, string> = { is: 'is', is_not: 'is not', in: 'is one of', at_least: 'is at least', at_most: 'is at most', contains: 'contains' };
export const BUCKET_PURPOSES = {
  target: 'Find new customers like these',
  upgrade: 'Likely to upgrade or buy more',
  winback: 'Win back lapsed customers',
  retention: 'At risk of leaving (for your own team)',
  exclude: 'Never target (already customers)',
  lookalike_seed: 'Seed for lookalikes',
} as const;
export type BucketPurpose = keyof typeof BUCKET_PURPOSES;

export function cleanRules(raw: unknown): BucketRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 12).flatMap(r => {
    const x = r as Record<string, unknown>;
    const field = typeof x.field === 'string' ? fieldName(x.field) : '';
    const op = typeof x.op === 'string' && x.op in RULE_OPS ? x.op as RuleOp : null;
    const value = typeof x.value === 'string' ? x.value.trim().slice(0, 200) : typeof x.value === 'number' ? String(x.value) : '';
    if (!field || !op || !value) return [];
    if ((op === 'at_least' || op === 'at_most') && !/^-?\d+(\.\d+)?$/.test(value)) return [];
    return [{ field, op, value }];
  });
}

/** In plain words, for screens and exports: "status is free, and listening is rising". */
export function describeRules(rules: BucketRule[]): string {
  return rules.map(r => `${r.field.replace(/_/g, ' ')} ${RULE_OPS[r.op]} ${r.value}`).join(', and ');
}

/** What the bucket builder knows about one attribute of a list. */
export interface AttributeSummary { filled: number; distinct: number; numeric: boolean; min?: number; max?: number; top: [string, number][] }
