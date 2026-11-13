import { vi } from "vite-plus/test";

/**
 * A small IndexedDB stand-in for the connection cache tests: object stores, an index cursor over
 * the rows that carry an age and a size, and the transaction events the storage layer waits on.
 */

interface FakeCachedRow {
  readonly environmentId: string;
  readonly updatedAt: number;
  readonly bytes: number;
  readonly payload: string;
}

const isFakeCachedRow = (value: unknown): value is FakeCachedRow =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as FakeCachedRow).environmentId === "string" &&
  typeof (value as FakeCachedRow).updatedAt === "number" &&
  typeof (value as FakeCachedRow).bytes === "number";

type FakeRequest<T> = EventTarget & { result: T | undefined; error: unknown };

const makeRequest = <T>(): FakeRequest<T> =>
  Object.assign(new EventTarget(), { result: undefined as T | undefined, error: null });

export interface FakeKeyRange {
  readonly lower: unknown;
  readonly upper: unknown;
}

interface FakeCursor {
  readonly key: unknown;
  readonly primaryKey: string;
  readonly delete: () => void;
  continue: () => void;
}

interface FakeTransactionState {
  walking: number;
  completed: boolean;
  pending: boolean;
  scheduled: boolean;
}

type FakeTransaction = EventTarget & {
  error: unknown;
  objectStore: (name: string) => unknown;
};

export interface FakeIndexedDb {
  /** The rows one store holds, by key. */
  readonly rows: (storeName: string) => ReadonlyMap<string, unknown>;
}

export const installFakeIndexedDb = (options?: {
  /** The version the database already holds when the client opens it. */
  readonly oldVersion?: number;
  /** The rows the database already holds, by store name and key. */
  readonly seed?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}): FakeIndexedDb => {
  const stores = new Map<string, Map<string, unknown>>();
  const indexes = new Map<string, Set<string>>();
  for (const [name, rows] of Object.entries(options?.seed ?? {})) {
    stores.set(name, new Map(Object.entries(rows)));
    indexes.set(name, new Set());
  }

  const rowsOf = (name: string) => {
    const existing = stores.get(name);
    if (existing !== undefined) return existing;
    const rows = new Map<string, unknown>();
    stores.set(name, rows);
    return rows;
  };
  const indexesOf = (name: string) => {
    const existing = indexes.get(name);
    if (existing !== undefined) return existing;
    const names = new Set<string>();
    indexes.set(name, names);
    return names;
  };

  // A transaction completes once the work queued behind it has settled. A cursor walk keeps it
  // open until the walk ends, so the rows the walk deletes belong to the same commit.
  const settle = (state: FakeTransactionState, transaction: FakeTransaction) => {
    if (state.completed) return;
    state.pending = true;
    if (state.scheduled) return;
    state.scheduled = true;
    queueMicrotask(() => {
      state.scheduled = false;
      if (!state.pending || state.walking > 0) return;
      state.pending = false;
      state.completed = true;
      transaction.dispatchEvent(new Event("complete"));
    });
  };

  const makeStore = (name: string, state?: FakeTransactionState, transaction?: FakeTransaction) => {
    const rows = rowsOf(name);
    const changed = () => {
      if (state !== undefined && transaction !== undefined) settle(state, transaction);
    };
    const walk = <Row>(
      entries: ReadonlyArray<readonly [string, Row]>,
      makeCursor: (entry: readonly [string, Row], advance: () => void) => FakeCursor,
    ) => {
      const request = makeRequest<FakeCursor | null>();
      let position = 0;
      if (state !== undefined) state.walking += 1;
      const advance = () => {
        const entry = entries[position++];
        if (entry === undefined) {
          request.result = null;
          request.dispatchEvent(new Event("success"));
          if (state !== undefined) state.walking -= 1;
          changed();
          return;
        }
        request.result = makeCursor(entry, advance);
        request.dispatchEvent(new Event("success"));
      };
      queueMicrotask(advance);
      return request;
    };
    return {
      createIndex: (indexName: string) => {
        indexesOf(name).add(indexName);
        return { name: indexName };
      },
      indexNames: { contains: (indexName: string) => indexesOf(name).has(indexName) },
      put: (value: unknown, key: string) => {
        rows.set(key, value);
        changed();
      },
      get: (key: string) => {
        const request = makeRequest<unknown>();
        request.result = rows.get(key);
        queueMicrotask(() => request.dispatchEvent(new Event("success")));
        changed();
        return request;
      },
      delete: (key: string) => {
        rows.delete(key);
        changed();
      },
      clear: () => {
        rows.clear();
        changed();
      },
      index: () => ({
        openKeyCursor: (range: FakeKeyRange, direction: "prev" | "next") => {
          const environmentId = Array.isArray(range.lower) ? range.lower[0] : undefined;
          const entries = [...rows.entries()]
            .filter(([, value]) => isFakeCachedRow(value) && value.environmentId === environmentId)
            .sort((left, right) => {
              const older = left[1] as FakeCachedRow;
              const newer = right[1] as FakeCachedRow;
              return older.updatedAt - newer.updatedAt || older.bytes - newer.bytes;
            });
          const ordered = direction === "prev" ? entries.reverse() : entries;
          return walk(ordered, ([key, value], advance) => {
            const row = value as FakeCachedRow;
            return {
              key: [row.environmentId, row.updatedAt, row.bytes],
              primaryKey: key,
              delete: () => {
                rows.delete(key);
                changed();
              },
              continue: advance,
            };
          });
        },
      }),
      openCursor: (range: FakeKeyRange) => {
        const lower = typeof range.lower === "string" ? range.lower : "";
        const upper = typeof range.upper === "string" ? range.upper : "￿";
        const entries = [...rows.entries()].filter(([key]) => key >= lower && key <= upper);
        return walk(entries, ([key], advance) => ({
          key,
          primaryKey: key,
          delete: () => {
            rows.delete(key);
            changed();
          },
          continue: advance,
        }));
      },
    };
  };

  const makeTransaction = (): FakeTransaction => {
    const state: FakeTransactionState = {
      walking: 0,
      completed: false,
      pending: false,
      scheduled: false,
    };
    const transaction = Object.assign(new EventTarget(), {
      error: null as unknown,
      objectStore: (name: string) => makeStore(name, state, transaction),
    }) as FakeTransaction;
    return transaction;
  };

  const database = Object.assign(new EventTarget(), {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => {
      rowsOf(name);
      indexesOf(name);
      return makeStore(name);
    },
    transaction: () => makeTransaction(),
    close: vi.fn(),
  });

  let version = options?.oldVersion ?? 0;
  const open = (_name: string, requested: number) => {
    const request = Object.assign(new EventTarget(), {
      result: undefined as unknown,
      error: null as unknown,
      transaction: null as unknown,
    });
    queueMicrotask(() => {
      request.result = database;
      if (requested > version) {
        const oldVersion = version;
        version = requested;
        request.transaction = { objectStore: (name: string) => makeStore(name) };
        request.dispatchEvent(
          Object.assign(new Event("upgradeneeded"), { oldVersion, newVersion: requested }),
        );
      }
      queueMicrotask(() => request.dispatchEvent(new Event("success")));
    });
    return request;
  };

  vi.stubGlobal("indexedDB", { open });
  vi.stubGlobal("IDBKeyRange", {
    bound: (lower: unknown, upper: unknown): FakeKeyRange => ({ lower, upper }),
  });

  return { rows: (storeName: string) => rowsOf(storeName) };
};
