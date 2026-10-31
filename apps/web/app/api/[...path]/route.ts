import { handle, createPostgresDb, type Db } from '@vtology/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Accept the connection string the way people actually paste it: stray quotes or spaces,
 *  a leading "DATABASE_URL=", the [brackets] from Supabase's template, or a password with
 *  symbols that are not percent-encoded. */
function cleanDatabaseUrl(raw: string): string {
  let s = raw.trim().replace(/^DATABASE_URL\s*=\s*/i, '').trim().replace(/^['"]|['"]$/g, '').trim();
  const m = /^(postgres(?:ql)?:\/\/)([^:/@]+):(.*)@([^@/]+)(\/.*)?$/s.exec(s);
  if (!m) return s;
  const [, scheme, user, pass0, host, rest] = m;
  let pass = pass0!;
  if (pass.startsWith('[') && pass.endsWith(']')) pass = pass.slice(1, -1);
  let decoded = pass;
  try { decoded = decodeURIComponent(pass); } catch { /* raw symbols such as a lone % */ }
  return `${scheme}${user}:${encodeURIComponent(decoded)}@${host}${rest ?? '/postgres'}`;
}

/** What is wrong with the connection string, without ever revealing the password. */
function describeDatabaseUrl(raw: string): string {
  const s = cleanDatabaseUrl(raw);
  const issues: string[] = [];
  if (!/^postgres(ql)?:\/\//.test(s)) issues.push('should start with postgresql://');
  if (!/pooler\.supabase\.com/.test(s)) issues.push('should use the pooler address (…pooler.supabase.com)');
  if (!/:6543\//.test(s)) issues.push('should use port 6543 (Transaction pooler)');
  if (/YOUR-PASSWORD/i.test(s)) issues.push('still contains YOUR-PASSWORD: put your database password in its place');
  if (!/^postgres(ql)?:\/\/postgres\.[a-z0-9]+:/.test(s)) issues.push('user should be postgres.<project-ref>');
  return issues.length ? issues.join('; ') : 'format looks right';
}

let dbPromise: Promise<Db> | null = null;
function db(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Use the Supabase connection string (Connect → Transaction pooler).');
  dbPromise ??= createPostgresDb(cleanDatabaseUrl(url));
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
  const databaseUrl = process.env.DATABASE_URL && !ok ? describeDatabaseUrl(process.env.DATABASE_URL) : undefined;
  return Response.json({ ok, service: 'vtology', database, databaseUrl, stages, auth: auth ? 'configured' : 'SUPABASE_URL missing' }, { status: ok ? 200 : 503 });
}

export const GET = route;
export const POST = route;
