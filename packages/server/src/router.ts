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

const MappingSchema = z.object({
  entity: z.enum(['lead', 'journey_event', 'transaction', 'campaign', 'partner', 'consent']),
  sourceSystem: z.string().min(1),
  fields: z.record(z.string(), z.union([z.string(), z.object({ column: z.string().optional(), transform: z.enum(['trim', 'upper', 'lower', 'number', 'date', 'bool']).optional(), default: z.union([z.string(), z.number(), z.boolean()]).optional() })])),
});
const ImportSchema = z.object({ mapping: MappingSchema, csv: z.string().min(1).max(20_000_000), fileName: z.string().optional() });
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
    if (parts[0] === 'health') return json(200, { ok: true, service: 'vtology', version: '0.1.0' });
    if (parts[0] !== 'tenants' || !parts[1]) throw new HttpError(404, 'Not found.');

    const userId = await authenticate(req, deps);
    const ctx = await loadContext(deps, userId, parts[1]);
    const route = `${req.method} ${parts.slice(2).join('/')}`;

    if (route === 'GET me') return json(200, await me(ctx));
    if (route === 'POST imports') return json(201, await importCsv(ctx, await body(req, ImportSchema)));
    if (route === 'POST pipeline/run') return json(200, await runPipeline(ctx));
    if (route === 'GET journeys') return json(200, await listJourneys(ctx, { stalledOnly: url.searchParams.get('stalled') === 'true' }));
    if (route === 'GET partners') return json(200, await listPartners(ctx));
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
