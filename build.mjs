// Dual CJS + ESM build. Our own sources are bundled into one file per format;
// the single runtime dependency stays external so it resolves from node_modules.
import { build } from 'esbuild';

const shared = {
  entryPoints: ['src/index.ts', 'src/cache-handler.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  external: ['@libsql/client'],
  sourcemap: true,
  logLevel: 'info',
};

await build({ ...shared, format: 'esm', outdir: 'dist', outExtension: { '.js': '.mjs' } });
await build({ ...shared, format: 'cjs', outdir: 'dist', outExtension: { '.js': '.cjs' } });
