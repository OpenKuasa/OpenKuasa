/**
 * A stand-in for the Supabase query builder: records each statement and
 * answers it from a queue keyed by `<table>.<op>` (`rpc.<function>` for an rpc call). The last reply for a key is
 * reused, so one reply serves any number of identical statements.
 */
export type FakeCall = {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete' | 'rpc';
  values?: unknown;
  /** For an `rpc` call: the function's name, and the arguments it was given. */
  fn?: string;
  args?: Record<string, unknown>;
  columns?: string;
  filters: Record<string, unknown>;
};

export type FakeReply = { data?: unknown; error?: { code?: string; message: string } | null };

export function fakeSupabase(replies: Record<string, FakeReply | FakeReply[]> = {}) {
  const calls: FakeCall[] = [];
  const queues = new Map<string, FakeReply[]>();
  for (const [key, value] of Object.entries(replies)) {
    queues.set(key, Array.isArray(value) ? [...value] : [value]);
  }
  const next = (key: string): FakeReply => {
    const queue = queues.get(key);
    if (!queue || queue.length === 0) return {};
    return queue.length > 1 ? queue.shift()! : queue[0];
  };

  const from = (table: string) => {
    const call: FakeCall = { table, op: 'select', filters: {} };
    let settled: { data: unknown; error: FakeReply['error'] } | null = null;
    const settle = () => {
      if (!settled) {
        calls.push(call);
        const reply = next(`${table}.${call.op}`);
        settled = { data: reply.data ?? null, error: reply.error ?? null };
      }
      return settled;
    };
    const builder = {
      select(columns?: string) {
        call.columns = columns;
        return builder;
      },
      insert(values: unknown) {
        call.op = 'insert';
        call.values = values;
        return builder;
      },
      update(values: unknown) {
        call.op = 'update';
        call.values = values;
        return builder;
      },
      delete() {
        call.op = 'delete';
        return builder;
      },
      eq(column: string, value: unknown) {
        call.filters[column] = value;
        return builder;
      },
      in(column: string, value: unknown) {
        call.filters[column] = value;
        return builder;
      },
      not() {
        return builder;
      },
      order() {
        return builder;
      },
      single: async () => settle(),
      maybeSingle: async () => settle(),
      then<A, B>(resolve: (value: ReturnType<typeof settle>) => A, reject?: (reason: unknown) => B) {
        return Promise.resolve(settle()).then(resolve, reject);
      },
    };
    return builder;
  };

  const rpc = async (fn: string, args: Record<string, unknown> = {}) => {
    calls.push({ table: 'rpc', op: 'rpc', fn, args, filters: {} });
    const reply = next(`rpc.${fn}`);
    return { data: reply.data ?? null, error: reply.error ?? null };
  };

  return { client: { from, rpc } as never, calls };
}
