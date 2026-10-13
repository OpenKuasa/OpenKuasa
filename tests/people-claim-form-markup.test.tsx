import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ClaimForm } from '@/components/people/claim-form';

const html = renderToStaticMarkup(
  <ClaimForm disabled={false} error={null} onUpload={vi.fn()} onDiscard={vi.fn()} onSubmit={vi.fn()} onCancel={vi.fn()} />,
);

describe('the claim form\'s receipt control', () => {
  it('shows a Choose file button and says no receipt is attached', () => {
    expect(html).toContain('Choose file');
    expect(html).toContain('No receipt attached.');
  });

  it('keeps the native file input out of sight and out of the tab order, so it cannot say "No file chosen"', () => {
    const input = /<input[^>]*type="file"[^>]*>/.exec(html)?.[0] ?? '';
    expect(input).toContain('sr-only');
    expect(input).toContain('tabindex="-1"');
    expect(input).toContain('aria-hidden="true"');
  });
});
