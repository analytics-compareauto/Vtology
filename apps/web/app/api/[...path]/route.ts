import { handle, createPostgresDb, type Db } from '@vtology/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Accept the connection string the way people actually paste it: stray quotes or spaces,
 *  a leading "DATABASE_URL=", the [brackets] from Supabase's template, or a password with
 *  symbols that are not percent-encoded. */
function cleanDatabaseUrl(raw: string): string {
  let s = raw.trim().replace(/^DATABASE_URL\s*=\s*/i, '').trim().replace(/^['"]|['"]$/g, '').trim();
  // Text pasted around the address (a psql command, a label, quotes): keep only the address.
  const at = s.search(/postgres(?:ql)?:\/\//);
  if (at > 0) s = s.slice(at).replace(/['"\s].*$/s, '');
  // The postgresql:// part cut off when copying: put it back.
  else if (at < 0 && /^[^\s:/@]+:.+@[^@\s]+:\d+/.test(s)) s = `postgresql://${s}`;
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
  if (!/^postgres(ql)?:\/\//.test(s)) {
    // Show only what comes before the first ":" (never the password).
    const head = s.split(':')[0]!.slice(0, 24);
    issues.push(`should start with postgresql:// (yours starts with "${head}")`);
  }
  if (!/pooler\.supabase\.com/.test(s)) issues.push('should use the pooler address (…pooler.supabase.com)');
  if (!/:6543\//.test(s)) issues.push('should use port 6543 (Transaction pooler)');
  if (/YOUR-PASSWORD/i.test(s)) issues.push('still contains YOUR-PASSWORD: put your database password in its place');
  if (!/^postgres(ql)?:\/\/postgres\.[a-z0-9]+:/.test(s)) issues.push('user should be postgres.<project-ref>');
  return issues.length ? issues.join('; ') : 'format looks right';
}

/** The connection string to use. DATABASE_PASSWORD, when set, is kept separate so nobody has to
 *  edit a password into the middle of a long address. Without a usable DATABASE_URL, the address
 *  is built from SUPABASE_URL (Mumbai transaction pooler by default; DATABASE_HOST overrides). */
function databaseUrl(): string | undefined {
  const password = process.env.DATABASE_PASSWORD?.trim();
  const raw = process.env.DATABASE_URL?.trim();
  let url = raw ? cleanDatabaseUrl(raw) : '';
  const ref = /https:\/\/([a-z0-9]+)\.supabase\.co/.exec(process.env.SUPABASE_URL ?? '')?.[1];
  let parsed: URL | null = null;
  try { parsed = url && /^postgres(ql)?:\/\//.test(url) ? new URL(url) : null; } catch { parsed = null; }
  // A mangled address (e.g. the server name lost while editing) is rebuilt when we have what we need.
  if (parsed && password && ref && !/^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(parsed.hostname)) parsed = null;
  if (!parsed && password && ref) {
    const host = process.env.DATABASE_HOST?.trim() || 'aws-0-ap-south-1.pooler.supabase.com';
    parsed = new URL(`postgresql://postgres.${ref}@${host}:6543/postgres`);
  }
  if (!parsed) return url || undefined;
  if (password) parsed.password = encodeURIComponent(password);
  return parsed.toString();
}

let dbPromise: Promise<Db> | null = null;
function db(): Promise<Db> {
  const url = databaseUrl();
  if (!url) throw new Error('Set DATABASE_PASSWORD (and SUPABASE_URL) in Vercel.');
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
  if (databaseUrl()) {
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
  const url = databaseUrl();
  const databaseUrlCheck = url && !ok ? describeDatabaseUrl(url) : undefined;
  return Response.json({ ok, service: 'vtology', database, databaseUrl: databaseUrlCheck, passwordSetSeparately: !!process.env.DATABASE_PASSWORD, stages, auth: auth ? 'configured' : 'SUPABASE_URL missing' }, { status: ok ? 200 : 503 });
}

export const GET = route;
export const POST = route;
