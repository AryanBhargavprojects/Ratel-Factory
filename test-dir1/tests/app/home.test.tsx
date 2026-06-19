// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import HomePage from '@/app/page';

const getAllContent = vi.fn();
const searchContent = vi.fn();

vi.mock('@/lib/db', () => ({
  getAllContent: () => getAllContent(),
}));

vi.mock('@/lib/search', () => ({
  searchContent: (q: string) => searchContent(q),
}));

describe('home page', () => {
  it('lists stored content titles and previews', async () => {
    getAllContent.mockReturnValue([
      { id: 1, title: 'Apple pie recipe', body: 'Use apples cinnamon and crust.', createdAt: 1 },
      { id: 2, title: 'Database indexing', body: 'Indexes improve keyword lookup speed.', createdAt: 2 },
    ]);
    searchContent.mockReturnValue([]);

    const jsx = await HomePage({ searchParams: {} });
    render(jsx);

    expect(screen.getByRole('heading', { name: 'Apple pie recipe' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Database indexing' })).toBeInTheDocument();
    expect(screen.getByText('Use apples cinnamon and crust.')).toBeInTheDocument();
    expect(screen.getByText('Indexes improve keyword lookup speed.')).toBeInTheDocument();
  });

  it('links each item to its detail page', async () => {
    getAllContent.mockReturnValue([
      { id: 5, title: 'SQLite BM25 notes', body: 'SQLite FTS5 can rank keyword matches using BM25.', createdAt: 1 },
    ]);
    searchContent.mockReturnValue([]);

    const jsx = await HomePage({ searchParams: {} });
    render(jsx);

    const link = screen.getByRole('link', { name: 'SQLite BM25 notes' });
    expect(link).toHaveAttribute('href', '/content/5');
  });

  it('shows a preview instead of the full body for long content', async () => {
    const longBody = 'word '.repeat(1200).trim();
    getAllContent.mockReturnValue([
      { id: 3, title: 'Long note', body: longBody, createdAt: 1 },
    ]);
    searchContent.mockReturnValue([]);

    const jsx = await HomePage({ searchParams: {} });
    render(jsx);

    expect(screen.queryByText(longBody)).not.toBeInTheDocument();
    expect(screen.getByText(/word word word/)).toBeInTheDocument();
  });
});
