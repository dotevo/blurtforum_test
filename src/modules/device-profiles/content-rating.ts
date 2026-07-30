import type { PegiRating } from './types';
import { PEGI_ORDER } from './types';

/**
 * modules/device-profiles/content-rating.ts
 *
 * Content itself has no rating field yet (called out from the very start of
 * this feature -- see types.ts's DeviceProfile.maxRating comment). Until it
 * does, this rates content by WHERE it's posted (community account, or a
 * tag as a fallback) rather than per-post -- coarse, but zero dependency on
 * new backend/indexer data, and trivially upgradable later: once posts
 * carry their own rating, swap ratingFor()'s body for a direct field read
 * and every caller of filterByRating() below keeps working unchanged.
 *
 * NOT wired into CinemaIndex.vue (or anywhere else) yet. That's intentional
 * for now -- CinemaIndex.vue is under active, separate development as this
 * was written, so actually filtering its content lists is a deliberate
 * follow-up once those changes land, rather than risking a conflicting
 * edit to a file being worked on elsewhere.
 */

/** Fill in as real communities/tags get mapped. Anything not listed falls
 *  back to DEFAULT_RATING -- we'd rather under-filter unrated content than
 *  silently hide everything just because nothing's been mapped yet. */
const COMMUNITY_RATINGS: Record<string, PegiRating> = {
  // 'some-community-account': 'PEGI_12',
};
const DEFAULT_RATING: PegiRating = 'PEGI_3';

export function ratingFor(communityAccount?: string | null, tag?: string | null): PegiRating {
  if (communityAccount && COMMUNITY_RATINGS[communityAccount]) return COMMUNITY_RATINGS[communityAccount];
  if (tag && COMMUNITY_RATINGS[tag]) return COMMUNITY_RATINGS[tag];
  return DEFAULT_RATING;
}

export function isRatingAllowed(rating: PegiRating, maxRating: PegiRating | null): boolean {
  if (maxRating == null) return true; // no cap (the adult default)
  return PEGI_ORDER.indexOf(rating) <= PEGI_ORDER.indexOf(maxRating);
}

/**
 * Filters `entries` down to whatever fits `maxRating`. `getRatingSource`
 * extracts whichever fields on T identify its community/tag -- generic on
 * purpose, since it's not yet known what shape CinemaIndex.vue's list items
 * will have by the time this is actually wired in.
 */
export function filterByRating<T>(
  entries: T[],
  maxRating: PegiRating | null,
  getRatingSource: (entry: T) => { communityAccount?: string | null; tag?: string | null },
): T[] {
  if (maxRating == null) return entries;
  return entries.filter((entry) => {
    const { communityAccount, tag } = getRatingSource(entry);
    return isRatingAllowed(ratingFor(communityAccount, tag), maxRating);
  });
}
