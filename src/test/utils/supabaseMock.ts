import { vi } from "vitest";

/**
 * Minimal chainable Supabase stub. Every builder method returns `this`, and
 * awaiting the builder resolves to a canned result for that table.
 *
 * Tests set results with `setTableResult("user_word_state", { data, count })`.
 * The stub records each call so tests can assert on the filters applied
 * (e.g. that `learning_language` was constrained).
 */
export type QueryResult = { data?: unknown; error?: unknown; count?: number };

type Recorded = { table: string; filters: Array<[string, unknown]>; op: string };

const results = new Map<string, QueryResult | ((rec: Recorded) => QueryResult)>();
export const calls: Recorded[] = [];

export function setTableResult(
  table: string,
  result: QueryResult | ((rec: Recorded) => QueryResult),
) {
  results.set(table, result);
}

export function resetSupabaseMock() {
  results.clear();
  calls.length = 0;
  functionsInvoke.mockReset();
  functionsInvoke.mockResolvedValue({ data: null, error: null });
}

export const functionsInvoke = vi.fn(async () => ({ data: null, error: null }));

const CHAIN = [
  "select",
  "insert",
  "update",
  "upsert",
  "delete",
  "eq",
  "neq",
  "in",
  "is",
  "not",
  "gt",
  "gte",
  "lt",
  "lte",
  "order",
  "limit",
  "range",
];

function builder(table: string) {
  const rec: Recorded = { table, filters: [], op: "select" };
  calls.push(rec);

  const resolve = (): QueryResult => {
    const r = results.get(table) ?? { data: [], error: null, count: 0 };
    return typeof r === "function" ? r(rec) : r;
  };

  const api: Record<string, unknown> = {
    _rec: rec,
    single: async () => resolve(),
    maybeSingle: async () => resolve(),
    then: (onFulfilled: (v: QueryResult) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onFulfilled, onRejected),
  };

  for (const m of CHAIN) {
    api[m] = (...args: unknown[]) => {
      if (["insert", "update", "upsert", "delete"].includes(m)) rec.op = m;
      if (["eq", "in", "is", "not", "neq"].includes(m)) rec.filters.push([String(args[0]), args[1]]);
      if (["insert", "upsert"].includes(m)) {
        const rows = Array.isArray(args[0]) ? args[0] : [args[0]];
        for (const row of rows as Array<Record<string, unknown>>) {
          for (const [k, v] of Object.entries(row ?? {})) rec.filters.push([k, v]);
        }
      }
      return api;
    };
  }
  return api;
}

export const supabaseMock = {
  from: (table: string) => builder(table),
  functions: { invoke: functionsInvoke },
  auth: {
    getSession: async () => ({ data: { session: null } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    signOut: async () => ({ error: null }),
  },
  storage: { from: () => ({ download: async () => ({ data: null, error: null }) }) },
};

/** All filters/values applied to a table across every recorded call. */
export const filtersFor = (table: string) =>
  calls.filter((c) => c.table === table).flatMap((c) => c.filters);
