import { revalidatePath } from 'next/cache';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import {
  createCrmDeal,
  deleteCrmDeal,
  getCrmDeal,
  listCrmDealContacts,
  listCrmDeals,
  markCrmDealLost,
  moveCrmDeal,
  parseCrmDealForm,
  readDealId,
  readLostReason,
  readStageId,
  reopenCrmDeal,
  updateCrmDeal,
} from '@/lib/crm/deals';
import type { CrmDealActions, CrmFormState } from '@/lib/crm/form-state';
import {
  dealBilling,
  dealInvoiceChoices,
  listDealInvoiceLinks,
  readDealInvoiceIds,
  setDealInvoices,
} from '@/lib/crm/invoice-links';
import { money } from '@/lib/finance/format';
import { listInvoices } from '@/lib/finance/invoices';
import {
  addCrmPipelineStage,
  createCrmPipeline,
  deleteCrmPipeline,
  deleteCrmPipelineStage,
  ensureDefaultPipeline,
  listCrmPipelines,
  moveCrmPipelineStage,
  needsDefaultPipeline,
  parseCrmPipelineForm,
  parsePipelineName,
  parseStageName,
  parseStageProbability,
  readPipelineId,
  readStageDirection,
  renameCrmPipeline,
  setDefaultCrmPipeline,
  updateCrmPipelineStage,
} from '@/lib/crm/pipelines';
import { loadRecordNotes, readOpenParam, OPEN_PARAM } from '@/lib/crm/notes';
import { runCrmWrite } from '@/lib/crm/run-write';
import { loadCrmSettings } from '@/lib/crm/settings';
import { errorCodeOf } from '@/lib/ai/call-log';
import { createClient } from '@/lib/supabase/server';
import { CouldntLoad } from '@/components/crm/couldnt-load';
import DealsScreen from './deals';

const DEALS_PATH = '/crm/deals';

/**
 * How many deals the page loads, across every pipeline. The board, its
 * figures, search and the filters all run in the browser over these, so this
 * is also how far they reach.
 */
const DEALS_LOADED = 500;

/** How many contacts the New Deal form offers. */
const CONTACTS_OFFERED = 1000;

function runWrite(formData: FormData, failure: string, write: () => Promise<void>) {
  return runCrmWrite(DEALS_PATH, formData, failure, write);
}

/**
 * A change to a pipeline's stages. Some are several writes in a row, so one
 * that stopped part-way, or found the stages changed by someone else, has
 * still left the page out of date: it is loaded afresh on a failure too.
 */
async function runStageWrite(formData: FormData, failure: string, write: () => Promise<void>) {
  const state = await runWrite(formData, failure, write);
  if (state && !state.ok) revalidatePath(DEALS_PATH);
  return state;
}

async function saveDealAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId, userId } = await getViewer();
  const supabase = await createClient();

  return runWrite(formData, 'Could not save the deal.', async () => {
    if (formData.has('dealId')) {
      const dealId = readDealId(formData);
      // Read before anything is written, so a bad choice changes nothing.
      const invoiceIds = readDealInvoiceIds(formData);
      await updateCrmDeal(supabase, orgId, dealId, parseCrmDealForm(formData));
      // Undefined when the form did not show the picker: the links are left alone.
      if (invoiceIds !== undefined) await setDealInvoices(supabase, orgId, dealId, invoiceIds, userId);
    } else {
      // Whoever adds a deal starts as its owner.
      await createCrmDeal(supabase, orgId, parseCrmDealForm(formData), userId);
    }
  });
}

async function moveDealAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId } = await getViewer();
  const supabase = await createClient();

  return runWrite(formData, 'Could not move the deal.', () =>
    moveCrmDeal(supabase, orgId, readDealId(formData), readStageId(formData)),
  );
}

async function markDealLostAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId } = await getViewer();
  const supabase = await createClient();

  return runWrite(formData, 'Could not mark the deal as lost.', () =>
    markCrmDealLost(supabase, orgId, readDealId(formData), readLostReason(formData)),
  );
}

async function reopenDealAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId } = await getViewer();
  const supabase = await createClient();

  return runWrite(formData, 'Could not reopen the deal.', () =>
    reopenCrmDeal(supabase, orgId, readDealId(formData)),
  );
}

async function deleteDealAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId } = await getViewer();
  const supabase = await createClient();

  return runWrite(formData, 'Could not delete the deal.', () =>
    deleteCrmDeal(supabase, orgId, readDealId(formData)),
  );
}

async function createPipelineAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId } = await getViewer();
  const supabase = await createClient();

  let id = '';
  const state = await runWrite(formData, 'Could not create the pipeline.', async () => {
    id = await createCrmPipeline(supabase, orgId, parseCrmPipelineForm(formData));
  });
  // The board switches to the pipeline it is told was made.
  return state?.ok ? { ...state, id } : state;
}

async function renamePipelineAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId } = await getViewer();
  const supabase = await createClient();

  return runWrite(formData, 'Could not rename the pipeline.', () =>
    renameCrmPipeline(
      supabase,
      orgId,
      readPipelineId(formData),
      parsePipelineName(String(formData.get('name') ?? '')),
    ),
  );
}

async function makeDefaultPipelineAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId } = await getViewer();
  const supabase = await createClient();

  return runWrite(formData, 'Could not change the default pipeline.', () =>
    setDefaultCrmPipeline(supabase, orgId, readPipelineId(formData)),
  );
}

async function deletePipelineAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId } = await getViewer();
  const supabase = await createClient();

  return runWrite(formData, 'Could not delete the pipeline.', () =>
    deleteCrmPipeline(supabase, orgId, readPipelineId(formData)),
  );
}

async function addStageAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId } = await getViewer();
  const supabase = await createClient();

  return runStageWrite(formData, 'Could not add the stage.', async () => {
    await addCrmPipelineStage(
      supabase,
      orgId,
      readPipelineId(formData),
      parseStageName(String(formData.get('name') ?? '')),
    );
  });
}

async function updateStageAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId } = await getViewer();
  const supabase = await createClient();

  return runStageWrite(formData, 'Could not save the stage.', () =>
    updateCrmPipelineStage(supabase, orgId, readPipelineId(formData), readStageId(formData), {
      name: parseStageName(String(formData.get('name') ?? '')),
      probability: parseStageProbability(String(formData.get('probability') ?? '')),
    }),
  );
}

async function moveStageAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId } = await getViewer();
  const supabase = await createClient();

  return runStageWrite(formData, 'Could not move the stage.', () =>
    moveCrmPipelineStage(
      supabase,
      orgId,
      readPipelineId(formData),
      readStageId(formData),
      readStageDirection(formData),
    ),
  );
}

async function removeStageAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId } = await getViewer();
  const supabase = await createClient();

  return runStageWrite(formData, 'Could not remove the stage.', () =>
    deleteCrmPipelineStage(supabase, orgId, readPipelineId(formData), readStageId(formData)),
  );
}

async function loadDealNotesAction(dealId: string) {
  'use server';
  // The workspace is the viewer's, never the caller's input; the database's row security applies too.
  const { orgId } = await getViewer();
  const supabase = await createClient();
  return loadRecordNotes(supabase, orgId, { dealId });
}

const ACTIONS: CrmDealActions = {
  notes: loadDealNotesAction,
  save: saveDealAction,
  move: moveDealAction,
  markLost: markDealLostAction,
  reopen: reopenDealAction,
  remove: deleteDealAction,
  createPipeline: createPipelineAction,
  renamePipeline: renamePipelineAction,
  makeDefaultPipeline: makeDefaultPipelineAction,
  removePipeline: deletePipelineAction,
  addStage: addStageAction,
  updateStage: updateStageAction,
  moveStage: moveStageAction,
  removeStage: removeStageAction,
};

/** The contact a new deal starts with: Create deal on a contact's row opens this page with `?contact=<id>`. */
function contactParam(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function CrmDealsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  // No project configured (dev / preview / tests): the sample view.
  if (!hasSupabaseEnv()) return <DealsScreen />;

  // The layout already loaded the viewer for this request; this reuses it.
  const { orgId, role } = await getViewer();
  const supabase = await createClient();
  const params = await searchParams;
  const openId = readOpenParam(params?.[OPEN_PARAM]);
  // Viewers can read deals but the database refuses their writes.
  const canWrite = role !== 'viewer';

  let live: {
    pipelines: Awaited<ReturnType<typeof listCrmPipelines>>;
    deals: Awaited<ReturnType<typeof listCrmDeals>>;
    contacts: Awaited<ReturnType<typeof listCrmDealContacts>>;
    billing: {
      invoices: Awaited<ReturnType<typeof listInvoices>>;
      links: Awaited<ReturnType<typeof listDealInvoiceLinks>>;
    } | null;
    requireLostReason: boolean;
    openDeal: Awaited<ReturnType<typeof getCrmDeal>>;
  } | null = null;
  try {
    // Fetched together: each trip to the database costs about the same.
    const [pipelines, deals, contacts, billing, requireLostReason] = await Promise.all([
      listCrmPipelines(supabase, orgId),
      listCrmDeals(supabase, orgId, DEALS_LOADED),
      // Only the form needs these; the board still shows if they cannot load.
      canWrite
        ? listCrmDealContacts(supabase, orgId, CONTACTS_OFFERED, contactParam(params?.contact)).catch((error) => {
            console.error('[crm/deals] could not load contacts', errorCodeOf(error));
            return [];
          })
        : [],
      // Linked invoices are an extra; the board still shows if they cannot load.
      Promise.all([listInvoices({ client: supabase, orgId }), listDealInvoiceLinks(supabase, orgId)])
        .then(([invoices, links]) => ({ invoices, links }))
        .catch((error) => {
          console.error('[crm/deals] could not load linked invoices', errorCodeOf(error));
          return null;
        }),
      // Only the lost-deal form needs the rule. If it cannot be read the form treats the reason as optional; the
      // database still refuses a lost deal with no reason when the rule is on.
      canWrite
        ? loadCrmSettings(supabase, orgId)
            .then((settings) => settings.requireLostReason)
            .catch((error) => {
              console.error('[crm/deals] could not load the Kasturi settings', errorCodeOf(error));
              return false;
            })
        : false,
    ]);
    // A deal opened by link that is beyond the ones loaded is read by its id.
    // An unknown or foreign id opens nothing, and so does a read that fails.
    const openDeal =
      canWrite && openId && !deals.deals.some((deal) => deal.id === openId)
        ? await getCrmDeal(supabase, orgId, openId).catch((error) => {
            console.error('[crm/deals] could not load the linked deal', errorCodeOf(error));
            return null;
          })
        : null;
    live = { pipelines, deals, contacts, billing, requireLostReason, openDeal };
  } catch (error) {
    // The CRM migration is applied to a database separately from a deploy, so
    // the tables can be missing for a while. The page says so; it never shows sample data in its place.
    console.error('[crm/deals] could not load deals', errorCodeOf(error));
  }

  if (!live) {
    return (
      <CouldntLoad
        title="Deals"
        subtitle="Your sales pipeline — move deals toward close."
        thing="deals"
      />
    );
  }

  // A workspace needs a pipeline before it can hold deals. The first person
  // who can edit sets up the starting one by opening this page.
  if (canWrite && needsDefaultPipeline(live.pipelines)) {
    try {
      await ensureDefaultPipeline(supabase, orgId);
      // `fresh`: this is the same read as above, repeated after a write.
      live.pipelines = await listCrmPipelines(supabase, orgId, { fresh: true });
    } catch (error) {
      // The page says the pipeline could not be set up; it does not fail.
      console.error('[crm/deals] could not set up the default pipeline', errorCodeOf(error));
    }
  }

  const { billing } = live;
  const totals = billing ? dealBilling(billing.links, billing.invoices) : {};

  return (
    <DealsScreen
      pipelines={live.pipelines}
      deals={live.deals.deals.map((deal) => (totals[deal.id] ? { ...deal, billing: totals[deal.id] } : deal))}
      invoices={canWrite && billing ? dealInvoiceChoices(billing.invoices, billing.links, money) : undefined}
      totalDeals={live.deals.total}
      contacts={live.contacts}
      actions={canWrite ? ACTIONS : undefined}
      requireLostReason={live.requireLostReason}
      openId={openId}
      openDeal={live.openDeal}
      now={new Date().toISOString()}
    />
  );
}
