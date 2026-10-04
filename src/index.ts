/**
 * cacheplank — "the shared plank your pods walk across."
 *
 * A single-file, tag-based distributed cache handler for Next.js 16, backed by
 * libSQL.
 *
 * Cache *entries* stay local to each process (an in-memory LRU). Only tag
 * *invalidation* is shared, through one tiny libSQL table (`tag_stamps`). Any
 * number of pods/regions converge because every `get` compares the entry's
 * timestamp against the shared invalidation stamps.
 *
 * Two handlers, one invariant. Next 16 exposes two distinct, unrelated cache
 * interfaces and resolves them from two different config keys:
 *
 *   1. `cacheHandlers` (plural) — a five-method API used for `"use cache"` /
 *      fetch-path entries. cacheplank's `default` export implements this.
 *   2. `cacheHandler` (singular) — the legacy incremental/ISR handler
 *      (`get`/`set`/`revalidateTag`/`resetRequestCache`) that sits under
 *      prerendered `APP_PAGE` / `APP_ROUTE` / `PAGES` routes and the fetch
 *      cache. The `cacheplank/cache-handler` entry implements this.
 *
 * Both share the same `tag_stamps` table and the same convergence rule, so a
 * `revalidateTag` from any pod invalidates both kinds of entry everywhere.
 *
 * Ground truth for the contracts below: the installed `next@16.3.8` package —
 * `dist/server/lib/cache-handlers/{types,default}.js`,
 * `dist/server/lib/incremental-cache/{index,file-system-cache}.js`,
 * `dist/server/lib/incremental-cache/tags-manifest.external.js`, and
 * `dist/server/use-cache/{use-cache-wrapper,handlers}.js`. See README
 * "Compatibility notes".
 */
import { createClient, type Client } from '@libsql/client';

/* ------------------------------------------------------------------------- *
 * Next 16 `cacheHandlers` (plural) contract — the five-method, `use cache` API.*
 * Hand-written: Next does not export these types publicly (README note #1).   *
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

/* ------------------------------------------------------------------------- *
 * Next 16 `cacheHandler` (singular) contract — the legacy incremental/ISR API. *
 * Mirrors `CacheHandler`/`CacheHandlerValue` in                                *
 * `next/dist/server/lib/incremental-cache/index.d.ts`. Values are opaque       *
 * JSON-ish objects (Buffers/headers/segment maps); we never introspect them,   *
 * only the tags they carry.                                                    *
 * ------------------------------------------------------------------------- */

/** Mirrors `GetIncremental*Context` (union) in next@16.3.8 — the fields we read. */
export interface IncrementalCacheContext {
  kind: string;
  route?: string;
  revalidate?: number;
  /** Fetch-cache entry tags (only for `kind: 'FETCH'`). */
  tags?: string[];
  /** Route-path-derived tags Next passes for staleness checks. */
  softTags?: string[];
  fetchCache?: boolean;
  isFallback?: boolean;
  isRoutePPREnabled?: boolean;
}

/** A stored incremental value. Opaque to us beyond `kind` and any tags. */
export interface IncrementalCacheValue {
  kind: string;
}

/** Mirrors `CacheHandlerValue` in next@16.3.8. */
export interface IncrementalCacheHandlerValue {
  lastModified: number;
  age?: number;
  cacheState?: string;
  value: IncrementalCacheValue | null;
}

/** Mirrors the singular `CacheHandler` class in next@16.3.8. */
export interface IncrementalCacheHandler {
  get(cacheKey: string, ctx: IncrementalCacheContext): Promise<IncrementalCacheHandlerValue | null>;
  set(cacheKey: string, data: IncrementalCacheValue | null, ctx: IncrementalCacheContext): Promise<void>;
  revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void>;
  resetRequestCache(): void;
}

/* ------------------------------------------------------------------------- *
 * Options.                                                                     *
 * ------------------------------------------------------------------------- */

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
  /**
   * Stamp retention window: stamps older than this are treated as inert and
   * excluded from shared-table reads. Bounds the shared table to tags touched
   * within the window. MUST be ≥ the app's longest entry lifetime (e.g. the
   * longest `cacheLife` expire), else entries that outlive the window can
   * resurrect stale. Defaults to `CACHEPLANK_STAMPS_RETENTION_MS`, else
   * 30 days. [ms]
   */
  stampsRetentionMs?: number;
  /** Sink for the single fail-open warning. Defaults to `console.warn`. */
  warn?: (message: string) => void;
}

/** Fail-open backoff after a stamp-store error, so we don't hammer a dead DB. [ms] */
const RETRY_BACKOFF_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 2000;
/** Default soft TTL for the in-process tag-stamp memo. [ms] */
const DEFAULT_STAMPS_TTL_MS = 3000;
/**
 * Default stamp retention window. Stamps older than this are ignored by
 * shared-table reads, bounding the table to tags touched within the window.
 * Generous enough to exceed any realistic max entry TTL (next's own `max`
 * cacheLife profile is a year — apps using it should raise this).
 * [ms]
 */
const DEFAULT_STAMPS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const now = (): number => Date.now();

/** Trims an env value; returns its numeric value, or undefined if blank/invalid. */
function envNumber(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

interface ResolvedOptions {
  url?: string;
  authToken?: string;
  prefix: string;
  maxEntries: number;
  tagCheckTtlMs: number;
  stampsRetentionMs: number;
  warn: (message: string) => void;
}

function resolveOptions(options: CacheplankOptions): ResolvedOptions {
  const configuredMax = envNumber('CACHEPLANK_MAX_ENTRIES');
  const configuredTtl = envNumber('CACHEPLANK_STAMPS_TTL_MS');
  const configuredRetention = envNumber('CACHEPLANK_STAMPS_RETENTION_MS');
  return {
    url: options.url ?? process.env.CACHEPLANK_URL ?? process.env.BUNNY_DATABASE_URL,
    authToken:
      options.authToken ?? process.env.CACHEPLANK_AUTH_TOKEN ?? process.env.BUNNY_DATABASE_AUTH_TOKEN,
    prefix: options.prefix ?? process.env.CACHEPLANK_PREFIX ?? '',
    // `>= 0` so `CACHEPLANK_MAX_ENTRIES=0` disables entry storage, mirroring
    // next's own `maxSize === 0` no-op handler; blank/garbage falls back.
    maxEntries:
      options.maxEntries ??
      (configuredMax !== undefined && configuredMax >= 0 ? configuredMax : DEFAULT_MAX_ENTRIES),
    tagCheckTtlMs:
      options.stampsTtlMs ??
      (configuredTtl !== undefined && configuredTtl >= 0 ? configuredTtl : DEFAULT_STAMPS_TTL_MS),
    // Window reads need a positive horizon; zero/blank/garbage → the default.
    stampsRetentionMs:
      options.stampsRetentionMs ??
      (configuredRetention !== undefined && configuredRetention > 0
        ? configuredRetention
        : DEFAULT_STAMPS_RETENTION_MS),
    warn: options.warn ?? ((message: string) => console.warn(`[cacheplank] ${message}`)),
  };
}

/* ------------------------------------------------------------------------- *
 * Shared tag-stamp store — the only shared state.                              *
 * ------------------------------------------------------------------------- */

interface StampStore {
  /** Monotonic in-process memo of tag → latest invalidation timestamp. */
  readonly stamps: Map<string, number>;
  /** Refresh the memo from the shared table, respecting the soft TTL. */
  sync(): Promise<void>;
  /** Latest stamp across `tags` (0 if none seen). */
  expiration(tags: string[]): Promise<Timestamp>;
  /** Write a monotone stamp for every tag, and make it self-visible at once. */
  update(tags: string[]): Promise<void>;
  /**
   * Record the fingerprint of a freshly rendered route: `generation` is the
   * route soft-tag stamp at publish time, `etag` hashes the stored payload.
   * Monotone on generation (never regress), fail-open like every write.
   */
  publishFingerprint(path: string, generation: number, etag: string): Promise<void>;
  /**
   * Fingerprint for `path`, or undefined. Only rows from a generation ≥
   * `minGeneration` (the caller's view of the route's current generation) and
   * within the retention window are returned — older ones are provably
   * superseded.
   */
  fingerprint(path: string, minGeneration: number): Promise<string | undefined>;
}

/**
 * One libSQL table holds invalidation stamps. Reads and writes are fail-open:
 * a dead store degrades to process-local invalidation, never an exception.
 */
function createStampStore(opts: ResolvedOptions): StampStore {
  const stamps = new Map<string, number>();
  let stampsSyncedAt = 0;

  let client: Client | undefined;
  let ready: Promise<boolean> | undefined;
  let retryAt = 0;
  let warned = false;
  function warnOnce(message: string): void {
    if (!warned) {
      warned = true;
      opts.warn(message);
    }
  }

  function observe(tag: string, at: number): void {
    if (at > (stamps.get(tag) ?? 0)) stamps.set(tag, at);
  }

  function ensureStore(): Promise<boolean> {
    if (ready) return ready;
    if (!opts.url) {
      warnOnce('no CACHEPLANK_URL / BUNNY_DATABASE_URL set; tag stamps are process-local only');
      return Promise.resolve(false);
    }
    if (now() < retryAt) return Promise.resolve(false);
    ready = (async () => {
      try {
        const created = createClient({ url: opts.url as string, authToken: opts.authToken });
        await created.execute(
          'CREATE TABLE IF NOT EXISTS tag_stamps (tag TEXT PRIMARY KEY, revalidated_at INTEGER NOT NULL)',
        );
        // Makes the retention-windowed sync read a range scan over live rows
        // instead of a full-table scan (rows_read stays O(window), not
        // O(every tag ever stamped)). Idempotent; rides the same lazy init.
        await created.execute(
          'CREATE INDEX IF NOT EXISTS tag_stamps_revalidated_at ON tag_stamps(revalidated_at)',
        );
        // Route fingerprints: per-path record of the latest generation's
        // rendered etag, so a sibling pod's middleware can answer a
        // conditional request (If-None-Match) with 304 without rendering.
        // `generation` is the route soft-tag stamp at publish time;
        // `published_at` is wall-clock (used for retention filtering —
        // generations are stamp epochs, not ages). Rows age out with the
        // same retention window as stamps.
        await created.execute(
          'CREATE TABLE IF NOT EXISTS route_fingerprints (' +
            'path TEXT PRIMARY KEY, generation INTEGER NOT NULL, ' +
            'etag TEXT NOT NULL, published_at INTEGER NOT NULL)',
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

  // Single-flight: one in-progress refresh; concurrent callers await it instead
  // of each issuing their own full-table SELECT at a TTL boundary.
  let syncing: Promise<void> | undefined;

  function sync(): Promise<void> {
    if (now() - stampsSyncedAt < opts.tagCheckTtlMs) return Promise.resolve();
    if (syncing) return syncing;
    // Claim the freshness window synchronously, so a burst of `get`s that all
    // observe the expired memo together joins the one refresh below.
    stampsSyncedAt = now();
    syncing = (async () => {
      try {
        if (!(await ensureStore()) || !client) return;
        // Retention window: stamps older than the window are provably inert
        // (every entry they could invalidate has expired by then), so they are
        // excluded here. That bounds memo size and read cost to tags touched
        // within the window instead of every tag ever stamped, and keeps the
        // range scan index-backed (see ensureStore).
        const result = await client.execute({
          sql: 'SELECT tag, revalidated_at FROM tag_stamps WHERE revalidated_at > ?',
          args: [now() - opts.stampsRetentionMs],
        });
        for (const row of result.rows) {
          const at = Number(row.revalidated_at);
          if (Number.isFinite(at)) observe(String(row.tag), at);
        }
      } catch (error) {
        retryAt = now() + RETRY_BACKOFF_MS;
        warnOnce(`tag-stamp read failed; serving local state (${(error as Error).message})`);
      } finally {
        syncing = undefined;
      }
    })();
    return syncing;
  }

  return {
    stamps,
    sync,
    async expiration(tags) {
      await sync();
      let max = 0;
      for (const tag of tags) {
        const at = stamps.get(tag) ?? 0;
        if (at > max) max = at;
      }
      return max;
    },
    async update(tags) {
      const at = now();
      for (const tag of tags) observe(tag, at);
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

    async publishFingerprint(path, generation, etag) {
      try {
        if (!(await ensureStore()) || !client) return;
        await client.execute({
          sql:
            'INSERT INTO route_fingerprints(path, generation, etag, published_at) VALUES (?, ?, ?, ?) ' +
            'ON CONFLICT(path) DO UPDATE SET ' +
            'generation = excluded.generation, etag = excluded.etag, published_at = excluded.published_at ' +
            'WHERE excluded.generation >= route_fingerprints.generation',
          args: [path, generation, etag, now()],
        });
      } catch (error) {
        warnOnce(`fingerprint write failed; conditional answers may re-render (${(error as Error).message})`);
      }
    },

    async fingerprint(path, minGeneration) {
      try {
        if (!(await ensureStore()) || !client) return undefined;
        // Retention on published_at (wall clock); generation check is the
        // freshness rule: a fingerprint from a superseded generation must
        // never answer (see resolveConditional).
        const result = await client.execute({
          sql:
            'SELECT etag FROM route_fingerprints ' +
            'WHERE path = ? AND generation >= ? AND published_at > ?',
          args: [path, minGeneration, now() - opts.stampsRetentionMs],
        });
        const row = result.rows[0];
        return row ? String(row.etag) : undefined;
      } catch (error) {
        warnOnce(`fingerprint read failed; rendering instead (${(error as Error).message})`);
        return undefined;
      }
    },
  };
}

/** LRU insert via Map insertion order, capped at `max`. */
function remember<V>(entries: Map<string, V>, key: string, value: V, max: number): void {
  entries.delete(key);
  entries.set(key, value);
  while (entries.size > max) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/** Extract the tag list a stored incremental value carries, if any. */
function valueTags(value: IncrementalCacheValue | null): string[] {
  if (!value) return [];
  const tags = (value as { tags?: unknown }).tags;
  if (Array.isArray(tags)) return tags.filter((t): t is string => typeof t === 'string');
  const headers = (value as { headers?: Record<string, string | string[]> }).headers;
  const header = headers?.['x-next-cache-tags'];
  if (typeof header === 'string') return header.split(',');
  return [];
}

/**
 * ETag of an incremental value's etag-able payload, mirroring next's
 * `generateETag(payload)` (FNV-1a over the response text, `lib/etag.js`) so
 * published fingerprints match what `sendRenderResult` computes for the same
 * bytes. Returns undefined when the kind has no single HTML payload
 * (FETCH, APP_ROUTE) or the html field is absent/not a string.
 */
function valueEtag(value: IncrementalCacheValue): string | undefined {
  if (value.kind !== 'APP_PAGE' && value.kind !== 'PAGES') return undefined;
  if (!('html' in value)) return undefined;
  const html: unknown = value.html;
  if (typeof html !== 'string') return undefined;
  return generateETag(html);
}

/**
 * Extract the URL path from a route-cache storage key:
 * `/route-cache/APP_PAGE/<sha256(owner)>/$/<normalized-path>` →
 * `/<normalized-path>`. Returns undefined for unexpected shapes.
 */
function routeFromCacheKey(cacheKey: string): string | undefined {
  const marker = '/$/';
  const at = cacheKey.lastIndexOf(marker);
  if (at === -1) return undefined;
  const normalized = cacheKey.slice(at + marker.length);
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

/** FNV-1a (52-bit), ported from next's `lib/etag.js` — identical output. */
function generateETag(payload: string): string {
  let v0 = 0x2325;
  let v1 = 0x8422;
  let v2 = 0x9ce4;
  let v3 = 0xcbf2;
  for (let i = 0; i < payload.length; ) {
    v0 ^= payload.charCodeAt(i++);
    const t0 = v0 * 435;
    let t1 = v1 * 435;
    let t2 = v2 * 435;
    let t3 = v3 * 435;
    t2 += v0 << 8;
    t3 += v1 << 8;
    t1 += t0 >>> 16;
    v0 = t0 & 65535;
    t2 += t1 >>> 16;
    v1 = t1 & 65535;
    v3 = (t3 + (t2 >>> 16)) & 65535;
    v2 = t2 & 65535;
  }
  const folded = (v3 & 15) * 281474976710656 + v2 * 4294967296 + v1 * 65536 + (v0 ^ (v3 >>> 4));
  return `"${folded.toString(36)}${payload.length.toString(36)}"`;
}

/* ------------------------------------------------------------------------- *
 * Handler 1 — `cacheHandlers` (plural). Entries are byte streams.              *
 * ------------------------------------------------------------------------- */

interface StoredEntry {
  bytes: Uint8Array;
  tags: string[];
  timestamp: number;
  expire: number;
  revalidate: number;
  stale: number;
}

/**
 * Create a `cacheHandlers` (plural) handler. The package's `default` export is
 * one of these, configured from the environment.
 */
export function createCacheHandler(options: CacheplankOptions = {}): CacheHandler {
  const opts = resolveOptions(options);
  const store = createStampStore(opts);

  // Local entry store, LRU via Map insertion order.
  const entries = new Map<string, StoredEntry>();
  // In-flight `set` calls, so a `get` racing a `set` waits instead of missing.
  const pendingSets = new Map<string, Promise<void>>();

  return {
    async get(cacheKey, softTags) {
      const key = opts.prefix + cacheKey;
      const pending = pendingSets.get(key);
      if (pending) await pending.catch(() => {});

      const entry = entries.get(key);
      if (!entry) return undefined;

      // Touch for LRU recency.
      entries.delete(key);
      entries.set(key, entry);

      // A negative `expire` is a tombstone: dropped for good here rather than
      // re-checked on every read (and independently of the retention bounds).
      if (entry.expire < 0) {
        entries.delete(key);
        return undefined;
      }
      // Mirror Next's effective expiry. `set` already dropped `expire: 0` in
      // production. The wrapper discards an entry once
      // `currentTime > timestamp + expire*1000` (always) or past `revalidate`
      // during static generation; the default handler additionally drops past
      // `revalidate` in production (SWR background revalidation takes over).
      // Dropping at either bound here matches what Next would reject anyway and
      // never serves a value the wrapper throws away. In dev next widens the
      // expire bound to MIN_PRERENDERABLE_EXPIRE (300s) — the default
      // handler's single dev max-age and the wrapper's dev expire check use
      // the same formula — so reloads of short-`expire` entries still hit; we
      // widen the expire-bound check to match instead of only the max-age
      // one. A `revalidate <= 0` (including SWR's `-1`) drops in production.
      const age = now() - entry.timestamp;
      const dev = Boolean(process.env.__NEXT_DEV_SERVER);
      const maxAgeSeconds = dev ? Math.max(entry.expire, 300) : entry.revalidate;
      const expireBoundSeconds = dev ? Math.max(entry.expire, 300) : entry.expire;
      if (
        !(age < maxAgeSeconds * 1000) ||
        (entry.expire >= 0 && !(age < expireBoundSeconds * 1000))
      ) {
        return undefined;
      }

      // Shared invalidation: any tag (own or route soft tag) stamped at or
      // after this entry was written means another pod revalidated it → miss,
      // so Next regenerates. `>=` mirrors Next's own wrapper-side discard.
      await store.sync();
      for (const tag of entry.tags) {
        if ((store.stamps.get(tag) ?? 0) >= entry.timestamp) return undefined;
      }
      for (const tag of softTags) {
        if ((store.stamps.get(tag) ?? 0) >= entry.timestamp) return undefined;
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
      const key = opts.prefix + cacheKey;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      pendingSets.set(key, gate);
      try {
        const entry = await pendingEntry;
        // In production an `expire: 0` entry is dynamic and never served back.
        if (entry.expire === 0 && !process.env.__NEXT_DEV_SERVER) return;

        const bytes = await drainStream(entry.value);
        remember(
          entries,
          key,
          {
            bytes,
            tags: entry.tags ?? [],
            timestamp: entry.timestamp,
            expire: entry.expire,
            revalidate: entry.revalidate,
            stale: entry.stale,
          },
          opts.maxEntries,
        );
      } catch (error) {
        opts.warn(`failed to buffer a cache entry (${(error as Error).message})`);
      } finally {
        release();
        pendingSets.delete(key);
      }
    },

    async refreshTags() {
      await store.sync();
    },

    async getExpiration(tags) {
      return store.expiration(tags);
    },

    async updateTags(tags, _durations) {
      // `durations.expire` is accepted but not persisted: the shared table holds
      // a single monotone stamp per tag. A profile'd `revalidateTag` therefore
      // invalidates immediately rather than stale-while-revalidate — safe, and
      // faithful to the one-table model. See README compatibility note #4.
      await store.update(tags);
    },
  };
}

/* ------------------------------------------------------------------------- *
 * Handler 2 — `cacheHandler` (singular). Entries are opaque JSON-ish values.   *
 * ------------------------------------------------------------------------- */

interface StoredIncrementalEntry {
  lastModified: number;
  value: IncrementalCacheValue;
}

/**
 * Create a `cacheHandler` (singular, incremental/ISR) handler **class**.
 *
 * Next instantiates this class once per request (`new CurCacheHandler(ctx)` in
 * `IncrementalCache`) and imports the module once, so all state lives in this
 * closure — shared across the per-request instances by construction.
 *
 * Unlike the plural handler we do *not* re-implement time-based expiry: the
 * incremental wrapper owns `revalidate`/`expire`/`isStale` semantics (it reads
 * them from the prerender manifest's cache controls), so we implement exactly
 * one policy — shared tag invalidation — and let Next decide everything else.
 * That is what makes fully-static `APP_PAGE` routes converge across pods.
 */
export function createIncrementalCacheHandler(
  options: CacheplankOptions = {},
): new (ctx: unknown) => IncrementalCacheHandler {
  const opts = resolveOptions(options);
  const store = createStampStore(opts);
  const entries = new Map<string, StoredIncrementalEntry>();

  return class CacheplankIncrementalCacheHandler implements IncrementalCacheHandler {
    // Next only ever passes its own context; we read none of it here (the
    // meaningful context is supplied per call to `get`/`set`).
    constructor(_ctx: unknown) {}

    async get(cacheKey: string, ctx: IncrementalCacheContext) {
      const key = opts.prefix + cacheKey;
      const entry = entries.get(key);
      if (!entry) return null;

      // Touch for LRU recency.
      entries.delete(key);
      entries.set(key, entry);

      // One shared rule, identical to the plural handler: a tag stamped at or
      // after the entry was written means some pod revalidated it → miss, so
      // Next regenerates (through the same response-cache path that wrote it).
      await store.sync();
      const tags = valueTags(entry.value);
      if (ctx.tags) tags.push(...ctx.tags);
      if (ctx.softTags) tags.push(...ctx.softTags);
      for (const tag of tags) {
        if ((store.stamps.get(tag) ?? 0) >= entry.lastModified) {
          entries.delete(key);
          return null;
        }
      }

      return { lastModified: entry.lastModified, value: entry.value };
    }

    async set(
      cacheKey: string,
      data: IncrementalCacheValue | null,
      ctx: IncrementalCacheContext,
    ) {
      const key = opts.prefix + cacheKey;
      // A null datum means "delete this key" (Next uses it to drop entries).
      if (data == null) {
        entries.delete(key);
        return;
      }
      // The incremental values are plain objects (Buffers, headers, segment
      // Maps) that Next does not mutate after writing, so we retain the
      // reference — exactly like Next's own in-memory `FileSystemCache`. Only
      // invalidation is shared; the entry itself never leaves this process.
      remember(entries, key, { lastModified: now(), value: data }, opts.maxEntries);

      // Publish a route fingerprint for fully-static HTML pages, so sibling
      // pods' middleware can answer conditional (If-None-Match) requests with
      // 304 without rendering. Generation = the route soft-tag stamp as of
      // THIS render; a later revalidation bumps the soft-tag stamp and
      // instantly supersedes this row (resolveConditional requires
      // generation >= current). Only APP_PAGE (one response per route);
      // FETCH/APP_ROUTE segment maps have no single etag-able payload.
      //
      // Route path: Next strips `ctx.route` for non-FETCH kinds before calling
      // us (IncrementalCache.set), but the storage key it hands us embeds the
      // owner hash and the normalized page path:
      //   /route-cache/APP_PAGE/<sha256(sourceRoute)>/$/<normalized-path>
      // The trailing segment is the URL path — use it for the fingerprint.
      if (data.kind === 'APP_PAGE') {
        const etag = valueEtag(data);
        if (etag) {
          // Next treats `/` and `/index` as the same route (implicit-tags
          // aliasing); normalize so middleware lookups for `/` find the row
          // and the soft-tag generation reads the same stamp revalidateTag
          // bumps (`_N_T_/`).
          const path = (ctx.route ?? routeFromCacheKey(cacheKey))?.replace(/\/index$/, '/') || '/';
          const softTag = `_N_T_${path}`;
          await store.sync();
          await store.publishFingerprint(path, store.stamps.get(softTag) ?? 0, etag);
        }
      }
    }

    async revalidateTag(tags: string | string[], _durations?: { expire?: number }) {
      // Same table, same monotone upsert as the plural handler, so a
      // `revalidateTag` invalidates both entry kinds across every pod.
      await store.update(typeof tags === 'string' ? [tags] : tags);
    }

    resetRequestCache() {
      // No per-request cache state to reset.
    }
  };
}

/* ------------------------------------------------------------------------- *
 * Small helpers.                                                               *
 * ------------------------------------------------------------------------- */

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
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
  return bytes;
}

/* ------------------------------------------------------------------------- *
 * Conditional-request (304) answering from shared fingerprints.                *
 * ------------------------------------------------------------------------- */

/** Options shared by every public entry point. */
export interface FingerprintOptions extends CacheplankOptions {}

/**
 * Decide a conditional request from the shared fingerprint table.
 *
 * Returns `304` when a pod has already rendered the *current generation* of
 * `pathname` and its published ETag equals `ifNoneMatch` — the caller (Next
 * middleware) may then answer `new NextResponse(null, { status: 304 })`
 * without rendering. Any other case returns `null`: render as usual.
 *
 * Safety rule baked in: the fingerprint's generation must be ≥ the route's
 * current generation (the `_N_T_<path>` stamp as seen through the same
 * sync'd memo the cache handlers use), and the row must be inside the
 * retention window. A revalidation bumps the stamp and instantly retires the
 * old fingerprint fleet-wide.
 */
export async function resolveConditional(
  pathname: string,
  ifNoneMatch: string | undefined,
  options: FingerprintOptions = {},
): Promise<304 | null> {
  if (!ifNoneMatch) return null;
  const resolved = resolveOptions(options);
  const store = createStampStore(resolved);
  await store.sync();
  const generation = store.stamps.get(`_N_T_${pathname}`) ?? 0;
  const etag = await store.fingerprint(pathname, generation);
  return etag !== undefined && etag === ifNoneMatch ? 304 : null;
}

/**
 * Next middleware wrapper answering conditional requests from shared
 * fingerprints. Install in `middleware.ts`:
 *
 *   import { withConditional304 } from 'cacheplank/middleware';
 *   export const middleware = withConditional304();
 *   export const config = { matcher: ['/:path*'] };
 *
 * Only GET/HEAD requests carrying `If-None-Match` consult the table (one
 * memoized lookup via the same single-flight sync); everything else passes
 * straight through. Fail-open: any store error → render as usual.
 */
export function withConditional304(options: FingerprintOptions = {}) {
  return async function middleware(request: Request): Promise<Response> {
    const ifNoneMatch = request.headers.get('if-none-match') ?? undefined;
    if (ifNoneMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      const pathname = new URL(request.url).pathname;
      const verdict = await resolveConditional(pathname, ifNoneMatch, options);
      if (verdict === 304) {
        return new Response(null, { status: 304 });
      }
    }
    // Neutral pass-through: let the request continue to the app. Returning a
    // plain 200 with no body rewrites nothing — Next middleware treats a
    // missing `x-middleware-next` header as "continue" only for its own
    // Response shape, so we use the official escape hatch instead.
    const headers = new Headers();
    headers.set('x-middleware-next', '1');
    return new Response(null, { status: 200, headers });
  };
}

/**
 * Default singleton for the plural `cacheHandlers` API. Next loads the module
 * via `interopDefault`, so this `default` export is the handler Next uses.
 */
export default createCacheHandler();
