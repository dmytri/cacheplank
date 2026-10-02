# cacheplank — coding agent brief (build & publish)

You are implementing and publishing **cacheplank**: a single-file, tag-based distributed cache handler for Next.js 16's `cacheHandlers` API, backed by libSQL. Every design decision below was verified against Next 16.3.8 docs, Vercel/Bunny platform docs, and the target app's source. Do not re-derive or "improve" the architecture — implement this spec, verify the listed unknowns, publish.

## Mission

Next.js 16 (`cacheComponents: true`) exposes a pluggable cache handler. cacheplank implements it so that **cache entries stay local to each process** (plain in-memory LRU) while **tag invalidation is shared** through one tiny libSQL table (`tag_stamps`). Any number of pods/regions converge because every `get` checks entry timestamps against shared invalidation stamps. This makes ISR/data-cache cost structurally zero for self-hosted deploys (the motivating workload: a Saleor storefront with 10,000s of stock-of-one products where webhook-driven regeneration makes Vercel's per-write ISR billing expensive).

## Hard constraints (non-negotiable)

1.  **One file of logic** (≤ ~300 LOC excluding tests and types). If a feature would exceed this, refuse it.
    
2.  **Entries are never shared.** Only the tag-stamp table is shared state. This is the design, not a shortcut.
    
3.  **Fail-open, always.** If the DB is unreachable: `get` still returns valid local entries, `updateTags`/`refreshTags` log one warning and continue. Never throw into Next's request path.
    
4.  **Zero runtime deps** except `@libsql/client`. No Redis, no other stores, no driver abstraction, no HTTP endpoints, no config files (env vars only), no telemetry, no instrumentation hooks, no build-ID coupling (an optional `CACHEPLANK_PREFIX` string concat is the entire escape hatch).
    
5.  **Bunny-specific features are forbidden** in the package (e.g. `replication_index` wait-for-position reads — verified to be a Bunny extension, not in the Hrana 3 spec). Portability across libSQL URL schemes is the point: `:memory:`, `file:`, `libsql://` (Turso), Bunny DB URLs must all work.
    

## The contract (Next 16 `cacheHandlers` — verified from nextjs.org docs)

Config: `cacheHandlers: { default: require.resolve('cacheplank') }`. The handler is a plain object with five async methods. `CacheEntry`:

```ts
{ value: ReadableStream<Uint8Array>; tags: string[]; stale: number;
  timestamp: number; expire: number; revalidate: number } // timestamp in ms
```

*   `get(cacheKey: string, softTags: string[]): Promise<CacheEntry | undefined>` — `softTags` are route-path-derived tags; treat them exactly like entry tags for staleness.
    
*   `set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void>` — **must await** `pendingEntry`; `value` is a stream that may still be open. Buffer it (read to completion, store bytes) and reconstruct a fresh `ReadableStream` in `get` (this is the documented Redis-example pattern).
    
*   `refreshTags(): Promise<void>` — called before requests; sync the stamps memo.
    
*   `getExpiration(tags: string[]): Promise<number>` — most recent revalidation timestamp across the tags (default impl is `Math.max(...ts, 0)`).
    
*   `updateTags(tags: string[], durations: unknown): Promise<void>` — called when `revalidateTag()` fires; write stamps to shared storage.
    

**Ground truth rule:** where docs are ambiguous, read the installed `next@16.3.8` package's default handler implementation (docs state it is viewable as reference) and the handler types. Code is truth, prose isn't.

## Data model

```sql
CREATE TABLE IF NOT EXISTS tag_stamps (
  tag TEXT PRIMARY KEY,
  revalidated_at INTEGER NOT NULL  -- ms epoch
);
-- the idempotency crown jewel; batch all tags of one updateTags call:
INSERT INTO tag_stamps(tag, revalidated_at) VALUES (?, ?)
  ON CONFLICT(tag) DO UPDATE SET revalidated_at = MAX(revalidated_at, excluded.revalidated_at)
```

In-process state: a `Map` stamp memo (refreshed by `refreshTags`, soft-TTL `TAG_CHECK_TTL_MS = 3000`; update locally after own `updateTags` for immediate self-visibility) and a capped entry LRU (`CACHEPLANK_MAX_ENTRIES`, default 2000; Map delete+set trick). Table creation is lazy at first use, fail-open.

## Method semantics

*   `get`: L1 hit? → check expiry (`now > timestamp + revalidate*1000`, and `expire` window — mirror the default handler's exact logic) → check staleness: if any of `entry.tags ∪ softTags` has `stamp > entry.timestamp` → return `undefined` (Next regenerates). Miss → `undefined`.
    
*   `set`: await entry → read stream to bytes → store `{bytes, tags, softTags, timestamp, expire, revalidate, stale}` in L1 under `CACHEPLANK_PREFIX + cacheKey`.
    
*   `updateTags`: batched MAX-upsert of all tags at `Date.now()`.
    
*   `getExpiration`: max over memo stamps for requested tags (0 if none).
    
*   `refreshTags`: if memo older than `TAG_CHECK_TTL_MS`, `SELECT tag, revalidated_at FROM tag_stamps` into the memo. Whole table is fine — it's KB-scale.
    

## The six invariants = the test file

These tests ARE the compatibility contract. Write them first, against `:memory:`:

1.  `set` → `get` roundtrip returns identical bytes, tags, timestamps.
    
2.  `updateTags` is idempotent and monotone: same tag twice, older timestamp loses (`MAX` wins); two interleaved upserts both succeed.
    
3.  Tag mutation after write → miss: entry tagged `a`, `updateTags(['a'])`, `get` → `undefined`; a softTag stamping also misses the entry.
    
4.  Fail-open: client pointed at an unreachable port → `get` still returns the valid local hit; `updateTags`/`refreshTags` resolve without throwing.
    
5.  `get` after `set` works when only tags are set (never rely on revalidate times round-tripping through Next).
    
6.  Expiry: past `revalidate` → `undefined`; past `expire` → `undefined`; inside `stale` semantics as the default handler treats them.
    

Run on Node 20/22 with `next@16.3.8` in devDeps for types. Optional stretch (do only if quick): two-process fixture proving cross-process invalidation via a shared `file:` DB.

## Package

*   **Name:** `cacheplank@0.1.0` (unscoped — verified free on npm and GitHub, Oct 2026). MIT. `engines: node >=20`.
    
*   `dependencies`: `@libsql/client`. `peerDependencies`: `next >=16.0.0` (Next 16 five-method API only — 15.x's older handler shape is explicitly out of scope).
    
*   Author in **TypeScript, one source file**; compile dual CJS+ESM with a `.d.ts` and `exports` map. **Must be loadable via** `require.resolve()` (Next docs' config pattern) and importable in ESM configs. `files: ["dist", "README.md"]`.
    
*   Env vars: `CACHEPLANK_URL` + `CACHEPLANK_AUTH_TOKEN`, falling back to `BUNNY_DATABASE_URL` + `BUNNY_DATABASE_AUTH_TOKEN` (target deployment injects those names natively).
    
*   Repo: `cacheplank`, CI running tests on Node 20/22.
    

## README must-haves

One-liner: **"cacheplank — the shared plank your pods walk across: one table of tagstamps, everything else stays local."** Then: 10-line quickstart (env + config snippet); examples for `:memory:`, `file:`, Turso, Bunny DB; and this negative promise verbatim-ish: **"cacheplank does not share cache entries between pods. Entries are local and derived; only invalidation is shared. If you want shared entry storage, this is not your package."** Compatibility note: "verified against [next@16.3.8](mailto:next@16.3.8); the handler API is platform-unofficial — pin your Next version and treat the tests as the contract."

## Known unknowns — verify in installed [next@16.3.8](mailto:next@16.3.8), then document in README "Compatibility notes"

1.  Exact `CacheHandler` TS types — import from next's exported types if available, else hand-write to match.
    
2.  How `revalidatePath` interacts with handlers (softTags? separate mechanism?) — read source, document findings.
    
3.  Whether `cacheKey` embeds the build generation (deploy staleness) — if not, ship `CACHEPLANK_PREFIX` (already specced).
    
4.  The `durations` param shape in `updateTags` — accept; store if useful; otherwise ignore.
    
5.  Location of the default in-memory handler in the package (your reference implementation).
    

## Publishing checklist

`npm whoami` → build → test → `npm publish` (unscoped public) → git tag `v0.1.0` → GitHub repo with CI → verify `npx cacheplank` — no, don't add a bin; verify via a fresh `npm i cacheplank` in a scratch Next 16 fixture with `cacheHandlers` wired and one `use cache` route, two concurrent processes, stamp written by one visible to the other.

## Context (why, in one paragraph for the commit message / release notes)

Target app: saleor/storefront ("Paper"), Next 16.3.8, `cacheComponents: true`, tag-first webhook invalidation (`/api/revalidate` → `revalidateTag` with cacheLife profiles; channel/locale-sharded tags via its cache-manifest). Self-hosting goal: Bunny Magic Containers + Bunny Database (libSQL). Vercel bills ISR writes 10× reads and this workload is regen-heavy by design; on self-hosted pods every regen is a local memory write and the only durable write is a KB-scale tagstamp upsert. cacheplank is the entire migration surface for caching: one `next.config` line, one env pair, one table.
