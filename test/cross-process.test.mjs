// The load-bearing claim: two independent processes sharing nothing but a
// libSQL URL converge on invalidation. "cacheplank does not share cache entries
// between pods. Entries are local and derived; only invalidation is shared."
//
// Two real child processes share one on-disk `file:` DB:
//   * the reader stores an entry in its own process-local L1 and confirms a hit,
//   * a *separate* process stamps the tag,
//   * the reader (prompted over stdin) re-reads and must now miss.
//
// The steps are sequenced so the two processes never hammer the file DB at the
// same instant: dev-grade SQLite locking should not decide whether the shared
// table gets consulted. Real deployments (Turso / Bunny DB) are not affected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = fileURLToPath(new URL('.', import.meta.url));
const dist = join(here, '..', 'dist', 'index.mjs');

test('cross-process: a stamp written by one process invalidates another process’s local entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cacheplank-'));
  const url = `file:${join(dir, 'tags.db')}`;

  // Pre-create the schema so neither child races the other on DDL.
  const { createClient } = await import('@libsql/client');
  const setup = createClient({ url });
  await setup.execute(
    'CREATE TABLE IF NOT EXISTS tag_stamps (tag TEXT PRIMARY KEY, revalidated_at INTEGER NOT NULL)',
  );
  await setup.close();

  // TTL 0 makes the reader consult the shared table on every `get`.
  const env = { ...process.env, CACHEPLANK_URL: url, CACHEPLANK_STAMPS_TTL_MS: '0' };

  const reader = spawn(process.execPath, ['-e', readerScript, dist], {
    env,
    cwd: here,
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  try {
    const lines = lineReader(reader.stdout);

    // 1. Reader seeds and serves its own local entry.
    const before = JSON.parse((await lines.next()).value);
    assert.equal(before.before, 'hit', 'the entry must be a local hit before invalidation');

    // 2. A different process stamps the tag, through the shared table only.
    await run(process.execPath, ['-e', writerScript, dist], { env, cwd: here });

    // 3. Reader re-reads; the foreign stamp must have invalidated its entry.
    reader.stdin.write('check\n');
    const after = JSON.parse((await lines.next()).value);
    assert.equal(after.after, 'miss', 'the entry must miss after the other process stamped the tag');
  } finally {
    reader.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

/** Async iterator over newline-delimited stdout, one JSON value per line. */
async function* lineReader(stream) {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) yield line;
    }
  }
}

const readerScript = `
const { createCacheHandler } = await import(process.argv[1]);
const readline = await import('node:readline');
const handler = createCacheHandler({ url: process.env.CACHEPLANK_URL, warn() {} });

const entry = {
  value: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); } }),
  tags: ['shared-tag'],
  stale: 0,
  timestamp: Date.now() - 5,
  expire: 3600,
  revalidate: 600,
};

await handler.set('pkey', Promise.resolve(entry));
const before = await handler.get('pkey', []);
process.stdout.write(JSON.stringify({ before: before ? 'hit' : 'miss' }) + '\\n');

// Wait for the parent's "check" pulse, then re-read the shared table.
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  if (line.trim() !== 'check') continue;
  const after = await handler.get('pkey', []);
  process.stdout.write(JSON.stringify({ after: after ? 'hit' : 'miss' }) + '\\n');
  break;
}
process.exit(0);
`;

const writerScript = `
const { createClient } = await import('@libsql/client');
const db = createClient({ url: process.env.CACHEPLANK_URL });
await db.execute({
  sql: 'INSERT INTO tag_stamps(tag, revalidated_at) VALUES (?, ?) ON CONFLICT(tag) DO UPDATE SET revalidated_at = MAX(revalidated_at, excluded.revalidated_at)',
  args: ['shared-tag', Date.now()],
});
await db.close();
`;
