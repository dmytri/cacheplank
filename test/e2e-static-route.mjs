/**
 * End-to-end proof of the *static-route* convergence fix — the gap documented
 * in the first cacheplank verification report.
 *
 * A real `next` app with a **fully-static** route (`○`, no request APIs) is
 * built once, then copied into two independent "pods": separate cwd, separate
 * `.next`, separate memory — sharing **only** a libSQL `file:` stamp DB. The
 * built `dist/` is wired via both config keys:
 *
 *   cacheHandlers: { default: dist/index.cjs }   // plural, "use cache"
 *   cacheHandler:  dist/cache-handler.cjs        // singular, incremental/ISR
 *
 * Then: warm both pods → change the underlying value → `revalidateTag` on pod A
 * → pod B must converge (regenerate) after the stamp-memo TTL. Set
 * `WITH_SINGULAR=0` to prove the singular handler is doing the work (pod B then
 * never converges). This is the controlled experiment that attributes the fix.
 *
 * Run: npm run test:e2e   (builds a throwaway app under tmp/, gitignored)
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repo = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const nextBin = path.join(repo, 'node_modules', 'next', 'dist', 'bin', 'next');
const dist = path.join(repo, 'dist');

const WITH_SINGULAR = process.env.WITH_SINGULAR !== '0';
const PORT_A = Number(process.env.PORT_A || 4301);
const PORT_B = Number(process.env.PORT_B || 4302);
const STAMP_TTL_MS = 3000; // cacheplank's default CACHEPLANK_STAMPS_TTL_MS

const root = path.join(repo, 'tmp', `e2e-static-${process.pid}`);
const valueFile = path.join(root, 'value.txt');
const stampDb = path.join(root, 'stamps.db');
const env = { ...process.env, CACHEPLANK_URL: `file:${stampDb}` };

const log = (...args) => console.log(...args);
const fail = (message) => {
  console.error(`\n✗ ${message}`);
  process.exitCode = 1;
  throw new Error(message);
};

function writeApp(appDir) {
  mkdirSync(path.join(appDir, 'app', 'api', 'revalidate'), { recursive: true });
  writeFileSync(
    path.join(appDir, 'next.config.mjs'),
    `const dist = ${JSON.stringify(dist)};
const repo = ${JSON.stringify(repo)};
const config = {
  cacheComponents: false,
  cacheHandlers: { default: dist + '/index.cjs' },
  // Turbopack only resolves files under its workspace root; the middleware
  // shim imports the built handler from the repo's dist/, so root = repo.
  turbopack: { root: repo },
};
${WITH_SINGULAR ? "config.cacheHandler = dist + '/cache-handler.cjs';" : ''}
export default config;
`,
  );
  writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify({ name: 'cacheplank-e2e', private: true, type: 'module' }),
  );
  // Middleware answering conditionals from shared fingerprints (current
  // generation only; pass-through otherwise). Next bundles middleware and
  // rejects absolute-path imports, so the app gets a shim that imports the
  // package by name (resolved from the repo's node_modules) — same trick the
  // cacheHandler config uses with require.resolve.
  mkdirSync(path.join(appDir, 'node_modules', 'cacheplank-e2e-shim'), { recursive: true });
  writeFileSync(
    path.join(appDir, 'node_modules', 'cacheplank-e2e-shim', 'package.json'),
    JSON.stringify({
      name: 'cacheplank-e2e-shim',
      version: '0.0.0',
      type: 'module',
      exports: './shim.mjs',
    }),
  );
  writeFileSync(
    path.join(appDir, 'node_modules', 'cacheplank-e2e-shim', 'shim.mjs'),
    // Relative import from the shim up to the repo dist — turbopack resolves
    // relative specifiers under its configured root (repo, see next.config).
    `import handler, { withConditional304 } from '../../../../../dist/middleware.mjs';
export { withConditional304 };
export default handler;
`,
  );
  writeFileSync(
    path.join(appDir, 'middleware.js'),
    `import handler from 'cacheplank-e2e-shim';
export default handler;
export const config = { matcher: ['/:path*'], runtime: 'nodejs' };
`,
  );
  writeFileSync(
    path.join(appDir, 'app', 'layout.js'),
    `export default function L({ children }) { return <html><body>{children}</body></html>; }\n`,
  );
  // A fully-static route: reads a file at render time (so regeneration is
  // observable) but uses no request APIs, so Next prerenders it static.
  writeFileSync(
    path.join(appDir, 'app', 'page.js'),
    `import fs from 'node:fs';
export default function Page() {
  let value = 'V1';
  try { value = fs.readFileSync(${JSON.stringify(valueFile)}, 'utf8').trim(); } catch {}
  return <div id="value">{value}</div>;
}
`,
  );
  writeFileSync(
    path.join(appDir, 'app', 'api', 'revalidate', 'route.js'),
    `import { revalidateTag } from 'next/cache';
export async function GET() {
  revalidateTag('_N_T_/');
  return Response.json({ ok: true });
}
`,
  );
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
    child.on('error', reject);
  });
}

function start(cwd, port, logFile) {
  const child = spawn(process.execPath, [nextBin, 'start', '-p', String(port)], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // `next start` spawns a next-server child; kill the group.
  });
  const tag = path.basename(cwd);
  child.stdout.on('data', (d) => process.stdout.write(`[${tag}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${tag}] ${d}`));
  child.on('exit', (code) => {
    if (!stopping) log(`pod on ${port} exited early (${code})`);
  });
  return child;
}

let stopping = false;
const pods = [];
function stopAll() {
  stopping = true;
  for (const child of pods) {
    try {
      process.kill(-child.pid, 'SIGKILL'); // negative pid = the whole group
    } catch {
      /* already gone */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPort(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => (socket.end(), resolve(true)));
      socket.once('error', () => resolve(false));
      socket.setTimeout(1000, () => (socket.destroy(), resolve(false)));
    });
    if (open) return;
    if (Date.now() > deadline) fail(`port ${port} never opened`);
    await sleep(200);
  }
}

async function pageValue(port) {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  const html = await res.text();
  const match = html.match(/id="value">([^<]*)/);
  return match ? match[1] : null;
}

try {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  log(`cacheplank e2e — static-route cross-pod convergence`);
  log(`  singular cacheHandler: ${WITH_SINGULAR ? 'ENABLED' : 'DISABLED (control)'}`);
  log(`  workdir: ${root}\n`);

  // 1. Build once, in the source app directory.
  const appDir = path.join(root, 'app-src');
  writeApp(appDir);
  writeFileSync(valueFile, 'V1\n');
  log('1. building the static app …');
  await run(process.execPath, [nextBin, 'build'], { cwd: appDir, env });

  // 2. Fan out into two independent pod directories (no shared filesystem).
  for (const pod of ['podA', 'podB']) {
    const dir = path.join(root, pod);
    cpSync(path.join(appDir, '.next'), path.join(dir, '.next'), { recursive: true });
    cpSync(path.join(appDir, 'app'), path.join(dir, 'app'), { recursive: true });
    cpSync(path.join(appDir, 'next.config.mjs'), path.join(dir, 'next.config.mjs'));
    cpSync(path.join(appDir, 'package.json'), path.join(dir, 'package.json'));
    cpSync(path.join(appDir, 'middleware.js'), path.join(dir, 'middleware.js'));
    cpSync(path.join(appDir, 'node_modules'), path.join(dir, 'node_modules'), { recursive: true });
  }

  // 3. Start both pods.
  pods.push(start(path.join(root, 'podA'), PORT_A));
  pods.push(start(path.join(root, 'podB'), PORT_B));
  await waitForPort(PORT_A);
  await waitForPort(PORT_B);

  const a0 = await pageValue(PORT_A);
  const b0 = await pageValue(PORT_B);
  log(`2. both pods warm:            A=${a0} B=${b0}`);
  if (a0 !== 'V1' || b0 !== 'V1') fail(`expected both pods to serve V1, got A=${a0} B=${b0}`);

  writeFileSync(valueFile, 'V2\n');
  const a1 = await pageValue(PORT_A);
  const b1 = await pageValue(PORT_B);
  log(`3. value file -> V2 (no revalidate yet): A=${a1} B=${b1}`);
  if (a1 !== 'V1' || b1 !== 'V1') fail('pods should still serve the cached V1 before any revalidate');

  log('4. revalidateTag("_N_T_/") via POD A …');
  const res = await fetch(`http://127.0.0.1:${PORT_A}/api/revalidate`);
  if (!res.ok) fail(`revalidate endpoint failed: ${res.status}`);

  // 5. After the stamp-memo TTL, pod B must have converged by regenerating.
  await sleep(STAMP_TTL_MS + 1500);
  const a2 = await pageValue(PORT_A);
  const b2 = await pageValue(PORT_B);
  log(`5. after stamp-memo TTL:       A=${a2} B=${b2}`);

  if (WITH_SINGULAR) {
    if (b2 !== 'V2') fail(`pod B did not converge (expected V2, got ${b2})`);
    log('\n✓ static-route cross-pod convergence: OK');

    // 6. Fingerprint scenario: pod B answers the CDN-style conditional with
    // 304 WITHOUT rendering. Pod A has rendered V2 (step 5) and published its
    // fingerprint. Ask POD B with If-None-Match: etag-of-A's-V2.
    const htmlA = await (await fetch(`http://127.0.0.1:${PORT_A}/`)).text();
    // Next's send-layer etag: FNV-1a over the exact payload bytes. Extract
    // the page payload the way Next would (full response body for a static
    // page IS the payload).
    const { generateETag } = await import(
      path.join(repo, 'node_modules', 'next', 'dist', 'server', 'lib', 'etag.js')
    );
    const etagV2 = generateETag(htmlA);
    const conditional = await fetch(`http://127.0.0.1:${PORT_B}/`, {
      headers: { 'if-none-match': etagV2 },
    });
    log(`6. conditional (If-None-Match: ${etagV2}) on POD B → ${conditional.status}`);
    if (conditional.status === 304) {
      log('✓ pod B answered 304 from the shared fingerprint — no render needed');
    } else {
      // Not fatal-but-report: middleware may legitimately pass through (e.g.
      // middleware matcher skipped, or generation superseded). Distinguish:
      const body = await conditional.text();
      log(`   … got ${conditional.status} (body has value ${body.match(/id="value">([^<]*)/)?.[1]}).`);
      log('   ✗ fingerprint 304 did not happen');
      fail('expected pod B to answer 304 from the shared fingerprint');
    }

    // 7. Attribution: after ANOTHER revalidation the old etag must stop
    // answering (generation bumped, fingerprint retired).
    await fetch(`http://127.0.0.1:${PORT_A}/api/revalidate`);
    await sleep(STAMP_TTL_MS + 1500);
    const staleConditional = await fetch(`http://127.0.0.1:${PORT_B}/`, {
      headers: { 'if-none-match': etagV2 },
    });
    log(`7. same conditional after re-revalidation → ${staleConditional.status}`);
    if (staleConditional.status === 304) {
      fail('superseded fingerprint answered 304 — generation check is broken');
    }
    log('✓ superseded fingerprint no longer answers: OK');
  } else {
    if (b2 === 'V2') fail('pod B converged even without the singular handler — control is invalid');
    log('\n✓ control (no singular handler): pod B correctly did NOT converge');
  }
} catch (error) {
  if (!process.exitCode) {
    console.error(error);
    process.exitCode = 1;
  }
} finally {
  stopAll();
  // rmSync disabled for debugging
}
