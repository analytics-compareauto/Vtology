import type { PGlite } from '@electric-sql/pglite';
import { createPgliteDb } from '../../src/devdb';
import type { Db } from '../../src/db';

export async function createTestDb(): Promise<{ db: Db; pg: PGlite }> {
  const { db, pg } = await createPgliteDb();
  return { db, pg: pg as PGlite };
}
