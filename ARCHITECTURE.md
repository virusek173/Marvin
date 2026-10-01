# Marvin — Architecture

## Module Map

```
src/
├── index.ts               Entry point: 20:00 server-summary cron
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
│       ├── query.ts       Read-only query layer (separate readonly connection)
│       ├── tools.ts       The tools exposed to the model (wrap query.ts only)
│       └── time.ts        Warsaw-time formatting/parsing
└── utils/
    ├── prompts.ts         All system prompts and prompt factories
    ├── helpers.ts         pushWithLimit, mapGlobalNameNameToRealName, exceptionHandler
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
            ├── NO → end
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
                                ↓ model may call search_messages / get_messages / get_message_context / list_channels
                                ↓ (max 5 rounds, then a forced answer without tools)
                    │
                    └── (both paths)
                            message.reply(response.substring(0, 1950))
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
//   "[YYYY.MM.DD HH:MM] Jacek: text"   (Warsaw time; Marvin's own messages get role "assistant")
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

4. **Tools get the query layer, never Discord**: history tools wrap `HistoryQuery` (readonly connection, parameterized SQL, hard limits, excluded channels filtered). Tool results are data to quote, not instructions.

5. **`MODEL` constant**: In `discord.ts`, `MODEL = openai` is a module-level constant. Swap it to `grok` to change the main responder without touching logic.

## Staging

`make staging-restart` (docker profile `staging`, its own `marvin_staging_data` volume and a separate bot token in the
staging env file) runs a second instance for testing the history features without touching production.
