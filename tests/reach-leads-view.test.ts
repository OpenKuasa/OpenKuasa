import { describe, expect, it } from 'vitest';
import { clearDanglingPromotions } from '@/lib/reach/leads-view';
import type { Lead } from '@/lib/reach/types';

const lead = (over: Partial<Lead>): Lead => ({
  id: 'l1',
  name: 'Aisyah',
  channel: 'whatsapp',
  stage: 'lead',
  source: 'ad',
  promoted_contact_id: null,
  created_at: new Date().toISOString(),
  ...over,
});

describe('clearDanglingPromotions', () => {
  it('keeps promoted_contact_id when the CRM contact still exists', () => {
    const [r] = clearDanglingPromotions([lead({ promoted_contact_id: 'c1' })], new Set(['c1']));
    expect(r.promoted_contact_id).toBe('c1');
  });

  it('clears promoted_contact_id when the CRM contact was deleted', () => {
    const [r] = clearDanglingPromotions([lead({ promoted_contact_id: 'c1' })], new Set());
    expect(r.promoted_contact_id).toBeNull();
  });

  it('never touches a lead read from Kasturi, whose promoted_contact_id is its own id', () => {
    const [r] = clearDanglingPromotions([lead({ origin: 'crm', promoted_contact_id: 'l1' })], new Set());
    expect(r.promoted_contact_id).toBe('l1');
  });

  it('leaves an unpromoted lead untouched', () => {
    const [r] = clearDanglingPromotions([lead({ promoted_contact_id: null })], new Set(['c1']));
    expect(r.promoted_contact_id).toBeNull();
  });
});
