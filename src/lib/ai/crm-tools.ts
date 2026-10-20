/**
 * Kasturi (CRM) tools for Tuah: looking up contacts, deals, pipelines,
 * follow-ups and the calendar, and changing them. Every query runs as the signed-in user and is narrowed to
 * their workspace; the `org_id` never comes from the model. Changes go through
 * the same functions and the same field rules as the Kasturi screens, and each
 * one waits for the user's approval before it runs (see `CRM_WRITE_TOOL_NAMES`).
 */

import { errorCodeOf } from '@/lib/ai/call-log';
import { tool } from 'ai';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  CrmContactFormError,
  createCrmContact,
  deleteCrmContact,
  parseCrmContactFields,
  updateCrmContact,
} from '@/lib/crm/contacts';
import {
  createCrmDeal,
  deleteCrmDeal,
  listCrmDeals,
  markCrmDealLost,
  moveCrmDeal,
  parseCrmDealForm,
  reopenCrmDeal,
  updateCrmDeal,
  MAX_LOST_REASON_LENGTH,
  type CrmDeal,
} from '@/lib/crm/deals';
import { buildBillings } from '@/lib/crm/billings';
import { loadCrmCalendar, parseMonth } from '@/lib/crm/calendar';
import { listDealInvoiceLinks } from '@/lib/crm/invoice-links';
import { listInvoices } from '@/lib/finance/invoices';
import { listPaymentsIn, receivedRinggitByInvoice } from '@/lib/finance/money';
import { klDay } from '@/lib/crm/deal-stats';
import { completeFollowUp, createFollowUp, parseFollowUpForm } from '@/lib/crm/follow-ups';
import {
  ensureDefaultPipeline,
  listCrmPipelines,
  needsDefaultPipeline,
  type CrmPipeline,
} from '@/lib/crm/pipelines';
import { LOST_REASON_REQUIRED_MESSAGE, loadCrmSettings } from '@/lib/crm/settings';
import { limitSchema, rowLimit } from '@/lib/ai/limits';
import { rm } from '@/lib/reach/format';

/** Who is asking and where, and whether they may change anything. */
export type CrmAccess = {
  client: SupabaseClient;
  orgId: string;
  userId: string;
  canWrite: boolean;
  /**
   * The workspace's rule that a deal marked lost needs a reason (Kasturi > Settings). Off when left out. With it
   * on, `markDealLost` refuses a call with no reason at its input check, so no Approve card is shown for a change
   * the database would refuse. The database enforces the rule either way.
   */
  requireLostReason?: boolean;
};

/** Tools that change CRM data: each one pauses for the user's approval before running. */
export const CRM_WRITE_TOOL_NAMES = [
  'createContact',
  'updateContact',
  'deleteContact',
  'createDeal',
  'updateDeal',
  'moveDeal',
  'markDealLost',
  'reopenDeal',
  'deleteDeal',
  'createFollowUp',
  'completeFollowUp',
] as const;

const CONTACT_STATUSES = ['lead', 'contacted', 'qualified', 'customer', 'archived'] as const;
const CONTACT_COLUMNS =
  'id,first_name,last_name,email,phone,company,country,status,lead_score,tags,created_at';

type FollowUpRow = {
  id: string;
  title: string;
  due_at: string | null;
  contact_id: string | null;
};

type ContactRow = {
  id: string;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  country: string | null;
  status: string;
  lead_score: number;
  tags: string[] | null;
};

const fullName = (row: { first_name: string; last_name: string | null }) =>
  [row.first_name, row.last_name].filter(Boolean).join(' ');

function contactOut(row: ContactRow) {
  return {
    id: row.id,
    name: fullName(row),
    email: row.email,
    phone: row.phone,
    company: row.company,
    country: row.country,
    status: row.status,
    lead_score: row.lead_score,
    tags: row.tags ?? [],
  };
}

/** A search typed by the model, made safe to drop into a filter. */
function searchTerm(value: string | undefined): string | null {
  const term = (value ?? '').replace(/[%,()*\\]/g, ' ').replace(/\s+/g, ' ').trim();
  return term ? term.slice(0, 80) : null;
}

function form(values: Record<string, unknown>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) data.set(key, String(value));
  }
  return data;
}

type Outcome<T> = { ok: true; data: T } | { ok: false; error: string };

/** Runs a change and reports a problem with what was asked as a plain message. */
async function attempt<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    if (error instanceof CrmContactFormError) return { ok: false, error: error.message };
    // The code only: a database error's message quotes the values it refused (a contact's details).
    console.error('[tuah] CRM change failed:', errorCodeOf(error));
    return { ok: false, error: 'That change could not be saved. Please try again.' };
  }
}

function stageNames(pipelines: CrmPipeline[]): Map<string, { stage: string; pipeline: string }> {
  const names = new Map<string, { stage: string; pipeline: string }>();
  for (const pipeline of pipelines) {
    for (const stage of pipeline.stages) {
      names.set(stage.id, { stage: stage.name, pipeline: pipeline.name });
    }
  }
  return names;
}

function dealOut(deal: CrmDeal, stages: Map<string, { stage: string; pipeline: string }>) {
  return {
    id: deal.id,
    // `name` is what an approval card calls the deal.
    name: deal.title,
    contact: deal.contactName || deal.company,
    company: deal.company,
    value: rm(Math.round(deal.value * 100)),
    status: deal.status,
    stage: stages.get(deal.stageId)?.stage ?? null,
    pipeline: stages.get(deal.stageId)?.pipeline ?? null,
    stage_id: deal.stageId,
    expected_close: deal.expectedClose,
    owner: deal.owner,
    lost_reason: deal.lostReason,
  };
}

export type DealStats = {
  total: number;
  open: { count: number; value: string };
  won: { count: number; value: string };
  lost: { count: number; value: string };
  /** Open deals per stage, in board order. */
  open_by_stage: { pipeline: string; stage: string; count: number; value: string }[];
};

/** Totals for the deals board, worked out from the deals themselves. */
export function deriveDealStats(deals: CrmDeal[], pipelines: CrmPipeline[]): DealStats {
  const sum = (status: CrmDeal['status']) => {
    const rows = deals.filter((d) => d.status === status);
    return {
      count: rows.length,
      value: rm(Math.round(rows.reduce((total, d) => total + d.value, 0) * 100)),
    };
  };
  const open = deals.filter((d) => d.status === 'open');
  return {
    total: deals.length,
    open: sum('open'),
    won: sum('won'),
    lost: sum('lost'),
    open_by_stage: pipelines.flatMap((pipeline) =>
      pipeline.stages
        .map((stage) => {
          const rows = open.filter((d) => d.stageId === stage.id);
          return {
            pipeline: pipeline.name,
            stage: stage.name,
            count: rows.length,
            value: rm(Math.round(rows.reduce((total, d) => total + d.value, 0) * 100)),
          };
        })
        .filter((row) => row.count > 0),
    ),
  };
}

const idSchema = z.string().uuid();
const contactFields = {
  firstName: z.string().min(1).describe('First name.'),
  lastName: z.string().optional().describe('Last name.'),
  email: z.string().describe('Email address. Required for every contact.'),
  phone: z.string().optional(),
  company: z.string().optional(),
  country: z.string().optional().describe('Two-letter country code, such as MY (the default).'),
  status: z.enum(CONTACT_STATUSES).optional().describe('Defaults to lead.'),
  leadScore: z.number().int().min(0).max(100).optional(),
  tags: z.array(z.string()).optional().describe('Up to 10 short labels.'),
};
const dealFields = {
  title: z.string().min(1).describe('What the deal is, such as "Annual plan".'),
  contactId: idSchema.describe('The id of the contact the deal is for, from listCrmContacts.'),
  stageId: idSchema.describe('The id of the stage it starts in, from listPipelines.'),
  value: z.number().min(0).optional().describe('Value in ringgit, such as 18000.'),
  tag: z.string().optional(),
  expectedCloseDate: z.string().optional().describe('YYYY-MM-DD.'),
};

/**
 * Gives a workspace its starting pipeline when it has none, as opening the Deals screen does. A chat route calls
 * this once, for someone who may edit, before the assistant runs: a deal cannot be added without a stage to put
 * it in. It is a write, so it lives here and not in a lookup tool. Never throws: without a pipeline the assistant
 * simply finds none.
 */
export async function ensureCrmPipeline(client: SupabaseClient, orgId: string): Promise<void> {
  try {
    if (needsDefaultPipeline(await listCrmPipelines(client, orgId))) await ensureDefaultPipeline(client, orgId);
  } catch (error) {
    console.error('[tuah] could not set up the default pipeline:', errorCodeOf(error));
  }
}

/**
 * Whether the workspace requires a reason to mark a deal lost, for `CrmAccess.requireLostReason`. A chat route
 * reads it once, for someone who may edit, before the assistant runs. Never throws: if it cannot be read the rule
 * counts as off here, and the database still refuses a lost deal with no reason.
 */
export async function loadRequireLostReason(client: SupabaseClient, orgId: string): Promise<boolean> {
  try {
    return (await loadCrmSettings(client, orgId)).requireLostReason;
  } catch (error) {
    console.error('[tuah] could not read the Kasturi settings:', errorCodeOf(error));
    return false;
  }
}

/** Builds Tuah's CRM tools for one request. Without write access only the lookups exist. */
export function createCrmTools(access: CrmAccess) {
  const { client, orgId } = access;

  // A lookup only reads. A new workspace's first pipeline is set up before the tools are built
  // (`ensureCrmPipeline`, called by the chat routes for someone who may edit), never from here.
  const pipelines = () => listCrmPipelines(client, orgId);

  const readContact = async (id: string): Promise<ContactRow> => {
    const { data, error } = await client
      .from('crm_contacts')
      .select(CONTACT_COLUMNS)
      .eq('org_id', orgId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new CrmContactFormError('That contact no longer exists.');
    return data as unknown as ContactRow;
  };

  const read = {
    listCrmContacts: tool({
      description:
        'CRM contacts in Kasturi, newest first: id, name, email, phone, company, status, lead score and tags. ' +
        'Optionally search by name, email or company, or filter by status. Also returns the total in the workspace.',
      inputSchema: z.object({
        search: z.string().optional().describe('Part of a name, email or company.'),
        status: z.enum(CONTACT_STATUSES).optional(),
        limit: limitSchema('Max rows to return (default 20, at most 50).'),
      }),
      execute: async ({ search, status, limit }) => {
        let query = client
          .from('crm_contacts')
          .select(CONTACT_COLUMNS, { count: 'exact' })
          .eq('org_id', orgId);
        if (status) query = query.eq('status', status);
        const term = searchTerm(search);
        // Every word must be found somewhere, so "Hana Lee" matches a first
        // name of Hana and a last name of Lee.
        for (const word of (term ?? '').split(' ').filter(Boolean).slice(0, 5)) {
          query = query.or(
            ['first_name', 'last_name', 'email', 'company']
              .map((column) => `${column}.ilike.%${word}%`)
              .join(','),
          );
        }
        const { data, count, error } = await query
          .order('created_at', { ascending: false })
          .limit(rowLimit(limit, 20));
        if (error) throw error;
        const rows = (data ?? []) as unknown as ContactRow[];
        return { total_matching: count ?? rows.length, contacts: rows.map(contactOut) };
      },
    }),

    listDeals: tool({
      description:
        'Deals on the Kasturi board, newest first: id, name (the title), contact, company, value (RM), status, ' +
        'stage and pipeline. Optionally filter by status or search the title, contact or company.',
      inputSchema: z.object({
        status: z.enum(['open', 'won', 'lost']).optional(),
        search: z.string().optional().describe('Part of a title, contact name or company.'),
        limit: limitSchema('Max rows to return (default 20, at most 50).'),
      }),
      execute: async ({ status, search, limit }) => {
        const [{ deals, total }, list] = await Promise.all([
          listCrmDeals(client, orgId, 500),
          pipelines(),
        ]);
        // Every word must be found in the title, the contact or the company.
        const words = (searchTerm(search)?.toLowerCase() ?? '').split(' ').filter(Boolean);
        const matching = deals
          .filter((d) => (status ? d.status === status : true))
          .filter((d) => {
            const haystack = [d.title, d.contactName, d.company].join(' ').toLowerCase();
            return words.every((word) => haystack.includes(word));
          });
        const stages = stageNames(list);
        return {
          total_in_workspace: total,
          total_matching: matching.length,
          deals: matching.slice(0, rowLimit(limit, 20)).map((d) => dealOut(d, stages)),
        };
      },
    }),

    listPipelines: tool({
      description:
        'The sales pipelines and their stages, in board order, with the id of each stage. ' +
        'Use a stage id when adding or moving a deal.',
      inputSchema: z.object({}),
      execute: async () =>
        (await pipelines()).map((pipeline) => ({
          id: pipeline.id,
          name: pipeline.name,
          is_default: pipeline.isDefault,
          stages: pipeline.stages.map((stage) => ({
            id: stage.id,
            name: stage.name,
            probability_pct: stage.probability,
          })),
        })),
    }),

    getDealStats: tool({
      description:
        'Totals for the deals board: how many deals are open, won and lost and what they are worth (RM), ' +
        'and open deals broken down by stage.',
      inputSchema: z.object({}),
      execute: async () => {
        const [{ deals }, list] = await Promise.all([listCrmDeals(client, orgId, 500), pipelines()]);
        return deriveDealStats(deals, list);
      },
    }),

    listFollowUps: tool({
      description:
        'Open follow-ups (reminders to get back to a contact), soonest due first: id, name (what to do), ' +
        'the contact, the due date (YYYY-MM-DD, or null) and whether it is overdue. Finished ones are not listed.',
      inputSchema: z.object({
        contactId: idSchema.optional().describe('Only this contact’s follow-ups.'),
        limit: limitSchema('Max rows to return (default 20, at most 50).'),
      }),
      execute: async ({ contactId, limit }) => {
        let query = client
          .from('crm_activities')
          .select('id,title,due_at,contact_id', { count: 'exact' })
          .eq('org_id', orgId)
          .eq('type', 'task')
          .is('completed_at', null);
        if (contactId) query = query.eq('contact_id', contactId);
        const { data, count, error } = await query
          .order('due_at', { ascending: true, nullsFirst: false })
          .limit(rowLimit(limit, 20));
        if (error) throw error;
        const rows = (data ?? []) as unknown as FollowUpRow[];

        const contactIds = [...new Set(rows.map((row) => row.contact_id))].filter(
          (id): id is string => Boolean(id),
        );
        const names = new Map<string, string>();
        if (contactIds.length > 0) {
          const contacts = await client
            .from('crm_contacts')
            .select('id,first_name,last_name')
            .eq('org_id', orgId)
            .in('id', contactIds);
          if (contacts.error) throw contacts.error;
          for (const row of (contacts.data ?? []) as unknown as ContactRow[]) {
            names.set(row.id, fullName(row));
          }
        }

        const today = klDay(new Date());
        return {
          total_open: count ?? rows.length,
          follow_ups: rows.map((row) => {
            // A due date is stored as midnight UTC of the chosen day.
            const due = row.due_at ? row.due_at.slice(0, 10) : null;
            return {
              id: row.id,
              // `name` is what an approval card calls the follow-up.
              name: row.title,
              contact: row.contact_id ? (names.get(row.contact_id) ?? null) : null,
              contact_id: row.contact_id,
              due,
              overdue: due !== null && due < today,
            };
          }),
        };
      },
    }),

    getCalendar: tool({
      description:
        'The Kasturi calendar for one month: appointments, open follow-ups by due date and open deals by expected ' +
        'close date, in date order. Every date and time is already in Malaysian time: say them as given, never add or ' +
        'subtract hours. Also counts for today, the next 7 days and the next 30 days. Leave the month out for the current month.',
      inputSchema: z.object({
        month: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .optional()
          .describe('YYYY-MM. Defaults to the current month in Malaysia.'),
      }),
      execute: async ({ month }) => {
        const now = new Date();
        const calendar = await loadCrmCalendar(client, orgId, parseMonth(month, now), now);
        return {
          month: calendar.month,
          today_in_malaysia: klDay(now),
          counts: {
            today: calendar.stats.today,
            next_7_days: calendar.stats.next7,
            in_month: calendar.stats.inMonth,
            next_30_days: calendar.stats.next30,
          },
          entries: calendar.days.flatMap((day) =>
            day.items.map((item) => ({
              date_in_malaysia: item.day,
              time_in_malaysia: item.time,
              kind: item.kind,
              what: item.label,
            })),
          ),
        };
      },
    }),

    getBillingSummary: tool({
      description:
        'Billing totals from the workspace’s sales invoices (kept in Bendahara), in RM: billed this month, what is ' +
        'outstanding and overdue, money received, the collection rate, invoice counts by status and the customers ' +
        'billed the most. Drafts and void invoices are not counted as billed. Invoices are read-only here.',
      inputSchema: z.object({}),
      execute: async () => {
        const [invoices, payments] = await Promise.all([
          listInvoices({ client, orgId }),
          listPaymentsIn({ client, orgId }),
        ]);
        const model = buildBillings(invoices, new Date(), new Map(), payments);
        return {
          month: model.monthTitle,
          billed_this_month_rm: model.stats.billedThisMonth,
          invoices_this_month: model.stats.billedThisMonthCount,
          outstanding_rm: model.stats.outstanding,
          outstanding_invoices: model.stats.outstandingCount,
          overdue_rm: model.stats.overdue,
          overdue_invoices: model.stats.overdueCount,
          received_rm: model.stats.received,
          collection_rate_pct: model.stats.collectionRate,
          invoices_by_status: Object.fromEntries(model.byStatus.map(({ status, count }) => [status, count])),
          top_customers: model.topCustomers.map((customer) => ({
            customer: customer.name,
            billed_rm: customer.billed,
            outstanding_rm: customer.outstanding,
          })),
        };
      },
    }),

    listBillingInvoices: tool({
      description:
        'Sales invoices (kept in Bendahara), newest first: number, customer, dates (YYYY-MM-DD), total, paid and ' +
        'balance in RM, status and the deal it is linked to. Filter by status, by a contact (the invoices of the ' +
        'billing customer that contact is linked to) or by a deal (the invoices linked to it). Read-only: invoices ' +
        'are created and changed on Bendahara’s Invoices screen.',
      inputSchema: z.object({
        status: z.enum(['draft', 'sent', 'overdue', 'paid', 'void']).optional(),
        contactId: idSchema.optional().describe('Only invoices of this contact’s billing customer.'),
        dealId: idSchema.optional().describe('Only invoices linked to this deal.'),
        limit: limitSchema('Max rows to return (default 20, at most 50).'),
      }),
      execute: async ({ status, contactId, dealId, limit }) => {
        let customerId: string | null = null;
        if (contactId) {
          const { data, error } = await client
            .from('crm_contacts')
            .select('id,finance_customer_id')
            .eq('org_id', orgId)
            .eq('id', contactId)
            .maybeSingle();
          if (error) throw error;
          if (!data) return { total_matching: 0, invoices: [], note: 'That contact no longer exists.' };
          customerId = (data as { finance_customer_id: string | null }).finance_customer_id;
          if (!customerId) {
            return {
              total_matching: 0,
              invoices: [],
              note: 'This contact has no billing customer. One is chosen on the contact’s edit form in Kasturi.',
            };
          }
        }

        const [invoices, payments, links, { deals }] = await Promise.all([
          listInvoices({ client, orgId }),
          listPaymentsIn({ client, orgId }),
          listDealInvoiceLinks(client, orgId),
          listCrmDeals(client, orgId, 500),
        ]);
        // What actually arrived, as Bendahara shows it; the balance below still counts what the payments carried.
        const arrived = receivedRinggitByInvoice(payments);
        const dealOf = new Map(links.map((link) => [link.invoiceId, link.dealId] as const));
        const titles = new Map(deals.map((deal) => [deal.id, deal.title] as const));

        const matching = invoices
          .filter((invoice) => (status ? invoice.display_status === status : true))
          .filter((invoice) => (customerId ? invoice.customer_id === customerId : true))
          .filter((invoice) => (dealId ? dealOf.get(invoice.id) === dealId : true));
        return {
          total_matching: matching.length,
          invoices: matching.slice(0, rowLimit(limit, 20)).map((invoice) => {
            const linked = dealOf.get(invoice.id);
            return {
              number: invoice.invoice_no ?? 'Draft',
              customer: invoice.customer_name,
              invoice_date: invoice.invoice_date,
              due_date: invoice.due_date,
              // In ringgit: an invoice in another currency at its own rate (null while a draft has no rate).
              total_rm: invoice.total_myr,
              paid_rm: arrived.get(invoice.id) ?? 0,
              // Nothing is owed on a void invoice, whatever it totalled.
              balance_rm: invoice.display_status === 'void' ? 0 : invoice.balance_myr,
              // An invoice in another currency also says its own currency and total.
              ...(invoice.currency === 'MYR' ? {} : { currency: invoice.currency, total_in_currency: invoice.total }),
              status: invoice.display_status,
              deal: linked ? (titles.get(linked) ?? null) : null,
            };
          }),
        };
      },
    }),
  };

  // A caller who cannot write gets no change tools at all (not merely gated ones).
  if (!access.canWrite) return read;

  const readDealFields = async (id: string) => {
    const { data, error } = await client
      .from('crm_deals')
      .select('id,title,contact_id,stage_id,value_cents,tag,expected_close_date')
      .eq('org_id', orgId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new CrmContactFormError('That deal no longer exists.');
    return data as {
      id: string;
      title: string | null;
      contact_id: string;
      stage_id: string;
      value_cents: number | null;
      tag: string | null;
      expected_close_date: string | null;
    };
  };

  return {
    ...read,

    createContact: tool({
      description: 'Add a contact to Kasturi. Needs the user’s approval before it is saved.',
      inputSchema: z.object(contactFields),
      execute: async (input) =>
        attempt(async () => {
          const fields = parseCrmContactFields(
            form({ ...input, tags: input.tags?.join(', ') }),
          );
          const contact = await createCrmContact(client, {
            org_id: orgId,
            ...fields,
            owner_user_id: access.userId,
          });
          return { id: contact.id, name: [contact.first, contact.last].filter(Boolean).join(' ') };
        }),
    }),

    updateContact: tool({
      description:
        'Edit a contact by id. Give only the fields that change; the rest stay as they are. Needs approval.',
      inputSchema: z.object({
        id: idSchema,
        firstName: z.string().min(1).optional(),
        lastName: contactFields.lastName,
        email: z.string().optional(),
        phone: contactFields.phone,
        company: contactFields.company,
        country: contactFields.country,
        status: contactFields.status,
        leadScore: contactFields.leadScore,
        tags: contactFields.tags,
      }),
      execute: async ({ id, ...changes }) =>
        attempt(async () => {
          const now = await readContact(id);
          const fields = parseCrmContactFields(
            form({
              firstName: changes.firstName ?? now.first_name,
              lastName: changes.lastName ?? now.last_name,
              email: changes.email ?? now.email,
              phone: changes.phone ?? now.phone,
              company: changes.company ?? now.company,
              country: changes.country ?? now.country,
              status: changes.status ?? now.status,
              leadScore: changes.leadScore ?? now.lead_score,
              tags: (changes.tags ?? now.tags ?? []).join(', '),
            }),
          );
          await updateCrmContact(client, orgId, id, fields);
          return { id, name: [fields.first_name, fields.last_name].filter(Boolean).join(' ') };
        }),
    }),

    deleteContact: tool({
      description:
        'Delete a contact by id. Their deals go with them. This cannot be undone and needs approval.',
      inputSchema: z.object({ id: idSchema }),
      execute: async ({ id }) =>
        attempt(async () => {
          const now = await readContact(id);
          await deleteCrmContact(client, orgId, id);
          return { id, name: fullName(now) };
        }),
    }),

    createDeal: tool({
      description:
        'Add a deal for a contact, in a stage of a pipeline. Get the contact id from listCrmContacts ' +
        'and the stage id from listPipelines first. Needs approval.',
      inputSchema: z.object(dealFields),
      execute: async (input) =>
        attempt(async () => {
          const fields = parseCrmDealForm(form(input));
          await createCrmDeal(client, orgId, fields, access.userId);
          // The id lets a follow-up ("move it", "mark it lost") name this deal.
          const { data } = await client
            .from('crm_deals')
            .select('id')
            .eq('org_id', orgId)
            .eq('contact_id', fields.contact_id)
            .eq('title', fields.title)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          return {
            ...(data?.id ? { id: data.id as string } : {}),
            name: fields.title,
            value: rm(fields.value_cents),
          };
        }),
    }),

    updateDeal: tool({
      description:
        'Edit a deal by id: its title, value, tag, expected close date or contact. Give only what changes. ' +
        'To change its stage use moveDeal. Needs approval.',
      inputSchema: z.object({
        id: idSchema,
        title: dealFields.title.optional(),
        contactId: idSchema.optional(),
        value: dealFields.value,
        tag: dealFields.tag,
        expectedCloseDate: dealFields.expectedCloseDate,
      }),
      execute: async ({ id, ...changes }) =>
        attempt(async () => {
          const now = await readDealFields(id);
          const fields = parseCrmDealForm(
            form({
              title: changes.title ?? now.title,
              contactId: changes.contactId ?? now.contact_id,
              stageId: now.stage_id,
              value: changes.value ?? (now.value_cents ?? 0) / 100,
              tag: changes.tag ?? now.tag,
              expectedCloseDate: changes.expectedCloseDate ?? now.expected_close_date,
            }),
          );
          await updateCrmDeal(client, orgId, id, fields);
          return { id, name: fields.title, value: rm(fields.value_cents) };
        }),
    }),

    moveDeal: tool({
      description:
        'Move a deal to another stage of its own pipeline, by deal id and stage id. ' +
        'Moving it into the stage called Won wins the deal. Needs approval.',
      inputSchema: z.object({ id: idSchema, stageId: idSchema }),
      execute: async ({ id, stageId }) =>
        attempt(async () => {
          const now = await readDealFields(id);
          await moveCrmDeal(client, orgId, id, stageId);
          const stage = stageNames(await pipelines()).get(stageId)?.stage ?? null;
          return { id, name: now.title, stage };
        }),
    }),

    markDealLost: tool({
      // A call that fails this input check gets no Approve card: with the rule on, one without a reason is
      // refused here, and the model is told to ask the user for the reason instead.
      description: access.requireLostReason
        ? 'Mark a deal as lost, by id, with a short reason. This workspace requires a reason to mark a deal lost: ' +
          'if the user has not given one, ask them why the deal was lost before calling this. Needs approval.'
        : 'Mark a deal as lost, by id, with a short reason if one was given. Needs approval.',
      inputSchema: z.object({
        id: idSchema,
        reason: access.requireLostReason
          ? z
              .string(LOST_REASON_REQUIRED_MESSAGE)
              .max(MAX_LOST_REASON_LENGTH)
              .refine((reason) => reason.trim().length > 0, LOST_REASON_REQUIRED_MESSAGE)
          : z.string().max(MAX_LOST_REASON_LENGTH).optional(),
      }),
      execute: async ({ id, reason }) =>
        attempt(async () => {
          const now = await readDealFields(id);
          await markCrmDealLost(client, orgId, id, reason?.trim() || null);
          return { id, name: now.title, status: 'lost' };
        }),
    }),

    reopenDeal: tool({
      description: 'Bring a lost deal back, by id. Needs approval.',
      inputSchema: z.object({ id: idSchema }),
      execute: async ({ id }) =>
        attempt(async () => {
          const now = await readDealFields(id);
          await reopenCrmDeal(client, orgId, id);
          return { id, name: now.title };
        }),
    }),

    deleteDeal: tool({
      description: 'Delete a deal by id. This cannot be undone and needs approval.',
      inputSchema: z.object({ id: idSchema }),
      execute: async ({ id }) =>
        attempt(async () => {
          const now = await readDealFields(id);
          await deleteCrmDeal(client, orgId, id);
          return { id, name: now.title };
        }),
    }),

    createFollowUp: tool({
      description:
        'Add a follow-up (a reminder to get back to a contact), with an optional due date. ' +
        'Get the contact id from listCrmContacts first. Needs approval.',
      inputSchema: z.object({
        contactId: idSchema.describe('The id of the contact to follow up with, from listCrmContacts.'),
        title: z.string().min(1).describe('What to do, such as "Send the quotation".'),
        dueDate: z.string().optional().describe('YYYY-MM-DD.'),
      }),
      execute: async (input) =>
        attempt(async () => {
          const payload = parseFollowUpForm(form(input), orgId, access.userId);
          await createFollowUp(client, payload);
          return { name: payload.title, due: payload.due_at ? payload.due_at.slice(0, 10) : null };
        }),
    }),

    completeFollowUp: tool({
      description: 'Mark a follow-up as done, by id from listFollowUps. Needs approval.',
      inputSchema: z.object({ id: idSchema }),
      execute: async ({ id }) =>
        attempt(async () => {
          const { data, error } = await client
            .from('crm_activities')
            .select('title')
            .eq('org_id', orgId)
            .eq('id', id)
            .eq('type', 'task')
            .maybeSingle();
          if (error) throw error;
          await completeFollowUp(client, orgId, id);
          return { id, name: (data as { title: string } | null)?.title ?? null, done: true };
        }),
    }),
  };
}

export type CrmTools = ReturnType<typeof createCrmTools>;
