import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'test-dir1-db-'));
process.env.SQLITE_DB_PATH = join(tmpDir, 'app.db');

let storeContent: (title: string, body: string) => number;
let getContentById: (id: number) => import('@/lib/db').Content | undefined;
let getAllContent: () => import('@/lib/db').Content[];

beforeAll(async () => {
  const db = await import('@/lib/db');
  storeContent = db.storeContent;
  getContentById = db.getContentById;
  getAllContent = db.getAllContent;
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('persistence', () => {
  it('stores content and retrieves it by id', () => {
    const id = storeContent('Hello', 'World body');
    expect(id).toBeGreaterThan(0);

    const content = getContentById(id);
    expect(content).toMatchObject({ id, title: 'Hello', body: 'World body' });
    expect(content?.createdAt).toBeTypeOf('number');
  });

  it('returns all stored content ordered by newest first', () => {
    const first = storeContent('First', 'first body');
    const second = storeContent('Second', 'second body');

    const all = getAllContent();
    const ids = all.map((c) => c.id);
    expect(ids).toContain(first);
    expect(ids).toContain(second);
    expect(ids[0]).toBe(second);
  });

  it('returns undefined for unknown ids', () => {
    const content = getContentById(999999);
    expect(content).toBeUndefined();
  });
});
