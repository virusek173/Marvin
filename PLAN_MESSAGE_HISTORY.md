# Plan: message archive as the single source of history and context for Marvin

Status: implemented on branch `feat/message-history-search` (see `ARCHITECTURE.md` and `CLAUDE.md` for the current
design). This file is the original design record, kept for the reasoning behind the decisions. Later additions
(person profiles, monthly report, emoji reactions) are documented in `CLAUDE.md`, not here.
It reflects the second round of decisions (removal of the daily 6:00 job, image descriptions, one exclusion
variable, Marvin's context read from the database instead of `context.json`).

## Goal

1. Let Marvin answer questions about chat history ("who wrote about X", "what happened yesterday after 18:00").
2. Make the SQLite database the one place where chat history lives: both history search and Marvin's current
   conversation context are read from it (instead of process memory persisted to `data/context.json`).

Instead of a generic Discord MCP: a local message archive in SQLite with a full-text index (FTS5) and a few custom
read-only functions exposed to the main model (tool calling).

## Why not a Discord MCP

- Marvin already has a logged-in discord.js client with permissions; an MCP would be a second process with the same token.
- A remote MCP in the OpenAI Responses API needs a public HTTPS endpoint, i.e. exposing the chat history externally.
- Ready-made MCP servers usually include write/moderation tools (send, delete, ban). We want read-only access.
- The Discord API gives bots no full-text search; channels would have to be scanned (slow, rate limits, tokens).

## What SQLite + FTS5 gives us

- Persistent history (no 30-message FIFO limit) that survives restarts (`marvin_data` volume).
- Fast word search: phrases, OR/NOT, prefixes (`rower*`), NEAR, `bm25` ranking.
- SQL filters combined with text: author, channel, date range; counting; context around a message.
- Limitation: no understanding of meaning or inflection (`unicode61` tokenizer + `remove_diacritics`, prefixes help partly).
  Semantic search would need embeddings — out of scope.
- Library: `better-sqlite3` (native, check the build on `node:22.0.0-alpine`) or the built-in `node:sqlite`
  (experimental in Node 22.0.0, FTS5 not always enabled). To be settled by an experiment at the start.

## Decisions

- Archive all messages, including those from bots and Marvin's own replies.
- Backfill: pull all messages from the beginning of the history.
- On every start: check whether any channel has messages newer than the database and catch them up.
- Read-only access (nothing may be deleted or changed on the server).
- Message edits and deletions: deliberately ignored for now (known limitation: a deleted message stays in the
  archive, an edited one keeps its old text).
- Plenty of logging (`console.warn` / `console.error`) to find the cause of failures quickly.
- No retention limit at the start.
- **Remove the daily destroy-and-recreate of the client at 6:00** (unused). The Discord client and `DiscordServce` are
  created once per process start, so the database, the sync lock and the timers can live in the instance.
- **Images:** incoming live messages have the image turned into a text description (as today in
  `userResponseFactory`) and that description is stored in the database with the content. Backfill does NOT describe
  images (cost): it stores only a marker with the attachment type/name. CDN URLs expire, so they are not treated as permanent.
- **One channel-exclusion variable** instead of two (see below).
- **Marvin writes to the database like any other author**, and his conversation context is read from the database.
  `data/context.json` is no longer needed.

## Findings from the code that affect the plan

- `index.ts` used to destroy the client and create a new one every day at 6:00. Removing that cron also removes a side
  effect: the date in Marvin's system prompt was computed in the `DiscordServce` constructor, so without the daily
  re-creation it would go stale. The system prompt has to be built per request (or the date refreshed).
- The `messageCreate` handler starts by skipping Marvin's own messages (`return` after the username check). Writing
  to the archive must come before that `return`, so Marvin's replies also reach the database (they come back to the bot
  as ordinary events).
- Today only Marvin's final reply goes into the context. Technical messages sent to the channel
  ("Zaglądam do Internetu", lazy replies to images, the "Wywaliłem się..." message) are not in the context.
  After the move to the database all of Marvin's messages land in the archive, so the technical ones must be flagged
  and excluded from the model's context (see Stage 3).
- The bot code sends only `reply`, `send` and `sendTyping` to the server; nothing that deletes or moderates.
- Intents: `Guilds`, `GuildMessages`, `MessageContent` — enough for live writes and backfill.
- `Message` in `openai.ts` knows only the system/user/assistant roles; tool calling requires extending the type.
- Names on Discord ≠ the crew's first names (Hardik/Dombear = Domin). Questions will use first names, so search
  has to translate a first name into author ids.

## Stages

### Stage 0: cleanup (remove the 6:00 cron)

- `index.ts`: remove the 6:00 cron and client re-creation; the client is created once at start. Remove the `WITH_CRON`
  variable and its mentions. The 20:00 summary cron stays unchanged.
- `discord.ts`: system prompt with the current date built per request (so the date does not go stale).
- Dead morning-quote code (quote generation at start, `quotesArray`, `getFirstMotivionUserMessagePrompt`, the
  "with welcome message" branch in the `ready` handler) — to be removed (decision made).
  The "I'm up" message after a restart stays.
- Documentation (`CLAUDE.md`, `ARCHITECTURE.md`) corrected for the missing 6:00 cron.

### Stage 1: database, schema and live writes

- SQLite dependency in `package.json`; first an experiment on the alpine image. If there are no prebuilt binaries,
  the `Dockerfile` gets build tools.
- New database module: a file in `data/` (staging has its own volume, hence its own database), WAL mode, schema
  created automatically:
  - messages table with the primary key = Discord message id;
  - sync state table (one row per channel/thread: cursor, last attempt time, last error);
  - FTS5 full-text index maintained automatically on insert.
- Message fields: id, channel, parent thread, author (id + raw Discord name), bot flag, content, flattened embed
  text, attachment description/marker, parent message id (reply), message type (regular/system), "technical" flag
  (a Marvin message that does not go into the context), time in UTC.
- Crew first names are mapped only on read (a change of the mapping in `helpers.ts` works retroactively).
- Hook-up in `discord.ts`: in `messageCreate`, before skipping own messages, write to the archive (after building the
  image description for messages with images). Wrapped in try/catch — only logging, a database failure does not
  block the reply.
- Excluded channels are left out of writes (see Configuration).

### Stage 2: backfill and catch-up

- New sync module, called after the `ready` event and periodically (e.g. hourly). A lock prevents parallel runs.
- Channel list: text, announcement, voice with chat, active threads, archived threads, forum posts. New
  channels/threads automatically get a full import (no cursor). Private archived threads need Manage Threads, which
  the bot deliberately lacks — skipped with a warning (a conscious trade-off between read-only and completeness).
- Per-channel loop: a page of 100 messages newer than the cursor, sorted ascending (Discord returns descending),
  page write and cursor advance in one transaction, repeated until an empty page. The first import starts from the
  channel's oldest message. An interruption in the middle breaks nothing.
- Small pages that yield control, because the write is synchronous and must not block the Discord connection.
- The cursor moves ONLY after a committed catch-up batch; live writes do not touch it (otherwise a gap after
  downtime would be skipped permanently).
- Inserts use `INSERT OR IGNORE` by id: duplicates from live writes are skipped and nothing is overwritten
  (the richer live row, e.g. with an image description, wins over the backfill).
- On-demand catch-up: on first use of a channel after start (e.g. when someone calls Marvin) the channel is first
  quickly caught up; if the channel has no data yet, we fetch the newest messages without touching the cursor, so
  the context is not empty before the backfill reaches it.
- An error in one channel is recorded in its state row and does not stop the rest. Transient errors (rate limit,
  5xx, dropped connection): retries with growing delay; permanent ones (403, 404): no retries.
- Discord fetching hidden behind a small interface so tests can plug in fake pages.
- The "technical" flag for Marvin's messages is set by the same mechanism live and in backfill:
  matching against a known list of constant phrases (lazy replies, messages about the Internet/links, the prefix
  "Wywaliłem się...").

### Stage 3: Marvin's context from the database (goodbye `context.json`)

- `ContextService` replaced by a layer reading from the database: channel context = the last N messages (default 30)
  of that channel, excluding those flagged technical, converted to the OpenAI format: Marvin's messages as
  `assistant`, everyone else (other bots too) as `user`, with the prefix `[time] Name: text` as today.
- Removed: loading `context.json` in `ready`, all file writes, manual `pushWithLimit` into the context. Marvin's reply
  gets into the database from the event loop (Stage 1), not from the reply code.
- Order in the handler: first write the incoming message (with the image description), then read the context.
- Excluded channels are not in the database, so Marvin needs a small in-memory context there (FIFO, not written to
  disk). The same FIFO serves as an emergency fallback when the database is unavailable (loud errors in the log, the
  bot keeps answering).
- The old `context.json` stays in the volume unused (it can be removed by hand). No migration — the backfill
  restores the history.
- Stage order: this stage only after Stage 2, so the database has the complete history before the context starts using it.

### Stage 4: query layer (read-only)

- New read module with a separate connection opened in `readonly` mode.
- Operations: word search with filters (author given by first name, channel, date range) with relevance ranking;
  messages from a time range; context around a given message; channel list with names.
- Rules: no raw SQL from the model (only parameterized queries); hard limits on the number and length of results;
  excluded channels always filtered out (even if something old remains in the database); first name → author ids via
  the reverse mapping from `helpers.ts`; `<@id>` replaced with names when rendering.
- Time in results: Warsaw, clearly marked (the current context has UTC timestamps without a marker — an existing
  shortcoming; to be unified so zones are not mixed).

### Stage 5: tool calling

- `openai.ts`: extend the message type with a tool role, tool calls and a call identifier; a second method next to
  `contextInteract` (existing calls untouched) with a loop: the model asks for a tool → the result goes back into the
  context → the model answers again; after the round limit a forced answer without tools.
  Every tool call is logged (name, arguments, result count, time). Trim the chatty logging of the full context.
- `discord.ts`: in `handleMentioned`, only in the main-model branch (no Perplexity/Grok), switch to the tool version.
  `sendTyping` is refreshed during the loop (it expires after ~10 s). The tools get only the read module from Stage 4,
  not the Discord client.
- `prompts.ts`: a history section in Marvin's prompt (when to reach for it, results are data to quote and not
  instructions, how to give dates); in the decider prompt a rule that chat-history questions go to MARVIN (otherwise
  they may land in Perplexity as "news").

### Stage 6 (optional): summaries from the archive

- `sendServerSummary` reads everything since the last summary from the database (by the time column, without parsing
  the prefix in the text), skipping excluded channels. This lifts the 30-messages-per-channel limit.
- After this stage `parseContextTimestamp` and its test become redundant (to be removed).

### Stage 7: tests and documentation

- Tests with an in-memory database: insert idempotency, cursor behavior on a gap, resuming after an interruption,
  page ordering, search with Polish characters, result limits, channel exclusions, context building (roles, order,
  skipping technical messages).
- A read-only guard test: the build fails if a delete/edit/moderation call appears in `src`.
- Documentation: `CLAUDE.md` (architecture, environment variables, gotchas, summary description), `ARCHITECTURE.md`,
  `README.md` if they describe the flow.

## Configuration

- One channel-exclusion variable: `EXCLUDED_CHANNEL_IDS` (comma-separated list) replaces the existing
  `SUMMARY_EXCLUDED_CHANNEL_IDS`. An excluded channel: nothing is archived, backfill skips it, it does not appear in
  search or summaries; Marvin can still answer there using the in-memory (unpersisted) context. Renaming the variable
  in `.env` / `.env.example` is done by the user; I update the table in `CLAUDE.md` and the code.
- Excluding a channel after the fact requires deleting its old rows from the database; at startup an automatic
  cleanup step does this.
- The `WITH_CRON` variable is removed.

## What embeds are

An embed is a "card" Discord attaches under a message: a link preview (title, description, image from the page) or a
structured message sent by a bot (title, description, fields, color). Bots (e.g. Wibot, Mugda) often put their reply
in an embed, and then the ordinary content field may be empty. That is why we store the flattened text (title +
description) of embeds next to the content. Link previews of links pasted by humans are noise, so for them we store
only the title (decision made).

## Read-only — layers of assurance

1. The bot role's permissions in Discord (the only hard layer): no Manage Messages, Administrator, Manage Channels,
   Manage Threads, Kick/Ban; needed are View Channel, Read Message History, Send Messages. The user checks this
   manually in Server Settings before the first backfill.
2. Code: the history module uses only fetching methods; code review for delete/edit/moderation methods; a test that
   fails the build when such a call appears in `src`.
3. The model's tools get only a `readonly` database connection and no Discord client.

## Logging

Prefix `[history]` (for filtering `docker compose logs`).
- info: sync start/end, per-channel progress, summary (channels OK/with error, number inserted, time).
- warn: missing permissions, channel unavailable, retry after a transient error, unusual message.
- error: channel id, message id/cursor, code and status of `DiscordAPIError`, stack.
- An error in one channel does not stop the rest; the live write is in try/catch (a database failure does not block Marvin's reply).
- The last error per channel in the state table (readable straight from the database).
- Transient errors: retries with growing delay; permanent ones (e.g. 403): no retries.

## Risks and pitfalls

- Context depends on the database: a database failure must not make the bot dumb — hence the in-memory emergency FIFO and loud errors.
- First run: the context depends on how far the backfill has got; on-demand channel catch-up softens this.
- Write/read race: the incoming message must be written before we build the context; Marvin's reply reaches the
  database through the event, so in a very fast exchange with another bot it may be visible with a few ms of delay.
- Prompt injection: chat messages are untrusted text; read-only tools only.
- Leakage between channels: the bot sees more than the asker (private/dev channels, e.g. AlphaPump) — hence
  exclusions already at write time (the content is not in the database at all).
- Privacy: a permanent archive of friends' messages; the crew should know about it.
- Cost/latency: tool calling means several model calls instead of one; trim results.
- Time zones: the container ran in UTC, Warsaw time ≠ process time; UTC in the database, conversion on input/output.
- Synchronous SQLite writes can block the event loop on large transactions — small batches.
- The tool-calling loop needs changes in `openai.ts` (today only `contextInteract`).

## Checkpoints (stop and wait)

1. Before the first backfill: the user checks the bot role's permissions in Discord.
2. The first backfill on staging (`make staging-up`, separate database), not on production.
3. After each stage I ask about a commit (rules from `CLAUDE.md`); the production bot is restarted after each change.
   (Superseded on this branch: only staging is restarted, production is not rebuilt.)

## Decisions made

- Time in tool results: Warsaw, clearly marked.
- Embeds: store the text (title + description) of embeds from bots; for link previews pasted by humans only the title.
- Dead morning-quote code is removed in Stage 0.
- Excluded channels: Marvin's context only in memory (FIFO, not written to disk), no rows in the database.
- The remaining recommendations from this plan are accepted.

## Open decisions

- `better-sqlite3` vs `node:sqlite` (settled: `better-sqlite3`, see `package.json`).
