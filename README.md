# Marvin - Motivational Discord Bot

Marvin is a Discord bot that sends a daily motivational quote every morning at 6:00 AM (Warsaw time) and answers questions from server members using multiple AI models.

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
├── index.ts               Entry point — cron scheduler, quote generation
├── services/
│   ├── discord.ts         Bot logic — message handling and AI routing
│   ├── context.ts         Per-channel conversation memory (max 30 messages)
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

1. **Every day at 6 AM** — Marvin generates a unique motivational quote and sends a personalized greeting to the configured Discord channel
2. **When mentioned** (`@Marvin` or reply) — Marvin reads the conversation context, decides whether the question needs internet access (Perplexity) or can be answered from knowledge (OpenAI/Grok), and replies accordingly
3. **All messages** — stored in per-channel context (last 30 messages) persisted in `context.json`

## Adding a New AI Service

1. Create `src/services/newai.ts` with `interact()` and `contextInteract()` methods (follow `openai.ts` pattern)
2. Add your API key to `.env` and `.env.example`
3. Import and instantiate the service in `discord.ts`
4. Add routing logic — either change the `MODEL` constant or add a new branch in the decider flow

## Team Members

| Name | Role in Marvin's context |
|---|---|
| Homar | Event planner — Marvin can mention him for scheduling |
| Jacek | Highly motivated — doesn't need extra motivation |
| Domin | Runner, family man |
| Mariusz | Kubernetes expert |
| Mason | Music and fitness expert |
| Wiktor | The comedian |
| Madzia | Artist, paints, raises kids |
| Podsumowuś | Summarizes discussions on demand |

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
