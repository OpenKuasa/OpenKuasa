import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AdSettings,
  Appointment,
  Automation,
  Broadcast,
  Campaign,
  Creative,
  Form,
  FormSubmission,
  Lead,
  ReachData,
} from './types';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { createSeedReachData } from './seed';
import { FORM_COLUMNS } from './forms';
import {
  CAPTURED_CONTACT_COLUMNS,
  CAPTURED_CONTACT_TAGS,
  type CapturedContactRow,
  mergeCapturedLeads,
} from './crm-leads';
import {
  FORM_SUBMISSION_COLUMNS,
  type FormSubmissionRow,
  SUBMISSIONS_SHOWN,
  mapFormSubmission,
} from './form-submissions';

/** The API answers with at most this many rows per request. */
const PAGE_SIZE = 1000;
/** Where reading submission times stops: 20,000 in the window asked for. */
const MAX_TIME_PAGES = 20;

/**
 * RLS-scoped {@link ReachData} over Supabase. Reads are filtered to `orgId`
 * (the caller's current org); Postgres RLS independently guarantees no other
 * org's rows are reachable, so `orgId` is a workspace selector, not the security
 * boundary. Broadcasts/automations have no tables yet (later slices), so their
 * methods return [] rather than erroring.
 */
export function createSupabaseReachData(client: SupabaseClient, orgId: string): ReachData {
  async function rows<T>(table: string, columns: string, order: { col: string; asc: boolean }): Promise<T[]> {
    const { data, error } = await client
      .from(table)
      .select(columns)
      .eq('org_id', orgId)
      .order(order.col, { ascending: order.asc });
    if (error) throw error;
    return (data ?? []) as T[];
  }

  return {
    listCampaigns: () =>
      rows<Campaign>('campaigns', 'id,name,channel,status,leads_count,spend_cents,cpl_cents,created_at', {
        col: 'created_at', asc: false,
      }),
    listLeads: async () => {
      const [leads, captured] = await Promise.all([
        rows<Lead>('leads', 'id,name,channel,stage,source,promoted_contact_id,created_at', { col: 'created_at', asc: false }),
        // Form, landing page and chatbot leads live only in Kasturi.
        client
          .from('crm_contacts')
          .select(CAPTURED_CONTACT_COLUMNS)
          .eq('org_id', orgId)
          .overlaps('tags', CAPTURED_CONTACT_TAGS)
          .order('created_at', { ascending: false })
          .then(({ data, error }) => {
            if (error) throw error;
            return (data ?? []) as CapturedContactRow[];
          }),
      ]);
      return mergeCapturedLeads(leads, captured);
    },
    listAppointments: () =>
      rows<Appointment>('appointments', 'id,contact_name,kind,scheduled_at,via,status,created_at', {
        col: 'scheduled_at', asc: true,
      }),
    listCreatives: () =>
      rows<Creative>('creatives', 'id,campaign_id,name,type,channel,status,body,ctr,created_at', {
        col: 'created_at', asc: false,
      }),
    getAdSettings: async (): Promise<AdSettings | null> => {
      const { data, error } = await client
        .from('ad_settings')
        .select('daily_cap_cents,monthly_cap_cents,currency,automation,notifications,updated_at')
        .eq('org_id', orgId)
        .maybeSingle();
      if (error) throw error;
      return (data as AdSettings) ?? null;
    },
    listForms: () => rows<Form>('forms', FORM_COLUMNS, { col: 'created_at', asc: false }),
    listFormSubmissions: async (formId, limit = SUBMISSIONS_SHOWN): Promise<FormSubmission[]> => {
      const { data, error } = await client
        .from('form_submissions')
        .select(FORM_SUBMISSION_COLUMNS)
        .eq('org_id', orgId)
        .eq('form_id', formId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return ((data ?? []) as unknown as FormSubmissionRow[]).map(mapFormSubmission);
    },
    listFormSubmissionTimes: async (sinceIso): Promise<string[]> => {
      const times: string[] = [];
      // Read a page at a time: one request never answers with more than a page.
      for (let page = 0; page < MAX_TIME_PAGES; page += 1) {
        const { data, error } = await client
          .from('form_submissions')
          .select('created_at')
          .eq('org_id', orgId)
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: false })
          .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
        if (error) throw error;
        const batch = (data ?? []) as { created_at: string }[];
        for (const row of batch) times.push(row.created_at);
        if (batch.length < PAGE_SIZE) break;
      }
      return times;
    },
    listBroadcasts: async (): Promise<Broadcast[]> => [],
    listAutomations: async (): Promise<Automation[]> => [],
  };
}

const EMPTY_REACH_DATA: ReachData = {
  listCampaigns: async () => [],
  listLeads: async () => [],
  listAppointments: async () => [],
  listForms: async () => [],
  listBroadcasts: async () => [],
  listAutomations: async () => [],
  listCreatives: async () => [],
  getAdSettings: async () => null,
};

/**
 * Request-scoped provider selection: RLS-scoped Supabase in prod, the seed
 * fixtures only when no project is configured (dev/preview/tests). One place,
 * so the route and the Overview stay consistent.
 */
export async function getReachData(client: SupabaseClient): Promise<ReachData> {
  if (!hasSupabaseEnv()) return createSeedReachData(); // dev / preview / tests only
  const org = await getCurrentOrg(client);
  // Signed in but not yet in a workspace: show nothing, never the fictional seed.
  return org ? createSupabaseReachData(client, org.orgId) : EMPTY_REACH_DATA;
}
