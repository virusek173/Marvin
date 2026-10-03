# Marvin — Architecture

## Module Map

```
src/
├── index.ts               Entry point: crons (20:00 server summary + monthly report, 04:00 profiles)
├── services/
│   ├── discord.ts         Bot logic: message routing, event handlers
│   ├── context.ts         In-memory FIFO context (fallback only, see "Message Archive")
│   ├── openai.ts          OpenAI API wrapper (main model + decider, tool-calling loop)
│   ├── grok.ts            Grok/X.ai API wrapper (alternative model)
│   ├── perplexity.ts      Perplexity API wrapper (web search)
│   ├── client.ts          Discord.js client factory
│   ├── date.ts            Date formatting utility
│   └── history/           SQLite message archive (see below)
│       ├── db.ts          Schema (messages, FTS5 index, channels, sync_state), writes, context/summary reads
│       ├── archive.ts     Live write path (never throws) + startup purge of excluded channels
│       ├── mapper.ts      Discord message → archive row (embeds, attachments, image descriptions)
│       ├── technical.ts   Detects Marvin's own technical messages ("Zaglądam do Internetu"...)
│       ├── sync.ts        Backfill + hourly catch-up + on-demand catch-up (HistorySync)
│       ├── discordSource.ts  The only place that talks to Discord for history — fetch only
│       ├── context.ts     HistoryContext: last 30 messages of a channel from the archive
│       ├── profiles.ts    ProfileService: periodic per-person profiles written to the `profiles` table
│       ├── report.ts      Monthly statistics report: exact numbers + unicode bar charts (phrases.ts counts words/pairs)
│       ├── query.ts       Read-only query layer (separate readonly connection)
│       ├── tools.ts       The tools exposed to the model (wrap query.ts only)
│       └── time.ts        Warsaw-time formatting/parsing
└── utils/
    ├── prompts.ts         All system prompts and prompt factories
    ├── emojiReaction.ts   Spontaneous emoji reactions: prompt, answer validation, the only message.react() call
    ├── helpers.ts         pushWithLimit, mapGlobalNameNameToRealName, exceptionHandler, splitForDiscord, moveCitesToLineStart
    └── consts.ts          Model name constants
```

## Startup Flow

```
index.ts
    │
    └── new DiscordServce()   ← created once per process start
            │
            ├── MessageArchive.open()   ← data/history.db, purges excluded channels
            ├── HistoryContext, read-only HistoryQuery + tools
            │
            └── client.login(DISCORD_CLIENT_TOKEN)
                    ↓ "ready" event fires
                    ├── start HistorySync (only if HISTORY_SYNC_ENABLED=true): backfill now, catch-up hourly
                    └── MODEL.interact(WAKE_UP_MESSAGE_PROMPT) → channel.send(wakeUpMessage)
```

The system prompt (with today's date) is built per request in `getSystemContext()`, so the date never goes stale.

## Message Archive (`data/history.db`)

Every message Marvin sees (and, after a backfill, the whole server history) lives in a local SQLite database
(better-sqlite3, WAL, FTS5 index with diacritics folding incl. `ł`). It is the **only** source of conversation
context and of the periodic summary.

- **Live write**: `messageCreate` → `MessageArchive.archive()` (upsert by Discord id; image descriptions are stored
  as `[Obraz: ...]`). Marvin's own messages arrive through the same event.
- **Backfill / catch-up** (`sync.ts`, opt-in with `HISTORY_SYNC_ENABLED=true`): per channel, pages of 100 messages
  oldest-first after a stored cursor, inserted with `INSERT OR IGNORE` and the cursor advanced in one transaction.
  The cursor never moves backwards and live writes never move it, so a gap while the bot was down is never skipped.
  Transient errors are retried with backoff, permanent ones (403/404) are recorded in `sync_state.last_error`.
  `ensureChannelFresh` catches a channel up on first use after startup.
- **Exclusions**: `EXCLUDED_CHANNEL_IDS` (and legacy `SUMMARY_EXCLUDED_CHANNEL_IDS`) — never archived, never synced,
  purged at startup, hidden from every query. Marvin still answers there using the in-memory fallback context.
- **Person profiles** (`profiles.ts`, opt-in `PROFILES_ENABLED=true`): `updateProfiles()` runs at startup and daily at 04:00.
  For each author (real name, usernames merged; other bots included and flagged as bots, Marvin himself excluded) with ≥30 messages it asks the model for a ≤600-char description from the
  person's own messages (first run: newest 500; later: old profile + up to 400 messages with `seq > last_seq`), but only
  when the profile is ≥7 days old and ≥20 new messages exist. State lives in the `profiles` table, so restarts are safe.
  Marvin reads them through the `get_profile` tool (`HistoryQuery.profiles`). Besides the tool, the profile of the author of a mention is appended to the reply's system prompt (`getAuthorProfile` in `discord.ts`) so the answer fits the person; other people's profiles are not injected.
- **Technical messages** (Marvin's "Zaglądam do ...", error messages) are flagged `is_technical` and left out of context.
- **Read-only by construction**: the Discord side is fetch-only (a guard test in `npm test` fails if `src` gains a
  Discord delete/edit/moderation call); the model's tools use a separate `readonly` SQLite connection. The hard
  guarantee is the bot role's permissions in Discord (no Manage Messages/Channels/Threads, Kick, Ban, Administrator).

## Message Routing Flow

```
Discord: user sends message
    ↓
"messageCreate" event in discord.ts
    │
    ├── author = MARVIN_USERNAME? → archive it, SKIP the rest
    │
    └── describeImages → archive.archive(message, descriptions)   ← ALL messages stored in the DB
            ↓
        [message mentions @Marvin or is reply to Marvin?]
            │
            ├── NO → 2% roll: one cheap model call on this single message → optional emoji reaction
            │        (Unicode or server custom emoji; utils/emojiReaction.ts; needs Add Reactions; not archived)
            │
            └── YES → context = last 30 non-technical messages of the channel from the DB
                    decider.contextInteract([DECIDER_SYSTEM_PROMPT, ...context])
                        ↓ responds: "MARVIN" or "PERPLEXITY"
                    │
                    ├── "PERPLEXITY" →
                    │       message.reply("Zaglądam do Internetu 🌐")
                    │       perplexity.contextInteract(context)
                    │           ↓ web search result
                    │       MODEL.contextInteract([system, ...context, perplexityToMarvinPrompt])
                    │
                    └── "MARVIN" →
                            MODEL.contextInteractWithTools([system + history rules, ...context], historyTools)
                                ↓ model may call search_messages / get_messages / get_message_context / get_conversation / get_stats / get_profile / list_channels
                                ↓ (OpenAI Responses API, reasoning "low"; max 5 rounds, then a forced answer without tools;
                                ↓  empty / leaked-tool-call replies are retried up to 4 times, from the 3rd attempt without tools, then an error is raised)
                    │
                    └── (both paths)
                            splitForDiscord(response) → reply + follow-up messages (≤1950 chars each)
                            ↓ the reply comes back through "messageCreate" and is archived like any other message
```

## Cron Schedule

```
node-cron: "0 20 * * *" (Europe/Warsaw)
    ↓
index.ts: checks days since last summary (data/last_summary.json)
    ↓
[>= SERVER_SUMMARY_INTERVAL_DAYS] client.sendServerSummary(lastSummaryAt)
    ↓
reads everything since lastSummaryAt from the archive (all non-excluded channels, max 1500 messages)

same 20:00 cron, MONTHLY_REPORT_ENABLED=true:
    ↓
index.ts: previous month not yet in data/last_report.json (baseline only on first run unless it is the 1st)
    ↓
client.sendMonthlyReport(month) → HistoryQuery.stats/phrases (exact counts) → model writes intro + award titles
    ↓
channel(BOTS_CHANNEL_ID): commentary + bar charts rendered from the numbers
```

## Data Models

```typescript
// Core message format (OpenAI-compatible)
interface Message {
    role: "system" | "user" | "assistant" | "tool";
    content: string | ContentPart[];
    tool_calls?: ToolCall[];      // assistant requesting tools
    tool_call_id?: string;        // tool result
}

// Context line shown to the model (built at read time from the DB row):
//   "Jacek (YYYY.MM.DD HH:MM): text"   (Warsaw time; Marvin's own messages get role "assistant")
```

## AI Services Comparison

| Service | Used for | Model | Internet? |
|---|---|---|---|
| `OpenAi` (MODEL) | Main responses (with history tools), wake-up message, summaries | see `consts.ts` | No |
| `OpenAi` (decider) | Routing decision only | see `consts.ts` | No |
| `Grok` | Alternative (unused in current routing) | — | No |
| `Perplexity` | Web search queries | — | Yes |

## Key Design Decisions

1. **Decider pattern**: A separate `OpenAi` instance (`decider`) classifies each query before routing. This avoids modifying the main conversation context with routing logic. Questions about chat history always go to MARVIN.

2. **Two-step Perplexity flow**: Perplexity fetches raw internet data, then MODEL rephrases it in Marvin's voice. This preserves Marvin's personality even for web answers.

3. **Archive as the single source of context**: the context window is a query (last 30 messages of the channel), not a stored copy, so it survives restarts and rebuilds through the `marvin_data` volume. `ContextService` is only an in-memory FIFO used for excluded channels and when the archive is unavailable.

4. **Tools get the query layer, never Discord**: history tools wrap `HistoryQuery` (readonly connection, parameterized SQL, hard limits, excluded channels filtered). Tool results are data to quote, not instructions. Each result message carries a ready-made `cite` (markdown jump link) that the model pastes verbatim, because hand-built links with 19-digit ids get corrupted; long messages are clipped around the search hit, `search_messages` skips bot messages by default (unless an author or `include_bots` is given) and falls back from "all words" to "any word" with a note, and `get_messages` can return the newest N messages (`newest=true`; `truncated` then only flags a cut caused by the size budget, not the existence of older messages). Tools are built per mention over `HistoryQuery.scoped(message.id)`, which adds `CAST(id AS INTEGER) < cutoff` to every query (via `excludedClause` / `cutoffSql`), so the question itself and newer messages are invisible to the model. `get_conversation` (`HistoryQuery.conversation`) expands a hit into its conversation by walking back and forward in the same channel while consecutive non-technical messages are at most `gap_minutes` apart (default 30, max 240; scan capped at 300 messages per side; window of `limit` around the hit when longer). `get_stats` answers counting questions with SQL aggregates computed in `HistoryQuery.stats` (group by author/channel, or by Warsaw-time day/month/weekday/hour via UTC-hour buckets folded in JS; optional FTS phrase; humans only unless `include_bots` or an author filter) — a fixed set of parameters instead of model-written SQL, so hidden channels and bot/technical filtering always apply. The result budget counts the serialized size of each message (`LIMITS.totalChars` = 45000); `openai.ts` replaces any tool output above `MAX_TOOL_RESULT_CHARS` (60000) with an error, so the two must stay consistent. In summaries of many messages the prompt asks for a `cite` link only on points about one concrete message, placed first in the point (and `moveCitesToLineStart` enforces this in code for replies to mentions). The scraper skips Discord message links so Marvin's own citations are not fetched as web pages.

5. **`MODEL` constant**: In `discord.ts`, `MODEL = openai` is a module-level constant. Swap it to `grok` to change the main responder without touching logic.

## Staging

`make staging-restart` (docker profile `staging`, its own `marvin_staging_data` volume and a separate bot token in the
staging env file) runs a second instance for testing the history features without touching production.
