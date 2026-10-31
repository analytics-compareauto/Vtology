/**
 * Identity resolution: turns source records from many systems into one profile per real person.
 *
 * 1. Shared-identifier guard: an identifier that appears under too many different names
 *    (a dealer's office phone, a fraud ring) is never used to link records; it is flagged instead.
 * 2. Deterministic links: records sharing a hashed phone, email or government ID are joined.
 * 3. Hard stop: two groups with different government IDs are never merged; the conflict goes to review.
 * 4. Probabilistic links: same pin code + very similar name. High confidence merges automatically,
 *    middle confidence goes to the review queue, low confidence stays separate.
 */
import { normalizeName } from './hashing';

export interface IdentityInput {
  id: string;
  name: string;
  phoneHash?: string | null;
  emailHash?: string | null;
  govIdHash?: string | null;
  pincode?: string | null;
}

export type MatchMethod = 'anchor' | 'deterministic' | 'probabilistic' | 'held_for_review';

export interface Assignment { recordId: string; clusterId: string; method: MatchMethod; confidence: number }
export interface ReviewItem { kind: 'shared_identifier' | 'gov_id_conflict' | 'possible_match'; recordIds: string[]; detail: string; confidence?: number; identifier?: string }
export interface ResolveResult { assignments: Assignment[]; clusters: Map<string, string[]>; review: ReviewItem[]; sharedIdentifiers: { identifier: string; names: number; records: number }[] }

export interface ResolveOptions {
  /** An identifier seen under more distinct names than this is treated as shared. */
  maxNamesPerIdentifier?: number;
  autoMergeAt?: number;
  reviewAt?: number;
}

/** Jaro-Winkler similarity, 0..1. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array<boolean>(a.length).fill(false), bm = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bm[j] || a[i] !== b[j]) continue;
      am[i] = bm[j] = true; matches++; break;
    }
  }
  if (!matches) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Names match if they are similar, or one is the first name of the other ("Meera" vs "Meera Bose"). */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeName(a), y = normalizeName(b);
  if (!x || !y) return 0;
  const full = jaroWinkler(x, y);
  const xf = x.split(' ')[0]!, yf = y.split(' ')[0]!;
  const firstOnly = (x === xf || y === yf) && xf === yf ? 0.9 : 0;
  return Math.max(full, firstOnly);
}

class UnionFind {
  parent = new Map<string, string>();
  gov = new Map<string, Set<string>>();
  find(x: string): string {
    let p = this.parent.get(x) ?? x;
    if (p !== x) { p = this.find(p); this.parent.set(x, p); }
    return p;
  }
  /** Returns false when the two groups hold different government IDs (hard stop). */
  union(a: string, b: string): boolean {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return true;
    const ga = this.gov.get(ra) ?? new Set(), gb = this.gov.get(rb) ?? new Set();
    if (ga.size && gb.size && ![...ga].some(g => gb.has(g))) return false;
    this.parent.set(rb, ra);
    this.gov.set(ra, new Set([...ga, ...gb]));
    return true;
  }
}

export function resolveIdentities(records: IdentityInput[], opts: ResolveOptions = {}): ResolveResult {
  const maxNames = opts.maxNamesPerIdentifier ?? 3;
  const autoAt = opts.autoMergeAt ?? 0.94;
  const reviewAt = opts.reviewAt ?? 0.85;
  const uf = new UnionFind();
  records.forEach(r => { uf.parent.set(r.id, r.id); if (r.govIdHash) uf.gov.set(r.id, new Set([r.govIdHash])); });
  const review: ReviewItem[] = [];
  const linkedBy = new Map<string, 'deterministic' | 'probabilistic'>();
  const confidence = new Map<string, number>();
  const held = new Set<string>();

  // 1. group by identifier, guard against shared identifiers
  const byKey = new Map<string, IdentityInput[]>();
  for (const r of records) {
    for (const [k, v] of [['phone', r.phoneHash], ['email', r.emailHash], ['gov', r.govIdHash]] as const) {
      if (!v) continue;
      const key = `${k}:${v}`;
      (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(r);
    }
  }
  const sharedIdentifiers: ResolveResult['sharedIdentifiers'] = [];
  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    // count distinct people-by-name in the group (similar names count once)
    const names: string[] = [];
    for (const r of group) if (!names.some(n => nameSimilarity(n, r.name) >= reviewAt)) names.push(r.name);
    if (!key.startsWith('gov:') && names.length > maxNames) {
      sharedIdentifiers.push({ identifier: key, names: names.length, records: group.length });
      review.push({ kind: 'shared_identifier', recordIds: group.map(r => r.id), identifier: key, detail: `One identifier appears under ${names.length} different names` });
      group.forEach(r => held.add(r.id));
      continue;
    }
    // 2. deterministic links (3. hard stop inside union)
    const first = group[0]!;
    for (const r of group.slice(1)) {
      if (uf.union(first.id, r.id)) { linkedBy.set(r.id, 'deterministic'); confidence.set(r.id, 0.99); }
      else review.push({ kind: 'gov_id_conflict', recordIds: [first.id, r.id], detail: 'Same contact details but different government IDs; never merged automatically' });
    }
  }

  // 4. probabilistic links within pin code + first letter buckets
  const buckets = new Map<string, IdentityInput[]>();
  for (const r of records) {
    if (!r.pincode) continue;
    const n = normalizeName(r.name);
    if (!n) continue;
    const key = `${r.pincode}:${n[0]}`;
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(r);
  }
  for (const group of buckets.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!, b = group[j]!;
        if (uf.find(a.id) === uf.find(b.id)) continue;
        if (a.phoneHash && b.phoneHash && a.phoneHash !== b.phoneHash && a.emailHash && b.emailHash && a.emailHash !== b.emailHash) continue;
        const sim = nameSimilarity(a.name, b.name);
        const conf = Math.round((0.55 + 0.45 * sim) * 1000) / 1000;
        if (conf >= autoAt) {
          if (uf.union(a.id, b.id)) { linkedBy.set(b.id, 'probabilistic'); confidence.set(b.id, conf); }
        } else if (conf >= reviewAt) {
          review.push({ kind: 'possible_match', recordIds: [a.id, b.id], confidence: conf, detail: `Similar names in pin code ${a.pincode}` });
        }
      }
    }
  }

  // assemble clusters and assignments
  const clusters = new Map<string, string[]>();
  for (const r of records) {
    const root = uf.find(r.id);
    (clusters.get(root) ?? clusters.set(root, []).get(root)!).push(r.id);
  }
  const assignments: Assignment[] = [];
  for (const [root, ids] of clusters) {
    ids.forEach((id, i) => {
      if (held.has(id) && ids.length === 1) assignments.push({ recordId: id, clusterId: root, method: 'held_for_review', confidence: 0.4 });
      else if (i === 0) assignments.push({ recordId: id, clusterId: root, method: 'anchor', confidence: 1 });
      else assignments.push({ recordId: id, clusterId: root, method: linkedBy.get(id) ?? 'deterministic', confidence: confidence.get(id) ?? 0.99 });
    });
  }
  return { assignments, clusters, review, sharedIdentifiers };
}
