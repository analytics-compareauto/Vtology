import { handle, createPostgresDb, type Db } from '@vtology/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let dbPromise: Promise<Db> | null = null;
function db(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Use the Supabase connection string (Project settings → Database).');
  dbPromise ??= createPostgresDb(url);
  return dbPromise;
}

async function route(req: Request): Promise<Response> {
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (!jwtSecret) return Response.json({ error: 'SUPABASE_JWT_SECRET is not set on the server.' }, { status: 500 });
  return handle(req, { db: await db(), jwtSecret });
}

export const GET = route;
export const POST = route;
