import { revalidatePath } from 'next/cache';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import {
  createCrmDeal,
  deleteCrmDeal,
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
import { rm } from '@/lib/finance/format';
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
import { runCrmWrite } from '@/lib/crm/run-write';
import { createClient } from '@/lib/supabase/server';
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

const ACTIONS: CrmDealActions = {
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
  } | null = null;
  try {
    // Fetched together: each trip to the database costs about the same.
    const [pipelines, deals, contacts, billing] = await Promise.all([
      listCrmPipelines(supabase, orgId),
      listCrmDeals(supabase, orgId, DEALS_LOADED),
      // Only the form needs these; the board still shows if they cannot load.
      canWrite
        ? listCrmDealContacts(supabase, orgId, CONTACTS_OFFERED, contactParam((await searchParams)?.contact)).catch((error) => {
            console.error('[crm/deals] could not load contacts', error);
            return [];
          })
        : [],
      // Linked invoices are an extra; the board still shows if they cannot load.
      Promise.all([listInvoices({ client: supabase, orgId }), listDealInvoiceLinks(supabase, orgId)])
        .then(([invoices, links]) => ({ invoices, links }))
        .catch((error) => {
          console.error('[crm/deals] could not load linked invoices', error);
          return null;
        }),
    ]);
    live = { pipelines, deals, contacts, billing };
  } catch (error) {
    // The CRM migration is applied to a database separately from a deploy, so
    // the tables can be missing for a while. Keep the page up meanwhile.
    console.error('[crm/deals] could not load deals', error);
  }

  if (!live) return <DealsScreen />;

  // A workspace needs a pipeline before it can hold deals. The first person
  // who can edit sets up the starting one by opening this page.
  if (canWrite && needsDefaultPipeline(live.pipelines)) {
    try {
      await ensureDefaultPipeline(supabase, orgId);
      // `fresh`: this is the same read as above, repeated after a write.
      live.pipelines = await listCrmPipelines(supabase, orgId, { fresh: true });
    } catch (error) {
      // The page says the pipeline could not be set up; it does not fail.
      console.error('[crm/deals] could not set up the default pipeline', error);
    }
  }

  const { billing } = live;
  const totals = billing ? dealBilling(billing.links, billing.invoices) : {};

  return (
    <DealsScreen
      pipelines={live.pipelines}
      deals={live.deals.deals.map((deal) => (totals[deal.id] ? { ...deal, billing: totals[deal.id] } : deal))}
      invoices={canWrite && billing ? dealInvoiceChoices(billing.invoices, billing.links, rm) : undefined}
      totalDeals={live.deals.total}
      contacts={live.contacts}
      actions={canWrite ? ACTIONS : undefined}
      now={new Date().toISOString()}
    />
  );
}
