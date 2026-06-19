import { searchByKeyword, type Content } from './db';

export type SearchResult = Content;

export function searchContent(query: string): SearchResult[] {
  return searchByKeyword(query);
}
