/**
 * Framework-free HTTP router: takes a standard Request, returns a standard Response.
 * Next.js route handlers, tests and any other runtime can all call `handle`.
 */
import { z } from 'zod';
import { authenticate, loadContext, HttpError, type Deps } from './context';
import { importCsv } from './imports';
import { runPipeline } from './pipeline';
import { listJourneys, listPartners, listViolations, listActions, me } from './queries';
import { requestAction, decideAction } from './actions';
import { signIn, refreshSession } from './auth';
import { listWorkspaces, createWorkspace, switchSampleRole } from './workspaces';
import { schemaReady } from './schema';
import { startConnect, finishConnect, socialOverview, syncTenant, syncAll, syncConnection, disconnect, growthOverview, addCompetitor, removeCompetitor } from './social';
import { ROLES, type RoleCode } from '@vtology/core';

const MappingSchema = z.object({
  entity: z.enum(['lead', 'journey_event', 'transaction', 'campaign', 'partner', 'consent']),
  sourceSystem: z.string().min(1),
  fields: z.record(z.string(), z.union([z.string(), z.object({ column: z.string().optional(), transform: z.enum(['trim', 'upper', 'lower', 'number', 'date', 'bool']).optional(), default: z.union([z.string(), z.number(), z.boolean()]).optional() })])),
});
const ImportSchema = z.object({ mapping: MappingSchema, csv: z.string().min(1).max(20_000_000), fileName: z.string().optional() });
const LoginSchema = z.object({ email: z.string().trim().email('Enter a valid email address.'), password: z.string().min(1, 'Enter your password.') });
const RefreshSchema = z.object({ refreshToken: z.string().min(10) });
const WorkspaceSchema = z.object({ name: z.string().trim().min(2, 'Give the workspace a name.').max(80), industry: z.enum(['Automotive', 'BFSI', 'FMCG']), sample: z.boolean().default(false) });
const RoleSchema = z.object({ role: z.enum(Object.keys(ROLES) as [RoleCode, ...RoleCode[]]) });
const ActionSchema = z.object({ type: z.string(), objectId: z.string().min(1), newPartnerId: z.string().uuid().optional(), reason: z.string().max(500).optional() });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try { raw = await req.json(); } catch { throw new HttpError(400, 'The request body must be JSON.'); }
  const r = schema.safeParse(raw);
  if (!r.success) throw new HttpError(400, 'The request body is not valid.', r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`));
  return r.data;
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  try {
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    if (parts[0] === 'health') return json(200, { ok: true, service: 'vtology', version: '0.2.0' });
    const top = `${req.method} ${parts.join('/')}`;
    if (top === 'GET auth/config') return json(200, { mode: deps.localSecret ? 'local' : 'supabase', ready: !!(deps.localSecret || (deps.supabaseUrl && deps.supabaseKey)) });
    if (top === 'POST auth/login') { const b = await body(req, LoginSchema); return json(200, await signIn(deps, b.email, b.password)); }
    if (top === 'POST auth/refresh') return json(200, await refreshSession(deps, (await body(req, RefreshSchema)).refreshToken));

    await schemaReady(deps.db);
    // the platform sends the browser back here after the brand approves access; verified by the signed state
    const cb = top.match(/^GET social\/callback\/([a-z]+)$/);
    if (cb) return new Response(null, { status: 302, headers: { location: await finishConnect(deps, cb[1]!, url.searchParams) } });
    if (top === 'GET cron/social-sync' || top === 'POST cron/social-sync') {
      // who may run it: Vercel's scheduler (with CRON_SECRET when set, else its own user agent), or
      // this server calling itself for one connection (a key derived from the server's secret)
      const internalKey = deps.secretKey ? await internalCronKey(deps.secretKey) : undefined;
      const internal = !!internalKey && req.headers.get('x-vt-internal') === internalKey;
      const fromScheduler = deps.cronSecret ? req.headers.get('authorization') === `Bearer ${deps.cronSecret}` : /vercel-cron/i.test(req.headers.get('user-agent') ?? '');
      if (!internal && !fromScheduler) throw new HttpError(401, 'Not allowed.');
      const one = url.searchParams.get('connection'), tenant = url.searchParams.get('tenant');
      if (internal && one && tenant) return json(200, await syncConnection(deps, tenant, one));
      return json(200, await syncAll(deps, { selfUrl: deps.social?.publicUrl, internalKey }));
    }
    const userId = await authenticate(req, deps);
    if (top === 'GET workspaces') return json(200, await listWorkspaces(deps, userId));
    if (top === 'POST workspaces') return json(201, await createWorkspace(deps, userId, await body(req, WorkspaceSchema)));
    if (parts[0] !== 'tenants' || !parts[1]) throw new HttpError(404, 'Not found.');

    const ctx = await loadContext(deps, userId, parts[1]);
    const route = `${req.method} ${parts.slice(2).join('/')}`;

    if (route === 'GET me') return json(200, await me(ctx));
    if (route === 'GET social') return json(200, await socialOverview(deps, ctx));
    if (route === 'POST social/sync') return json(200, await syncTenant(deps, ctx));
    if (route === 'GET social/growth') {
      const per = url.searchParams.get('period');
      const pl = url.searchParams.get('platform');
      return json(200, await growthOverview(deps, ctx, per === 'week' || per === 'quarter' ? per : 'month', pl && ['instagram', 'facebook', 'youtube'].includes(pl) ? pl : null));
    }
    if (route === 'POST social/competitors') {
      const b = await req.json().catch(() => ({})) as { platform?: unknown; handle?: unknown };
      if (typeof b.platform !== 'string' || typeof b.handle !== 'string') throw new HttpError(400, 'Send a platform and a handle.');
      return json(201, await addCompetitor(deps, ctx, b.platform, b.handle));
    }
    const rc = route.match(/^DELETE social\/competitors\/([0-9a-f-]{36})$/);
    if (rc) return json(200, await removeCompetitor(ctx, rc[1]!));
    const sc = route.match(/^POST social\/connect\/([a-z]+)$/);
    if (sc) return json(200, await startConnect(deps, ctx, sc[1]!));
    const sd = route.match(/^DELETE social\/([0-9a-f-]{36})$/);
    if (sd) return json(200, await disconnect(ctx, sd[1]!));
    if (route === 'POST sample/role') return json(200, await switchSampleRole(ctx, (await body(req, RoleSchema)).role));
    if (route === 'POST imports') return json(201, await importCsv(ctx, await body(req, ImportSchema)));
    if (route === 'POST pipeline/run') return json(200, await runPipeline(ctx));
    if (route === 'GET journeys') return json(200, await listJourneys(ctx, { stalledOnly: url.searchParams.get('stalled') === 'true' }));
    if (route === 'GET partners') return json(200, await listPartners(ctx));
    // names only, so anyone (including partner users) can pick a partner when requesting a reassignment
    if (route === 'GET partners/directory') return json(200, await ctx.db.admin.query(`select id, name, city from vt.partners where tenant_id = $1 and active order by name`, [ctx.tenantId]));
    if (route === 'GET violations') return json(200, await listViolations(ctx));
    if (route === 'GET actions') return json(200, await listActions(ctx));
    if (route === 'POST actions') return json(201, await requestAction(ctx, await body(req, ActionSchema)));
    const m = route.match(/^POST actions\/([0-9a-f-]{36})\/(approve|reject)$/);
    if (m) return json(200, await decideAction(ctx, m[1]!, m[2] === 'approve'));
    throw new HttpError(404, 'Not found.');
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message, details: e.details });
    console.error(e);
    return json(500, { error: 'Something went wrong on our side. The error has been logged.' });
  }
}

/** A key only this server can derive, for calling itself from the daily job. */
async function internalCronKey(secret: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`vtology-cron:${secret}`));
  return Buffer.from(d).toString('hex');
}
