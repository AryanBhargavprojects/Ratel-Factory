import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'test-dir1-search-'));
process.env.SQLITE_DB_PATH = join(tmpDir, 'app.db');

let storeContent: (title: string, body: string) => number;
let searchContent: (query: string) => import('@/lib/search').SearchResult[];

beforeAll(async () => {
  const db = await import('@/lib/db');
  const search = await import('@/lib/search');
  storeContent = db.storeContent;
  searchContent = search.searchContent;
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('search', () => {
  it('ranks documents with more keyword occurrences higher', () => {
    // Both documents match "apple"; one mentions it more often.
    storeContent('One apple', 'An apple a day');
    storeContent('Many apple', 'apple apple apple');

    const results = searchContent('apple');
    expect(results.length).toBe(2);
    expect(results[0].title).toContain('Many');
    expect(results[1].title).toContain('One');
  });

  it('is case-insensitive', () => {
    storeContent('Banana', 'YELLOW fruit');

    const results = searchContent('yellow');
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Banana');
  });

  it('returns all content when query is empty', () => {
    storeContent('A', 'alpha');
    storeContent('B', 'beta');

    const results = searchContent('');
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('returns an empty array when nothing matches', () => {
    storeContent('Zebra', 'stripes');

    const results = searchContent('xyzzy');
    expect(results).toEqual([]);
  });
});
