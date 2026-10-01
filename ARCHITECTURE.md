# Marvin — Architecture

## Module Map

```
src/
├── index.ts               Entry point: cron scheduler + init()
├── services/
│   ├── discord.ts         Bot logic: message routing, event handlers
│   ├── context.ts         Per-channel conversation memory
│   ├── openai.ts          OpenAI API wrapper (main model + decider)
│   ├── grok.ts            Grok/X.ai API wrapper (alternative model)
│   ├── perplexity.ts      Perplexity API wrapper (web search)
│   ├── client.ts          Discord.js client factory
│   └── date.ts            Date formatting utility
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
            ├── new ContextService({})
            │
            └── client.login(DISCORD_CLIENT_TOKEN)
                    ↓ "ready" event fires
                    ├── contextService.loadContextFromFile("context.json")
                    └── MODEL.interact(WAKE_UP_MESSAGE_PROMPT) → channel.send(wakeUpMessage)
```

The system prompt (with today's date) is built per request in `getSystemContext()`, so the date never goes stale.

## Message Routing Flow

```
Discord: user sends message
    ↓
"messageCreate" event in discord.ts
    │
    ├── author = MARVIN_USERNAME? → SKIP (ignore own messages)
    │
    └── userResponseFactory(message)
            ↓ mapGlobalNameNameToRealName lookup → "Vajrusek: text" → "Jacek: text"
            ↓
        contextService.pushWithLimit(userMessage, channelId)  ← ALL messages stored

        [message mentions @Marvin or is reply to Marvin?]
            │
            ├── NO → end
            │
            └── YES →
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
                            MODEL.contextInteract([system, ...context])
                    │
                    └── (both paths)
                            contextService.pushWithLimit(assResponse, channelId)
                            message.reply(response.substring(0, 1950))
                            contextService.saveContextToFile("context.json")
```

## Cron Schedule

```
node-cron: "0 20 * * *" (Europe/Warsaw)
    ↓
index.ts: checks days since last summary (data/last_summary.json)
    ↓
[>= SERVER_SUMMARY_INTERVAL_DAYS] client.sendServerSummary(lastSummaryAt)
```

## Data Models

```typescript
// Core message format (OpenAI-compatible)
interface Message {
    role: "system" | "user";
    content: string;
}

// Context storage structure
type ContextMap = Record<channelId: string, Message[]>
// Stored in: context.json (persisted) and ContextService.contextMap (in-memory)
// Limit: 30 messages per channel (FIFO)
```

## AI Services Comparison

| Service | Used for | Model | Internet? |
|---|---|---|---|
| `OpenAi` (MODEL) | Main responses, wake-up message, summaries | gpt-5-chat-latest | No |
| `OpenAi` (decider) | Routing decision only | gpt-5-chat-latest | No |
| `Grok` | Alternative (unused in current routing) | — | No |
| `Perplexity` | Web search queries | — | Yes |

## Key Design Decisions

1. **Decider pattern**: A separate `OpenAi` instance (`decider`) classifies each query before routing. This avoids modifying the main conversation context with routing logic.

2. **Two-step Perplexity flow**: Perplexity fetches raw internet data, then MODEL rephrases it in Marvin's voice. This preserves Marvin's personality even for web answers.

3. **FIFO context window**: `ContextService.pushWithLimit` drops the oldest message when over 30. Keeps API costs predictable and avoids stale context.

4. **File-persisted context**: `context.json` survives bot restarts. Loaded at startup, saved after every reply. Delete it to reset Marvin's memory.

5. **`MODEL` constant**: In `discord.ts`, `MODEL = openai` is a module-level constant. Swap it to `grok` to change the main responder without touching logic.
