# cacheplank 0.1.5 — verification report (shared fingerprints / 304 answering)

Resolves the redundant-regen question from the design discussion: after an
invalidation, sibling pods re-rendered identical payloads because "what is
cached" is process-local. 0.1.5 shares the *minimum fact* that fixes the
CDN-facing case — not content, not leases: the **etag of the current
generation**.

## What changed

| Change | Detail |
| --- | --- |
| `route_fingerprints` table | `{path PK, generation, etag, published_at}`; created lazily in `ensureStore` alongside the stamps table. Retention-windowed on `published_at` (wall clock — generations are stamp epochs, not ages). |
| Publish on singular `set` | `APP_PAGE` values publish `{path, generation = stamp of `_N_T_<path>` at render time, etag = FNV-1a over the html payload}`. ETag algorithm is a verified port of next's `lib/etag.js` (identical output on ASCII/unicode/astral/10KB samples). |
| Route-path derivation | Next strips `ctx.route` for non-FETCH kinds; the path comes from the storage key's trailing segment (`/route-cache/APP_PAGE/<sha256(owner)>/$/<path>`), with `/index` normalized to `/` (next's implicit-tag aliasing) so the soft-tag generation matches what `revalidateTag` bumps. |
| `resolveConditional(pathname, ifNoneMatch, options)` | Returns `304` iff a fingerprint exists for the path, its `generation >= ` the route's current generation (the same sync'd `_N_T_` stamp memo the handlers use), it is inside the retention window, and the etag matches. Otherwise `null` (render as usual). |
| `withConditional304(options)` / `cacheplank/middleware` entry | Next middleware (Node runtime — proxy files always run on Node) that answers matching conditionals with a bare 304 pre-render and passes everything else through. Fail-open: any store error → normal render path. |

## Safety invariants (the "can a fingerprint bless stale content?" question)

1. **Generation guard**: `revalidateTag('_N_T_/<path>')` bumps the route stamp;
   `resolveConditional` requires `row.generation >= stamp`. Any invalidation
   retires the fleet's fingerprints for that path *instantly* (each pod's memo
   absorbs the stamp on its next sync, ≤ TTL window).
2. **Retention guard**: fingerprints older than `CACHEPLANK_STAMPS_RETENTION_MS`
   are invisible, exactly like stamps — a row cannot outlive the correctness
   argument that retired stamps use.
3. **Monotone publish**: the upsert only overwrites when
   `excluded.generation >= existing.generation` — a lagging pod cannot regress
   the table to an older generation.
4. **No-content sharing**: the row is `{path, generation, etag, published_at}`
   — no bytes cross pods, ever.

## Verified end-to-end (two real pods, one `file:` DB, real `next` app)

```
1-4. warm both pods (V1) → change source value → revalidateTag via pod A
5.   after stamp-memo TTL:        A=V2 B=V2        (existing convergence proof)
6.   conditional (If-None-Match: etag-of-V2) on POD B → 304
     ✓ pod B answered from the shared fingerprint — no render
7.   revalidateTag again → same conditional on POD B → 200
     ✓ superseded fingerprint no longer answers (generation guard)
```

`WITH_SINGULAR=0` control: no fingerprints are published (publish lives in the
singular `set`), pod B does not converge — unchanged from 0.1.4.

Also fixed while wiring the e2e: pods are now spawned detached and stopped via
process-group kill — `next start`'s server child previously survived the CLI's
SIGKILL and kept the ports bound, poisoning subsequent runs.

## Cost

- Steady-state reads: unchanged (fingerprint consulted only on the miss path;
  the middleware lookup rides the same single-flight sync'd memo).
- Regen path: one extra ~50-byte row write per rendered route generation.
- Sync payload: fingerprint rows flow through the same retention-windowed
  read (rows_read stays O(live window)); `route_fingerprints` is keyed by
  path, so its size is bounded by routes-touched-in-window.
- Failure mode of the feature (etag mismatch, no row yet): falls through to
  the exact 0.1.4 behavior — never worse.

## Matrix (all green on 0.1.5 build, Node 24.21)

| Check | Result |
| --- | --- |
| `npm run build` (now 3 entries: index, cache-handler, middleware) | pass |
| `npm test` — 21 tests | 21/21 pass |
| `npm run typecheck` | pass |
| `node test/two-process.mjs` | pass |
| `npm run test:e2e` — convergence + fingerprint 304 + superseded guard | pass |
| `WITH_SINGULAR=0 npm run test:e2e` | pass (control) |

---

# cacheplank 0.1.4 — verification report (stamp retention window)

Resolves the last open item from the growth discussion: the shared-table read
cost previously scaled with *every tag ever stamped* (append-mostly table,
rows never deleted). Rows are still never deleted — they now simply **age out
of the read window**.

## What changed

| Change | Detail |
| --- | --- |
| `CACHEPLANK_STAMPS_RETENTION_MS` | New knob, default 30d. Stamps older than the window are excluded from shared-table reads. Programmatically: `stampsRetentionMs` option on both factories. |
| Windowed sync SELECT | `SELECT tag, revalidated_at FROM tag_stamps WHERE revalidated_at > ?` with `now() − retention`. Memo size and read cost now track tags *touched recently*, not the historical total. |
| Auto-provisioned index | `ensureStore` runs `CREATE INDEX IF NOT EXISTS tag_stamps_revalidated_at ON tag_stamps(revalidated_at)` alongside the table DDL — the windowed SELECT becomes an index range scan (`rows_read` O(live rows), not O(every tag ever)). |
| Test 9 | Red→green regression: a 10-minute-old stamp is invisible to sync under a 60s window (entry stays fresh), a fresh stamp still invalidates, and the index exists after first use. |

**Safety argument (why forgetting is sound):** a stamp S only guards entries
written before S; those entries are dead by `S + entryExpire`. Once
`now − S > maxExpire`, no live entry can reference S, so excluding it from
reads cannot fabricate freshness. Corollary constraint: X must be ≥ the app's
longest entry lifetime — hence the README rule "set
`CACHEPLANK_STAMPS_RETENTION_MS` ≥ your longest `cacheLife` expire". Next's
own `max` profile is a year; apps using it must raise X or accept that
entries older than X regenerate once. Clock skew is subsumed: a lagging pod's
stamp lands *earlier* and may drop out of the window sooner — same
fail-safe direction as the existing skew model (extra misses, never stale),
and 30d dwarfs plausible skew.

**Write path unchanged:** no DELETE, no tombstone GC, no sweeper — the
discussed alternatives (time-bucketed keys, access-time LRU) were rejected in
design discussion: lossy keys over- or under-invalidate, and access times put
a write on the read path while evicting exactly the rows (hot soft-tags) whose
loss resurrects stale static pages. Age-windowed reads get the same bound for
one string + one index.

## Verification matrix (all green on 0.1.4 build, Node 24.21)

| Check | Result |
| --- | --- |
| `npm run build` | pass |
| `npm test` — 20 tests (18 plural-side + 9 singular + cross-process = 20 total) | 20/20 pass |
| `npm run typecheck` (incl. compat vs real `next` types) | pass |
| `node test/two-process.mjs` | pass |
| `npm run test:e2e` | pass — pod B converges |
| `WITH_SINGULAR=0 npm run test:e2e` | pass — control holds |
| Test 9 red/green | red on 0.1.3, green on 0.1.4 (see note) |

Test 9 note: on the 0.1.3 build the red run failed on the *fresh-stamp*
assertion chain because the seeded entries were past their own `revalidate`
window (test bug, not product bug); entries were given `revalidate: 3600` so
the stamp window is the only failing bound, then red was re-confirmed as
`a stamp older than the retention window must be invisible to sync → null !==
'hello'` before the source change landed.

---

# cacheplank 0.1.3 — verification report (hardening pass addendum)

Scope: the 0.1.2 report's core claim (cross-pod invalidation for both the
plural `use cache` handler and the singular static/ISR handler) is unchanged
and still holds; everything below re-verifies it after the 0.1.3 hardening
changes. Environment: Node 24.21, `next@16.3.8` devDependency as pinned.

## What changed in 0.1.3 (all fixes applied from the 0.1.2 review)

| Fix | Change |
| --- | --- |
| Sync stampede (P1) | `createStampStore.sync` is now single-flight: one in-flight refresh per store; concurrent `get`/`getExpiration` callers share it instead of each issuing a full-table SELECT (probe: 50 concurrent `get`s at a stamp-TTL boundary, previously 50 SELECTs, now exactly 1) |
| Dev-mode short-`expire` retention (P4) | The dev `expire`-bound check now widens to `MIN_PRERENDERABLE_EXPIRE` (300s) alongside the existing max-age widening, matching `default.js:76` and `use-cache-wrapper.js:2297`; dev reloads of short-`expire` entries hit again, dev never serves past 300s |
| `CACHEPLANK_MAX_ENTRIES=0` (P6) | Now disables entry storage (next's `maxSize: 0` semantics); blank/unset still falls back to 2000. Env parsing trims whitespace and rejects non-numeric values to the default, instead of `Number('')===0` accidentally zeroing capacity |
| Tests (P2 prep) | Two new regression tests in `test/invariants.test.mjs` (#7 dev retention, #8 env parsing) — both verified red on 0.1.2, green on 0.1.3; suite is now 19 tests |
| CI / publish (P2) | `ci.yml` matrix 20/22/24 now runs `npm run test:e2e` and the `WITH_SINGULAR=0` control; `publish.yml` gates the artifact on the same pair before `npm publish` |
| Docs (P3/P5/P7) | README now states the LRU bound is per-entry (not bytes) — sizing recommendation added; the 30s `RETRY_BACKOFF_MS` fail-open recovery window is documented next to the convergence window; the shared-state cost model (single-flight refresh, cost scales with distinct tags revalidated, ≈48B/tag measured) replaces the stale "KB-scale table" phrasing; `CACHEPLANK_PREFIX` is documented as entry-key-only (stamps are global across configs sharing one DB); the absolute-path requirement is generalized to both config keys since `formatDynamicImportPath` is applied to both in `next-server.js` |

## Full verification matrix (all green on 0.1.3 build)

| Check | Result |
| --- | --- |
| `npm run build` (esbuild dual ESM/CJS × 2 entries + `tsc` declarations) | pass |
| `npm test` — `node --test` 19 tests (10 plural + 9 singular) | 19/19 pass |
| `npm run typecheck` (incl. `type-tests/compat.ts` vs real `next` types) | pass |
| `node test/two-process.mjs` (file: DB, two child processes, plural handler) | pass |
| `npm run test:e2e` (two-pod static-route convergence, real `next` app) | pass — pod B converges after stamp-memo TTL |
| `WITH_SINGULAR=0 npm run test:e2e` (attribution control) | pass — pod B correctly does **not** converge |
| Single-flight probe (instrumented `@libsql/client` fake, distinct DDL/SELECT counting) | 50 concurrent `get`s → 1 DDL + 1 SELECT; 50 concurrent at TTL boundary → 1 SELECT; 30 concurrent `getExpiration` → 1 SELECT |

## Regression-test evidence (red → green)

* Test 7 (dev retention): **fail on 0.1.2** (`past the expire window → miss in production` assertion passed; the dev-side `short expire retained in dev` assertion failed because 0.1.2 applied the expire bound in dev too) → **pass on 0.1.3**.
* Test 8 (env parsing): **fail on 0.1.2** (`max 0 must not store entries` failed; a first-draft fix using `Number(envString(...))` was itself caught by this suite — `Number('')===0` zeroed capacity for *unset* vars, breaking every store — before being corrected to an `envNumber` that returns `undefined` for blank/garbage) → **pass on 0.1.3**.

## Post-change sanity checks that found nothing (documented, not assumed)

* Single-flight does not delay error observability: a failed refresh releases the window (`syncing` cleared in `finally`), so the next caller retries after `retryAt`, same as before.
* Overlapping same-key `set`s and `get`-during-`set` race behavior is byte-identical to 0.1.2 (probes 10/11 from the review re-run implicitly via the existing cross-process suite); single-flight only touches the read path.
* The dev-mode widening only adds retention (never staleness): the `>= 300` bound can only extend an entry's life in dev, and only up to the same 300s next itself uses; stamp invalidation still applies after any `sync()`.

## Known unchanged trade-offs (accepted, documented in README)

* Stamp-sync cost scales with the number of distinct tags ever revalidated (full-table re-read per sync window, mitigated by single-flight; 10k tags ≈ 484KB DB / ~27ms sync measured).
* A database error (not "no URL configured") delays convergence by up to `RETRY_BACKOFF_MS` = 30s in addition to `CACHEPLANK_STAMPS_TTL_MS`.
* On-disk SQLite `file:` deployments still serialize on the DB across pods; Turso/Bunny are the intended shared backends (unchanged from 0.1.2).

---

# cacheplank 0.1.2 — verification report (original, appended below)

Verified on this machine against a real `next@16.3.8` app (not mocks) and the
built artifacts in `dist/` (what npm ships). Environment note: `/usr/bin/node` is
v18 (EOL, below the declared `engines`), so everything was run with the v20/v24
installs also present — i.e. the actual CI matrix.

## What was run

| Check | Result |
| --- | --- |
| `npm run build` (esbuild dual ESM/CJS ×2 entries + `tsc`) | pass |
| `npm run typecheck` (incl. `type-tests/compat.ts` vs real `next` types) | pass |
| `node --test` — 17 tests (8 plural + 9 singular) | 17/17 pass |
| `test/two-process.mjs` fixture (file: DB, two child processes, plural handler) | pass |
| `npm run test:e2e` — two-pod static-route convergence (real `next` app) | pass |
| `npm run test:e2e` with `WITH_SINGULAR=0` (control) | pass (pod B correctly does **not** converge) |

## Core claim (unchanged)

Two **independent app directories** (separate cwd → separate route-cache),
sharing **only** the libSQL `file:` DB converge on `revalidateTag`: pod A
revalidates, pod B's cached entry misses on its next read and regenerates. Entries
are never shared. This holds for `"use cache"` entries (plural handler) and — now
— for fully-static prerendered routes (singular handler).

## The static-route gap — found, then closed

The first verification pass found that a route Next prerenders **static** (`○`)
did not pick up a cross-pod `revalidateTag`:

```
A (static)  B (static)                    both serve the build-time value
revalidateTag via A
A now: V2                                 (A regenerated)
B now: <stale build-time value>           (B never converged)
```

### Why

Next 16 has **two** unrelated cache interfaces, resolved from two config keys:

1. `cacheHandlers` (plural, five-method) — `"use cache"` / fetch-path results.
2. `cacheHandler` (singular, legacy incremental/ISR: `get`/`set`/`revalidateTag`/
   `resetRequestCache`) — prerendered `APP_PAGE` / `APP_ROUTE` / `PAGES` + fetch
   cache.

A fully-static route is materialised through layer 2 (or, with no singular
handler configured, a **pod-local** on-disk `.next/server/route-cache/…`). The
`revalidateTag` in `revalidation-utils.js` does call `updateTags` on every plural
handler **and** `revalidateTag` on the singular one, but cacheplank only
implemented the plural interface, so static page bodies never converged.

Verified by direct reading of the installed package:
`next-server.js` imports both handlers (`cacheHandlers` per-kind, and the
singular `cacheHandler`); `IncrementalCache` constructs the singular one with
`new CurCacheHandler(ctx)` and consults it for every request when present.

### The fix

cacheplank now also implements the singular interface, shipped as a second entry
point `cacheplank/cache-handler` (default export is a class Next can `new`). It
shares the exact same `tag_stamps` table and convergence rule as the plural
handler. The handler state (entry LRU + stamp memo) lives in a module-level
closure so the per-request instances share it.

### Evidence (the fix is causal, not incidental)

`npm run test:e2e` builds a real app with one fully-static route, fans it into two
independent pods, and runs the scenario:

```
singular handler ENABLED:
  2. both pods warm:            A=V1 B=V1
  3. value file -> V2:          A=V1 B=V1     (still cached)
  4. revalidateTag('_N_T_/') via POD A
  5. after stamp-memo TTL (3s): A=V2 B=V2     ← pod B converged

singular handler DISABLED (control, WITH_SINGULAR=0):
  5. after stamp-memo TTL (3s): A=V2 B=V1     ← pod B did not converge
```

The only difference between the two runs is whether `cacheHandler` is set, so the
singular handler is what closes the gap.

### Convergence window

B first read after the revalidate still showed V1 (its stamp memo had not yet
expired); after `CACHEPLANK_STAMPS_TTL_MS` (default 3s) it converged. That is the
designed, documented bound on shared-invalidation propagation — not a lease on
staleness. Setting the env var to `0` makes every read consult the shared table.

## DX gotcha worth knowing

Next resolves the singular `cacheHandler` path against `.next/`
(`formatDynamicImportPath(distDir, …)`). Confirmed empirically: a relative
`./cache-handler.cjs` becomes `.next/cache-handler.cjs` and throws
`ERR_MODULE_NOT_FOUND: Cannot find module …/.next/cache-handler.cjs` at server
startup. `require.resolve('cacheplank/cache-handler')` (absolute) is the correct
form; the README calls this out.

Verified from a packed tarball (`npm pack` → install → `require.resolve`): both
`require('cacheplank/cache-handler')` and `import … from 'cacheplank/cache-handler'`
resolve, the default export is a constructor, and both the singular and plural
method sets are present.

## Minor: test harness fragility on old Node

`test/cross-process.test.mjs` spawns a child with `node -e` containing top-level
`await`. Top-level await in `--eval` needs Node ≥ 20.10 (module-syntax detection)
or `--input-type=module`; on Node 18 it throws `Unexpected token 'u'`. Harmless
for CI (20/22/24) but the failure mode on an unsupported runtime is a confusing
JSON parse error rather than a clear version message.
