// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ContentPage from '@/app/content/[id]/page';

const getContentById = vi.fn();
vi.mock('@/lib/db', () => ({
  getContentById: (...args: unknown[]) => getContentById(...args),
}));

describe('content detail page', () => {
  it('renders the full title and body for a stored item', async () => {
    const longBody = 'word '.repeat(1200).trim();
    getContentById.mockReturnValue({
      id: 7,
      title: 'Long note',
      body: longBody,
      createdAt: Date.now(),
    });

    const jsx = await ContentPage({ params: { id: '7' } });
    render(jsx);

    expect(screen.getByRole('heading', { name: 'Long note' })).toBeInTheDocument();
    expect(screen.getByText(longBody)).toBeInTheDocument();
    expect(longBody.length).toBeGreaterThanOrEqual(5000);
  });
});
