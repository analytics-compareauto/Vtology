import { jwtVerify } from 'jose';
import type { Industry, RoleCode } from '@vtology/core';
import type { Db } from './db';

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

export interface Deps {
  db: Db;
  /** Supabase JWT secret (Project settings → API). */
  jwtSecret: string;
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
}

/** Verify the Supabase access token and return the user id. */
export async function authenticate(req: Request, jwtSecret: string): Promise<string> {
  const h = req.headers.get('authorization') ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) throw new HttpError(401, 'Sign in first: missing access token.');
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(jwtSecret), { algorithms: ['HS256'] });
    if (!payload.sub) throw new Error('no subject');
    return payload.sub;
  } catch {
    throw new HttpError(401, 'Your session is invalid or has expired. Sign in again.');
  }
}

export async function loadContext(deps: Deps, userId: string, tenantId: string): Promise<Ctx> {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new HttpError(404, 'Tenant not found.');
  const rows = await deps.db.admin.query<{ role: RoleCode; partner_id: string | null; book_code: string | null; industry: Industry; phone_salt: string }>(
    `select m.role, m.partner_id, m.book_code, t.industry, t.phone_salt
       from vt.memberships m join vt.tenants t on t.id = m.tenant_id
      where m.tenant_id = $1 and m.user_id = $2`, [tenantId, userId]);
  const m = rows[0];
  if (!m) throw new HttpError(403, 'You are not a member of this tenant.');
  return { db: deps.db, now: deps.now ? deps.now() : new Date(), userId, tenantId, industry: m.industry, salt: m.phone_salt, role: m.role, partnerId: m.partner_id, bookCode: m.book_code };
}

export function requireRole(ctx: Ctx, roles: RoleCode[], what: string): void {
  if (!roles.includes(ctx.role)) throw new HttpError(403, `${what} needs one of these roles: ${roles.join(', ')}.`);
}
