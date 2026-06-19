export function makePreview(body: string, maxLength: number = 150): string {
  if (body.length <= maxLength) {
    return body;
  }

  const truncated = body.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  const endIndex = lastSpace > 0 ? lastSpace : maxLength;
  return truncated.slice(0, endIndex).trimEnd() + '…';
}
