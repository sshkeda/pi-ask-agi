# Design

## Architecture

```
Pi model ──compile prompt──► ask_agi ──send──► Telegram ──reply──► Pi inject
  (orchestrator)              (delivery)   (background)         (follow-up)
```

## Constraints

- No frontier API calls — the human is the transport layer
- The orchestrator (Pi model) compiles the prompt — ask_agi is a pure delivery tool
- Telegram delivery and reply waiting happen in the background (non-blocking)
- Configurable model registry with user-defined defaults

## Telegram transport

- One shared `getUpdates` polling loop per bot/chat pair
- Per-request listeners receive messages from the shared loop
- Reply matching requires Telegram reply-to-message threading
- Supports both text replies and `.txt` document replies
- No automatic timeout — requests wait indefinitely until replied to or Pi restarts

## Prompt compilation

The orchestrator (the Pi model calling the tool) compiles the prompt itself before
calling ask_agi. This avoids any dependency on API keys within the extension — the
orchestrator already has working auth. The compiled prompt is passed via the `prompt`
parameter and sent to Telegram as-is.

## Response injection

When a Telegram reply arrives:
- If Pi is idle: `sendUserMessage(content)` triggers a new turn
- If Pi is busy: `sendUserMessage(content, { deliverAs: "followUp" })` queues it
