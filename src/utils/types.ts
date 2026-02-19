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

/**
 * Team member configuration for Marvin's social context.
 * IDs come from .env and are injected into the system prompt.
 */
export interface PeopleMap {
    MarvinId: DiscordId;
    HomarId: DiscordId;
    JacekId: DiscordId;
    DominId: DiscordId;
    MariuszId: DiscordId;
    WiktorId: DiscordId;
    MadziaId: DiscordId;
    MasonId: DiscordId;
    PodsumowusId: DiscordId;
}

/**
 * Which AI service should handle a given query.
 * Returned by the decider model as a single word in its response.
 */
export type AIRouter = 'MARVIN' | 'PERPLEXITY';

/**
 * Cron schedule keys used in index.ts.
 */
export interface CronMap {
    EVERY_DAY_SIX_AM: string;
    EVERY_MINUTE: string;
}
