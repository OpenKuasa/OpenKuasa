/**
 * The letterhead's source: the workspace's own details, read from the org row every member can already read (no
 * wider read than that: no other table, no private column). The letter screens call this once and hand the result to
 * the pure letterhead rules; {@link logoUrl} turns `logo_path` (and the demo flag) into the image address.
 *
 * Never throws. A failed read is logged as one fixed sentence and answers null, so a letter still shows, only
 * without its letterhead; the screen decides what null looks like.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isLogoPath } from '@/lib/account/logo-url';

/** What a letter's header is made from. `null` for each line that is not set. */
export type Letterhead = {
  name: string;
  registration_no: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  /** `<org>/<uuid>.<png|jpg|webp>`, or null. Use `logoUrl(logo_path, { isDemo })` for the address. */
  logo_path: string | null;
  isDemo: boolean;
};

const optional = (value: unknown): string | null | undefined =>
  value === null || value === undefined ? null : typeof value === 'string' ? value : undefined;

/**
 * The letterhead of the viewer's current workspace. `orgId` is the load context's (null when there is none), and
 * `isDemo` is the viewer's own flag. A logo path that is not of the shape for this workspace is dropped to null.
 */
export async function getLetterhead(ctx: { client: SupabaseClient; orgId: string | null; isDemo: boolean }): Promise<Letterhead | null> {
  if (!ctx.orgId) return null;
  try {
    const { data, error } = await ctx.client
      .from('orgs')
      .select('name, registration_no, address, city, state, postcode, logo_path')
      .eq('id', ctx.orgId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const row = data as Record<string, unknown>;
    const [registration_no, address, city, state, postcode, logo] = [
      optional(row.registration_no),
      optional(row.address),
      optional(row.city),
      optional(row.state),
      optional(row.postcode),
      optional(row.logo_path),
    ];
    if (
      typeof row.name !== 'string' ||
      registration_no === undefined ||
      address === undefined ||
      city === undefined ||
      state === undefined ||
      postcode === undefined ||
      logo === undefined
    ) {
      throw new Error('unexpected row');
    }
    return {
      name: row.name,
      registration_no,
      address,
      city,
      state,
      postcode,
      logo_path: logo !== null && isLogoPath(logo, ctx.orgId) ? logo : null,
      isDemo: ctx.isDemo,
    };
  } catch {
    console.error('[people/letterhead] the workspace details could not be read.');
    return null;
  }
}
