# cacheplank

**The shared plank your pods walk across: one table of tag stamps, everything else stays local.**

`cacheplank` is a single-file, tag-based distributed cache handler for Next.js 16,
backed by [libSQL](https://github.com/tursodatabase/libsql).

Next 16 has **two** pluggable cache interfaces, resolved from two different
config keys. cacheplank implements **both**, so every kind of cached route
converges across pods:

| Config key | Interface | Serves | cacheplank entry |
| --- | --- | --- | --- |
| `cacheHandlers` (plural) | five-method `use cache` API | `"use cache"` results, fetch path | `cacheplank` (default export) |
| `cacheHandler` (singular) | legacy incremental / ISR | prerendered **static** `APP_PAGE` / `APP_ROUTE` / `PAGES`, fetch cache | `cacheplank/cache-handler` (default export) |

Cache **entries** stay local to each process (a plain in-memory LRU). Only tag
**invalidation** is shared, through one tiny libSQL table (`tag_stamps`). Both
handlers read and write that one table, so a `revalidateTag` from any pod
invalidates every entry kind everywhere: every `get` compares the entry's
timestamp against the shared invalidation stamps. That makes ISR/data-cache cost
structurally low for self-hosted deploys: every regeneration is a local memory
write, and the only durable write is a one-row tag-stamp upsert.

## Quickstart

```sh
npm i cacheplank
```

```sh
# One env pair is the entire migration surface.
CACHEPLANK_URL=libsql://your-db.turso.io
CACHEPLANK_AUTH_TOKEN=...
```

```js
// next.config.js  (CommonJS)
module.exports = {
  cacheComponents: true,
  // "use cache" / fetch path (the five-method API):
  cacheHandlers: {
    default: require.resolve('cacheplank'),
  },
  // Prerendered static routes + ISR (the incremental/ISR API):
  cacheHandler: require.resolve('cacheplank/cache-handler'),
};
```

```js
// next.config.mjs  (ESM) — `require` doesn't exist here, so create it:
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export default {
  cacheComponents: true,
  cacheHandlers: {
    default: require.resolve('cacheplank'),
  },
  cacheHandler: require.resolve('cacheplank/cache-handler'),
};
```

That's it. Each entry's `default` export is a ready-to-use handler configured
from the environment. You can enable just one if you prefer — the two keys are
independent — but you need **both** for fully-static pages to converge (see
[Compatibility notes](#compatibility-notes) #6, and `npm run test:e2e`).

> **Both handler paths must be absolute.** Next joins each config value against
> the `.next/` directory (`formatDynamicImportPath(distDir, …)` in
> `next-server.js`, called for `cacheHandlers` and `cacheHandler` alike), so a
> relative `./cache-handler.cjs` resolves to `.next/cache-handler.cjs` and
> throws `ERR_MODULE_NOT_FOUND` at startup. `require.resolve('cacheplank')` and
> `require.resolve('cacheplank/cache-handler')` yield absolute paths and are the
> recommended forms; plain absolute paths and `file://` URLs also work.

### Optional: 304 answers from shared fingerprints (`cacheplank/middleware`)

When a pod re-renders a fully-static route, it also publishes a tiny
**fingerprint** row — `{ path, generation, etag }` — to the shared table
(`route_fingerprints`, same retention window as stamps). A `middleware.ts`
using `cacheplank/middleware` answers conditional requests whose
`If-None-Match` matches the **current generation's** published etag with
**304** — before Next renders anything. The classic case: pod A regenerated,
the CDN holds A's etag, and the CDN's revalidation lands on pod B — B answers
304 from the table instead of re-rendering the identical page.

```js
// middleware.ts  (Next 16: the file may also be named `proxy.js`)
import { withConditional304 } from 'cacheplank/middleware';

export default withConditional304();          // or withConditional304(options)
export const config = { matcher: ['/:path*'] };
```

Facts worth knowing:

- **What is shared is metadata, never content**: a 48-byte row per route
  generation. Entries stay process-local as always.
- **A 304 is only ever answered for the current generation.** Any
  `revalidateTag` bumps the route's soft-tag stamp (`_N_T_<path>`) and
  instantly retires the old fingerprint on every pod — a stale etag can never
  bless stale content. Rows age out with `CACHEPLANK_STAMPS_RETENTION_MS`
  like stamps.
- **Fingerprints are published for `APP_PAGE` values** (fully-static/ISR
  HTML). `use cache`/RSC segment payloads have no single etag-able body and
  are not fingerprinted.
- ETags are computed with Next's own algorithm (`lib/etag.js` FNV-1a over the
  payload), so published etags match what Next's send layer computes for the
  same bytes.
- Without this middleware nothing changes: the handlers behave exactly as
  before, and every conditional falls through to the normal render path.

### Storage backends

Any libSQL URL scheme works — the table is created lazily on first use.

```sh
CACHEPLANK_URL=:memory:                       # tests / single process
CACHEPLANK_URL=file:./.cache/tag_stamps.db    # one box, several processes
CACHEPLANK_URL=libsql://db.turso.io           # Turso (add CACHEPLANK_AUTH_TOKEN)
CACHEPLANK_URL=libsql://db.bunny.net          # Bunny Database (libSQL)
```

The target deployment injects Bunny's native names, so these are honored as
fallbacks: `BUNNY_DATABASE_URL` and `BUNNY_DATABASE_AUTH_TOKEN`.

### Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `CACHEPLANK_URL` | — | libSQL URL (falls back to `BUNNY_DATABASE_URL`) |
| `CACHEPLANK_AUTH_TOKEN` | — | libSQL token (falls back to `BUNNY_DATABASE_AUTH_TOKEN`) |
| `CACHEPLANK_PREFIX` | `''` | String prepended to every cache key. Namespaces **entry keys only** — tag stamps are global, so configs sharing one DB cross-invalidate on identical tag strings |
| `CACHEPLANK_MAX_ENTRIES` | `2000` | Local LRU capacity, **counted in entries, not bytes** — size it to your pod's memory; `0` disables entry storage |
| `CACHEPLANK_STAMPS_TTL_MS` | `3000` | How long the in-process stamp memo is trusted |
| `CACHEPLANK_STAMPS_RETENTION_MS` | `2592000000` (30d) | Stamp retention window: stamps older than this are ignored by shared-table reads, bounding the table and every sync to tags touched within the window. **Set it ≥ your longest entry lifetime** (longest `cacheLife` expire) — see below |

The same options can be passed programmatically:

```js
import { createCacheHandler } from 'cacheplank';

const handler = createCacheHandler({ url: process.env.CACHEPLANK_URL, prefix: 'prod' });
```

## What it does *not* do

> **cacheplank does not share cache entries between pods. Entries are local and
> derived; only invalidation is shared. If you want shared entry storage, this is
> not your package.**

That is the design, not a shortcut. Two pods will each render and each hold their
own copy; what they agree on is *what is stale*, not *what is cached*. In
exchange, the shared state is one small table (≈48 bytes per distinct tag ever
revalidated), and a cold pod simply regenerates locally instead of paying a
network round-trip for every read.

The handlers are **fail-open**: if the database is unreachable, `get` still
serves valid local entries, and `updateTags` / `refreshTags` / `revalidateTag`
resolve without throwing (after logging exactly one warning). cacheplank never
throws into Next's request path.

There is a **bounded convergence window**: a pod's in-process view of
invalidation is refreshed from the shared table at most every
`CACHEPLANK_STAMPS_TTL_MS` (default 3s). A pod therefore converges on another
pod's `revalidateTag` within that window, not instantaneously. Set the env var to
`0` to consult the shared table on every read. Once the memo expires,
concurrent reads coalesce into a single windowed query (single-flight
refresh), so a read burst costs one stamp query per handler instance per
window. That query only reads stamps **inside the retention window**
(`CACHEPLANK_STAMPS_RETENTION_MS`, default 30 days) via an auto-provisioned
index on the stamp age — so sync cost and memo size track the tags *touched
recently*, not every tag ever stamped. Rows are never deleted; they simply age
out of the window (a 48-byte row that nothing reads costs disk alone).

**The retention window is a correctness knob, not a tuning knob.** A stamp
guards entries written before it, and entries die at `timestamp + expire`;
so a stamp is provably inert once older than the app's longest entry
lifetime. Keep `CACHEPLANK_STAMPS_RETENTION_MS` ≥ your longest `cacheLife`
expire, or entries that outlive the window (including no-expiry static
pages) can resurrect stale after the window passes.

After a **database error** (as opposed to the URL merely being unset), the pod
backs off 30s before retrying the store — fail-open recovery can therefore lag
the configured `CACHEPLANK_STAMPS_TTL_MS` by that much. With no URL configured
at all, the handler warns once and stays process-local permanently.

## Invariants (the compatibility contract)

These are enforced by the test suite, which runs against the built artifacts —
the thing npm actually ships:

1. `set` → `get` roundtrip returns identical bytes, tags, and timestamps.
2. `updateTags` is idempotent and monotone across processes sharing one DB
   (`MAX` wins, interleaved upserts all land).
3. A tag mutation after a write makes the entry miss — entry tags and route
   soft tags alike.
4. Fail-open: an unreachable store never throws, and local hits still serve.
5. `get` after `set` works with tags alone (never relies on revalidate times
   round-tripping through Next).
6. Expiry mirrors Next's own bounds: an entry is a miss past `revalidate` **or**
   past `expire` (the wrapper discards on either), `expire < 0` is the tiered-cache
   eviction sentinel → miss, and `expire === 0` is dynamic and not stored in
   production. In dev (when `__NEXT_DEV_SERVER` is set) both bounds widen to
   `MIN_PRERENDERABLE_EXPIRE` (300s), matching next's own dev retention, and
   `CACHEPLANK_MAX_ENTRIES=0` disables entry storage (next's `maxSize: 0`
   semantics).
7. Stamp refreshes are single-flight: however many reads observe an expired
   memo together, exactly one shared-table query is issued per handler
   instance, and the rest await its result.

The same invariants are enforced for **both** handlers (the plural
`cacheHandlers` and the singular `cacheHandler`), plus a cross-process fixture:
two real child processes, one on-disk `file:` DB, a stamp written by one observed
by the other. Run everything with:

```sh
npm run build && npm test && npm run test:e2e
```

`npm run test:e2e` is the end-to-end proof of the issue that motivated the
singular handler: it builds a real `next` app with a **fully-static** route,
copies it into two independent pods (separate `.next`, separate memory, sharing
only the stamp DB), and asserts that pod B converges on pod A's
`revalidateTag`. Run it with `WITH_SINGULAR=0` for the control — without the
singular handler, pod B does not converge.

## Compatibility notes

**Verified against [next@16.3.8](https://www.npmjs.com/package/next/v/16.3.8);
the handler API is platform-unofficial — pin your Next version and treat the
tests as the contract.** The following were resolved by reading the installed
package's source (code is truth, prose isn't):

1. **Types are hand-written.** Next does not export `CacheHandler` / `CacheEntry`
   from its public surface; the canonical definitions live in
   `dist/server/lib/cache-handlers/types.d.ts`. cacheplank mirrors them exactly
   (including the `[seconds]` durations and the ms-epoch `timestamp`), so it
   compiles without depending on Next's internal paths.
2. **`revalidatePath` is soft-tag based.** Next derives implicit tags from the
   route path (`_N_T_/…/layout`, `_N_T_/<path>`, with `/` ↔ `/index` aliases) in
   `dist/server/lib/implicit-tags.js` and passes them to `get` as `softTags`.
   `revalidatePath` ultimately calls `updateTags([_N_T_<path>])`, so it flows
   through the same shared-stamp path as any other tag. cacheplank treats
   `softTags` identically to entry tags.
3. **The cache key embeds a build ID.** `use-cache-wrapper.js` seeds the key with
   `workStore.deploymentId || workStore.buildId`, so a new deploy does not reuse
   old entries. No extra coupling is needed; `CACHEPLANK_PREFIX` remains as an
   optional manual namespace.
4. **`updateTags` `durations` is accepted but not persisted.** Next passes
   `{ expire }` in seconds when `revalidateTag` uses a cacheLife profile. The
   one-table model stores a single monotone stamp per tag, so a profile-driven
   `revalidateTag` invalidates immediately rather than serving stale-while-
   revalidate. This is safe (never serves stale data); it only forgoes a
   background-refresh window.
5. **The default handler is the reference.** Next's in-memory handler is
   `dist/server/lib/cache-handlers/default.js`; cacheplank's expiry logic and its
   negative-`expire` / `expire === 0` handling are mirrored from it deliberately.
6. **There are two cache-handler interfaces, not one.** Next resolves
   `cacheHandlers` (plural, five-method) and `cacheHandler` (singular, legacy
   incremental/ISR) independently — `next-server.js` imports both, and
   `IncrementalCache` constructs the singular one with `new`. A fully-static
   prerendered route never touches the plural handler; it is served through the
   singular incremental cache (or, with no handler configured, a pod-local
   on-disk `route-cache`). **A singular `cacheHandler` makes Next bypass that
   on-disk file and consult the handler for every request**, which is what lets
   static routes converge. cacheplank ships both entries off one shared table.
   The singular path is resolved against `.next/`, so it must be absolute.
7. **The singular handler is instantiated per request.** `IncrementalCache` does
   `new CurCacheHandler(ctx)` for each request while the module itself is
   imported once, so cacheplank keeps all singular-handler state (the entry LRU
   and the stamp memo) in a module-level closure — shared across those
   instances. Singular entries are opaque values (Buffers, headers, segment
   `Map`s); cacheplank retains the object by reference, exactly like Next's own
   in-memory `FileSystemCache`. Time-based `revalidate` / `expire` / `isStale`
   semantics are owned by the wrapper, not the handler, so the singular handler
   implements exactly one policy: shared tag invalidation.

## License

MIT.
