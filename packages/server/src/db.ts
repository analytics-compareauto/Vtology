/**
 * Minimal database interface so the same server code runs on Supabase Postgres (postgres.js)
 * and on PGlite in tests.
 *
 * - `admin` runs as the API's own server role (bypasses RLS; used only after TypeScript checks).
 * - `asUser(userId)` runs a function inside a transaction as role "authenticated" with the
 *   user's id in the JWT claims, so every read is filtered by row-level security exactly as in Supabase.
 */
export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface Db {
  admin: Sql;
  asUser<T>(userId: string, fn: (sql: Sql) => Promise<T>): Promise<T>;
  transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
}

/** Shared by both drivers: open a user-scoped transaction the way Supabase does. */
export const USER_CONTEXT_SQL = (userId: string) => [
  `select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`,
  [JSON.stringify({ sub: userId, role: 'authenticated' }), userId],
] as const;

/** Production driver: postgres.js against the Supabase connection string. */
export async function createPostgresDb(connectionString: string): Promise<Db> {
  const { default: postgres } = await import('postgres');
  const client = postgres(connectionString, { prepare: false, max: 5 });
  const wrap = (tx: { unsafe: (q: string, p?: unknown[]) => Promise<unknown> }): Sql => ({
    query: async <T,>(text: string, params: unknown[] = []) => (await tx.unsafe(text, params as never[])) as unknown as T[],
  });
  return {
    admin: wrap(client as never),
    transaction: fn => client.begin(tx => fn(wrap(tx as never))) as Promise<never>,
    asUser: (userId, fn) =>
      client.begin(async tx => {
        const [q, p] = USER_CONTEXT_SQL(userId);
        await (tx as never as { unsafe: (q: string, p: unknown[]) => Promise<unknown> }).unsafe(q, [...p]);
        await (tx as never as { unsafe: (q: string) => Promise<unknown> }).unsafe('set local role authenticated');
        return fn(wrap(tx as never));
      }) as Promise<never>,
  };
}
