# Marvin — Claude Code Guide

## What it is

Marvin is a Discord bot that responds to user messages and posts a periodic server summary. It uses OpenAI (GPT-5) as the primary model, with its hosted web search for questions that need the internet, and cheaper models for trivial jobs (image description, emoji pick). OpenAI is the only provider.

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
| `SERVER_SUMMARY_INTERVAL_DAYS` | Days between periodic server summaries (checked daily at 20:00 Warsaw). Default 3; a missing, non-numeric or non-positive value falls back to the default |
| `MONTHLY_REPORT_ENABLED` | `true` posts a statistics report for the previous month to `BOTS_CHANNEL_ID` on the 1st at 20:00 Warsaw (see "Monthly statistics report" in Gotchas). Off by default. `MONTHLY_REPORT_FORCE_MONTH=YYYY-MM` posts that month's report once at startup (testing) |
| `PROFILES_ENABLED` | `true` turns on generated person profiles (see "Person profiles" in Gotchas): generated at startup and daily at 04:00 Warsaw when due. Off by default; the `get_profile` tool then just reports that none exist |
| `HISTORY_SYNC_ENABLED` | `true` starts the history backfill (whole server, read-only) at startup and an hourly catch-up. Off by default |
| `MARVIN_ID` | Bot's Discord user ID — used to detect mentions |
| `MARVIN_USERNAME` | Bot's username — used to ignore its own messages |
| `OPENAI_API_KEY` | OpenAI API key — not read in our code, the `openai` SDK picks it up itself (`new OpenAI()`) |

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
                  MODEL.contextInteractWithTools([system + web/history rules, ...context], historyTools, { webSearch: true })
                        ↓ one loop: the model itself calls archive tools and/or OpenAI's hosted web_search (no separate decision step)
                  cite tokens {cN} → links, web source links → domain, then message.reply(response)   ← archived through its own "messageCreate"


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
| `src/index.ts` | Entry point — client startup + crons (server summary, monthly report, profiles) |
| `src/services/discord.ts` | Main bot logic — message routing |
| `src/services/context.ts` | In-memory FIFO context (30/channel) — fallback only (excluded channels, archive failure) |
| `src/services/history/` | SQLite message archive: `archive.ts` live write, `sync.ts` backfill, `context.ts` context from DB, `query.ts` + `tools.ts` + `cites.ts` read-only search for the model (see ARCHITECTURE.md) |
| `src/services/openai.ts` | OpenAI API wrapper — `interact()`, `contextInteract()`, `contextInteractWithTools()` |
| `src/services/webTools.ts` | `fetch_url` tool (page text for the model; reports the fetch so the reply gets 🔗) |
| `src/services/usage.ts` | `UsageTracker`: per-day token totals by call kind and model, persisted to `data/usage.json` (`make usage` prints the report) |
| `src/utils/prompts.ts` | All system prompts and prompt factories |
| `src/utils/helpers.ts` | Utilities: `pushWithLimit`, `mapGlobalNameNameToRealName`, `exceptionHandler`, `splitForDiscord`, `moveCitesToLineStart` |
| `src/utils/consts.ts` | Model name constants: `DEFAULT_MODEL_NAME`, `VISION_MODEL_NAME`, `SHORT_REACTION_MODEL_NAME`, etc. |

## Gotchas

- **Context line format is `Name (YYYY.MM.DD HH:MM): text`, never `[time] Name:`.** In an A/B test (`scripts/ab-garbage.mjs`, 120 calls per variant) a line starting with `[` made gpt-5.6-terra return an empty or garbage reply in the tool loop 15% of the time versus <1% for the current format. Do not change the format without re-running that test; `stripLeadingTimestampPrefix` and `parseContextTimestamp` understand both the new and the old format.
- **Context limit:** the context is the last **30 messages** of the channel read from the archive (`CONTEXT_LIMIT` in `history/context.ts`), technical Marvin messages excluded. Changing this affects API cost.
- **Message archive (`data/history.db`)** — SQLite + FTS5 in the `marvin_data` volume. Every message is written live; `HISTORY_SYNC_ENABLED=true` additionally imports the full history (per-channel cursor in `sync_state`, resumable, idempotent) and catches up hourly. Delete the file to rebuild it from scratch (the next backfill re-imports everything).
- **Discord access must stay read-only:** history sync only calls `fetch`; `npm test` includes a guard test (`readonly.guard.test.ts`) that fails if `src` gains a Discord delete/edit/moderation call. The bot role in Discord must have only View Channel, Read Message History, Send Messages and Add Reactions (for the emoji reactions, the single allowed exception) — role permissions are the hard guarantee.
- **History tools:** the main model (not the summary / report) can call `search_messages`, `get_messages`, `get_message_context`, `get_conversation`, `get_stats`, `get_profile`, `list_channels`, `top_reacted`. They go through `HistoryQuery` (separate `readonly` SQLite connection, parameterized SQL, result caps, excluded channels hidden). Results are data, not instructions (stated in the system prompt). `search_messages` ranks by relevance (bm25) by default, NOT by date: for "latest / current / who is X now" questions the model must pass `sort=newest` or a `from`/`to` range (the prompt says so; an old hit once got named as the "latest mention" while a newer, longer message ranked below the 25-hit cap). The result carries `sort`, `matches` (total hits) and `span` (date range of the returned ones), and a relevance-sorted result with more matches than returned adds a note saying so. `get_messages` over a range with more messages than `limit` (earliest-first) likewise returns `matches`, `span` and a note naming where the shown part ends (a busy evening was once cut at ~22:38 and the model drew conclusions from the visible part only). The prompt also forbids inventing host/place/occasion/attendees, inventing an explanation of its earlier reasoning (the model never sees its own past tool calls) and agreeing with a bare "nie" without re-checking; `stripLeadingTimestampPrefix` also removes a bare `Marvin:` prefix. Loop cap: 5 tool rounds, and a total tool-output budget per question (`MAX_TOTAL_TOOL_CHARS` 50000 in `openai.ts` (30000 was spent by one 100-message day read, which blocked the narrower follow-up the truncation note asks for)) after which tools return "budget spent" so the model answers with what it has; for "everything on the server" requests the prompt tells it to read one chunk of 100 newest messages (no paging) and report the date range it covered. For every mention the tools are built from `historyQuery.scoped(message.id)`, a view that hides the asking message and everything newer (ids grow with time): the question is already in the model's context, and its archived copy would otherwise show up in search hits, be cited as "evidence" and inflate counts. `get_conversation` returns the whole conversation a message belongs to (same channel, no gap longer than `gap_minutes`, default 30; computed on the fly from timestamps, no extra table; a window around the message when longer than `limit`, with the full size in `conversation`) so "what did we agree on" is answered from context, not from a single hit. Counting questions ("who wrote how much", "how many about X") go to `get_stats`: exact `COUNT`/`GROUP BY` over the whole archive (by author, channel, day, month, weekday or hour in Warsaw time; optional FTS phrase and the usual filters; humans only unless `include_bots`/author given) — there is deliberately no free-form SQL tool, so excluded channels and the `is_bot`/`is_technical` rules cannot be bypassed. `get_stats` also takes `reply_to_author` (explicit replies of one person to another, e.g. "how many times X replied to Y") and `with_length` / `sort=length` (average message length in characters and words); `get_stats` without dates returns `first`/`last` = archive range, and the system prompt carries the archive start date (`getArchiveRangePrompt`, `HistoryQuery.archiveStart()`) so the model never guesses "from the beginning". `get_messages`/`search_messages` accept `reply_to_author` too. Emoji and reactions: tables `message_emoji` (emoji in message text, from `history/emoji.ts`) and `reactions` (counts only — Discord does not tell who reacted, bots' and Marvin's own reactions included); `get_stats` has `group_by=emoji|reaction`, filters `emoji` / `reaction`, `with_reactions` and `sort=reactions`; `top_reacted` returns the most reacted messages. Reactions are read from REST-fetched messages (backfill) and kept current by `messageReactionAdd/Remove*` events (`refreshReactions` in `discord.ts`; needs the non-privileged `GuildMessageReactions` intent, enabled in `client.ts`). The first start on schema v2 resets the sync cursors, so the backfill re-reads the whole history (≈27 min on production) to collect reactions; reactions changed while the bot was offline are corrected only by a full backfill.
- **Monthly statistics report (`history/report.ts`, `phrases.ts`):** opt-in with `MONTHLY_REPORT_ENABLED=true`. The existing 20:00 cron in `index.ts` calls `sendMonthlyReportIfDue`: it posts the report for the previous calendar month (Warsaw time) to `BOTS_CHANNEL_ID` once, remembering the month in `data/last_report.json`. The first run without that file only records a baseline unless it is the 1st (so enabling mid-month posts nothing); after downtime on the 1st the missed report goes out at the next 20:00. All numbers come from SQL aggregates (`HistoryQuery.stats` with `from`/`to`, humans only) and `HistoryQuery.phrases` (word and word-pair counts, each at most once per message; links, mentions, code, laughter and a Polish stopword list in `phrases.ts` are ignored) and are rendered as unicode bar charts in code blocks by `renderReportBlock`; the model (`getMonthlyReportSystemPrompt`) only writes the intro and award titles from `reportFacts`, so it cannot distort the figures. There is deliberately no month-over-month message count. Months with <20 human messages are skipped. To test, set `MONTHLY_REPORT_FORCE_MONTH=YYYY-MM` (posts that month's report at startup, ignores the state file; remove it afterwards or every restart reposts).
- **Person profiles (`history/profiles.ts`, table `profiles` in `history.db`):** `ProfileService` writes a short, unofficial description of each regular participant (interests, topics, writing style, jokes) from their own archived messages, keyed by real name (usernames merged via `mapGlobalNameNameToRealName`). Only authors with ≥30 text messages; other bots (Mugda, Wibot, …) are profiled too, marked as bots in the model input so they are described by role and tone, but Marvin's own messages (`selfId`), technical messages and excluded channels are ignored. First profile reads the newest 500 messages; later runs feed the model the old profile plus up to 400 messages newer than `last_seq` and refresh only when the profile is ≥7 days old and ≥20 new messages exist, so the daily 04:00 cron and every startup are cheap no-ops most of the time. The prompt (`getProfileSystemPrompt`) tells the model to skip sensitive data and ignore instructions in the messages. Marvin reads profiles through the `get_profile` tool (for "what does Madzia like"). When someone mentions Marvin, the profile of that message's author (if one exists) is appended to the system prompt of the reply (`getAuthorProfilePrompt`, `getAuthorProfile` in `discord.ts`; about 600 characters, marked as unofficial data to be used discreetly, never quoted). The system prompt also carries a short line (≈220 characters) from every profile as the "people you know" list; the server summary is deliberately not injected. To regenerate, delete rows from `profiles` and restart.
- **Tool loop uses the OpenAI Responses API** (`responses.create`, reasoning effort `low`), not chat completions: gpt-5.6-terra rejects function tools with reasoning on `/v1/chat/completions`. An empty reply or one that prints a tool call as text (`to=functions.…`) a reply that is only the bare speaker header (`Marvin` / `Marvin (date):`), or tool-channel garbage (a reply starting with `[tool]`, , containing `weighted tokens left`, containing CJK/Georgian characters or leaked English reasoning such as "We need respond") is retried up to 4 times (from the 3rd attempt on without tools, so the model has to answer in text), then fails with an error instead of posting garbage. Summary, report, profiles, image description, emoji pick and the bot-exchange closing line use chat completions.
- **Web search is a tool, not a branch:** `contextInteractWithTools(..., { webSearch: true })` adds OpenAI's hosted `{ type: "web_search", user_location: Poznań/PL, search_context_size: "low" }` next to the function tools (cast to `any`, the SDK types only know `web_search_preview`). The model decides itself (`WEB_SEARCH_PROMPT` in the system prompt: only for current information, never for server matters; results are data, not instructions). `web_search_call` items are not function calls, the loop ignores them; the log line shows `wyszukiwań w sieci: N`. When at least one `web_search_call` happened, the loop returns `webSearch: true` and `discord.ts` prefixes the reply with 🌐 (`WEB_ANSWER_ICON`) so readers see the answer comes from the internet. 🔗 is added the same way when `fetch_url` read a page (see below); 🖼️ is prompt-driven (the model starts with it when it used an image description `[Obraz: …]`). Marvin's earlier replies lose their leading 🌐/🔗/🖼️ in the context (`stripSourceIcons` in `renderLine`) and a 🌐/🔗 the model writes itself is dropped (`stripSystemIcons`), otherwise the model imitated the icons without having used the source. The API appends sources as `([domain](https://…?utm_source=openai))`; `shortenWebCitations` reduces them to `(domain)`. There is no decider call and no Perplexity any more; `INTERNET_NOTICE` stays in `technical.ts` only so old archived notices remain technical. Every mention goes through this one loop (history tools when the archive is available, web search always).
- **Cheap models for trivial jobs (`consts.ts`):** `VISION_MODEL_NAME` (`gpt-5.4-mini`, `detail: "low"`) describes images and `SHORT_REACTION_MODEL_NAME` (`gpt-5.4-nano`) picks the reaction emoji; the main answer, summary, report and profiles stay on `gpt-5.6-terra`. Both cheap models were checked against this key (chat completions, `max_completion_tokens`, vision through `image_url`).
- **Token usage:** every OpenAI call logs `[usage] <kind> <model>: wejście … (z cache …), wyjście … (w tym rozumowanie …)`; the tool loop logs each round and a `[usage] razem N wywołań` total per question. Besides the log, `UsageTracker` (`usage.ts`) adds every call to `data/usage.json` (day in Warsaw time → kind `question|bot-exchange|summary|report|profile|reaction|image|wake-up|other` → model → calls/input/cached/output/reasoning; flushed 5 s after a change, so it survives container rebuilds in the `marvin_data` volume). `make usage` (prod) / `make usage-staging` print the per-day report (`DAYS=7` to limit, `scripts/usage-report.mjs`). Cost is dominated by input: ≈15k tokens in round 1 (system prompt + tool schemas + 30 context messages) and the tool results are resent in later rounds. Prices are not known to the code, so the report shows tokens only.
- **Message links:** every query result carries `cite`, a short token like `{c3}` (`history/cites.ts`, `CiteRegistry`; one registry per question because `scoped()` creates a fresh one). The full link `[dd.mm.yyyy hh:mm](<discord.com/channels/guild/channel/message>)` (the guild id comes from `client.guilds.cache.first()`, so it assumes a single server) was about 120 characters per message and was resent in every round, so the model pastes the token and `HistoryQuery.expandCites` turns it into the link in the final reply (unknown tokens are dropped). The prompt tells the model to paste it verbatim at the start of an entry — models corrupt long ids when they build links themselves. `search_messages` clips long messages around the matched word (not the first 500 chars), skips bot-authored messages (Marvin's own answers pollute results) unless an author filter or `include_bots` is given, and falls back to "any of the words" with a note when no message contains all of them; `get_messages` with `newest=true` returns the latest N messages of a range ("last 50 messages"); its `truncated` flag only marks a cut by the size budget. Messages from ranges, neighbours and conversations are clipped to `LIMITS.rangeTextChars` (300), search hits to `textChars` (500); `get_messages` returns 30 messages by default (`rangeDefault`, max 100). Result budget: `LIMITS.totalChars` 45000 in `query.ts` (counted on the serialized message), while `openai.ts` replaces any tool output over `MAX_TOOL_RESULT_CHARS` 60000 with an error — keep them consistent. In summaries the link goes first, only on points about one concrete message; because the model still appends links at the end, `moveCitesToLineStart` (`helpers.ts`) moves a single trailing `cite` link to the start of its line before the reply is sent.
- **`fetch_url` tool (`webTools.ts`, `scraper.ts`):** links are no longer scraped up front for every mention (up to 5 pages × 4000 chars in every round, plus up to 8 s of delay); the model calls `fetch_url(url)` when someone asks about a link (the prompt says to fetch first and not describe a page from its address; for a topic it knows well it may still answer without fetching). Max 3 pages per question, Discord message links are refused (that is the archive). `scrapeUrl` reads at most 400 KB of the body (a larger page used to fail with `maxContentLength`), keeps the text from `<main>`/`<article>`, drops `nav/header/footer/aside`, scripts, styles and `data-*` attributes, returns 4000 characters. Since the model chooses the address, `scrapeUrl` is SSRF-guarded: http(s) only, literal private/loopback/link-local IPs refused, and the DNS lookup of every request and redirect hop rejects non-public addresses (`isPrivateAddress`).
- **Scraper ignores Discord message links** (`extractUrls`): Marvin's own cited links sit in the context and must not be fetched as web pages.
- **Time zone:** the container runs with `TZ=Europe/Warsaw` (Dockerfile); context lines and tool results are in Warsaw time.
- **No spontaneous text replies:** Marvin writes only when mentioned / replied to (and in the capped exchange with other bots), plus the scheduled posts (server summary, monthly report). The old random short text reaction was removed; the periodic summary replaced the long spontaneous reply.
- **Spontaneous emoji reactions (`utils/emojiReaction.ts`, `maybeReactWithEmoji` in `discord.ts`):** every non-bot, non-mention message with real text (≥3 chars after stripping links/mentions, ≤500 chars) has a `EMOJI_REACTION_CHANCE` (2%) roll, no cooldown or cap. On a hit ONE cheap call (`SHORT_REACTION_MODEL_NAME`) sees only that single message plus the server's custom emoji names and is told to always pick the single best-fitting emoji (`:name:` of a server emoji, or a Unicode emoji); `parseEmojiChoice` validates it (single emoji only, custom name must exist) and `message.react()` is called. Reactions are not archived. This is the one deliberate write to Discord besides sending messages: the bot role needs **Add Reactions**; on Discord error 50013/403 the feature switches itself off until restart (one log line). `.react(` is allowed only in `emojiReaction.ts` (guard test).
- **Periodic server summary (`sendServerSummary`):** every day at 20:00 Warsaw time, a cron in `index.ts` checks how many days have passed since the last summary (persisted in `data/last_summary.json`, not an in-memory counter — survives restarts and `docker compose up --build` thanks to the `marvin_data` volume). Once `SERVER_SUMMARY_INTERVAL_DAYS` days (default 3) have elapsed, it calls `client.sendServerSummary()`, which digests all messages since the previous summary (read from the archive by time, excluded channels skipped, max 1500 messages) and posts the result to the channel configured via `BOTS_CHANNEL_ID` in `.env`.
- **`MODEL` is a constant** in `discord.ts` pointing to the `openai` instance. To switch the main model, change the `MODEL` object or the value in `consts.ts`.
- **`data/context.json`** is no longer read or written (context comes from the archive). An old file may remain in the volume; it is harmless and not migrated.
- **Staging:** `make staging-restart` / `make staging-logs` run a second instance (docker profile `staging`, own `marvin_staging_data` volume, separate bot token in the staging env file) for testing without touching production. `node scripts/staging-run.mjs [id|group]` runs the cases from `scripts/staging-cases.json` through a channel webhook (`scripts/staging-ask.mjs`; URL in `~/.marvin-staging-webhook`, outside the repo); it needs `TEST_WEBHOOK_AS_HUMAN=true` in the staging env file so webhook messages are handled like human ones (never set it in production).
- **System prompt date:** built per request in `DiscordServce.getSystemContext()` (the client is no longer re-created daily, so it must not be cached).
- **Discord reply limit:** the reply to a mention and the server summary are split by `splitForDiscord` (`helpers.ts`) into parts of ≤1950 characters (paragraph → line → word boundary, max 4 parts; the first part is a reply, the rest are plain channel messages). The bot-exchange reply is still trimmed with `substring(0, 1950)`. The history prompt tells the model about the limit so it picks the key points and ends on a full sentence.

## Discord globalName → Real Name Mapping

`mapGlobalNameNameToRealName` in `helpers.ts` maps Discord usernames to real first names prepended to messages in context. The map is NOT in the repo: it is the `nicks` section (`{"nick": "Name", ...}`) of `./people.json`, whose second section `noPing` is a list of first names of people who did not agree to be pinged (`{"nicks": {...}, "noPing": ["Name"]}`); it lives in `./people.json` next to `docker-compose.yml` (git-ignored), bind-mounted read-only to `data/people.json` in both the production and the staging container (`PEOPLE_FILE` overrides the path). Edit it in place (a single-file bind mount keeps pointing at the old inode if an editor replaces the file by rename; then restart the container). `people.ts` re-reads it when the file's mtime changes (checked at most every 5 s), so edits need no restart; a broken file (or one without `nicks`) keeps the previous data (one log line). If a username is not in the map, or the file is missing, the Proxy returns the username itself. Tests use a throw-away map with fictional names written by `jest.setup.cjs`.

The people section of Marvin's system prompt is built the same way, not hand-written: one short line per person from the generated profiles (`getKnownProfiles` in `discord.ts` → `describePeople`, ~220 characters each, nothing until profiles exist), and the mention list comes from the archive, not from environment variables: `HistoryQuery.personIds()` returns the Discord id per first name (nick map applied) of every author with ≥30 messages and activity in the last 180 days (humans and other bots; Marvin, technical messages and excluded channels left out; the id with the most messages wins), cached for 10 minutes in `discord.ts` (`getPersonIds`). People in `noPing` get no mention and are listed as "write the plain name". A person with no archive id is simply written by name.

## Tests

```bash
npm test
# src/services/__tests__/date.test.ts — date formatting
# src/utils/__tests__/helpers.test.ts — pushWithLimit, splitForDiscord, moveCitesToLineStart
# src/services/__tests__/openaiTools.test.ts — tool-calling loop on the Responses API (mocked OpenAI, web search, usage records)
# src/services/__tests__/usage.test.ts — UsageTracker aggregation and persistence
# src/services/__tests__/scraper.test.ts — URL extraction (Discord message links skipped)
# src/services/history/__tests__/ — archive db/FTS, mapper, sync, context building, query layer, tools, profiles, read-only guard
```
