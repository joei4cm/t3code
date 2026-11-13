import { describe, expect, it } from "@effect/vitest";

import { cacheRowsToDrop, type CacheBudget, type CacheBudgetRow } from "./cacheBudget.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

const budget: CacheBudget = {
  maxRows: 3,
  maxBytes: 100,
  maxAgeMs: 30 * DAY_MS,
};

const row = (key: string, updatedAt: number, bytes: number): CacheBudgetRow => ({
  key,
  updatedAt,
  bytes,
});

describe("cacheRowsToDrop", () => {
  it("drops nothing while the cache fits its budget", () => {
    const rows = [row("a", NOW - DAY_MS, 30), row("b", NOW, 30), row("c", NOW - 2 * DAY_MS, 30)];

    expect(cacheRowsToDrop(rows, budget, NOW)).toEqual([]);
  });

  it("drops the oldest rows first until the row cap holds", () => {
    const rows = [
      row("a", NOW - 4 * DAY_MS, 10),
      row("b", NOW - 3 * DAY_MS, 10),
      row("c", NOW, 10),
      row("d", NOW, 10),
    ];

    expect(cacheRowsToDrop(rows, budget, NOW)).toEqual(["a"]);
  });

  it("drops the oldest rows first until the byte cap holds", () => {
    const rows = [
      row("a", NOW - 4 * DAY_MS, 40),
      row("b", NOW - 3 * DAY_MS, 40),
      row("c", NOW, 40),
    ];

    expect(cacheRowsToDrop(rows, budget, NOW)).toEqual(["a"]);
  });

  it("keeps dropping while both caps are still over budget", () => {
    const rows = [
      row("a", NOW - 4 * DAY_MS, 40),
      row("b", NOW - 3 * DAY_MS, 40),
      row("c", NOW - 2 * DAY_MS, 40),
      row("d", NOW, 40),
    ];

    expect(cacheRowsToDrop(rows, budget, NOW)).toEqual(["a", "b"]);
  });

  it("drops a row older than the age limit even when the caps have room", () => {
    const rows = [row("a", NOW - 40 * DAY_MS, 10), row("b", NOW, 10)];

    expect(cacheRowsToDrop(rows, budget, NOW)).toEqual(["a"]);
  });

  it("drops a row larger than the whole byte budget", () => {
    const rows = [row("a", NOW, 400)];

    expect(cacheRowsToDrop(rows, budget, NOW)).toEqual(["a"]);
  });

  it("breaks ties between rows written at the same time by key", () => {
    const rows = [row("c", NOW, 10), row("a", NOW, 10), row("b", NOW, 10)];

    expect(cacheRowsToDrop(rows, { ...budget, maxRows: 2 }, NOW)).toEqual(["a"]);
  });
});
