import { handle, createPostgresDb, type Db } from '@vtology/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let dbPromise: Promise<Db> | null = null;
function db(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Use the Supabase connection string (Connect → Transaction pooler).');
  dbPromise ??= createPostgresDb(url);
  return dbPromise;
}

async function route(req: Request): Promise<Response> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (new URL(req.url).pathname === '/api/health') return health(!!(supabaseUrl || jwtSecret));
  if (!supabaseUrl && !jwtSecret) return Response.json({ error: 'Set SUPABASE_URL (and optionally SUPABASE_JWT_SECRET) on the server.' }, { status: 500 });
  return handle(req, { db: await db(), supabaseUrl, jwtSecret });
}

/** Health check that really talks to the database, so a wrong password or setup shows up here. */
async function health(auth: boolean): Promise<Response> {
  let database = 'not configured';
  let stages: number | undefined;
  if (process.env.DATABASE_URL) {
    try {
      const rows = await Promise.race([
        (await db()).admin.query<{ n: number }>('select count(*)::int as n from vt.stage_defs'),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out after 8s')), 8000)),
      ]);
      database = 'connected';
      stages = rows[0]?.n;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      database = /password|authentication/i.test(msg) ? 'wrong password in DATABASE_URL'
        : /does not exist/i.test(msg) ? 'connected, but setup_all.sql has not been run'
        : `error: ${msg.replace(/postgres(ql)?:\/\/\S+/g, '[connection string]').slice(0, 160)}`;
      dbPromise = null;
    }
  }
  const ok = database === 'connected' && auth;
  return Response.json({ ok, service: 'vtology', database, stages, auth: auth ? 'configured' : 'SUPABASE_URL missing' }, { status: ok ? 200 : 503 });
}

export const GET = route;
export const POST = route;
