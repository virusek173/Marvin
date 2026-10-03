# Marvin - Motivational Discord Bot

Marvin is a Discord bot that answers questions from server members using multiple AI models and posts a periodic server summary.

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

## Project Structure

```
src/
├── index.ts               Entry point — client startup, crons (summary, monthly report, profiles)
├── services/
│   ├── discord.ts         Bot logic — message handling and AI routing
│   ├── context.ts         In-memory FIFO context (fallback only)
│   ├── history/           SQLite message archive: live write, backfill, context, read-only search tools, profiles, monthly report
│   ├── openai.ts          OpenAI API wrapper (primary AI + decider)
│   ├── grok.ts            Grok/X.ai API wrapper
│   ├── perplexity.ts      Perplexity API wrapper (real-time web search)
│   ├── client.ts          Discord.js client factory
│   └── date.ts            Date formatting
└── utils/
    ├── prompts.ts         System prompts and prompt factories
    ├── helpers.ts         Utilities: pushWithLimit, name mapping, error handler
    ├── consts.ts          Model name constants
    └── types.ts           Shared TypeScript interfaces
```

## How It Works

1. **Every `SERVER_SUMMARY_INTERVAL_DAYS` days (default 3) at 20:00 (Warsaw)** — Marvin posts a digest of recent server activity to the bots channel
2. **When mentioned** (`@Marvin` or reply) — Marvin reads the conversation context, decides whether the question needs internet access (Perplexity) or can be answered from knowledge (OpenAI/Grok), and replies accordingly
3. **All messages** — archived in a local SQLite database (`data/history.db`); the last 30 messages of a channel are the conversation context
4. **History questions** ("what did Jacek write about the holiday?", "who wrote the most?", "what does Madzia like?") — Marvin uses read-only tools over the archive: full-text search, time ranges, surrounding messages and whole conversations, exact statistics (counts by author, channel, day, hour...) and generated person profiles. Set `HISTORY_SYNC_ENABLED=true` to import the whole server history; the bot role must not have Manage Messages, Manage Channels, Manage Threads, Kick, Ban or Administrator
5. **Person profiles** (opt-in, `PROFILES_ENABLED=true`) — short descriptions of each regular participant (and the other bots), generated from their archived messages and refreshed when they are a week old and enough new messages arrived
6. **Monthly statistics report** (opt-in, `MONTHLY_REPORT_ENABLED=true`) — on the 1st of the month at 20:00 (Warsaw) Marvin posts the previous month's report to the bots channel: top authors, loudest days, busiest hour, channels, most common words and phrases as bar charts with exact numbers, plus his commentary and award titles. `MONTHLY_REPORT_FORCE_MONTH=YYYY-MM` posts a chosen month once at startup (for testing)

## Configuration

Copy `.env.example` to `.env`. Optional switches (all off unless set to `true`): `HISTORY_SYNC_ENABLED`, `PROFILES_ENABLED`, `MONTHLY_REPORT_ENABLED`. `EXCLUDED_CHANNEL_IDS` lists channels that are never archived, searched or summarized. See the environment table in [CLAUDE.md](CLAUDE.md) for every variable.

## Staging

`make staging-restart` / `make staging-logs` run a second instance (own bot token, own data volume) for testing without touching production.

## Adding a New AI Service

1. Create `src/services/newai.ts` with `interact()` and `contextInteract()` methods (follow `openai.ts` pattern)
2. Add your API key to `.env` and `.env.example`
3. Import and instantiate the service in `discord.ts`
4. Add routing logic — either change the `MODEL` constant or add a new branch in the decider flow

## Scripts

```bash
npm run marvin        # Build TypeScript and run
npm run marvin:build  # Build only
npm run marvin:run    # Run only (requires prior build)
npm test              # Run Jest tests
```

## Docker

```bash
docker compose up --build
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for data flow diagrams and design decisions.
