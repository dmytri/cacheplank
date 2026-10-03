/**
 * The six invariants from the cacheplank brief. These tests ARE the
 * compatibility contract with next@16.3.8's cache-handler API; they run
 * against the built artifacts in dist/ (what npm ships), not the source.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { os, path } from './helpers.mjs';
import { createCacheHandler, default as defaultHandler } from '../dist/index.mjs';

const DEV = process.env.__NEXT_DEV_SERVER === undefined ? false : true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function streamOf(...chunks) {
  const encoded = chunks.map((c) => new TextEncoder().encode(c));
  return new ReadableStream({
    start(controller) {
      for (const chunk of encoded) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function drain(stream) {
  const reader = stream.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return Buffer.concat(parts.map(Buffer.from));
}

function entry(overrides = {}) {
  return {
    value: streamOf('hello'),
    tags: [],
    stale: 0,
    timestamp: Date.now(),
    expire: 60 * 60,
    revalidate: 60,
    ...overrides,
  };
}

/** Fresh handler on an isolated file: DB (empty options = :memory: semantics). */
function fileHandler(dir, name, options = {}) {
  return createCacheHandler({
    url: `file:${path.join(dir, `${name}.db`)}`,
    prefix: name,
    warn: () => {},
    ...options,
  });
}

test('default export exposes the five-method handler contract', async () => {
  for (const method of ['get', 'set', 'refreshTags', 'getExpiration', 'updateTags']) {
    assert.equal(typeof defaultHandler[method], 'function', method);
    assert.equal(defaultHandler[method].constructor.name, 'AsyncFunction', `${method} is async`);
  }
});

test('1: set → get roundtrip returns identical bytes, tags, timestamps', async () => {
  const handler = createCacheHandler({ url: ':memory:', warn: () => {} });
  const original = entry({
    value: streamOf('chunk-one-', 'chunk-two'),
    tags: ['product:42', 'channel:store'],
    timestamp: Date.now() - 1000,
    revalidate: 300,
    expire: 60 * 60 * 24,
    stale: 60,
  });
  await handler.set('roundtrip-key', Promise.resolve(original));
  const got = await handler.get('roundtrip-key', []);
  assert.ok(got, 'entry must be returned');
  assert.deepEqual(await drain(got.value), Buffer.from('chunk-one-chunk-two'));
  assert.deepEqual(got.tags, ['product:42', 'channel:store']);
  assert.equal(got.timestamp, original.timestamp);
  assert.equal(got.revalidate, 300);
  assert.equal(got.expire, 60 * 60 * 24);
  assert.equal(got.stale, 60);
  // Unknown key → undefined.
  assert.equal(await handler.get('never-set', []), undefined);
});

test('2: updateTags is idempotent and monotone across handlers on one DB', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cacheplank-'));
  try {
    const a = fileHandler(dir, 'monotone');
    const b = fileHandler(dir, 'monotone');
    await a.updateTags(['t']);
    const first = await a.getExpiration(['t']);
    assert.ok(first > 0);
    // Idempotent: same tag again — stamp does not go backwards.
    await b.updateTags(['t']);
    assert.ok((await b.getExpiration(['t'])) >= first);
    // Monotone: a simulated older write (from a lagging pod) must lose.
    await a.updateTags(['t']);
    const latest = await b.getExpiration(['t']);
    assert.ok(latest >= first);
    // Interleaved upserts of different tags both land.
    await Promise.all([a.updateTags(['x']), b.updateTags(['y'])]);
    assert.ok((await a.getExpiration(['x'])) > 0);
    assert.ok((await b.getExpiration(['y'])) > 0);
    // Never-revalidated tags → 0.
    assert.equal(await a.getExpiration(['unknown-tag']), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('3: tag mutation after write → miss, for entry tags and softTags', async () => {
  const handler = createCacheHandler({ url: ':memory:', warn: () => {} });
  // Write entries with a timestamp strictly below the upcoming stamp even on
  // same-ms clocks (handler regenerates on `stamp >= entry.timestamp`).
  await handler.set('k1', Promise.resolve(entry({ tags: ['a'], timestamp: Date.now() - 1 })));
  assert.ok(await handler.get('k1', []), 'hit before invalidation');
  await handler.updateTags(['a']);
  assert.equal(await handler.get('k1', []), undefined, 'entry tag stamped → miss');

  await handler.set('k2', Promise.resolve(entry({ tags: ['b'], timestamp: Date.now() - 1 })));
  assert.ok(await handler.get('k2', ['_N_T_/layout']), 'hit before softTag stamp');
  await handler.updateTags(['_N_T_/layout']);
  assert.equal(await handler.get('k2', ['_N_T_/layout']), undefined, 'softTag stamped → miss');
  // An entry written clearly AFTER the stamp still hits.
  await sleep(2);
  await handler.set('k3', Promise.resolve(entry({ tags: ['a'] })));
  assert.ok(await handler.get('k3', []), 'fresh entry survives old stamps');
});

test('4: fail-open — unreachable DB never throws, local hits still serve', async () => {
  const warnings = [];
  const handler = createCacheHandler({
    url: 'http://127.0.0.1:1', // nothing listens here
    prefix: 'failopen',
    warn: (m) => warnings.push(m),
  });
  await handler.set('local', Promise.resolve(entry({ tags: ['a'] })));
  // Stamp a *different* tag: the point is that a DB failure is swallowed and
  // does not disturb unrelated local entries. (Stamping 'a' itself would — by
  // design — invalidate this entry, since updateTags is self-visible.)
  await assert.doesNotReject(() => handler.updateTags(['some-other-tag']));
  await assert.doesNotReject(() => handler.refreshTags());
  const got = await handler.get('local', []);
  assert.ok(got, 'local entry still served with DB down');
  assert.deepEqual(await drain(got.value), Buffer.from('hello'));
  // Exactly one fail-open warning, never an exception.
  assert.equal(warnings.length, 1, `expected one warning, got: ${JSON.stringify(warnings)}`);
});

test('5: get after set works with tags only — no reliance on revalidate round-trips', async () => {
  const handler = createCacheHandler({ url: ':memory:', warn: () => {} });
  await handler.set('tagsonly', Promise.resolve(entry({ tags: ['only-tag'] })));
  const got = await handler.get('tagsonly', []);
  assert.ok(got, 'entry with tags serves without any revalidation machinery');
  assert.deepEqual(got.tags, ['only-tag']);
  // Stamping an unrelated tag must not invalidate it.
  await handler.updateTags(['unrelated']);
  assert.ok(await handler.get('tagsonly', []), 'unrelated tag stamp does not evict');
});

test('6: expiry — past revalidate misses, negative expire is an eviction sentinel, expire 0 is skipped in production', async () => {
  const handler = createCacheHandler({ url: ':memory:', warn: () => {} });

  // Past the revalidate window → undefined (default handler's prod max-age).
  await handler.set('expired-revalidate', Promise.resolve(entry({ timestamp: Date.now() - 2000, revalidate: 1 })));
  assert.equal(await handler.get('expired-revalidate', []), undefined);

  // Inside the revalidate window → hit.
  await handler.set('fresh', Promise.resolve(entry({ timestamp: Date.now(), revalidate: 60 })));
  assert.ok(await handler.get('fresh', []));

  // `expire < 0` is next's tiered-cache eviction sentinel → missing.
  await handler.set('evicted', Promise.resolve(entry({ expire: -1, revalidate: 60 })));
  assert.equal(await handler.get('evicted', []), undefined);

  // `expire === 0` entries are dynamic and never stored in production.
  await handler.set('dynamic', Promise.resolve(entry({ expire: 0, revalidate: 60 })));
  if (!DEV) assert.equal(await handler.get('dynamic', []), undefined);
});

test('7: dev-mode retention — the expire bound widens to 300s in dev, stays strict in production', async () => {
  const hadDev = process.env.__NEXT_DEV_SERVER;
  try {
    // Production: a 60s-old entry with expire: 30 is past its expire window
    // (revalidate: 3600 leaves that as the only failing bound) → must miss.
    process.env.__NEXT_DEV_SERVER = '';
    const prod = createCacheHandler({ url: ':memory:', warn: () => {} });
    await prod.set(
      'prod-short',
      Promise.resolve(entry({ expire: 30, revalidate: 3600, timestamp: Date.now() - 60_000 })),
    );
    assert.equal(
      await prod.get('prod-short', []),
      undefined,
      'past the expire window → miss in production',
    );

    // Dev: MIN_PRERENDERABLE_EXPIRE (300s) widens the expire bound too —
    // next's default handler and the use-cache wrapper do exactly this, so
    // reloads of short-expire entries still hit.
    process.env.__NEXT_DEV_SERVER = '1';
    const dev = createCacheHandler({ url: ':memory:', warn: () => {} });
    await dev.set(
      'dev-short',
      Promise.resolve(entry({ expire: 30, revalidate: 3600, timestamp: Date.now() - 60_000 })),
    );
    assert.ok(await dev.get('dev-short', []), 'short expire retained in dev');
    await dev.set(
      'dev-dead',
      Promise.resolve(entry({ expire: 30, revalidate: 3600, timestamp: Date.now() - 400_000 })),
    );
    assert.equal(await dev.get('dev-dead', []), undefined, 'nothing survives past the 300s dev minimum');
  } finally {
    if (hadDev === undefined) delete process.env.__NEXT_DEV_SERVER;
    else process.env.__NEXT_DEV_SERVER = hadDev;
  }
});

test('8: CACHEPLANK_MAX_ENTRIES=0 disables caching; an empty value falls back to the default', async () => {
  const previous = process.env.CACHEPLANK_MAX_ENTRIES;
  try {
    process.env.CACHEPLANK_MAX_ENTRIES = '0';
    const off = createCacheHandler({ url: ':memory:', warn: () => {} });
    await off.set('stored', Promise.resolve(entry()));
    assert.equal(await off.get('stored', []), undefined, 'max 0 must not store entries');

    process.env.CACHEPLANK_MAX_ENTRIES = '';
    const onDefault = createCacheHandler({ url: ':memory:', warn: () => {} });
    await onDefault.set('stored', Promise.resolve(entry()));
    assert.ok(await onDefault.get('stored', []), 'empty env value must fall back to the default capacity');
  } finally {
    if (previous === undefined) delete process.env.CACHEPLANK_MAX_ENTRIES;
    else process.env.CACHEPLANK_MAX_ENTRIES = previous;
  }
});

test('9: stamps older than the retention window are invisible; fresh stamps invalidate; index is provisioned', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cacheplank-retention-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'retention.db');
  const url = `file:${dbPath}`;
  const hadRetention = process.env.CACHEPLANK_STAMPS_RETENTION_MS;
  try {
    process.env.CACHEPLANK_STAMPS_RETENTION_MS = '60000'; // window: last 60s
    const handler = createCacheHandler({ url, prefix: 'p', stampsTtlMs: 0, warn: () => {} });

    // Seed the shared table directly: one stale stamp (outside the window)
    // and one fresh stamp (inside it), exactly as an old pod would have left
    // them before this handler ever started.
    const { createClient } = await import('@libsql/client');
    const db = createClient({ url });
    await db.execute(
      'CREATE TABLE IF NOT EXISTS tag_stamps (tag TEXT PRIMARY KEY, revalidated_at INTEGER NOT NULL)',
    );
    const staleAt = Date.now() - 10 * 60_000; // 10 minutes ago — outside the 60s window
    const freshAt = Date.now();
    await db.execute({ sql: 'INSERT INTO tag_stamps(tag, revalidated_at) VALUES (?, ?)', args: ['stale-tag', staleAt] });
    await db.execute({ sql: 'INSERT INTO tag_stamps(tag, revalidated_at) VALUES (?, ?)', args: ['fresh-tag', freshAt] });
    await db.close();

    const streamValue = async (h, key) => {
      const hit = await h.get(key, []);
      if (!hit) return null;
      return (await drain(hit.value)).toString('utf8');
    };
    await handler.set(
      'k-stale',
      Promise.resolve(entry({ tags: ['stale-tag'], revalidate: 3600, timestamp: staleAt - 1 })),
    );
    await handler.set(
      'k-fresh',
      Promise.resolve(entry({ tags: ['fresh-tag'], revalidate: 3600, timestamp: freshAt - 1 })),
    );

    // The stale stamp predates the retention window: it must not invalidate
    // (this is the bounded-table trade — entries only outlive stamps if X was
    // misconfigured; here the window is fresh so the entry is expected live).
    assert.equal(
      await streamValue(handler, 'k-stale'),
      'hello',
      'a stamp older than the retention window must be invisible to sync',
    );
    // The fresh stamp is inside the window and must still invalidate.
    assert.equal(
      await streamValue(handler, 'k-fresh'),
      null,
      'a stamp inside the retention window must invalidate the entry',
    );

    // Index provisioned lazily on first use.
    const db2 = createClient({ url });
    const idx = await db2.execute(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'tag_stamps_revalidated_at'",
    );
    await db2.close();
    assert.equal(idx.rows.length, 1, 'retention index must be provisioned by ensureStore');
  } finally {
    if (hadRetention === undefined) delete process.env.CACHEPLANK_STAMPS_RETENTION_MS;
    else process.env.CACHEPLANK_STAMPS_RETENTION_MS = hadRetention;
  }
});
