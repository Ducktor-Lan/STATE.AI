/**
 * Local leaderboard storage and ranking bounds.
 *
 * These are storage/ranking limits only. Match rewards, betrayal prices and
 * every other gameplay number stay in `balance.ts`; this file never feeds the
 * simulation. The leaderboard is purely local: no key here is uploaded, and
 * the schema is intentionally separate from the five-match `records` list so a
 * v1.0 archive can never be mistaken for ranked history.
 */

/** Exact platform key (the adapter adds the shared `state-conquest:` prefix). */
export const LEADERBOARD_STORAGE_KEY = 'leaderboard';

/**
 * Only these shapes are loaded. Version 1 (v1.1) payloads stay readable and
 * every row is preserved as a `legacy` record; version 2 (v1.2/v1.3) adds the
 * speed / rules-version / fairness dimensions; new writes use version 3, which
 * adds the faction-count dimension (v1.4 multi-party matches). Rows of schema
 * 1 and 2 predate the count and are always read as two-faction matches.
 */
export const LEADERBOARD_SCHEMA_VERSION = 3;
export const LEADERBOARD_READABLE_SCHEMA_VERSIONS: readonly number[] = [1, 2, 3];

/**
 * Faction counts a record may state. Schema 1/2 rows predate the dimension and
 * always mean 2; schema 3 rows must state a member of this list explicitly.
 */
export const LEADERBOARD_SUPPORTED_FACTION_COUNTS: readonly number[] = [2, 3, 4];
export const LEADERBOARD_DEFAULT_FACTION_COUNT = 2;

/**
 * Rules version stamped into new rows and required for a fixed-speed
 * comparison. Rows from v1.1 (or from a legacy SC challenge) carry 0 and are
 * never mixed into a comparable group.
 *
 * MAX is a WRITE-side bound only: this build refuses to mint a row it does not
 * understand. Reading is intentionally wider — any positive integer rules
 * version is preserved so a row written by a newer build survives an older
 * build's load/write cycle instead of being dropped and then erased.
 */
export const LEADERBOARD_CURRENT_RULES_VERSION = 2;
export const LEADERBOARD_LEGACY_RULES_VERSION = 0;
export const LEADERBOARD_MIN_RULES_VERSION = 1;
export const LEADERBOARD_MAX_RULES_VERSION = 3;

/** The three in-match speeds. A fixed-speed group is always exactly one. */
export const LEADERBOARD_SUPPORTED_SPEEDS: readonly number[] = [0.75, 1, 1.25];

/**
 * Hard storage bounds. The per-group cap keeps one seed from filling the whole
 * archive; the total cap bounds the platform key even if every record is its
 * own group.
 *
 * Legacy rows (migrated from a v1.1 archive) get their own budget. Without a
 * separate budget, a full v1.1 archive of 100 rows spread over 100 groups would
 * consume the entire total cap and every new fixed-speed result would be
 * evicted the moment it was written, so the player could never build a single
 * comparable score. The two budgets are independent:
 *   - at most LEADERBOARD_MAX_RECORDS modern rows (fixed + practice);
 *   - at most LEADERBOARD_MAX_LEGACY_RECORDS legacy rows, never more than were
 *     actually migrated, so nothing is gained by the split, only reserved.
 * The persisted archive can therefore hold up to the sum of both budgets.
 */
export const LEADERBOARD_MAX_RECORDS = 100;
export const LEADERBOARD_MAX_RECORDS_PER_GROUP = 20;
export const LEADERBOARD_MAX_LEGACY_RECORDS = 100;

/**
 * When a budget is exceeded:
 *   1. inside a group, the lowest-ranked records are dropped first;
 *   2. inside the modern budget, the earliest finished records are dropped
 *      first, so a fresh result is only evicted when it is itself the oldest
 *      of a full modern budget;
 *   3. inside the legacy budget, the earliest migrated rows are dropped first
 *      and the count is reported; legacy rows are never displaced by new rows.
 * Ties inside a group keep the earlier completion, then the smaller id.
 */
export const LEADERBOARD_MAX_SCORE = 1000000000;

/** The same three durations the core accepts (seconds). */
export const LEADERBOARD_SUPPORTED_DURATIONS: readonly number[] = [180, 300, 480];

/** Seed is the same positive 32-bit space the engine normalizes to. */
export const LEADERBOARD_MAX_SEED = 0xffffffff;

/** Challenge codes cap their target score at five digits. */
export const LEADERBOARD_MAX_CHALLENGE_SCORE = 99999;

/** Matches the profile nickname rule; duplicated here to keep the store standalone. */
export const LEADERBOARD_MAX_NICKNAME_CHARS = 12;
export const LEADERBOARD_MAX_AVATAR_ID_CHARS = 32;
export const LEADERBOARD_MAX_MAP_ID_CHARS = 96;
export const LEADERBOARD_MAX_MAP_NAME_CHARS = 40;
export const LEADERBOARD_MAX_RECORD_ID_CHARS = 64;

/** Challenge fairness locks the skill off; solo keeps the archive level. */
export const LEADERBOARD_CHALLENGE_BETRAYAL_LEVEL = 0;
