import { getAllContent } from '@/lib/db';
import { searchContent } from '@/lib/search';
import { submitContent } from '@/lib/actions';

export const dynamic = 'force-dynamic';

type PageProps = {
  searchParams?: { q?: string };
};

export default async function HomePage({ searchParams }: PageProps) {
  const query = searchParams?.q ?? '';
  const results = query.trim() ? searchContent(query.trim()) : getAllContent();

  return (
    <main>
      <h1>Content storage and search</h1>

      <section aria-labelledby="store-heading">
        <h2 id="store-heading">Store content</h2>
        <form action={submitContent as unknown as (formData: FormData) => void}>
          <label htmlFor="title">Title</label>
          <input id="title" name="title" type="text" placeholder="Enter a title" required />

          <label htmlFor="body">Body</label>
          <textarea id="body" name="body" placeholder="Enter the content body" required />

          <button type="submit">Store content</button>
        </form>
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
        <h2 id="results-heading">{query ? 'Search results' : 'Stored content'}</h2>
        {results.length === 0 ? (
          <p className="empty">No content yet.</p>
        ) : (
          <ul>
            {results.map((item) => (
              <li key={item.id}>
                <strong>{item.title}</strong>
                <p>{item.body}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
