/**
 * Sign-in through Supabase Auth. The browser talks only to our API; the API forwards to Supabase
 * Auth with the project's publishable key, so no Supabase keys are needed in the browser.
 * Local demo mode (no Supabase) signs its own short-lived tokens instead.
 */
import { SignJWT } from 'jose';
import { createHash } from 'node:crypto';
import { HttpError } from './context';

export interface AuthConfig {
  supabaseUrl?: string;
  /** Supabase publishable (or legacy anon) key. */
  supabaseKey?: string;
  /** Local demo mode: any email signs in with the password "demo"; tokens are signed with this secret. */
  localSecret?: string;
  fetch?: typeof fetch;
}

export interface Session { accessToken: string; refreshToken: string; expiresAt: number; user: { id: string; email: string | null } }

function base(cfg: AuthConfig): { url: string; key: string; f: typeof fetch } {
  if (!cfg.supabaseUrl || !cfg.supabaseKey) throw new HttpError(503, 'Sign-in is not set up yet: add SUPABASE_PUBLISHABLE_KEY in Vercel and redeploy.');
  return { url: cfg.supabaseUrl.replace(/\/$/, ''), key: cfg.supabaseKey, f: cfg.fetch ?? fetch };
}

type GoTrueSession = { access_token: string; refresh_token: string; expires_at?: number; expires_in?: number; user?: { id: string; email?: string } };
const toSession = (s: GoTrueSession): Session => ({
  accessToken: s.access_token, refreshToken: s.refresh_token,
  expiresAt: s.expires_at ?? Math.floor(Date.now() / 1000) + (s.expires_in ?? 3600),
  user: { id: s.user?.id ?? '', email: s.user?.email ?? null },
});

async function token(cfg: AuthConfig, grant: 'password' | 'refresh_token', body: unknown): Promise<Session> {
  const { url, key, f } = base(cfg);
  const res = await f(`${url}/auth/v1/token?grant_type=${grant}`, { method: 'POST', headers: { apikey: key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as GoTrueSession & { error_code?: string; msg?: string; error_description?: string; message?: string };
  if (!res.ok) {
    const why = `${data.error_code ?? ''} ${data.msg ?? data.error_description ?? data.message ?? ''}`.toLowerCase();
    if (why.includes('not confirmed')) throw new HttpError(401, 'This email has not been confirmed yet. Confirm it in Supabase (Authentication → Users) or from the confirmation email.');
    if (why.includes('invalid api key') || res.status === 401 && why.includes('api key')) throw new HttpError(503, 'Sign-in is misconfigured: SUPABASE_PUBLISHABLE_KEY in Vercel is not this project’s key.');
    if (grant === 'refresh_token') throw new HttpError(401, 'Your session has expired. Sign in again.');
    if (res.status === 429) throw new HttpError(429, 'Too many sign-in attempts. Wait a minute and try again.');
    throw new HttpError(401, 'Wrong email or password.');
  }
  return toSession(data);
}

const localUserId = (email: string) => {
  const h = createHash('sha256').update(`vtology-local:${email.trim().toLowerCase()}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

async function localSession(secret: string, email: string): Promise<Session> {
  const id = localUserId(email);
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sign = (kind: string, e: number) => new SignJWT({ role: 'authenticated', email, kind }).setProtectedHeader({ alg: 'HS256' }).setSubject(id).setIssuedAt().setExpirationTime(e).sign(new TextEncoder().encode(secret));
  return { accessToken: await sign('access', exp), refreshToken: await sign('refresh', exp + 7 * 86400), expiresAt: exp, user: { id, email } };
}

export async function signIn(cfg: AuthConfig, email: string, password: string): Promise<Session> {
  if (cfg.localSecret) {
    if (password !== 'demo') throw new HttpError(401, 'Local demo mode: use any email with the password "demo".');
    return localSession(cfg.localSecret, email);
  }
  return token(cfg, 'password', { email, password });
}

export async function refreshSession(cfg: AuthConfig, refreshToken: string): Promise<Session> {
  if (cfg.localSecret) {
    const { jwtVerify } = await import('jose');
    try {
      const { payload } = await jwtVerify(refreshToken, new TextEncoder().encode(cfg.localSecret), { algorithms: ['HS256'] });
      if (payload.kind !== 'refresh') throw new Error('not a refresh token');
      return localSession(cfg.localSecret, String(payload.email));
    } catch { throw new HttpError(401, 'Your session has expired. Sign in again.'); }
  }
  return token(cfg, 'refresh_token', { refresh_token: refreshToken });
}

const verified = new Map<string, { sub: string; until: number }>();
/** Ask Supabase Auth who a token belongs to (used when the project signs tokens with a secret we don't hold). */
export async function userFromAuthServer(cfg: AuthConfig, accessToken: string): Promise<string> {
  const hit = verified.get(accessToken);
  if (hit && hit.until > Date.now()) return hit.sub;
  const { url, key, f } = base(cfg);
  const res = await f(`${url}/auth/v1/user`, { headers: { apikey: key, authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`auth server said ${res.status}`);
  const u = (await res.json()) as { id?: string };
  if (!u.id) throw new Error('no user id');
  if (verified.size > 5000) verified.clear();
  verified.set(accessToken, { sub: u.id, until: Date.now() + 5 * 60_000 });
  return u.id;
}
