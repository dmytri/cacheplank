/**
 * Compile-time assertion that cacheplank's hand-written types match the ones
 * Next actually ships. Next does not re-export `CacheHandler`/`CacheEntry` from
 * its public surface, so we mirror `next/dist/server/lib/cache-handlers/types`
 * by hand — and this test fails `npm run typecheck` if the two ever drift.
 *
 * Verified against next@16.3.8. If a future Next changes the shapes, this is the
 * earliest place it will surface.
 */
import type {
  CacheEntry as NextCacheEntry,
  CacheHandler as NextCacheHandler,
} from 'next/dist/server/lib/cache-handlers/types';

import type { CacheEntry as OurCacheEntry, CacheHandler as OurCacheHandler } from '../src/index';

declare const ourHandler: OurCacheHandler;
declare const ourEntry: OurCacheEntry;

// Structural assignability in both directions (each is a valid Next value, and
// Next's values remain valid inputs where we expect ours).
export const asNextHandler: NextCacheHandler = ourHandler;
export const asOurHandler: OurCacheHandler = {} as NextCacheHandler;

export const asNextEntry: NextCacheEntry = ourEntry;
export const asOurEntry: OurCacheEntry = {} as NextCacheEntry;
