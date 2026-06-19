'use server';

import { revalidatePath } from 'next/cache';
import { storeContent } from './db';
import { searchContent } from './search';

export async function submitContent(formData: FormData) {
  const title = String(formData.get('title') ?? '').trim();
  const body = String(formData.get('body') ?? '').trim();

  if (!title || !body) {
    return { success: false, error: 'Title and body are required.' };
  }

  const id = storeContent(title, body);
  try {
    revalidatePath('/');
  } catch {
    // revalidatePath is only available inside a Next.js request context.
  }
  return { success: true, id };
}

export async function searchContentAction(formData: FormData) {
  const query = String(formData.get('query') ?? '').trim();
  const results = searchContent(query);
  return { success: true, results };
}
