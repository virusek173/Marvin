# Marvin — Architecture

## Module Map

```
src/
├── index.ts               Entry point: crons (20:00 server summary + monthly report, 04:00 profiles, every 30 min air alert)
├── services/
│   ├── discord.ts         Bot logic: message routing, event handlers
│   ├── context.ts         In-memory FIFO context (fallback only, see "Message Archive")
│   ├── openai.ts          OpenAI API wrapper (tool-calling loop with web search, image description)
│   ├── usage.ts           Token usage per day / call kind / model → data/usage.json
│   ├── webTools.ts        fetch_url tool: page text for the model (scraper.ts: partial download, SSRF guard)
│   ├── voice.ts           Voice-message transcription (opt-in via VOICE_TRANSCRIPTION_ENABLED)
│   ├── airQuality.ts      get_air_quality tool: parcel-locker air sensor (opt-in via AIR_QUALITY_PAGE_URL); read() for the alert
│   ├── airAlert.ts        Air alert rules (state machine, quiet hours, cooldown), state file, message template
│   ├── client.ts          Discord.js client factory
│   ├── date.ts            Date formatting utility
│   └── history/           SQLite message archive (see below)
│       ├── db.ts          Schema (messages, FTS5 index, channels, sync_state, message_emoji, reactions), writes, migrations, context/summary reads
│       ├── emoji.ts       Emoji extraction from text and normalisation (Unicode / `:name:`)
│       ├── archive.ts     Live write path (never throws) + startup purge of excluded channels
│       ├── mapper.ts      Discord message → archive row (embeds, attachments, image descriptions)
│       ├── technical.ts   Detects Marvin's own technical messages ("Zaglądam do Internetu"...)
│       ├── sync.ts        Backfill + hourly catch-up + on-demand catch-up (HistorySync)
│       ├── discordSource.ts  The only place that talks to Discord for history — fetch only
│       ├── context.ts     HistoryContext: last 30 messages of a channel from the archive
│       ├── profiles.ts    ProfileService: periodic per-person profiles written to the `profiles` table
│       ├── voiceBackfill.ts  Transcribes voice messages already in the archive (opt-in VOICE_BACKFILL_ENABLED)
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

### Database schema (`history/db.ts`)

| Table | Purpose |
|---|---|
| `messages` | One row per message: `seq` (PK), `id` (Discord id, TEXT, UNIQUE), `channel_id`, `parent_id` (thread → parent channel), `author_id`, `author_name`, `is_bot`, `content`, `embeds_text`, `attachments_text`, `reply_to_id`, `type`, `is_technical`, `created_at` (integer) |
| `messages_fts` | FTS5 virtual table, one column `body` = content + embeds + attachments, tokenizer `unicode61 remove_diacritics 2`; `ł` is folded to `l` by hand on both sides (`foldForSearch`). Kept in sync by triggers `messages_ai/ad/au`; `rowid` = `messages.seq` |
| `channels` | `id`, `name`, `parent_id` — lets queries filter by channel name and include threads |
| `sync_state` | Per-channel backfill cursor, last attempt/success, last error |
| `profiles` | Generated person profiles; `last_seq` is the archive position the profile was built up to |
| `message_emoji` | `(message_id, emoji, n)`: emoji used in the message TEXT (`n` = uses), built by `extractEmoji` at write time and backfilled from existing content by the v1 migration. Key is the Unicode emoji without skin tone / FE0F, or `:name:` for server emoji |
| `reactions` | `(message_id, emoji, n)`: reactions the message received (`n` = count). Discord gives only counts through the messages API, so there is no "who reacted". Includes bots' and Marvin's own reactions |

**Schema versions (`PRAGMA user_version`).** v1 creates and fills `message_emoji`. v2 adds `reactions` and sets every non-NULL `sync_state.cursor` to NULL, so the next backfill re-reads the whole history (a NULL cursor restarts from the beginning; ≈27 min on production) and `writePage` stores reactions of messages that are already archived. Migrations run once, in `HistoryDb` constructor.

**Reactions stay fresh through events**: the client has the `GuildMessageReactions` intent (non-privileged) and partials for Message/Reaction/Channel; `messageReactionAdd/Remove/RemoveEmoji/RemoveAll` call `refreshReactions` in `discord.ts`, which re-reads the message's reaction counts (`collectReactions`) into `HistoryDb.setReactions` for messages already in the archive. Reactions changed while the bot was offline are corrected only by a full backfill.

**Indexes.** `idx_messages_channel_time (channel_id, created_at)` serves context and `get_messages`; `idx_messages_author_time (author_id, created_at)` serves author filters and `get_stats`; `idx_messages_time (created_at)` serves pure time ranges (summary, "yesterday"). They are composite and used left to right, so a time-only query cannot use the first two. `seq` needs no index: it is the table's `rowid`, so the table itself is the B-tree keyed by `seq`. `id` has the automatic index from `UNIQUE`.

**Why `seq` and `id` both exist.** `id` is the Discord snowflake and identifies a message to the outside world (links, `reply_to_id`, idempotent upserts). It is stored as TEXT because ~19-digit ids exceed JS number precision; code compares them with `BigInt` / `CAST(id AS INTEGER)`. `seq` is a small autoincrement integer used internally: FTS5 needs an integer `rowid`, and it keeps indexes and FTS doclists compact. `AUTOINCREMENT` guarantees a `seq` is never reused after a delete.

**`seq` is insertion order, not time.** A backfill inserts old messages after newer live ones, so a 2024 message can have a higher `seq` than yesterday's. Never order by `seq` to get chronology — queries sort by `created_at` (tie-break on `id`). `seq` is only a "written after X" watermark, which is how `profiles.last_seq` works.

**FTS5 is built at write time**, not at query time and without a dictionary: each insert tokenizes the text and appends the message to the posting list of every word. There is no stemming, so `search_messages` matches word prefixes and the prompt tells the model to search by stems (`kurtk`).

## Message Routing Flow

```
Discord: user sends message
    ↓
"messageCreate" event in discord.ts
    │
    ├── author = MARVIN_USERNAME? → archive it, SKIP the rest
    │
    └── describeImages + transcribeVoices → archive.archive(message, descriptions, transcripts)   ← ALL messages stored in the DB
            ↓
        [message mentions @Marvin or is reply to Marvin?]
            │
            ├── NO → 2% roll: one cheap model call on this single message → optional emoji reaction
            │        (Unicode or server custom emoji; utils/emojiReaction.ts; needs Add Reactions; not archived)
            │
            └── YES → context = last 30 non-technical messages of the channel from the DB
                    MODEL.contextInteractWithTools([system + web/history rules, ...context], historyTools, { webSearch: true })
                            ↓ the model decides by itself (no separate decision step): archive tools and/or hosted web_search
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

[node-cron every 30 min, AIR_QUALITY_ALERT_ENABLED=true + AIR_QUALITY_PAGE_URL + AIR_ALERT_CHANNEL_ID]
    ↓
index.ts → client.checkAirAlert() → airQuality.read() (same sensor code and 10 min cache as the tool, no model)
    ↓
airAlert.evaluateAirAlert(state from data/air_alert.json, level): BAD / VERY_BAD, 2 readings in a row, 6 h cooldown per episode,
only 07:00-22:00 Warsaw (otherwise pending until the first daytime reading), "back to normal" after 2 fine readings
    ↓
[action] fixed text (formatAirAlert) + one sentence from Marvin (SERVER_SUMMARY_MODEL_NAME, usage kind `alert`) → channel(AIR_ALERT_CHANNEL_ID)
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
| `OpenAi` (MODEL) | Main responses (history tools + web search), wake-up message, summaries, profiles | `DEFAULT_MODEL_NAME` etc. in `consts.ts` | Yes (hosted `web_search` tool) |
| `OpenAi` (cheap) | Image description (`VISION_MODEL_NAME`), voice-message transcription (`TRANSCRIBE_MODEL_NAME`, `gpt-4o-mini-transcribe`, opt-in), emoji pick (`SHORT_REACTION_MODEL_NAME`) | `gpt-5.4-mini` / `gpt-5.4-nano` | No |

## Key Design Decisions

1. **One tool loop, no decider**: every mention goes to the main model with the archive tools and OpenAI's hosted `web_search` side by side; the prompt says when to use which. A reply that used web search starts with 🌐, one that read a page through `fetch_url` with 🔗, one that used `get_air_quality` (parcel-locker sensor, opt-in) with 📦 (all added by code, not by the model). This removed a ~2.7k-token classification call per question and the second model call of the old Perplexity flow, and the answer keeps Marvin's voice because there is no hand-off of raw text.

2. **Cost is input tokens**: a question costs ≈15k input in round 1 (system prompt, tool schemas, 30 context messages) plus every tool result again in each later round. Hence short `{cN}` citation tokens instead of 120-character links, harder clipping of bulk-read messages, a 30-message default for `get_messages`, cheap models for image description and emoji picks, and `data/usage.json` + `make usage` to measure it per day and call kind.

3. **Archive as the single source of context**: the context window is a query (last 30 messages of the channel), not a stored copy, so it survives restarts and rebuilds through the `marvin_data` volume. `ContextService` is only an in-memory FIFO used for excluded channels and when the archive is unavailable.

4. **Tools get the query layer, never Discord**: history tools wrap `HistoryQuery` (readonly connection, parameterized SQL, hard limits, excluded channels filtered). Tool results are data to quote, not instructions. Each result message carries a short `cite` token (`{c3}`, `history/cites.ts`) that the model pastes verbatim and `HistoryQuery.expandCites` turns into the markdown jump link in the final reply, because hand-built links with 19-digit ids get corrupted and the full links were resent in every round; long messages are clipped around the search hit, `search_messages` skips bot messages by default (unless an author or `include_bots` is given) and falls back from "all words" to "any word" with a note, and `get_messages` can return the newest N messages (`newest=true`; `truncated` then only flags a cut caused by the size budget, not the existence of older messages). Tools are built per mention over `HistoryQuery.scoped(message.id)`, which adds `CAST(id AS INTEGER) < cutoff` to every query (via `excludedClause` / `cutoffSql`), so the question itself and newer messages are invisible to the model. `get_conversation` (`HistoryQuery.conversation`) expands a hit into its conversation by walking back and forward in the same channel while consecutive non-technical messages are at most `gap_minutes` apart (default 30, max 240; scan capped at 300 messages per side; window of `limit` around the hit when longer). `get_stats` answers counting questions with SQL aggregates computed in `HistoryQuery.stats` (group by author/channel, or by Warsaw-time day/month/weekday/hour via UTC-hour buckets folded in JS; optional FTS phrase; humans only unless `include_bots` or an author filter) — a fixed set of parameters instead of model-written SQL, so hidden channels and bot/technical filtering always apply. The same filters accept `reply_to_author` (an `EXISTS` on `reply_to_id` → the replied-to message's author, so "how many times X replied to Y" counts explicit replies only), and `with_length` (or `sort=length`) adds average message length (`avgChars`, `avgWords` ≈ spaces+1, over messages with text only) to the total and every group. Without date filters the unrouped total's `first`/`last` is the archive range, and `HistoryQuery.archiveStart()` (earliest non-technical, non-excluded message, DD.MM.YYYY Warsaw) is appended to the system prompt (`getArchiveRangePrompt`) so the model does not guess where the archive begins. Emoji questions: `group_by=emoji` (uses in text) / `group_by=reaction` (reactions received) with `totalUses` for the share, filters `emoji` (in text) and `reaction` (received, both as `EXISTS` on the new tables, accepting `😂`, `:pepe:`, `pepe`, `<:pepe:id>`), `with_reactions` / `sort=reactions` (summed reactions per group), and the `top_reacted` tool (`HistoryQuery.topReacted`: most reacted messages, or most of one reaction, humans only by default). Every rendered message carries `reactions` when it has any, and `<:name:id>` is shown as `:name:`. The result budget counts the serialized size of each message (`LIMITS.totalChars` = 45000); `openai.ts` replaces any tool output above `MAX_TOOL_RESULT_CHARS` (60000) with an error, so the two must stay consistent. In summaries of many messages the prompt asks for a `cite` link only on points about one concrete message, placed first in the point (and `moveCitesToLineStart` enforces this in code for replies to mentions). The scraper skips Discord message links so Marvin's own citations are not fetched as web pages.

5. **`MODEL` constant**: In `discord.ts`, `MODEL = openai` is a module-level constant; OpenAI is the only provider.

## Staging

`make staging-restart` (docker profile `staging`, its own `marvin_staging_data` volume and a separate bot token in the
staging env file) runs a second instance for testing the history features without touching production.
