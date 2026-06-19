import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'test-dir1-restart-'));
process.env.SQLITE_DB_PATH = join(tmpDir, 'app.db');

let storeContent: (title: string, body: string) => number;
let getAllContent: () => import('@/lib/db').Content[];
let closeDb: () => void;
let searchContent: (query: string) => import('@/lib/search').SearchResult[];

beforeAll(async () => {
  const db = await import('@/lib/db');
  const search = await import('@/lib/search');
  storeContent = db.storeContent;
  getAllContent = db.getAllContent;
  closeDb = db.closeDb;
  searchContent = search.searchContent;
});

afterAll(() => {
  try {
    closeDb();
  } catch {
    // ignore
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('restart persistence', () => {
  it('keeps saved content available after the database connection is reopened', () => {
    const id = storeContent('Restart searchable', 'restarttoken remains indexed');
    expect(id).toBeGreaterThan(0);

    closeDb();

    const all = getAllContent();
    const match = all.find((c) => c.id === id);
    expect(match).toBeDefined();
    expect(match?.title).toBe('Restart searchable');
    expect(match?.body).toBe('restarttoken remains indexed');
  });

  it('keeps saved content searchable after the database connection is reopened', () => {
    storeContent('Fresh FTS entry', 'walrus keyword appears here');
    closeDb();

    const results = searchContent('walrus');
    expect(results.length).toBeGreaterThan(0);
    expect(results.map((r) => r.title)).toContain('Fresh FTS entry');
  });
});
