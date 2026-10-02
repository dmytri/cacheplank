/**
 * cacheplank — "the shared plank your pods walk across."
 *
 * A single-file, tag-based distributed cache handler for Next.js 16's
 * `cacheHandlers` API, backed by libSQL.
 *
 * Cache *entries* stay local to each process (an in-memory LRU). Only tag
 * *invalidation* is shared, through one tiny libSQL table (`tag_stamps`). Any
 * number of pods/regions converge because every `get` compares the entry's
 * timestamp against the shared invalidation stamps.
 *
 * Ground truth for the contract below: the installed `next@16.3.8` package —
 * `dist/server/lib/cache-handlers/{types,default}.js`,
 * `dist/server/lib/incremental-cache/tags-manifest.external.js`, and
 * `dist/server/use-cache/{use-cache-wrapper,handlers}.js`. See README
 * "Compatibility notes".
 */
import { createClient, type Client } from '@libsql/client';

/* ------------------------------------------------------------------------- *
 * Next 16 cache-handler contract.                                            *
 * Hand-written: Next does not export these types publicly (README note #1).  *
 * ------------------------------------------------------------------------- */

/** A timestamp in milliseconds elapsed since the epoch. */
export type Timestamp = number;

/** Mirrors `CacheEntry` in next@16.3.8. Durations are in seconds. */
export interface CacheEntry {
  /** The stored value. May be partially written / error while pending. */
  value: ReadableStream<Uint8Array>;
  /** Tags configured for the entry, excluding soft tags. */
  tags: string[];
  /** Client hint only; not used to compute expiration. [seconds] */
  stale: number;
  /** When the entry was created. [ms epoch] */
  timestamp: Timestamp;
  /** How long the entry may be used. [seconds] */
  expire: number;
  /** How long until the entry should be revalidated. [seconds] */
  revalidate: number;
}

/** Mirrors `CacheHandler` in next@16.3.8. */
export interface CacheHandler {
  get(cacheKey: string, softTags: string[]): Promise<CacheEntry | undefined>;
  set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void>;
  refreshTags(): Promise<void>;
  getExpiration(tags: string[]): Promise<Timestamp>;
  updateTags(tags: string[], durations?: { expire?: number }): Promise<void>;
}

export interface CacheplankOptions {
  /** libSQL URL. Defaults to `CACHEPLANK_URL`, then `BUNNY_DATABASE_URL`. */
  url?: string;
  /** libSQL auth token. Defaults to `CACHEPLANK_AUTH_TOKEN`, then `BUNNY_DATABASE_AUTH_TOKEN`. */
  authToken?: string;
  /** Key namespace. Defaults to `CACHEPLANK_PREFIX` (may be empty). */
  prefix?: string;
  /** Max local entries. Defaults to `CACHEPLANK_MAX_ENTRIES`, else 2000. */
  maxEntries?: number;
  /**
   * How long an in-process tag-stamp memo may be reused before the shared table
   * is re-read. This bounds how stale a pod's view of invalidation can get.
   * Defaults to `CACHEPLANK_STAMPS_TTL_MS`, else 3000. [ms]
   */
  stampsTtlMs?: number;
  /** Sink for the single fail-open warning. Defaults to `console.warn`. */
  warn?: (message: string) => void;
}

interface StoredEntry {
  bytes: Uint8Array;
  tags: string[];
  timestamp: number;
  expire: number;
  revalidate: number;
  stale: number;
}

/**
 * Soft TTL for the in-process tag-stamp memo. [ms]. Defaults to 3000; override
 * with `CACHEPLANK_STAMPS_TTL_MS` (e.g. `0` to read the shared table on every
 * `get`, which the cross-process test relies on).
 */
const TAG_CHECK_TTL_MS = (() => {
  const configured = Number(process.env.CACHEPLANK_STAMPS_TTL_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 3000;
})();
/** Fail-open backoff after a stamp-store error, so we don't hammer a dead DB. [ms] */
const RETRY_BACKOFF_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 2000;

const now = (): number => Date.now();

/**
 * Create a cache handler. The package's `default` export is one of these,
 * configured from the environment.
 */
export function createCacheHandler(options: CacheplankOptions = {}): CacheHandler {
  const url = options.url ?? process.env.CACHEPLANK_URL ?? process.env.BUNNY_DATABASE_URL;
  const authToken =
    options.authToken ?? process.env.CACHEPLANK_AUTH_TOKEN ?? process.env.BUNNY_DATABASE_AUTH_TOKEN;
  const prefix = options.prefix ?? process.env.CACHEPLANK_PREFIX ?? '';
  const configuredMax = Number(process.env.CACHEPLANK_MAX_ENTRIES);
  const maxEntries =
    options.maxEntries ??
    (Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : DEFAULT_MAX_ENTRIES);
  const configuredTtl = Number(process.env.CACHEPLANK_STAMPS_TTL_MS);
  const tagCheckTtlMs =
    options.stampsTtlMs ??
    (Number.isFinite(configuredTtl) && configuredTtl >= 0 ? configuredTtl : TAG_CHECK_TTL_MS);
  const warn = options.warn ?? ((message: string) => console.warn(`[cacheplank] ${message}`));

  // ---- local entry store, LRU via Map insertion order ----
  const entries = new Map<string, StoredEntry>();
  function remember(key: string, entry: StoredEntry): void {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  // ---- shared tag stamps (in-process memo; monotonically increasing) ----
  const stamps = new Map<string, number>();
  let stampsSyncedAt = 0;
  function observeStamp(tag: string, at: number): void {
    if (at > (stamps.get(tag) ?? 0)) stamps.set(tag, at);
  }

  // ---- libSQL client: lazy, memoized, and never allowed to throw ----
  let client: Client | undefined;
  let ready: Promise<boolean> | undefined;
  let retryAt = 0;
  let warned = false;
  function warnOnce(message: string): void {
    if (!warned) {
      warned = true;
      warn(message);
    }
  }

  function ensureStore(): Promise<boolean> {
    if (ready) return ready;
    if (!url) {
      warnOnce('no CACHEPLANK_URL / BUNNY_DATABASE_URL set; tag stamps are process-local only');
      return Promise.resolve(false);
    }
    if (now() < retryAt) return Promise.resolve(false);
    ready = (async () => {
      try {
        const created = createClient({ url, authToken });
        await created.execute(
          'CREATE TABLE IF NOT EXISTS tag_stamps (tag TEXT PRIMARY KEY, revalidated_at INTEGER NOT NULL)',
        );
        client = created;
        return true;
      } catch (error) {
        retryAt = now() + RETRY_BACKOFF_MS;
        ready = undefined;
        warnOnce(`tag-stamp store unavailable; continuing fail-open (${(error as Error).message})`);
        return false;
      }
    })();
    return ready;
  }

  async function syncStamps(): Promise<void> {
    if (now() - stampsSyncedAt < tagCheckTtlMs) return;
    try {
      if (!(await ensureStore()) || !client) return;
      const result = await client.execute('SELECT tag, revalidated_at FROM tag_stamps');
      for (const row of result.rows) {
        const at = Number(row.revalidated_at);
        if (Number.isFinite(at)) observeStamp(String(row.tag), at);
      }
    } catch (error) {
      retryAt = now() + RETRY_BACKOFF_MS;
      warnOnce(`tag-stamp read failed; serving local state (${(error as Error).message})`);
    } finally {
      stampsSyncedAt = now();
    }
  }

  // In-flight `set` calls, so a `get` racing a `set` waits instead of missing.
  const pendingSets = new Map<string, Promise<void>>();

  return {
    async get(cacheKey, softTags) {
      const key = prefix + cacheKey;
      const pending = pendingSets.get(key);
      if (pending) await pending.catch(() => {});

      const entry = entries.get(key);
      if (!entry) return undefined;

      // Touch for LRU recency.
      entries.delete(key);
      entries.set(key, entry);

      // A negative `expire` is the tiered-cache eviction sentinel Next's tiered
      // handler uses in dev (the interface has no per-key delete); treat it as
      // missing, independently of the retention bounds below.
      if (entry.expire < 0) {
        entries.delete(key);
        return undefined;
      }
      // Mirror Next's effective expiry. `set` already dropped `expire: 0` in
      // production. The wrapper discards an entry once
      // `currentTime > timestamp + expire*1000` (always) or past `revalidate`
      // during static generation; the default handler additionally drops past
      // `revalidate` in production (SWR background revalidation then takes
      // over). Dropping at either bound here matches what Next would reject
      // anyway and never serves a value the wrapper throws away. In dev the
      // default handler retains short-`expire` entries for at least
      // MIN_PRERENDERABLE_EXPIRE (300s) so reloads hit; mirror that. A
      // `revalidate <= 0` (including the stale-while-revalidate `-1`) drops.
      const age = now() - entry.timestamp;
      const maxAgeSeconds = process.env.__NEXT_DEV_SERVER
        ? Math.max(entry.expire, 300)
        : entry.revalidate;
      if (!(age < maxAgeSeconds * 1000) || (entry.expire >= 0 && !(age < entry.expire * 1000))) {
        return undefined;
      }

      // Shared invalidation: any tag (own or route soft tag) stamped at or
      // after this entry was written means another pod revalidated it — miss,
      // so Next regenerates. `>=` mirrors Next's wrapper-side discard
      // (`entry.timestamp <= implicitTagsExpiration`): for an entry created in
      // the same millisecond as a stamp the ordering is unknowable, so we
      // conservatively regenerate.
      await syncStamps();
      for (const tag of entry.tags) {
        if ((stamps.get(tag) ?? 0) >= entry.timestamp) return undefined;
      }
      for (const tag of softTags) {
        if ((stamps.get(tag) ?? 0) >= entry.timestamp) return undefined;
      }

      const bytes = entry.bytes;
      return {
        value: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        tags: entry.tags,
        stale: entry.stale,
        timestamp: entry.timestamp,
        expire: entry.expire,
        revalidate: entry.revalidate,
      };
    },

    async set(cacheKey, pendingEntry) {
      const key = prefix + cacheKey;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      pendingSets.set(key, gate);
      try {
        const entry = await pendingEntry;
        // In production an `expire: 0` entry is dynamic and never served back.
        if (entry.expire === 0 && !process.env.__NEXT_DEV_SERVER) return;

        const reader = entry.value.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              chunks.push(value);
              size += value.byteLength;
            }
          }
        } finally {
          reader.releaseLock();
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }

        remember(key, {
          bytes,
          tags: entry.tags ?? [],
          timestamp: entry.timestamp,
          expire: entry.expire,
          revalidate: entry.revalidate,
          stale: entry.stale,
        });
      } catch (error) {
        warnOnce(`failed to buffer a cache entry (${(error as Error).message})`);
      } finally {
        release();
        pendingSets.delete(key);
      }
    },

    async refreshTags() {
      await syncStamps();
    },

    async getExpiration(tags) {
      await syncStamps();
      let max = 0;
      for (const tag of tags) {
        const at = stamps.get(tag) ?? 0;
        if (at > max) max = at;
      }
      return max;
    },

    async updateTags(tags, _durations) {
      // `durations.expire` is accepted but not persisted: the shared table holds
      // a single monotone stamp per tag. A profile'd `revalidateTag` therefore
      // invalidates immediately rather than stale-while-revalidate — safe, and
      // faithful to the one-table model. See README compatibility note #4.
      const at = now();
      for (const tag of tags) observeStamp(tag, at);
      if (tags.length === 0) return;
      try {
        if (!(await ensureStore()) || !client) return;
        await client.batch(
          tags.map((tag) => ({
            sql:
              'INSERT INTO tag_stamps(tag, revalidated_at) VALUES (?, ?) ' +
              'ON CONFLICT(tag) DO UPDATE SET revalidated_at = MAX(revalidated_at, excluded.revalidated_at)',
            args: [tag, at],
          })),
          'write',
        );
      } catch (error) {
        warnOnce(`tag-stamp write failed; local state kept (${(error as Error).message})`);
      }
    },
  };
}

/**
 * Default singleton. Next loads the module via `interopDefault`, so this
 * `default` export is the handler Next uses.
 */
export default createCacheHandler();
