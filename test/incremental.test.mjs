/**
 * The singular `cacheHandler` (incremental/ISR) contract — the second half of
 * cacheplank. Same invariants as the plural handler, applied to Next's legacy
 * interface, which is what serves fully-static `APP_PAGE` routes. These run
 * against the built artifacts in dist/ (what npm ships).
 *
 * Ground truth for the shapes: next@16.3.8
 * `dist/server/lib/incremental-cache/index.d.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { os, path } from './helpers.mjs';
import { createIncrementalCacheHandler } from '../dist/cache-handler.mjs';

/** A minimal `APP_PAGE` value, as Next stores it: opaque except for headers. */
function appPage(headers = {}) {
  return { kind: 'APP_PAGE', html: '<html>v1</html>', rscData: undefined, headers };
}

/** Fresh handler class on an isolated file: DB. */
function classFor(dir, name, options = {}) {
  return createIncrementalCacheHandler({
    url: `file:${path.join(dir, `${name}.db`)}`,
    prefix: name,
    warn: () => {},
    ...options,
  });
}

test('the singular entry default-exports a class Next can `new`', async () => {
  const mod = await import('../dist/cache-handler.mjs');
  assert.equal(typeof mod.default, 'function', 'default export is a constructor');
  const instance = new mod.default({});
  for (const method of ['get', 'set', 'revalidateTag', 'resetRequestCache']) {
    assert.equal(typeof instance[method], 'function', method);
  }
  // resetRequestCache is synchronous and must not throw.
  assert.equal(instance.resetRequestCache(), undefined);
});

test('set → get roundtrip returns the identical value object', async () => {
  const handler = new (createIncrementalCacheHandler({ url: ':memory:', warn: () => {} }))({});
  const value = appPage({ 'x-next-cache-tags': 'product:42' });
  await handler.set('/page', value, { kind: 'APP_PAGE' });
  const got = await handler.get('/page', { kind: 'APP_PAGE' });
  assert.ok(got, 'entry must be returned');
  assert.equal(got.value, value, 'the value object is retained by reference');
  assert.equal(typeof got.lastModified, 'number');
  assert.ok(got.lastModified > 0);
  // Unknown key → null.
  assert.equal(await handler.get('/never-set', { kind: 'APP_PAGE' }), null);
});

test('revalidateTag on a tag in the entry’s x-next-cache-tags header → miss', async () => {
  const handler = new (createIncrementalCacheHandler({ url: ':memory:', warn: () => {} }))({});
  await handler.set('/page', appPage({ 'x-next-cache-tags': 'a,b' }), { kind: 'APP_PAGE' });
  assert.ok(await handler.get('/page', { kind: 'APP_PAGE' }), 'hit before invalidation');
  await handler.revalidateTag('a');
  assert.equal(await handler.get('/page', { kind: 'APP_PAGE' }), null, 'tag stamped → miss');
  // And it stays gone (the tombstone is dropped, not re-checked forever).
  assert.equal(await handler.get('/page', { kind: 'APP_PAGE' }), null);
});

test('revalidateTag accepts an array, a string, and route softTags', async () => {
  const handler = new (createIncrementalCacheHandler({ url: ':memory:', warn: () => {} }))({});
  await handler.set('/arr', appPage({ 'x-next-cache-tags': 'x' }), { kind: 'APP_PAGE' });
  await handler.revalidateTag(['x']);
  assert.equal(await handler.get('/arr', { kind: 'APP_PAGE' }), null, 'array form');

  await handler.set('/soft', appPage({}), { kind: 'APP_PAGE' });
  assert.ok(await handler.get('/soft', { kind: 'APP_PAGE', softTags: ['_N_T_/layout'] }));
  await handler.revalidateTag('_N_T_/layout');
  assert.equal(
    await handler.get('/soft', { kind: 'APP_PAGE', softTags: ['_N_T_/layout'] }),
    null,
    'softTag stamped → miss',
  );
});

test('FETCH-kind entries are invalidated via their own `tags` array', async () => {
  const handler = new (createIncrementalCacheHandler({ url: ':memory:', warn: () => {} }))({});
  const fetchValue = { kind: 'FETCH', data: { body: 'x' }, tags: ['fetched'], revalidate: 60 };
  await handler.set('/api', fetchValue, { kind: 'FETCH', fetchCache: true });
  assert.ok(await handler.get('/api', { kind: 'FETCH' }));
  await handler.revalidateTag('fetched');
  assert.equal(await handler.get('/api', { kind: 'FETCH' }), null);
});

test('`set(key, null)` deletes the entry', async () => {
  const handler = new (createIncrementalCacheHandler({ url: ':memory:', warn: () => {} }))({});
  await handler.set('/gone', appPage(), { kind: 'APP_PAGE' });
  assert.ok(await handler.get('/gone', { kind: 'APP_PAGE' }));
  await handler.set('/gone', null, { kind: 'APP_PAGE' });
  assert.equal(await handler.get('/gone', { kind: 'APP_PAGE' }), null);
});

test('fail-open — unreachable DB never throws, local hits still serve', async () => {
  const warnings = [];
  const handler = new (createIncrementalCacheHandler({
    url: 'http://127.0.0.1:1',
    prefix: 'failopen',
    warn: (m) => warnings.push(m),
  }))({});
  await handler.set('/local', appPage({ 'x-next-cache-tags': 'a' }), { kind: 'APP_PAGE' });
  await assert.doesNotReject(() => handler.revalidateTag('some-other-tag'));
  const got = await handler.get('/local', { kind: 'APP_PAGE' });
  assert.ok(got, 'local entry still served with DB down');
  assert.equal(warnings.length, 1, `expected one warning, got: ${JSON.stringify(warnings)}`);
});

test('two handler classes on one DB: a stamp written by one invalidates the other', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cacheplank-inc-'));
  try {
    const A = classFor(dir, 'shared', { stampsTtlMs: 0 });
    const B = classFor(dir, 'shared', { stampsTtlMs: 0 });
    const podA = new A({});
    const podB = new B({});

    await podB.set('/page', appPage({ 'x-next-cache-tags': 'product:42' }), { kind: 'APP_PAGE' });
    assert.ok(await podB.get('/page', { kind: 'APP_PAGE' }), 'pod B local hit');

    // Pod A — a separate instance sharing only the file: DB — revalidates.
    await podA.revalidateTag('product:42');

    assert.equal(
      await podB.get('/page', { kind: 'APP_PAGE' }),
      null,
      'pod B converges on pod A’s stamp (the static-route gap, closed)',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('entries are never shared: one class cannot read another’s value', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cacheplank-inc-'));
  try {
    const A = classFor(dir, 'isolated');
    const B = classFor(dir, 'isolated');
    const podA = new A({});
    const podB = new B({});
    await podA.set('/page', appPage({ 'x-next-cache-tags': 'k' }), { kind: 'APP_PAGE' });
    // Pod B has the same shared table, but never received the entry — the one
    // deliberate limit of the design.
    assert.equal(await podB.get('/page', { kind: 'APP_PAGE' }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
