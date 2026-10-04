/**
 * cacheplank/middleware — conditional-request (304) answering.
 *
 * Pair this with the singular `cacheHandler`: every pod that renders a
 * fully-static route publishes a fingerprint (route path, generation, payload
 * etag) to the shared table; this middleware answers conditional requests
 * (`If-None-Match`) whose etag matches the *current* generation with 304 —
 * before Next renders anything.
 *
 *   // middleware.ts (project root or src/)
 *   import { withConditional304 } from 'cacheplank/middleware';
 *   export const middleware = withConditional304();
 *   export const config = { matcher: ['/:path*'] };
 *
 * Env config is identical to the cache handler (CACHEPLANK_URL etc.), or pass
 * explicit options to `withConditional304(options)`.
 */
import { withConditional304 } from './index';

export { withConditional304, resolveConditional } from './index';
export default withConditional304();
