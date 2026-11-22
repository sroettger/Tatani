export const DEFAULT_SUPABASE_PAGE_SIZE = 1000;

export type PageQueryResult<T> = {
  data: T[] | null;
  error: unknown;
};

export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0 || items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Fetches all rows across PostgREST 1,000-row pages using deterministic `.range(from, to)`.
 * Stops as soon as `batch.length < pageSize` or if any page returns an `error`.
 */
export async function fetchAllPages<T>(
  buildPage: (from: number, to: number) => PromiseLike<PageQueryResult<T>>,
  pageSize = DEFAULT_SUPABASE_PAGE_SIZE,
): Promise<{ data: T[]; error: unknown }> {
  const rows: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await buildPage(from, from + pageSize - 1);
    if (error) {
      return { data: rows, error };
    }
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < pageSize) {
      break;
    }
    from += pageSize;
  }
  return { data: rows, error: null };
}

/**
 * Splits a `.in(column, keys)` filter into bounded key slices (e.g. 50 or 200)
 * and paginates each slice so neither URL length limits nor the 1,000-row cap truncate data.
 */
export async function fetchBatchedPages<TKey, TRow>(
  keys: readonly TKey[],
  batchSize: number,
  buildPage: (slice: TKey[], from: number, to: number) => PromiseLike<PageQueryResult<TRow>>,
  pageSize = DEFAULT_SUPABASE_PAGE_SIZE,
): Promise<{ data: TRow[]; error: unknown }> {
  const slices = chunkArray(keys, batchSize);
  const allRows: TRow[] = [];
  for (const slice of slices) {
    const { data, error } = await fetchAllPages((from, to) => buildPage(slice, from, to), pageSize);
    if (error) {
      return { data: allRows, error };
    }
    allRows.push(...data);
  }
  return { data: allRows, error: null };
}
