/**
 * Shift swaps: reading them, and the pure models the Shift Calendar card and the Shift Swaps approvals screen
 * show. A swap names two roster cells, the requester's and the colleague's, with the type each held when asked;
 * on approval the two people exchange their cells on each day the swap touches. The database decides who may
 * read and do what (`hr_shift_swaps` and its functions); this file only shapes the rows.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatDay } from './dates';
import { shiftTypeLabel } from './roster';
import type { Employee, PeopleViewer, ShiftType } from './types';

export type SwapStatus = 'requested' | 'accepted' | 'declined' | 'approved' | 'rejected' | 'cancelled';

export type ShiftSwap = {
  id: string;
  requester_employee_id: string;
  colleague_employee_id: string;
  requester_date: string;
  requester_type_id: string;
  colleague_date: string;
  colleague_type_id: string;
  note: string | null;
  status: SwapStatus;
  decision_note: string | null;
  created_at: string;
};

/** A future shift a member may offer (`mine`) or ask for, from `hr_swap_options`. */
export type SwapOption = {
  shift_id: string;
  employee_id: string;
  employee_name: string;
  work_date: string;
  shift_type_id: string;
  mine: boolean;
};

const SWAP_COLUMNS =
  'id,requester_employee_id,colleague_employee_id,requester_date,requester_type_id,colleague_date,colleague_type_id,note,status,decision_note,created_at';

/** The most swaps one screen reads: the newest first. */
export const SWAP_READ_LIMIT = 200;

/** The swaps the signed-in person may read in the workspace, newest first. Throws on a failed read. */
export async function listSwaps(ctx: { client: SupabaseClient; orgId: string }): Promise<ShiftSwap[]> {
  const { data, error } = await ctx.client
    .from('hr_shift_swaps')
    .select(SWAP_COLUMNS)
    .eq('org_id', ctx.orgId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(SWAP_READ_LIMIT);
  if (error) throw new Error(`hr_shift_swaps read failed: ${error.code ?? 'no-code'}`);
  return (data ?? []) as ShiftSwap[];
}

/** The future shifts the signed-in member may offer or ask for. Throws on a failed read. */
export async function listSwapOptions(ctx: { client: SupabaseClient; orgId: string }): Promise<SwapOption[]> {
  const { data, error } = await ctx.client.rpc('hr_swap_options', { p_org: ctx.orgId });
  if (error) throw new Error(`hr_swap_options failed: ${error.code ?? 'no-code'}`);
  return (Array.isArray(data) ? data : []) as SwapOption[];
}

// ---- Choosing a swap ----------------------------------------------------------------------

/** The type held in a cell, or null for no shift, from the options read (which hold every future cell up to 60 days). */
function typeOn(options: SwapOption[], employeeId: string, date: string): string | null {
  return options.find((o) => o.employee_id === employeeId && o.work_date === date)?.shift_type_id ?? null;
}

const isOff = (types: Record<string, ShiftType>, id: string | null) => id === null || types[id]?.is_off === true;

/**
 * Whether the database would take this pair, as far as the options show: the same day with another type, or two
 * days where neither person already works the other's day and something changes. The database checks again.
 */
export function swapAllowed(mine: SwapOption, theirs: SwapOption, options: SwapOption[], types: Record<string, ShiftType>): boolean {
  if (!mine.mine || theirs.mine || mine.employee_id === theirs.employee_id) return false;
  if (mine.work_date === theirs.work_date) return mine.shift_type_id !== theirs.shift_type_id;
  const myOther = typeOn(options, mine.employee_id, theirs.work_date);
  const theirOther = typeOn(options, theirs.employee_id, mine.work_date);
  if (!isOff(types, myOther) || !isOff(types, theirOther)) return false;
  return !(mine.shift_type_id === theirOther && myOther === theirs.shift_type_id);
}

export type SwapChoice = { shift_id: string; label: string };

export type SwapChoices = {
  /** The member's own future shifts. */
  mine: SwapChoice[];
  /** For each of their shifts, the colleagues' shifts it may be swapped for. */
  theirs: Record<string, SwapChoice[]>;
};

const cellLabel = (date: string, typeId: string, types: Record<string, ShiftType>) =>
  `${formatDay(date)} · ${types[typeId] ? shiftTypeLabel(types[typeId]) : 'Shift'}`;

/** The pickers of the "Ask for a swap" form. A shift already in an open swap is left out on either side. */
export function swapChoices(input: { options: SwapOption[]; types: Record<string, ShiftType>; swaps: ShiftSwap[] }): SwapChoices {
  const busy = new Set(
    input.swaps
      .filter((s) => s.status === 'requested' || s.status === 'accepted')
      .flatMap((s) => [`${s.requester_employee_id}|${s.requester_date}`, `${s.colleague_employee_id}|${s.colleague_date}`]),
  );
  const free = input.options.filter((o) => !busy.has(`${o.employee_id}|${o.work_date}`));
  const mine = free.filter((o) => o.mine);
  const theirs: Record<string, SwapChoice[]> = {};
  for (const m of mine) {
    theirs[m.shift_id] = free
      .filter((o) => swapAllowed(m, o, input.options, input.types))
      .map((o) => ({ shift_id: o.shift_id, label: `${o.employee_name} · ${cellLabel(o.work_date, o.shift_type_id, input.types)}` }));
  }
  return {
    mine: mine.filter((m) => theirs[m.shift_id].length > 0).map((m) => ({ shift_id: m.shift_id, label: cellLabel(m.work_date, m.shift_type_id, input.types) })),
    theirs,
  };
}

// ---- Showing swaps -------------------------------------------------------------------------

export const SWAP_STATUS_LABEL: Record<SwapStatus, string> = {
  requested: 'Waiting for the colleague',
  accepted: 'Waiting for approval',
  declined: 'Declined',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

export type SwapTone = 'good' | 'pending' | 'bad' | 'neutral';

export type SwapRow = {
  id: string;
  requester: string;
  colleague: string;
  /** "12 Jan · Morning · 09:00–18:00": the requester's shift, which the colleague takes. */
  gives: string;
  /** The colleague's shift, which the requester takes. */
  takes: string;
  note: string | null;
  decision_note: string | null;
  status: SwapStatus;
  /** Open but a day has come: it can no longer be accepted or approved. */
  expired: boolean;
  status_label: string;
  tone: SwapTone;
};

const isOpen = (status: SwapStatus) => status === 'requested' || status === 'accepted';

function toneOf(status: SwapStatus, expired: boolean): SwapTone {
  if (expired) return 'neutral';
  if (status === 'approved') return 'good';
  if (status === 'rejected' || status === 'declined') return 'bad';
  return isOpen(status) ? 'pending' : 'neutral';
}

/** One swap as a row: names from the directory, cells as date and type. */
export function swapRow(swap: ShiftSwap, names: Map<string, string>, types: Record<string, ShiftType>, today: string): SwapRow {
  const expired = isOpen(swap.status) && (swap.requester_date <= today || swap.colleague_date <= today);
  return {
    id: swap.id,
    requester: names.get(swap.requester_employee_id) ?? 'A former employee',
    colleague: names.get(swap.colleague_employee_id) ?? 'A former employee',
    gives: cellLabel(swap.requester_date, swap.requester_type_id, types),
    takes: cellLabel(swap.colleague_date, swap.colleague_type_id, types),
    note: swap.note,
    decision_note: swap.decision_note,
    status: swap.status,
    expired,
    status_label: expired ? 'Expired' : SWAP_STATUS_LABEL[swap.status],
    tone: toneOf(swap.status, expired),
  };
}

const namesOf = (employees: Employee[]) => new Map(employees.map((e) => [e.id, e.name]));

/** The closed swaps a screen lists under "Recent": this many, newest first. */
export const RECENT_SWAPS = 10;

export type MySwapRow = SwapRow & {
  /** The viewer is the colleague and it waits for their answer. */
  can_reply: boolean;
  /** The viewer is one of the two and it is still open. */
  can_cancel: boolean;
  /** The viewer asked for it. */
  asked: boolean;
};

export type MySwaps = { open: MySwapRow[]; recent: MySwapRow[]; waiting_for_you: number };

/** The Shift Calendar card: the viewer's own swaps, open ones first (those asking them to reply at the top). */
export function buildMySwaps(input: {
  swaps: ShiftSwap[];
  viewer: PeopleViewer;
  employees: Employee[];
  types: Record<string, ShiftType>;
  today: string;
}): MySwaps {
  const me = input.viewer.employeeId;
  if (me === null) return { open: [], recent: [], waiting_for_you: 0 };
  const names = namesOf(input.employees);
  const rows = input.swaps
    .filter((s) => s.requester_employee_id === me || s.colleague_employee_id === me)
    .map((s): MySwapRow => {
      const row = swapRow(s, names, input.types, input.today);
      return {
        ...row,
        can_reply: s.status === 'requested' && s.colleague_employee_id === me && !row.expired,
        can_cancel: isOpen(s.status),
        asked: s.requester_employee_id === me,
      };
    });
  const open = rows.filter((r) => isOpen(r.status)).sort((a, b) => Number(b.can_reply) - Number(a.can_reply));
  return {
    open,
    recent: rows.filter((r) => !isOpen(r.status)).slice(0, RECENT_SWAPS),
    waiting_for_you: open.filter((r) => r.can_reply).length,
  };
}

export type ApprovalSwapRow = SwapRow & {
  /** The viewer may approve or reject it: not one of the two, unless they own the workspace. */
  decidable: boolean;
};

export type SwapApprovals = {
  /** Accepted, both days to come: for a decision. */
  waiting: ApprovalSwapRow[];
  /** Still waiting for the colleague's answer. */
  with_colleague: ApprovalSwapRow[];
  recent: ApprovalSwapRow[];
};

/**
 * The Shift Swaps approvals screen. The rows are what the database let the viewer read: every swap for an owner
 * or admin, and for a manager those between two of their reports (and their own). A manager's own swaps are not
 * theirs to decide, so they are left out of the queue.
 */
export function buildSwapApprovals(input: {
  swaps: ShiftSwap[];
  viewer: PeopleViewer;
  employees: Employee[];
  types: Record<string, ShiftType>;
  today: string;
}): SwapApprovals {
  const me = input.viewer.employeeId;
  const names = namesOf(input.employees);
  const mine = (s: ShiftSwap) => me !== null && (s.requester_employee_id === me || s.colleague_employee_id === me);
  const rows = input.swaps
    .filter((s) => input.viewer.isHr || !mine(s))
    .map((s): ApprovalSwapRow => ({
      ...swapRow(s, names, input.types, input.today),
      decidable: !mine(s) || input.viewer.isOwner === true,
    }));
  return {
    waiting: rows.filter((r) => r.status === 'accepted' && !r.expired),
    with_colleague: rows.filter((r) => r.status === 'requested' && !r.expired),
    recent: rows.filter((r) => !isOpen(r.status) || r.expired).slice(0, RECENT_SWAPS),
  };
}
