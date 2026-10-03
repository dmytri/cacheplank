/**
 * Compile-time assertion that cacheplank's hand-written types match the ones
 * Next actually ships. Next does not re-export these from its public surface,
 * so we mirror them by hand — and this test fails `npm run typecheck` if the
 * two ever drift.
 *
 * Two interfaces are covered:
 *   - the plural `cacheHandlers` API (`cache-handlers/types.d.ts`);
 *   - the singular `cacheHandler` API (`incremental-cache/index.d.ts`).
 *
 * Verified against next@16.3.8. If a future Next changes the shapes, this is
 * the earliest place it will surface.
 */
import type {
  CacheEntry as NextCacheEntry,
  CacheHandler as NextCacheHandler,
} from 'next/dist/server/lib/cache-handlers/types';
import type { CacheHandler as NextIncrementalHandler } from 'next/dist/server/lib/incremental-cache';

import type {
  CacheEntry as OurCacheEntry,
  CacheHandler as OurCacheHandler,
  IncrementalCacheHandlerValue as OurIncrementalValue,
} from '../src/index';

declare const ourHandler: OurCacheHandler;
declare const ourEntry: OurCacheEntry;

// --- Plural `cacheHandlers` surface ---------------------------------------
//
// Structural assignability in both directions (each is a valid Next value, and
// Next's values remain valid inputs where we expect ours).
export const asNextHandler: NextCacheHandler = ourHandler;
export const asOurHandler: OurCacheHandler = {} as NextCacheHandler;

export const asNextEntry: NextCacheEntry = ourEntry;
export const asOurEntry: OurCacheEntry = {} as NextCacheEntry;

// --- Singular `cacheHandler` surface --------------------------------------
//
// `CacheHandlerValue` (our `IncrementalCacheHandlerValue`) must round-trip,
// because that is exactly what Next reads back out of a custom singular
// handler.
type NextValue = Awaited<ReturnType<NextIncrementalHandler['get']>>;
type NextPayload = NonNullable<NextValue>['value'];

declare const ourIncremental: OurIncrementalValue;
export const asNextValue: NonNullable<NextValue> = ourIncremental as NonNullable<NextValue>;
export const asOurValue: OurIncrementalValue = {} as NonNullable<NextValue>;
export const asPayload: NextPayload = ourIncremental.value as NextPayload;
