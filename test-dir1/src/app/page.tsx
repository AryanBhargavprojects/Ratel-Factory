import Link from 'next/link';
import { getAllContent } from '@/lib/db';
import { searchContent } from '@/lib/search';
import { submitContent } from '@/lib/actions';
import { ContentForm } from '@/components/ContentForm';
import { makePreview } from '@/lib/content';

export const dynamic = 'force-dynamic';

type PageProps = {
  searchParams?: { q?: string };
};

export default async function HomePage({ searchParams }: PageProps) {
  const query = searchParams?.q ?? '';
  const trimmedQuery = query.trim();
  const isSearch = trimmedQuery.length > 0;
  const results = isSearch ? searchContent(trimmedQuery) : getAllContent();

  return (
    <main>
      <h1>Content storage and search</h1>

      <section aria-labelledby="store-heading">
        <h2 id="store-heading">Store content</h2>
        <ContentForm action={submitContent} />
      </section>

      <section aria-labelledby="search-heading">
        <h2 id="search-heading">Search</h2>
        <form action="/" method="get">
          <label htmlFor="query">Search query</label>
          <input
            id="query"
            name="q"
            type="text"
            placeholder="Type a keyword"
            defaultValue={query}
          />
          <button type="submit">Search</button>
        </form>
      </section>

      <section aria-labelledby="results-heading">
        <h2 id="results-heading">
          {isSearch ? 'Keyword search results' : 'Stored content'}
        </h2>

        {!isSearch && (
          <p className="search-prompt">
            Enter a keyword above to search, or browse the stored content below.
          </p>
        )}

        {isSearch && results.length === 0 && (
          <p className="empty">No matching content was found.</p>
        )}

        {!isSearch && results.length === 0 && (
          <p className="empty">No content yet.</p>
        )}

        {results.length > 0 && (
          <ul>
            {results.map((item) => (
              <li key={item.id}>
                <article>
                  <h3>
                    <Link href={`/content/${item.id}`}>{item.title}</Link>
                  </h3>
                  <p>{makePreview(item.body)}</p>
                </article>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
