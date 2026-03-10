# Marvin — Claude Code Guide

## What it is

Marvin is a Discord bot that sends a motivational quote every day at 6:00 AM (Warsaw timezone) and responds to user messages throughout the day. It uses multiple AI models — OpenAI (GPT-5) as the primary, Grok as an alternative, and Perplexity for questions that require internet access.

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
| `CHANNEL_ID` | Channel ID where the bot sends morning quotes |
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

## Architecture — Message Flow

```
[node-cron 6:00 Warsaw]
        ↓
    index.ts → OpenAi.interact(quotePromptFactory) → generates quote
        ↓
    new DiscordServce(quote)
        ↓
    client "ready" → MODEL.contextInteract([system, firstUserMessage])
        ↓
    channel.send(message)  ← morning greeting message


[Discord: user sends a message]
        ↓
    discord.ts "messageCreate"
        ↓
    contextService.pushWithLimit(userResponse, channelId)  ← always stored
        ↓
    [does message mention @Marvin or reply to Marvin?]
        ├── NO → end
        └── YES → decider.contextInteract([DECIDER_SYSTEM_PROMPT, ...context])
                        ↓
                [does response contain "PERPLEXITY"?]
                    ├── YES → perplexity.contextInteract(context)
                    │         → MODEL.contextInteract([system, ...context, perplexityResult])
                    └── NO  → MODEL.contextInteract([system, ...context])
                                    ↓
                            contextService.pushWithLimit(response)
                                    ↓
                            message.reply(response)
                                    ↓
                            contextService.saveContextToFile("context.json")
```

## Key Files

| File | Role |
|---|---|
| `src/index.ts` | Entry point — cron + initialization |
| `src/services/discord.ts` | Main bot logic — message routing |
| `src/services/context.ts` | Per-channel conversation memory (max 30 messages) |
| `src/services/openai.ts` | OpenAI API wrapper — `interact()` and `contextInteract()` |
| `src/services/grok.ts` | Grok/X.ai API wrapper |
| `src/services/perplexity.ts` | Perplexity API wrapper (internet access) |
| `src/utils/prompts.ts` | All system prompts and prompt factories |
| `src/utils/helpers.ts` | Utilities: `pushWithLimit`, `mapGlobalNameNameToRealName`, `exceptionHandler` |
| `src/utils/consts.ts` | Model name constants: `DEFAULT_MODEL_NAME`, `QUOTE_MODEL_NAME` |

## How to Add a New AI Service

1. Create `src/services/newai.ts` following the `openai.ts` pattern — needs `interact()` and `contextInteract()` methods
2. Add the API key to `.env` and `.env.example`
3. Import and instantiate the service in `discord.ts`
4. Add routing logic in the `decider` flow or as a new branch in `messageCreate`

## Gotchas

- **Context limit:** `ContextService.pushWithLimit` stores max **30 messages** per channel (FIFO). Changing this affects memory and API cost.
- **Quote deduplication:** `quotesArray` keeps max 10 previous quotes to prevent repetition.
- **`MODEL` is a constant** in `discord.ts` pointing to the `openai` instance. To switch the main model, change the `MODEL` object or the value in `consts.ts`.
- **`decider`** uses a separate `OpenAi` instance (not Grok) — its model can be changed independently.
- **`context.json`** — conversation history file. Loaded on startup, saved after every bot reply. Delete it to reset Marvin's memory.
- **`WITH_INIT_MESSAGE = false`** in `index.ts` — when `false`, the bot starts without sending a morning message (silent restart mode).
- **Discord reply limit:** responses are trimmed to 1950 characters (`substring(0, 1950)`).

## Discord globalName → Real Name Mapping

`mapGlobalNameNameToRealName` in `helpers.ts` maps Discord usernames to real first names prepended to messages in context. If a username is not on the list, the Proxy returns the username itself as a fallback.

## Tests

```bash
npm test
# src/services/__tests__/date.test.ts — date formatting
# src/utils/__tests__/helpers.test.ts — pushWithLimit
```
