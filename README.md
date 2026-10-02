# cacheplank

**The shared plank your pods walk across: one table of tag stamps, everything else stays local.**

`cacheplank` is a single-file, tag-based distributed cache handler for Next.js 16's
[`cacheHandlers`](https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheHandlers)
API, backed by [libSQL](https://github.com/tursodatabase/libsql).

Cache **entries** stay local to each process (a plain in-memory LRU). Only tag
**invalidation** is shared, through one tiny libSQL table (`tag_stamps`). Any
number of pods or regions converge because every `get` compares the entry's
timestamp against the shared invalidation stamps. That makes ISR/data-cache cost
structurally low for self-hosted deploys: every regeneration is a local memory
write, and the only durable write is a KB-scale tag-stamp upsert.

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
  cacheHandlers: {
    default: require.resolve('cacheplank'),
  },
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
};
```

That's it. The package's `default` export is a ready-to-use handler configured
from the environment.

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
| `CACHEPLANK_PREFIX` | `''` | String prepended to every key (the only build/deploy escape hatch) |
| `CACHEPLANK_MAX_ENTRIES` | `2000` | Local LRU capacity |
| `CACHEPLANK_STAMPS_TTL_MS` | `3000` | How long the in-process stamp memo is trusted |

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
exchange, the shared state is one KB-scale table, and a cold pod simply
regenerates locally instead of paying a network round-trip for every read.

The handler is **fail-open**: if the database is unreachable, `get` still serves
valid local entries, and `updateTags` / `refreshTags` resolve without throwing
(after logging exactly one warning). cacheplank never throws into Next's request
path.

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
   production.

Plus a cross-process fixture: two real child processes, one on-disk `file:` DB,
a stamp written by one observed by the other. Run everything with:

```sh
npm run build && npm test
```

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

## License

MIT.
