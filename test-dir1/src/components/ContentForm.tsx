'use client';

import { useState } from 'react';
import type { SubmitContentResult } from '@/lib/actions';

type ContentFormProps = {
  action: (formData: FormData) => Promise<SubmitContentResult>;
};

export function ContentForm({ action }: ContentFormProps) {
  const [state, setState] = useState<SubmitContentResult | undefined>(undefined);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);

    const form = event.currentTarget;
    const formData = new FormData(form);
    const result = await action(formData);
    setState(result);

    if (result.success) {
      form.reset();
    }

    setPending(false);
  }

  return (
    <form onSubmit={handleSubmit}>
      <label htmlFor="title">Title</label>
      <input id="title" name="title" type="text" placeholder="Enter a title" required />

      <label htmlFor="body">Body</label>
      <textarea id="body" name="body" placeholder="Enter the content body" required />

      <button type="submit" disabled={pending}>
        {pending ? 'Storing…' : 'Store content'}
      </button>

      {state?.success && (
        <p role="status" className="success">
          Content item saved.
        </p>
      )}
      {state && !state.success && (
        <p role="alert" className="error">
          {state.error}
        </p>
      )}
    </form>
  );
}
