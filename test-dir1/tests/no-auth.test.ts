import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const srcDir = path.resolve(process.cwd(), 'src');

function readSource(...segments: string[]) {
  return readFileSync(path.join(srcDir, ...segments), 'utf8').toLowerCase();
}

describe('no authentication barrier', () => {
  it('does not include login, signup, logout, or access-denied text in the UI', () => {
    const pageSource = readSource('app', 'page.tsx');
    const forbidden = ['login', 'sign in', 'signin', 'signup', 'sign up', 'logout', 'log out', 'access denied'];
    for (const term of forbidden) {
      expect(pageSource).not.toContain(term);
    }
  });

  it('exposes content submission and search controls', () => {
    const pageSource = readSource('app', 'page.tsx');
    expect(pageSource).toContain('title');
    expect(pageSource).toContain('body');
    expect(pageSource).toContain('query');
  });

  it('does not gate server actions behind authentication', () => {
    const actionsSource = readSource('lib', 'actions.ts');
    const forbidden = ['login', 'signin', 'signup', 'logout', 'auth', 'session', 'password', 'credential'];
    for (const term of forbidden) {
      expect(actionsSource).not.toContain(term);
    }
  });
});
