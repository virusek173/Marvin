/**
 * Shared TypeScript types for the Marvin Discord bot.
 * Import from here to avoid duplicating type definitions across services.
 */

/** Discord user ID string (snowflake format). */
export type DiscordId = string;

/**
 * Maps a Discord username (globalName) to a real first name.
 * Used by mapGlobalNameNameToRealName in helpers.ts.
 */
export interface UsernameToNameMap {
    [discordGlobalName: string]: string;
}

/** Discord ids keyed by real first name, read from the message archive (HistoryQuery.personIds). */
export type PeopleMap = Record<string, DiscordId>;

/**
 * Cron schedule keys used in index.ts.
 */
export interface CronMap {
    EVERY_DAY_SIX_AM: string;
    EVERY_MINUTE: string;
}
