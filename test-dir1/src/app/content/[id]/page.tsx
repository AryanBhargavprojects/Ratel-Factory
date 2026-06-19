import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getContentById } from '@/lib/db';

export const dynamic = 'force-dynamic';

type ContentPageProps = {
  params: { id: string };
};

export default async function ContentPage({ params }: ContentPageProps) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    notFound();
  }

  const content = getContentById(id);
  if (!content) {
    notFound();
  }

  return (
    <main>
      <article>
        <h1>{content.title}</h1>
        <p className="body-full">{content.body}</p>
      </article>
      <p>
        <Link href="/">Back to all content</Link>
      </p>
    </main>
  );
}
