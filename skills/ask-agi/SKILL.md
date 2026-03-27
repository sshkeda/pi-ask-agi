---
name: ask-agi
description: >
  Escalate hard problems to GPT-5-4 Pro through the user as middleware.
  You compile the paste-ready prompt yourself (following the official prompting
  guide), ask_agi delivers it via Telegram, and injects the reply back into Pi.
  Triggers on: "ask agi", "escalate", "ask gpt", "frontier model".
version: 1.2.0
license: MIT
---

# ask-agi

Use `ask_agi` when escalation to a stronger model would materially help.

## How to call it

You are the prompt compiler. Before calling ask_agi:

1. **Fetch the prompting guide** at `https://developers.openai.com/docs/guides/prompt-guidance.md` using `fetch_page`
2. **Write the full, paste-ready prompt** following the guide's best practices
3. The frontier model has ZERO access to this Pi session — include all relevant files, code, errors, constraints, and goals
4. Call `ask_agi` with the compiled `prompt`
5. ask_agi sends it as a `.txt` file to Telegram and injects the reply back when it arrives

## Parameters

- `prompt` (required): The full, paste-ready prompt for GPT-5-4 Pro
- `question` (optional): Short summary for display/tracking in the widget
- `target_model` (optional): Default: `gpt-5-4-pro`
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
