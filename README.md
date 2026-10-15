# Marvin - a Discord bot with an agent loop

Marvin is an LLM agent with tools that lives on your Discord server: it remembers every message (a searchable archive), answers questions about what was said and by whom, searches the web, reads links and images, transcribes voice messages, sets reminders, watches the air quality and posts periodic digests. The model decides itself which tool to call, in a loop, before it answers. It is sarcastic, has opinions and writes in Polish. Powered by OpenAI, running in Docker.

## What Marvin can do

Mention `@Marvin` (or reply to him) and one model loop picks the right tool for the question:

- **Remembers the whole server.** Every message goes to a local SQLite archive with full-text search. Marvin answers history questions ("what did Adam write about the holiday?", "what did we agree on?") and counts exactly ("who wrote the most?", "who sent how many voice messages?", most reacted messages, emoji statistics) with read-only tools, never with guesses.
- **Knows people.** Opt-in generated profiles of regular participants; Marvin uses them to answer "what does Ania like?" and to fit the tone of his replies.
- **Searches the web** with OpenAI's hosted web search, and **reads links** you paste (`fetch_url`, SSRF-guarded).
- **Understands images** (short descriptions by a cheap vision model) and **voice messages** (transcription, opt-in; also for the ones already in the archive).
- **Sets reminders**: "remind me on Friday at 18 about X" is delivered on time with a short comment from Marvin.
- **Watches the air quality** from a parcel-locker sensor: answers "how is the air?" and, opt-in, posts an alert to a chosen channel when it is bad (and a note when it is back to normal).
- **Posts on a schedule**: a digest of recent server activity every few days and, opt-in, a monthly statistics report with bar charts and award titles.
- **Reacts with emoji** to a small share of human messages, picked by a cheap model.

Marvin never edits or deletes anything on Discord. The bot role needs only View Channel, Read Message History, Send Messages and Add Reactions (see the read-only guard in [CLAUDE.md](CLAUDE.md)).

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Fill in all values in .env

# 3. Build and run
npm run marvin
```

## How It Works

1. **When mentioned** (`@Marvin` or reply) - Marvin reads the last 30 messages of the channel from the archive and answers. The model itself decides whether to search the archive, search the web, fetch a page, read the air sensor, set a reminder, or just answer from knowledge
2. **All messages** - archived in `data/history.db`. `HISTORY_SYNC_ENABLED=true` imports the whole server history and catches up hourly; the bot role must not have Manage Messages, Manage Channels, Manage Threads, Kick, Ban or Administrator
3. **Every `SERVER_SUMMARY_INTERVAL_DAYS` days (default 3) at 20:00 (Warsaw)** - a digest of recent server activity goes to the bots channel
4. **Person profiles** (`PROFILES_ENABLED=true`) - descriptions generated from archived messages, refreshed when a week old and enough new messages arrived
5. **Monthly statistics report** (`MONTHLY_REPORT_ENABLED=true`) - on the 1st at 20:00 (Warsaw): top authors, loudest days, busiest hour, channels, common words and phrases, with exact numbers
6. **Voice messages** (`VOICE_TRANSCRIPTION_ENABLED=true`, plus `VOICE_BACKFILL_ENABLED=true` for the archive) - transcripts are stored in the archive, so they are searchable and countable
7. **Reminders** - stored in `data/reminders.db`, delivered by a per-minute check
8. **Air quality** (`AIR_QUALITY_PAGE_URL`; alert with `AIR_QUALITY_ALERT_ENABLED=true` and `AIR_ALERT_CHANNEL_ID`) - a 30-minute check with confirmations, a cooldown and quiet hours at night
9. **Emoji reactions** - each human message has a 2% chance; needs the **Add Reactions** permission

## Configuration

Copy `.env.example` to `.env`. Optional features are off unless set to `true`: `HISTORY_SYNC_ENABLED`, `PROFILES_ENABLED`, `MONTHLY_REPORT_ENABLED`, `VOICE_TRANSCRIPTION_ENABLED`, `VOICE_BACKFILL_ENABLED`, `AIR_QUALITY_ALERT_ENABLED`. `EXCLUDED_CHANNEL_IDS` lists channels that are never archived, searched or summarized. See the environment table in [CLAUDE.md](CLAUDE.md) for every variable.

## Project Structure

```
src/
├── index.ts               Entry point - client startup, crons (summary, report, profiles, reminders, air alert)
├── services/
│   ├── discord.ts         Bot logic - message handling and routing
│   ├── openai.ts          OpenAI wrapper: tool loop, web search, vision, transcription
│   ├── history/           SQLite message archive: live write, backfill, context, read-only search tools, profiles, report
│   ├── reminders.ts       Reminder tools and delivery
│   ├── airQuality.ts      Air sensor reading and the get_air_quality tool
│   ├── airAlert.ts        Air alert rules, state and message template
│   ├── voice.ts           Voice-message transcription
│   ├── webTools.ts        fetch_url tool (scraper.ts: page text, SSRF guard)
│   ├── context.ts         In-memory fallback context
│   ├── usage.ts           Token usage statistics (data/usage.json)
│   ├── client.ts          Discord.js client factory
│   └── date.ts            Date formatting
└── utils/
    ├── prompts.ts         System prompts and prompt factories
    ├── helpers.ts         Utilities: name mapping, message splitting, error handler
    ├── emojiReaction.ts   Spontaneous emoji reactions
    ├── consts.ts          Model name constants
    └── types.ts           Shared TypeScript interfaces
```

## Staging

`make staging-restart` / `make staging-logs` run a second instance (own bot token, own data volume) for testing without touching production. `node scripts/staging-run.mjs` runs the test questions from `scripts/staging-cases.json`.

## Scripts

```bash
npm run marvin        # Build TypeScript and run
npm run marvin:build  # Build only
npm run marvin:run    # Run only (requires prior build)
npm test              # Run Jest tests
make usage            # Token usage per day and kind
```

## Docker

```bash
docker compose up --build
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for data flow diagrams and design decisions, and [CLAUDE.md](CLAUDE.md) for the details of every feature.
