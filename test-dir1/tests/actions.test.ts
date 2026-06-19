import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'test-dir1-actions-'));
process.env.SQLITE_DB_PATH = join(tmpDir, 'app.db');

let submitContent: (formData: FormData) => Promise<{ success: boolean; id?: number; error?: string }>;
let searchContentAction: (formData: FormData) => Promise<{ success: boolean; results?: import('@/lib/search').SearchResult[]; error?: string }>;

beforeAll(async () => {
  const actions = await import('@/lib/actions');
  submitContent = actions.submitContent;
  searchContentAction = actions.searchContentAction;
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('server actions', () => {
  it('submits content without requiring credentials', async () => {
    const formData = new FormData();
    formData.set('title', 'Action title');
    formData.set('body', 'Action body');

    const result = await submitContent(formData);
    expect(result.success).toBe(true);
    expect(result.id).toBeGreaterThan(0);
  });

  it('searches content without requiring credentials', async () => {
    const storeForm = new FormData();
    storeForm.set('title', 'Searchable note');
    storeForm.set('body', 'needle in a haystack');
    await submitContent(storeForm);

    const searchForm = new FormData();
    searchForm.set('query', 'needle');

    const result = await searchContentAction(searchForm);
    expect(result.success).toBe(true);
    expect(result.results?.length).toBeGreaterThan(0);
    expect(result.results?.[0].body).toContain('needle');
  });

  it('rejects empty title or body', async () => {
    const formData = new FormData();
    formData.set('title', '');
    formData.set('body', '');

    const result = await submitContent(formData);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
