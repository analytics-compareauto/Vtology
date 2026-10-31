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
  if (new URL(req.url).pathname === '/api/health') {
    return Response.json({ ok: true, service: 'vtology', configured: { database: !!process.env.DATABASE_URL, auth: !!(supabaseUrl || jwtSecret) } });
  }
  if (!supabaseUrl && !jwtSecret) return Response.json({ error: 'Set SUPABASE_URL (and optionally SUPABASE_JWT_SECRET) on the server.' }, { status: 500 });
  return handle(req, { db: await db(), supabaseUrl, jwtSecret });
}

export const GET = route;
export const POST = route;
