# Design

## Architecture

```
Pi model ──compile──► ask_agi ──send──► Telegram ──reply──► Pi inject
  (foreground)                    (background)          (follow-up)
```

## Constraints

- No frontier API calls — the human is the transport layer
- Prompt construction happens in the foreground (blocking)
- Telegram delivery and reply waiting happen in the background (non-blocking)
- Official provider prompting guides are the source of truth for prompt formatting
- Configurable model registry with user-defined defaults

## Telegram transport

- One shared `getUpdates` polling loop per bot/chat pair
- Per-request listeners receive messages from the shared loop
- Reply matching requires Telegram reply-to-message threading
- Supports both text replies and `.txt` document replies
- No automatic timeout — requests wait indefinitely until replied to or Pi restarts

## Prompt compilation

The current Pi model compiles the frontier prompt by:
1. Fetching the target model's official prompting guide (live URL)
2. Building a compiler input with the question, context, output format, and reasoning depth
3. Calling the current model with a system prompt that instructs it to follow the guide

## Response injection

When a Telegram reply arrives:
- If Pi is idle: `sendUserMessage(content)` triggers a new turn
- If Pi is busy: `sendUserMessage(content, { deliverAs: "followUp" })` queues it
