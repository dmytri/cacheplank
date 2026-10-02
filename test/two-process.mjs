/**
 * Two-process cross-invalidation proof (the brief's stretch goal).
 *
 * Pod B (child process, own in-memory L1) writes a cache entry and reads it
 * back as a hit. Pod A (this parent process) — a separate process sharing only
 * the file: DB — stamps B's tag. After the tag-memo soft TTL
 * (TAG_CHECK_TTL_MS = 3000ms, a documented convergence window) B must observe
 * the shared stamp and miss, proving invalidation converges without any
 * shared entry storage.
 *
 * Run: node test/two-process.mjs   (exits 0 on success)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCacheHandler } from '../dist/index.mjs';

const TAG_CHECK_TTL_MS = 3000;
const dir = mkdtempSync(path.join(os.tmpdir(), 'cacheplank-xproc-'));
const db = path.join(dir, 'shared.db');
const script = path.join(dir, 'pod-b.mjs');

writeFileSync(
  script,
  `import assert from 'node:assert/strict';
import { createCacheHandler } from ${JSON.stringify(path.resolve('dist/index.mjs'))};
const handler = createCacheHandler({
  url: ${JSON.stringify(`file:${db}`)},
  prefix: 'xproc',
  warn: (m) => console.error('[cacheplank warn]', m),
});
const streamOf = (s) =>
  new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(s)); c.close(); } });
const drain = async (stream) => {
  const reader = stream.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return Buffer.concat(parts.map(Buffer.from)).toString();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let line = '';
for await (const chunk of process.stdin) {
  line += chunk;
  if (!line.endsWith('\\n')) continue;
  const cmd = JSON.parse(line);
  line = '';
  if (cmd.op === 'seed') {
    await handler.set('product', Promise.resolve({
      value: streamOf('stock=1'), tags: ['product:42'], stale: 0,
      timestamp: Date.now() - 5, expire: 3600, revalidate: 60,
    }));
    const hit = await handler.get('product', []);
    assert.ok(hit, 'B hit right after seeding');
    assert.equal(await drain(hit.value), 'stock=1');
    reply({ ok: true, note: 'seeded, local hit' });
  } else if (cmd.op === 'check') {
    // Wait out the memo soft TTL so this check really talks to the shared DB.
    await sleep(${TAG_CHECK_TTL_MS + 300});
    await handler.refreshTags();
    const after = await handler.get('product', []);
    reply({ ok: true, miss: after === undefined });
  }
}
function reply(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }
`,
);

const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'inherit'] });
const reply = () =>
  new Promise((resolve, reject) => {
    const onData = (d) => {
      child.stdout.off('data', onData);
      resolve(JSON.parse(d.toString()));
    };
    child.stdout.once('data', onData);
    child.once('exit', (code) => reject(new Error(`pod B exited (${code})`)));
  });
const ask = (cmd) => {
  child.stdin.write(JSON.stringify(cmd) + '\n');
  return reply();
};

try {
  // Pod B: seed a valid entry in its own process-local L1.
  const seeded = await ask({ op: 'seed' });
  console.log('pod B:', seeded.note);

  // Pod A: a different process, same shared DB. Stamp B's tag.
  const podA = createCacheHandler({ url: `file:${db}`, prefix: 'xproc', warn: () => {} });
  await podA.updateTags(['product:42']);
  console.log('pod A: stamped product:42 in the shared table');

  // Pod B: after the memo soft TTL, the shared stamp must invalidate the local entry.
  const checked = await ask({ op: 'check' });
  if (!checked.miss) throw new Error('pod B still serves the entry after the shared stamp');
  console.log('pod B: invalidated by a stamp written in another process');
  console.log('cross-process invalidation: OK');
} finally {
  child.kill();
  rmSync(dir, { recursive: true, force: true });
}
