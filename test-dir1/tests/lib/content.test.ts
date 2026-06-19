import { describe, it, expect } from 'vitest';
import { makePreview } from '@/lib/content';

describe('content preview', () => {
  it('returns the full body when it is short', () => {
    const body = 'SQLite FTS5 can rank keyword matches using BM25.';
    expect(makePreview(body)).toBe(body);
  });

  it('truncates long bodies without cutting words and adds an ellipsis', () => {
    const body = 'one two three four five six seven eight nine ten';
    const preview = makePreview(body, 20);
    expect(preview.length).toBeLessThanOrEqual(body.length);
    expect(preview.endsWith('…')).toBe(true);
    expect(body.startsWith(preview.replace(/…$/, ''))).toBe(true);
  });

  it('includes the start of a long ordinary text in the preview', () => {
    const words = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(' ');
    const preview = makePreview(words);
    expect(words.startsWith(preview.replace(/…$/, '').trimEnd())).toBe(true);
    expect(preview.endsWith('…')).toBe(true);
  });
});
