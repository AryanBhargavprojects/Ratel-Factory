import { searchByKeyword, getAllContent, type Content } from './db';

export type SearchResult = Content;

const TERM_SEPARATOR = /[^a-zA-Z0-9]+/g;

function sanitizeQuery(query: string): string[] {
  return query
    .replace(TERM_SEPARATOR, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

function buildFtsQuery(terms: string[]): string {
  if (terms.length === 0) return '';
  // OR semantics let BM25 rank items that match more terms higher than
  // partial matches, which matches the expected keyword-retrieval behavior.
  if (terms.length === 1) return terms[0];
  return terms.join(' OR ');
}

/**
 * Perform deterministic keyword/BM25-style search over stored content.
 *
 * Empty input is interpreted as a request to list all stored content so the UI
 * can display it as the unfiltered content list. Non-empty input that contains
 * no searchable tokens (e.g. only punctuation) returns an empty result set.
 */
export function searchContent(query: string): SearchResult[] {
  const raw = query.trim();
  if (!raw) {
    return getAllContent();
  }

  const terms = sanitizeQuery(raw);
  if (terms.length === 0) {
    return [];
  }

  return searchByKeyword(buildFtsQuery(terms));
}
