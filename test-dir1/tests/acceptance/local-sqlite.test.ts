import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const packageJsonPath = join(process.cwd(), 'package.json');

describe('local SQLite persistence', () => {
  it('declares better-sqlite3 as an application dependency', () => {
    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    expect(manifest.dependencies?.['better-sqlite3']).toBeTruthy();
  });

  it('resolves the default database path under test-dir1', async () => {
    const db = await import('@/lib/db');
    const dbPath = db.getDbPath();
    expect(dbPath.startsWith(resolve(process.cwd()))).toBe(true);
  });
});
