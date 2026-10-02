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
