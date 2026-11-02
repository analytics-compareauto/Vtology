import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Industry, RoleCode } from '@vtology/core';
import type { Db } from './db';
import { userFromAuthServer, type AuthConfig } from './auth';

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

export interface Deps {
  db: Db;
  /** Legacy Supabase JWT secret, for projects that sign tokens with HS256. */
  jwtSecret?: string;
  /** Project URL (https://<ref>.supabase.co), for projects that sign tokens with JWT signing keys. */
  supabaseUrl?: string;
  /** Supabase publishable key: used to sign people in and, if needed, to verify tokens with Supabase Auth. */
  supabaseKey?: string;
  /** Local demo mode only (no Supabase): secret for self-issued tokens. */
  localSecret?: string;
  /** Encrypts stored platform access keys and signs connection requests (VTOLOGY_SECRET_KEY). */
  secretKey?: string;
  /** Social platform apps (Meta, Google) and the public address the platforms send people back to. */
  social?: import('./social').SocialConfig;
  /** Shared secret for the daily scheduled job (Vercel sends it as a Bearer token). */
  cronSecret?: string;
  /** How long one sync may spend fetching per-post insights before saving what it has (default 35 s). */
  syncBudgetMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface Ctx {
  db: Db;
  now: Date;
  userId: string;
  tenantId: string;
  industry: Industry;
  salt: string;
  role: RoleCode;
  partnerId: string | null;
  bookCode: string | null;
  tenantName: string;
  isDemo: boolean;
}

const jwksCache = new Map<string, JWTVerifyGetKey>();
function jwks(supabaseUrl: string): JWTVerifyGetKey {
  const url = `${supabaseUrl.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`;
  let set = jwksCache.get(url);
  if (!set) { set = createRemoteJWKSet(new URL(url)); jwksCache.set(url, set); }
  return set;
}

/** Verify the Supabase access token and return the user id. Supports both the legacy
 *  shared secret (HS256) and Supabase JWT signing keys (ES256/RS256 via the project JWKS). */
export async function authenticate(req: Request, deps: Pick<Deps, 'jwtSecret' | 'supabaseUrl' | 'supabaseKey' | 'localSecret' | 'fetch'>): Promise<string> {
  const h = req.headers.get('authorization') ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) throw new HttpError(401, 'Sign in first: missing access token.');
  try {
    const { alg } = decodeProtectedHeader(token);
    let payload;
    if (alg === 'HS256') {
      const secret = deps.localSecret ?? deps.jwtSecret;
      if (!secret) return await userFromAuthServer(deps as AuthConfig, token);
      ({ payload } = await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ['HS256'] }));
      if (payload.kind === 'refresh') throw new Error('refresh token used as access token');
    } else {
      if (!deps.supabaseUrl) throw new Error('asymmetric token but no Supabase URL configured');
      ({ payload } = await jwtVerify(token, jwks(deps.supabaseUrl), { algorithms: ['ES256', 'RS256'] }));
    }
    if (!payload.sub) throw new Error('no subject');
    return payload.sub;
  } catch {
    throw new HttpError(401, 'Your session is invalid or has expired. Sign in again.');
  }
}

export async function loadContext(deps: Deps, userId: string, tenantId: string): Promise<Ctx> {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new HttpError(404, 'Tenant not found.');
  const rows = await deps.db.admin.query<{ role: RoleCode; partner_id: string | null; book_code: string | null; industry: Industry; phone_salt: string; name: string; is_demo: boolean }>(
    `select m.role, m.partner_id, m.book_code, t.industry, t.phone_salt, t.name, t.is_demo
       from vt.memberships m join vt.tenants t on t.id = m.tenant_id
      where m.tenant_id = $1 and m.user_id = $2`, [tenantId, userId]);
  const m = rows[0];
  if (!m) throw new HttpError(403, 'You are not a member of this tenant.');
  return { db: deps.db, now: deps.now ? deps.now() : new Date(), userId, tenantId, industry: m.industry, salt: m.phone_salt, role: m.role, partnerId: m.partner_id, bookCode: m.book_code, tenantName: m.name, isDemo: m.is_demo };
}

export function requireRole(ctx: Ctx, roles: RoleCode[], what: string): void {
  if (!roles.includes(ctx.role)) throw new HttpError(403, `${what} needs one of these roles: ${roles.join(', ')}.`);
}
