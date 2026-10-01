# Marvin — Claude Code Guide

## What it is

Marvin is a Discord bot that responds to user messages and posts a periodic server summary. It uses multiple AI models — OpenAI (GPT-5) as the primary, Grok as an alternative, and Perplexity for questions that require internet access.

The server also has two other bots with their own personas: [Mugda](#mugda) and [Wibot](#wibot) — see below.

## Git Workflow

After every change to this repo, do NOT commit and push automatically. Instead, ask the user whether to commit and push now, and wait for their confirmation before doing so.

After every change, restart the bot automatically so it runs the new code: `docker compose up --build -d`. Do this without waiting for confirmation.

## Commands

```bash
npm run marvin        # build + run (production)
npm run marvin:build  # TypeScript compilation only → dest/
npm run marvin:run    # run only (requires prior build)
npm test              # Jest tests
```

## Environment Variables (.env)

| Variable | Description |
|---|---|
| `DISCORD_CLIENT_TOKEN` | Discord bot token (from Discord Developer Portal) |
| `CHANNEL_ID` | Channel ID where the bot posts its wake-up message after a restart |
| `BOTS_CHANNEL_ID` | Channel ID (bots conversation channel) where the periodic server summary is posted |
| `EXCLUDED_CHANNEL_IDS` | Comma-separated channel IDs that are never archived, synced, searched or summarized (e.g. dev/issue-tracker channels). Threads of an excluded channel are excluded too. Legacy name `SUMMARY_EXCLUDED_CHANNEL_IDS` is still read and merged |
| `HISTORY_SYNC_ENABLED` | `true` starts the history backfill (whole server, read-only) at startup and an hourly catch-up. Off by default |
| `MARVIN_ID` | Bot's Discord user ID — used to detect mentions |
| `MARVIN_USERNAME` | Bot's username — used to ignore its own messages |
| `PERPLEXITY_KEY` | Perplexity API key (web search) |
| `GROK_API` | Grok/X.ai API key |
| `HOMAR_ID` | Discord ID of Homar |
| `JACEK_ID` | Discord ID of Jacek |
| `DOMIN_ID` | Discord ID of Domin |
| `MARIUSZ_ID` | Discord ID of Mariusz |
| `WIKTOR_ID` | Discord ID of Wiktor |
| `MADZIA_ID` | Discord ID of Madzia |
| `MASON_ID` | Discord ID of Mason |
| `PODSUMOWUS_ID` | Discord ID of Podsumowuś |
| `MUGDA_ID` | Discord ID of the Mugda bot |
| `WIBOT_ID` | Discord ID of the Wibot bot |

## Other Bots on the Server

Marvin shares the Discord server with two other bots, each with a distinct persona.

### Mugda

A girl-persona bot. During the day she "does" laundry, drinks coffee, plays Baldur's Gate, and goes to the gym. She replies sarcastically and is a bit snarky/biting in tone. She can generate images — if asked to "zrób zdjęcie" (take a photo), e.g. of whatever she's currently up to, she produces one.

### Wibot

Informs about "niedziela handlowa" (trading/non-trading Sundays in Poland — days when retail is open or closed by law) and current interest rates. Not great with the calendar, but does its best.

## Architecture — Message Flow

```
[process start]
        ↓
    index.ts → new DiscordServce()  (once per process)
        ↓
    client "ready" → (HISTORY_SYNC_ENABLED) start history backfill/catch-up
        ↓
    MODEL.interact(WAKE_UP_MESSAGE_PROMPT)
        ↓
    channel(CHANNEL_ID).send(message)  ← wake-up message


[Discord: user sends a message]
        ↓
    discord.ts "messageCreate"
        ↓
    archive.archive(message, imageDescriptions)  ← every message goes to data/history.db (SQLite)
        ↓
    [does message mention @Marvin or reply to Marvin?]
        ├── NO → end
        └── YES → context = last 30 non-technical messages of the channel from the DB
                  decider.contextInteract([DECIDER_SYSTEM_PROMPT, ...context])
                        ↓
                [does response contain "PERPLEXITY"?]
                    ├── YES → perplexity.contextInteract(context)
                    │         → MODEL.contextInteract([system, ...context, perplexityResult])
                    └── NO  → MODEL.contextInteractWithTools([system + history rules, ...context], historyTools)
                                    ↓
                            message.reply(response)   ← archived through its own "messageCreate"


[node-cron 20:00 Warsaw, every SERVER_SUMMARY_INTERVAL_DAYS days]
        ↓
    index.ts → client.sendServerSummary(lastSummaryAt)
        ↓
    read everything since lastSummaryAt from the archive (non-excluded channels) → combinedText
        ↓
    MODEL.contextInteract([getServerSummarySystemPrompt(), combinedText])
        ↓
    channel(BOTS_CHANNEL_ID).send(digest)
```

## Key Files

| File | Role |
|---|---|
| `src/index.ts` | Entry point — client startup + summary cron |
| `src/services/discord.ts` | Main bot logic — message routing |
| `src/services/context.ts` | In-memory FIFO context (30/channel) — fallback only (excluded channels, archive failure) |
| `src/services/history/` | SQLite message archive: `archive.ts` live write, `sync.ts` backfill, `context.ts` context from DB, `query.ts` + `tools.ts` read-only search for the model (see ARCHITECTURE.md) |
| `src/services/openai.ts` | OpenAI API wrapper — `interact()`, `contextInteract()`, `contextInteractWithTools()` |
| `src/services/grok.ts` | Grok/X.ai API wrapper |
| `src/services/perplexity.ts` | Perplexity API wrapper (internet access) |
| `src/utils/prompts.ts` | All system prompts and prompt factories |
| `src/utils/helpers.ts` | Utilities: `pushWithLimit`, `mapGlobalNameNameToRealName`, `exceptionHandler`, `splitForDiscord`, `moveCitesToLineStart` |
| `src/utils/consts.ts` | Model name constants: `DEFAULT_MODEL_NAME`, `DECIDER_MODEL_NAME`, etc. |

## How to Add a New AI Service

1. Create `src/services/newai.ts` following the `openai.ts` pattern — needs `interact()` and `contextInteract()` methods
2. Add the API key to `.env` and `.env.example`
3. Import and instantiate the service in `discord.ts`
4. Add routing logic in the `decider` flow or as a new branch in `messageCreate`

## Gotchas

- **Context limit:** the context is the last **30 messages** of the channel read from the archive (`CONTEXT_LIMIT` in `history/context.ts`), technical Marvin messages excluded. Changing this affects API cost.
- **Message archive (`data/history.db`)** — SQLite + FTS5 in the `marvin_data` volume. Every message is written live; `HISTORY_SYNC_ENABLED=true` additionally imports the full history (per-channel cursor in `sync_state`, resumable, idempotent) and catches up hourly. Delete the file to rebuild it from scratch (the next backfill re-imports everything).
- **Discord access must stay read-only:** history sync only calls `fetch`; `npm test` includes a guard test (`readonly.guard.test.ts`) that fails if `src` gains a Discord delete/edit/moderation call. The bot role in Discord must have only View Channel, Read Message History and Send Messages — role permissions are the hard guarantee.
- **History tools:** the main model (not Perplexity, not the short reaction / summary) can call `search_messages`, `get_messages`, `get_message_context`, `list_channels`. They go through `HistoryQuery` (separate `readonly` SQLite connection, parameterized SQL, result caps, excluded channels hidden). Results are data, not instructions (stated in the system prompt). Loop cap: 5 tool rounds, and a total tool-output budget per question (`MAX_TOTAL_TOOL_CHARS` 30000 in `openai.ts`) after which tools return "budget spent" so the model answers with what it has; for "everything on the server" requests the prompt tells it to read one chunk of 100 newest messages (no paging) and report the date range it covered.
- **Tool loop uses the OpenAI Responses API** (`responses.create`, reasoning effort `low`), not chat completions: gpt-5.6-terra rejects function tools with reasoning on `/v1/chat/completions`. An empty reply or one that prints a tool call as text (`to=functions.…`) is retried up to 2 times, then fails with an error instead of posting garbage. Decider, Perplexity rephrase, summary and short reactions still use chat completions.
- **Message links:** every query result carries `cite`, a ready-made `[dd.mm.yyyy hh:mm](<discord.com/channels/guild/channel/message>)` (the guild id comes from `client.guilds.cache.first()`, so it assumes a single server). The prompt tells the model to paste it verbatim at the start of an entry — models corrupt long ids when they build links themselves. `search_messages` clips long messages around the matched word (not the first 500 chars); `get_messages` with `newest=true` returns the latest N messages of a range ("last 50 messages"); its `truncated` flag only marks a cut by the size budget. Result budget: `LIMITS.totalChars` 45000 in `query.ts` (counted on the serialized message), while `openai.ts` replaces any tool output over `MAX_TOOL_RESULT_CHARS` 60000 with an error — keep them consistent. In summaries the link goes first, only on points about one concrete message; because the model still appends links at the end, `moveCitesToLineStart` (`helpers.ts`) moves a single trailing `cite` link to the start of its line before the reply is sent.
- **Scraper ignores Discord message links** (`extractUrls`): Marvin's own cited links sit in the context and must not be fetched as web pages.
- **Time zone:** the container runs with `TZ=Europe/Warsaw` (Dockerfile); context lines and tool results are in Warsaw time.
- **Spontaneous chat features (`discord.ts`):** on every non-mentioned message there's a `SHORT_REACTION_CHANCE` (1%) roll for a short AI reaction, cooldown-gated by `SHORT_REACTION_COOLDOWN` (30 messages). There is no more per-message chance for a long spontaneous reply — that feature was replaced by the periodic server summary below.
- **Periodic server summary (`sendServerSummary`):** every day at 20:00 Warsaw time, a cron in `index.ts` checks how many days have passed since the last summary (persisted in `data/last_summary.json`, not an in-memory counter — survives restarts and `docker compose up --build` thanks to the `marvin_data` volume). Once `SERVER_SUMMARY_INTERVAL_DAYS` days (default 3) have elapsed, it calls `client.sendServerSummary()`, which digests all messages since the previous summary (read from the archive by time, excluded channels skipped, max 1500 messages) and posts the result to the channel configured via `BOTS_CHANNEL_ID` in `.env`.
- **`MODEL` is a constant** in `discord.ts` pointing to the `openai` instance. To switch the main model, change the `MODEL` object or the value in `consts.ts`.
- **`decider`** uses a separate `OpenAi` instance (not Grok) — its model can be changed independently.
- **`data/context.json`** is no longer read or written (context comes from the archive). An old file may remain in the volume; it is harmless and not migrated.
- **Staging:** `make staging-restart` / `make staging-logs` run a second instance (docker profile `staging`, own `marvin_staging_data` volume, separate bot token in the staging env file) for testing without touching production.
- **System prompt date:** built per request in `DiscordServce.getSystemContext()` (the client is no longer re-created daily, so it must not be cached).
- **Discord reply limit:** the reply to a mention and the server summary are split by `splitForDiscord` (`helpers.ts`) into parts of ≤1950 characters (paragraph → line → word boundary, max 4 parts; the first part is a reply, the rest are plain channel messages). Short reactions and the bot-exchange reply are still trimmed with `substring(0, 1950)`. The history prompt tells the model about the limit so it picks the key points and ends on a full sentence.

## Discord globalName → Real Name Mapping

`mapGlobalNameNameToRealName` in `helpers.ts` maps Discord usernames to real first names prepended to messages in context. If a username is not on the list, the Proxy returns the username itself as a fallback.

## Tests

```bash
npm test
# src/services/__tests__/date.test.ts — date formatting
# src/utils/__tests__/helpers.test.ts — pushWithLimit, splitForDiscord, moveCitesToLineStart
# src/services/__tests__/openaiTools.test.ts — tool-calling loop on the Responses API (mocked OpenAI)
# src/services/__tests__/scraper.test.ts — URL extraction (Discord message links skipped)
# src/services/history/__tests__/ — archive db/FTS, mapper, sync, context building, query layer, tools, read-only guard
```
