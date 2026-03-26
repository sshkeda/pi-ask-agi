---
name: ask-agi
description: >
  Escalate hard problems to frontier models (GPT-5.4, Claude, etc.) through the
  user as middleware. ask_agi fetches the official prompting guide, compiles a
  paste-ready prompt, shows native Pi review UI, and collects the pasted response.
  Triggers on: "ask agi", "escalate", "ask gpt", "ask claude", "frontier model".
version: 1.0.0
license: MIT
---

# ask-agi

Use `ask_agi` when escalation to a stronger model would materially help.

## How to call it

Prefer passing `question` + `context`. ask_agi handles the rest:

- fetches the target model's official prompting guide
- compiles the prompt using the current Pi model
- sends it to Telegram
- injects the frontier reply back into Pi when it arrives

## Parameters

- `question` (required*): The core question for the frontier model
- `context` (optional): All relevant context the frontier model needs
- `target_model` (optional): Model ID. Default: `gpt-5.4`. Configured in `~/.ask-agi/config.json`
- `output_format` (optional): `prose` | `code` | `structured` | `diff`
- `reasoning_depth` (optional): `standard` | `deep` | `exhaustive`
- `prompt` (optional*): Advanced override — skip compilation and send this exact prompt

\* Either `question` or `prompt` is required.

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
