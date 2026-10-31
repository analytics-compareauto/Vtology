/**
 * Workspaces (tenants) as the signed-in person sees them: which ones they belong to, creating a
 * new one, and — in sample workspaces only — switching their own role to see each role's view.
 */
import { ROLES, journeyStatus, type Industry, type RoleCode } from '@vtology/core';
import { HttpError, loadContext, type Ctx, type Deps } from './context';
import { loadDemo, type DemoLoadResult } from './demo';

export interface Workspace { id: string; name: string; industry: Industry; isDemo: boolean; role: RoleCode; createdAt: string }

export async function listWorkspaces(deps: Deps, userId: string): Promise<{ workspaces: Workspace[]; canCreate: boolean }> {
  const rows = await deps.db.admin.query<{ id: string; name: string; industry: Industry; is_demo: boolean; role: RoleCode; created_at: string }>(
    `select t.id, t.name, t.industry, t.is_demo, m.role, t.created_at
       from vt.memberships m join vt.tenants t on t.id = m.tenant_id
      where m.user_id = $1 order by t.created_at`, [userId]);
  return { workspaces: rows.map(r => ({ id: r.id, name: r.name, industry: r.industry, isDemo: r.is_demo, role: r.role, createdAt: r.created_at })), canCreate: await canCreate(deps, userId) };
}

/** The very first person in a fresh installation may create a workspace; after that, only data stewards and marketing heads. */
async function canCreate(deps: Deps, userId: string): Promise<boolean> {
  const [r] = await deps.db.admin.query<{ any_tenant: boolean; admin: boolean }>(
    `select exists (select 1 from vt.tenants) as any_tenant,
            exists (select 1 from vt.memberships where user_id = $1 and role in ('data_steward', 'marketing_head')) as admin`, [userId]);
  return !r!.any_tenant || r!.admin;
}

export async function createWorkspace(deps: Deps, userId: string, input: { name: string; industry: Industry; sample: boolean }): Promise<{ workspace: Workspace; sample?: DemoLoadResult }> {
  if (!(await canCreate(deps, userId))) throw new HttpError(403, 'Only a data steward or marketing head can create workspaces. Ask one to add you.');
  const [t] = await deps.db.admin.query<{ id: string; created_at: string }>(
    `insert into vt.tenants (name, industry, is_demo, created_by) values ($1, $2, $3, $4) returning id, created_at`, [input.name.trim(), input.industry, input.sample, userId]);
  await deps.db.admin.query(`insert into vt.memberships (tenant_id, user_id, role) values ($1, $2, 'data_steward')`, [t!.id, userId]);
  const workspace: Workspace = { id: t!.id, name: input.name.trim(), industry: input.industry, isDemo: input.sample, role: 'data_steward', createdAt: t!.created_at };
  if (!input.sample) return { workspace };
  try {
    const sample = await loadDemo(await loadContext(deps, userId, t!.id));
    return { workspace, sample };
  } catch (e) {
    // don't leave a half-loaded sample behind
    await deps.db.admin.query(`delete from vt.memberships where tenant_id = $1`, [t!.id]).catch(() => undefined);
    await deps.db.admin.query(`delete from vt.tenants where id = $1`, [t!.id]).catch(() => undefined);
    throw e;
  }
}

/** Sample workspaces only: become another role, with a realistic scope for partner and RM roles. */
export async function switchSampleRole(ctx: Ctx, role: RoleCode): Promise<{ role: RoleCode; partner: string | null; bookCode: string | null }> {
  if (!ctx.isDemo) throw new HttpError(403, 'Roles can only be switched in sample workspaces. In real workspaces an admin assigns roles.');
  if (!ROLES[role]) throw new HttpError(400, 'Unknown role.');
  let partnerId: string | null = null, partner: string | null = null, bookCode: string | null = null;
  if (role === 'partner_user') {
    // the partner with the most journeys gone quiet: the most interesting view
    const js = await ctx.db.admin.query<{ partner_id: string; name: string; stage_index: number; stage_entered_at: string; last_activity_at: string }>(
      `select j.current_partner_id as partner_id, p.name, j.stage_index, j.stage_entered_at, j.last_activity_at
         from vt.journeys_current j join vt.partners p on p.id = j.current_partner_id where j.tenant_id = $1`, [ctx.tenantId]);
    const score = new Map<string, { name: string; stalled: number; n: number }>();
    for (const j of js) {
      const s = score.get(j.partner_id) ?? { name: j.name, stalled: 0, n: 0 };
      s.n++;
      if (journeyStatus(ctx.industry, { id: '', externalRef: '', partyId: null, campaignId: null, partnerId: j.partner_id, stageIndex: j.stage_index, stageEnteredAt: new Date(j.stage_entered_at), lastActivityAt: new Date(j.last_activity_at), crmConverted: false }, ctx.now).stalled) s.stalled++;
      score.set(j.partner_id, s);
    }
    const best = [...score.entries()].sort((a, b) => b[1].stalled - a[1].stalled)[0];
    if (!best) throw new HttpError(409, 'This workspace has no partners yet.');
    [partnerId, partner] = [best[0], best[1].name];
  }
  if (role === 'relationship_manager') {
    const [b] = await ctx.db.admin.query<{ book_code: string }>(
      `select book_code from vt.parties where tenant_id = $1 and book_code is not null group by book_code order by count(*) desc limit 1`, [ctx.tenantId]);
    if (!b) throw new HttpError(409, 'No customer book codes in this workspace yet.');
    bookCode = b.book_code;
  }
  await ctx.db.admin.query(`update vt.memberships set role = $3, partner_id = $4, book_code = $5 where tenant_id = $1 and user_id = $2`, [ctx.tenantId, ctx.userId, role, partnerId, bookCode]);
  return { role, partner, bookCode };
}
