// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ContentForm } from '@/components/ContentForm';
import type { SubmitContentResult } from '@/lib/actions';

describe('ContentForm', () => {
  it('renders title and body inputs and a submit button', () => {
    render(<ContentForm action={vi.fn()} />);

    expect(screen.getByLabelText(/title/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/body/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /store content/i })).toBeInTheDocument();
  });

  it('displays a success message when the action succeeds', async () => {
    const action = vi.fn().mockResolvedValue({ success: true, id: 42 } as SubmitContentResult);
    render(<ContentForm action={action} />);

    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'SQLite BM25 notes' } });
    fireEvent.change(screen.getByLabelText(/body/i), { target: { value: 'SQLite FTS5 can rank keyword matches using BM25.' } });
    fireEvent.click(screen.getByRole('button', { name: /store content/i }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/saved/i);
    });
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('displays an error message when the action fails', async () => {
    const action = vi.fn().mockResolvedValue({ success: false, error: 'Title is required.' } as SubmitContentResult);
    render(<ContentForm action={action} />);

    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Some title' } });
    fireEvent.change(screen.getByLabelText(/body/i), { target: { value: 'Some body' } });
    fireEvent.click(screen.getByRole('button', { name: /store content/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/title is required/i);
    });
    expect(action).toHaveBeenCalledTimes(1);
  });
});
