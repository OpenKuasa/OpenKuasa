import type { FinanceWriteContext } from '@/lib/finance/result';

/** One request the data layer made: a database function, or a statement on a table or view. */
export type FinanceCall = {
  kind: 'rpc' | 'table';
  name: string;
  op: 'rpc' | 'select' | 'insert' | 'update' | 'delete';
  args?: Record<string, unknown>;
  values?: Record<string, unknown>;
  columns?: string;
  filters: Record<string, unknown>;
  order: string[];
  range?: [number, number];
  limit?: number;
};

export type FinanceAnswer = { data: unknown; error: unknown };

/**
 * A stand-in for the Supabase client the finance data layer is given. It
 * records every request and answers it: with the same canned answer each
 * time, or with whatever `answer(call)` returns, for reads that page or that
 * touch two tables.
 */
export function fakeFinance(answer: FinanceAnswer | ((call: FinanceCall) => FinanceAnswer)) {
  const calls: FinanceCall[] = [];
  const reply = (call: FinanceCall) => (typeof answer === 'function' ? answer(call) : answer);
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      const call: FinanceCall = { kind: 'rpc', name, op: 'rpc', args, filters: {}, order: [] };
      calls.push(call);
      return reply(call);
    },
    from(name: string) {
      const call: FinanceCall = { kind: 'table', name, op: 'select', filters: {}, order: [] };
      calls.push(call);
      const builder = {
        select(columns?: string) {
          call.columns = columns;
          return builder;
        },
        insert(values: Record<string, unknown>) {
          call.op = 'insert';
          call.values = values;
          return builder;
        },
        update(values: Record<string, unknown>) {
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
        // Recorded under "<column> is", so a test can tell `is(null)` from `eq`.
        is(column: string, value: unknown) {
          call.filters[`${column} is`] = value;
          return builder;
        },
        order(column: string, options?: { ascending?: boolean }) {
          call.order.push(`${column} ${options?.ascending === false ? 'desc' : 'asc'}`);
          return builder;
        },
        range(from: number, to: number) {
          call.range = [from, to];
          return builder;
        },
        limit(count: number) {
          call.limit = count;
          return builder;
        },
        maybeSingle: async () => reply(call),
        single: async () => reply(call),
        then<A, B>(resolve: (value: FinanceAnswer) => A, reject?: (reason: unknown) => B) {
          return Promise.resolve(reply(call)).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { ctx: { client: client as never, orgId: 'org-1' } satisfies FinanceWriteContext, calls };
}
