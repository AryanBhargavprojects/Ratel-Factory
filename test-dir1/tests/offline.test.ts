import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const srcDir = path.resolve(process.cwd(), 'src');

function walk(dir: string, files: string[] = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      walk(full, files);
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

describe('offline capability', () => {
  it('does not make outbound network calls in application source', () => {
    const forbidden = ['fetch(', 'axios', 'http://', 'https://'];
    for (const file of walk(srcDir)) {
      const source = readFileSync(file, 'utf8').toLowerCase();
      for (const term of forbidden) {
        expect(source).not.toContain(term);
      }
    }
  });

  it('does not require external service configuration', () => {
    const forbidden = ['api key', 'apikey', 'openai', 'anthropic', 'gemini', 'api_token', 'token='];
    for (const file of walk(srcDir)) {
      const source = readFileSync(file, 'utf8').toLowerCase();
      for (const term of forbidden) {
        expect(source).not.toContain(term);
      }
    }
  });
});
