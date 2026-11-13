/** One cached row's cost and age, as the budget index keeps it. */
export interface CacheBudgetRow {
  readonly key: string;
  readonly updatedAt: number;
  readonly bytes: number;
}

export interface CacheBudget {
  readonly maxRows: number;
  readonly maxBytes: number;
  readonly maxAgeMs: number;
}

/**
 * The rows to drop so a cache fits its budget, oldest first. A row older than the age limit goes
 * even when the row and byte caps still have room, and a row larger than the whole byte budget
 * drops itself, so one oversized row cannot pin the cache.
 */
export function cacheRowsToDrop(
  rows: ReadonlyArray<CacheBudgetRow>,
  budget: CacheBudget,
  now: number,
): ReadonlyArray<string> {
  const oldestFirst = [...rows].sort(
    (left, right) =>
      left.updatedAt - right.updatedAt ||
      (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
  );
  let keptRows = oldestFirst.length;
  let keptBytes = oldestFirst.reduce((total, row) => total + row.bytes, 0);
  const dropped: Array<string> = [];
  for (const row of oldestFirst) {
    const withinAge = row.updatedAt >= now - budget.maxAgeMs;
    if (withinAge && keptRows <= budget.maxRows && keptBytes <= budget.maxBytes) break;
    dropped.push(row.key);
    keptRows -= 1;
    keptBytes -= row.bytes;
  }
  return dropped;
}
