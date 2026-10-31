'use client';
/** Browser-side API client: keeps the session, refreshes it before it expires, retries once on 401. */
import type { Industry, RoleCode } from '@vtology/core';

export interface Session { accessToken: string; refreshToken: string; expiresAt: number; user: { id: string; email: string | null } }
export interface Workspace { id: string; name: string; industry: Industry; isDemo: boolean; role: RoleCode; createdAt: string }
export interface Me { userId: string; tenantId: string; tenantName: string; isDemo: boolean; industry: Industry; role: RoleCode; partnerId: string | null; partner: string | null; bookCode: string | null; lastRun: { finishedAt: string; stats: PipelineStats } | null }
export interface PipelineStats { records: number; parties: number; newParties: number; heldForReview: number; reviewItems: number; journeysLinked: number; journeysWithCustomer?: number; journeys?: number; findings: number }
export interface Journey { id: string; externalRef: string; party: string | null; partyId: string | null; partner: string | null; partnerId: string | null; stage: string; stageIndex: number; daysIdle: number; slaDays: number; stalled: boolean; converted: boolean; edited: boolean }
export interface PartnerScore { partnerId: string; name: string; journeys: number; stalled: number; stalledShare: number }
export interface Finding { id: string; rule: string; severity: 'high' | 'medium' | 'info'; entity_kind: string; entity_ref: string; partner_id: string | null; detail: string; value_inr: string | null; status: string; detected_at: string }
export interface Rule { label: string; pass: boolean }
export interface ActionRun { id: string; type_code: string; object_kind: string; object_id: string; object_label: string; requested_role: RoleCode; reason: string | null; rules: Rule[]; effects: string[]; status: 'done' | 'awaiting_approval' | 'rejected' | 'blocked'; approver_role: RoleCode | null; decided_role: RoleCode | null; decided_at: string | null; created_at: string }
export interface ActionResult { id: string; status: ActionRun['status']; rules: Rule[]; effects: string[]; approverRole: RoleCode | null; objectLabel: string }
export interface ImportResult { batchId: string; entity: string; rowCount: number; imported: number; errors: { row: number; field: string; message: string }[] }

const KEY = 'vtology.session';

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

export function loadSession(): Session | null {
  try { const raw = localStorage.getItem(KEY); return raw ? (JSON.parse(raw) as Session) : null; } catch { return null; }
}
export function saveSession(s: Session | null) {
  try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch { /* private mode: session lives in memory only */ }
  current = s;
}

let current: Session | null = null;
let refreshing: Promise<Session | null> | null = null;
let onSignedOut: () => void = () => {};
export function setSignedOutHandler(fn: () => void) { onSignedOut = fn; }

async function raw<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `Request failed (${res.status})`, (data as { details?: unknown }).details);
  return data as T;
}

async function refresh(): Promise<Session | null> {
  const s = current ?? loadSession();
  if (!s) return null;
  refreshing ??= raw<Session>('POST', '/auth/refresh', { refreshToken: s.refreshToken })
    .then(n => { saveSession(n); return n; })
    .catch(() => { saveSession(null); onSignedOut(); return null; })
    .finally(() => { refreshing = null; });
  return refreshing;
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let s = current ?? loadSession();
  if (s && s.expiresAt - 60 < Date.now() / 1000) s = await refresh();
  if (!s) { onSignedOut(); throw new ApiError(401, 'Sign in again.'); }
  try {
    return await raw<T>(method, path, body, s.accessToken);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      const n = await refresh();
      if (n) return raw<T>(method, path, body, n.accessToken);
    }
    throw e;
  }
}

export const signIn = (email: string, password: string) => raw<Session>('POST', '/auth/login', { email, password }).then(s => { saveSession(s); return s; });
export const authConfig = () => raw<{ mode: 'local' | 'supabase'; ready: boolean }>('GET', '/auth/config');
