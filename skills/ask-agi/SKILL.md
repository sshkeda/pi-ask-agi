---
name: ask-agi
description: >
  Escalate hard problems to frontier models (GPT-5.4, Claude, etc.) through the
  user as middleware. You compile the paste-ready prompt yourself, ask_agi delivers
  it via Telegram, and injects the frontier reply back into Pi later.
  Triggers on: "ask agi", "escalate", "ask gpt", "ask claude", "frontier model".
version: 1.1.0
license: MIT
---

# ask-agi

Use `ask_agi` when escalation to a stronger model would materially help.

## How to call it

You are the prompt compiler. Write the full, paste-ready prompt yourself and pass it as `prompt`:

1. Include all relevant files, code, errors, constraints, and goals in the prompt
2. The frontier model has ZERO access to this Pi session — include everything it needs
3. Call `ask_agi` with the compiled `prompt`
4. ask_agi sends it to Telegram and injects the reply back when it arrives

## Parameters

- `prompt` (required): The full, paste-ready prompt for the frontier model
- `question` (optional): Short summary for display/tracking in the widget
- `target_model` (optional): Model ID. Default: `gpt-5.4`. Configured in `~/.ask-agi/config.json`
- `channel` (optional): `telegram` | `auto`

## When to use it

Use ask_agi for:
- hard reasoning, formal proofs, math
- subtle security or concurrency bugs
- architecture decisions with competing tradeoffs
- specialized knowledge you lack

Avoid ask_agi for:
- simple lookups
- straightforward edits
- tasks you can finish confidently without escalation

## Telegram setup

Requires:
- `ASK_AGI_TELEGRAM_BOT_TOKEN`
- `ASK_AGI_TELEGRAM_CHAT_ID`
