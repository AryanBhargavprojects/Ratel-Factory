import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const baseTmpDir = mkdtempSync(join(tmpdir(), 'test-dir1-keyword-bm25-'));
let dbPathIndex = 0;

function freshDbPath(): string {
  return join(baseTmpDir, `app-${dbPathIndex++}.db`);
}

let storeContent: (title: string, body: string) => number;
let searchContent: (query: string) => import('@/lib/search').SearchResult[];
let closeDb: () => void;

beforeEach(async () => {
  process.env.SQLITE_DB_PATH = freshDbPath();
  const db = await import('@/lib/db');
  const search = await import('@/lib/search');
  db.closeDb();
  storeContent = db.storeContent;
  searchContent = search.searchContent;
  closeDb = db.closeDb;
});

afterAll(() => {
  rmSync(baseTmpDir, { recursive: true, force: true });
});

function seedContent(): void {
  storeContent('Apple orchard', 'apples apples orchard fruit harvest');
  storeContent('Apple database', 'apple sqlite keyword search bm25 ranking');
  storeContent('Banana smoothie', 'banana yogurt blender fruit');
  storeContent('Vehicle maintenance', 'automobile engine oil tires');
}

describe('keyword BM25 search acceptance', () => {
  it('returns matching stored items for a keyword query', () => {
    seedContent();

    const results = searchContent('apple');
    const titles = results.map((r) => r.title);

    expect(titles).toContain('Apple orchard');
    expect(titles).toContain('Apple database');
    expect(titles).not.toContain('Banana smoothie');
    expect(titles).not.toContain('Vehicle maintenance');
  });

  it('returns the same ordered list for the same query over unchanged content', () => {
    seedContent();

    const first = searchContent('apple').map((r) => r.title);
    const second = searchContent('apple').map((r) => r.title);
    const third = searchContent('apple').map((r) => r.title);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(second[0]).toBe(first[0]);
    expect(third[0]).toBe(first[0]);
  });

  it('matches terms from both title and body', () => {
    seedContent();

    const results = searchContent('sqlite');
    const titles = results.map((r) => r.title);

    expect(titles).toContain('Apple database');
    expect(results.some((r) => r.body.includes('sqlite'))).toBe(true);
  });

  it('ranks denser keyword matches higher than sparse mentions', () => {
    seedContent();
    storeContent('Single apple mention', 'apple once');

    const results = searchContent('apple');
    const titles = results.map((r) => r.title);

    const orchardIndex = titles.indexOf('Apple orchard');
    const singleIndex = titles.indexOf('Single apple mention');

    expect(orchardIndex).toBeGreaterThanOrEqual(0);
    expect(singleIndex).toBeGreaterThanOrEqual(0);
    expect(orchardIndex).toBeLessThan(singleIndex);
  });

  it('favours items that match more query terms in multi-term queries', () => {
    seedContent();
    storeContent('BM25 primer', 'bm25 is a ranking function');
    storeContent('SQLite guide', 'sqlite is a database');

    const results = searchContent('sqlite bm25 ranking');
    const titles = results.map((r) => r.title);

    const databaseIndex = titles.indexOf('Apple database');
    const singleTermMatches = [
      titles.indexOf('BM25 primer'),
      titles.indexOf('SQLite guide'),
    ];

    expect(databaseIndex).toBeGreaterThanOrEqual(0);
    expect(singleTermMatches.some((i) => i >= 0)).toBe(true);
    expect(
      singleTermMatches
        .filter((i) => i >= 0)
        .every((i) => databaseIndex < i)
    ).toBe(true);
  });

  it('does not return semantic-only synonyms without keyword overlap', () => {
    seedContent();

    const results = searchContent('car');
    const titles = results.map((r) => r.title);

    expect(titles).not.toContain('Vehicle maintenance');
  });

  it('returns an empty array for queries with no keyword matches', () => {
    seedContent();

    const results = searchContent('zebra');

    expect(results).toEqual([]);
  });

  it('ignores punctuation and case when retrieving keywords', () => {
    seedContent();

    const results = searchContent('APPLE!');
    const titles = results.map((r) => r.title);

    expect(titles).toContain('Apple orchard');
    expect(titles).toContain('Apple database');
  });

  it('returns all stored content for an empty query', () => {
    seedContent();

    const results = searchContent('');
    const titles = results.map((r) => r.title);

    expect(titles).toContain('Apple orchard');
    expect(titles).toContain('Apple database');
    expect(titles).toContain('Banana smoothie');
    expect(titles).toContain('Vehicle maintenance');
  });
});
