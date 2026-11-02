/**
 * Encryption for stored platform access keys (AES-256-GCM, key derived from VTOLOGY_SECRET_KEY) and
 * signed, short-lived OAuth "state" values so a callback can't be forged or replayed into another workspace.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { HttpError } from './context';

const keyOf = (secret: string) => createHash('sha256').update(`vtology-tokens:${secret}`).digest();

export function requireSecret(secret: string | undefined): string {
  if (!secret || secret.length < 32) throw new HttpError(503, 'Connections are not set up yet: add VTOLOGY_SECRET_KEY (40+ random characters) in Vercel and redeploy.');
  return secret;
}

export function encrypt(secret: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

export function decrypt(secret: string, sealed: string): string {
  const [v, iv, tag, body] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !body) throw new Error('unknown token format');
  const d = createDecipheriv('aes-256-gcm', keyOf(secret), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
}

export interface OAuthState { tenantId: string; userId: string; provider: string }

export async function signState(secret: string, s: OAuthState): Promise<string> {
  return new SignJWT({ ...s, kind: 'oauth_state' }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('15m')
    .setJti(randomBytes(8).toString('hex')).sign(keyOf(`state:${secret}`));
}

export async function verifyState(secret: string, token: string, provider: string): Promise<OAuthState> {
  try {
    const { payload } = await jwtVerify(token, keyOf(`state:${secret}`), { algorithms: ['HS256'] });
    if (payload.kind !== 'oauth_state' || payload.provider !== provider) throw new Error('wrong state');
    return { tenantId: String(payload.tenantId), userId: String(payload.userId), provider };
  } catch { throw new HttpError(400, 'This connection link has expired or is invalid. Start again from the Social tab.'); }
}
