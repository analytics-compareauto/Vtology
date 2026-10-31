/**
 * Identifiers are normalised, then hashed with a per-tenant salt before they are stored.
 * Raw phone numbers and emails never reach the database or leave the engine.
 * Uses Web Crypto, so it runs in Node 20+, browsers and edge runtimes.
 */

/** Normalise an Indian mobile number to its 10 digits; returns null if it is not a valid mobile. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = String(raw).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

/** PAN-style government IDs: upper-case, no spaces. */
export function normalizeGovId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = String(raw).replace(/\s/g, '').toUpperCase();
  return v.length >= 6 ? v : null;
}

export async function hashValue(salt: string, kind: string, value: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${kind}:${value}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return `${kind}_` + [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export function normalizeName(raw: string | null | undefined): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/\b(mr|mrs|ms|dr|shri|smt)\.?\s+/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
