/**
 * Vanaya's admin panel: every client on one screen, each one's plan and switched-on parts, the
 * activation margin, and a record of every change. Open only to Vanaya's owners (by email); no brand
 * or partner ever sees it or can reach it.
 */
import { decodeJwt } from 'jose';
import { HttpError, type Deps } from './context';

export const FEATURES = ['social', 'media', 'audiences', 'journeys'] as const;
export type Feature = typeof FEATURES[number];
/** the parts each plan includes; "custom" keeps whatever is switched on */
export const PLANS: Record<string, { label: string; features: Feature[] }> = {
  starter: { label: 'Starter', features: ['social'] },
  growth: { label: 'Growth', features: ['social', 'media', 'audiences'] },
  enterprise: { label: 'Enterprise', features: ['social', 'media', 'audiences', 'journeys'] },
  custom: { label: 'Custom', features: [] },
};
const DEFAULT_OWNERS = ['sarvesh@vanayaventures.com', 'sarvesh@tecreo.io'];

/** The signed-in person's email, from a token the server has already verified. */
export function tokenEmail(req: Request): string | null {
  try { const t = (req.headers.get('authorization') ?? '').replace(/^Bearer /, ''); const p = decodeJwt(t) as { email?: string }; return p.email?.toLowerCase() ?? null; } catch { return null; }
}
export function isOwner(deps: Deps & { ownerEmails?: string[] }, email: string | null): boolean {
  if (!email) return false;
  const list = (deps.ownerEmails ?? (process.env.VANAYA_OWNERS ? process.env.VANAYA_OWNERS.split(',') : DEFAULT_OWNERS)).map(e => e.trim().toLowerCase());
  return list.includes(email) || (!!deps.localSecret && email === 'sarvesh@vanaya.test');
}
function requireOwner(deps: Deps, email: string | null): string {
  if (!isOwner(deps, email)) throw new HttpError(404, 'Not found.');
  return email!;
}

export async function adminOverview(deps: Deps, email: string | null) {
  requireOwner(deps, email);
  const rows = await deps.db.admin.query<Record<string, unknown> & { id: string; name: string; industry: string; is_demo: boolean; plan: string; features: Record<string, boolean> | string; margin_pct: string | null; admin_note: string | null; created_at: string }>(
    `select t.id, t.name, t.industry, t.is_demo, t.plan, t.features, t.margin_pct, t.admin_note, t.created_at,
       (select count(*) from vt.memberships m where m.tenant_id = t.id)::int as members,
       (select count(*) from vt.journeys j where j.tenant_id = t.id)::int as leads,
       (select count(*) from vt.data_sources s where s.tenant_id = t.id)::int as sources,
       (select count(*) filter (where s.status = 'error') from vt.data_sources s where s.tenant_id = t.id)::int as source_errors,
       (select count(*) from vt.social_connections c where c.tenant_id = t.id)::int as social,
       (select count(*) from vt.media_reports r where r.tenant_id = t.id)::int as dv360,
       (select count(*) from vt.perf_reports r where r.tenant_id = t.id)::int as ads,
       (select count(*) from vt.offline_reports r where r.tenant_id = t.id)::int as offline,
       (select count(*) from vt.audience_lists a where a.tenant_id = t.id)::int as audiences,
       greatest((select max(last_sync_at) from vt.data_sources s where s.tenant_id = t.id), (select max(created_at) from vt.media_reports r where r.tenant_id = t.id),
                (select max(created_at) from vt.perf_reports r where r.tenant_id = t.id), (select max(created_at) from vt.offline_reports r where r.tenant_id = t.id),
                (select max(last_activity_at) from vt.journeys j where j.tenant_id = t.id))::text as last_data
     from vt.tenants t order by t.is_demo, t.created_at`);
  const audit = await deps.db.admin.query(`select at::text, admin_email, tenant_name, action, detail from vt.admin_audit order by at desc limit 50`);
  return {
    plans: Object.entries(PLANS).map(([id, p]) => ({ id, ...p })), features: FEATURES,
    clients: rows.map(r => ({ ...r, features: typeof r.features === 'string' ? JSON.parse(r.features) : r.features, margin_pct: r.margin_pct === null ? null : Number(r.margin_pct) })),
    audit,
  };
}

export async function adminUpdateTenant(deps: Deps, email: string | null, id: string, body: { plan?: unknown; features?: unknown; marginPct?: unknown; note?: unknown }) {
  const who = requireOwner(deps, email);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'Client not found.');
  const [t] = await deps.db.admin.query<{ name: string; plan: string; features: Record<string, boolean> | string; margin_pct: string | null }>(`select name, plan, features, margin_pct from vt.tenants where id = $1`, [id]);
  if (!t) throw new HttpError(404, 'Client not found.');
  const before = { plan: t.plan, features: typeof t.features === 'string' ? JSON.parse(t.features) : t.features, marginPct: t.margin_pct === null ? null : Number(t.margin_pct) };
  let plan = before.plan, features = { ...before.features } as Record<string, boolean>, margin = before.marginPct;
  if (typeof body.plan === 'string') {
    if (!(body.plan in PLANS)) throw new HttpError(400, 'Unknown plan.');
    plan = body.plan;
    if (plan !== 'custom') features = Object.fromEntries(FEATURES.map(f => [f, PLANS[plan]!.features.includes(f)]));
  }
  if (body.features && typeof body.features === 'object') {
    for (const f of FEATURES) if (typeof (body.features as Record<string, unknown>)[f] === 'boolean') features[f] = (body.features as Record<string, boolean>)[f]!;
    // switching parts by hand makes the plan custom unless it still matches one
    const match = Object.entries(PLANS).find(([k, p]) => k !== 'custom' && FEATURES.every(f => p.features.includes(f) === !!features[f]));
    plan = match ? match[0] : 'custom';
  }
  if (body.marginPct !== undefined) {
    const m = body.marginPct === null || body.marginPct === '' ? null : Number(body.marginPct);
    if (m !== null && (!Number.isFinite(m) || m < 0 || m > 100)) throw new HttpError(400, 'The margin is a percentage between 0 and 100.');
    margin = m;
  }
  const note = typeof body.note === 'string' ? body.note.slice(0, 1000) : undefined;
  await deps.db.admin.query(`update vt.tenants set plan = $2, features = $3, margin_pct = $4${note !== undefined ? ', admin_note = $5' : ''} where id = $1`, note !== undefined ? [id, plan, JSON.stringify(features), margin, note] : [id, plan, JSON.stringify(features), margin]);
  const after = { plan, features, marginPct: margin };
  await deps.db.admin.query(`insert into vt.admin_audit (admin_email, tenant_id, tenant_name, action, detail) values ($1,$2,$3,'Changed plan',$4)`, [who, id, t.name, JSON.stringify({ before, after, ...(note !== undefined ? { note: true } : {}) })]);
  return after;
}

/** Which part of the dashboard a route belongs to; a part that is switched off is refused. */
export function featureOfRoute(route: string): Feature | null {
  const r = route.replace(/^(GET|POST|PATCH|DELETE) /, '');
  if (/^(social|content|growth)(\/|$)/.test(r)) return 'social';
  if (/^(media|crossmedia|performance|adtocar)(\/|$)/.test(r)) return 'media';
  if (/^audiences(\/|$)/.test(r)) return 'audiences';
  if (/^(journeys|partners|findings|violations|actions|approvals)(\/|$)/.test(r)) return 'journeys';
  return null;
}
