/**
 * cacheplank/cache-handler — the singular `cacheHandler` entry.
 *
 * Wire this as `cacheHandler` in `next.config` to give Next's legacy
 * incremental/ISR cache (prerendered static `APP_PAGE` routes, `APP_ROUTE`,
 * `PAGES`, fetch cache) the same shared-invalidation behaviour the plural
 * `cacheHandlers` entry already has. Both share one `tag_stamps` table, so a
 * `revalidateTag` from any pod converges every entry kind on every pod.
 *
 *   // next.config.js
 *   module.exports = {
 *     cacheComponents: true,
 *     cacheHandlers: { default: require.resolve('cacheplank') },
 *     cacheHandler: require.resolve('cacheplank/cache-handler'),
 *   };
 *
 * Next resolves this path against `.next/`, so it must be **absolute** or a
 * `file://` URL — `require.resolve(...)` yields an absolute path (README note
 * #6).
 */
import { createIncrementalCacheHandler } from './index';

/** Next does `new CurCacheHandler(ctx)`, and loads `mod.default || mod`. */
export default createIncrementalCacheHandler();

export { createIncrementalCacheHandler } from './index';
