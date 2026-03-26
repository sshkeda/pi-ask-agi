# ask-agi

Escalate hard problems to frontier models through Telegram. You are the API layer.

The current Pi model compiles an optimal prompt in the foreground, sends it to Telegram, and injects the frontier response back into Pi when you reply.

## Install

```bash
pi install git+https://github.com/sshkeda/ask-agi.git
```

## Setup

### 1. Create a Telegram bot

1. Message [@BotFather](https://t.me/BotFather) → `/newbot`
2. Save the bot token

### 2. Get your chat ID

1. Message [@userinfobot](https://t.me/userinfobot) → `/start`
2. Save the numeric ID

### 3. Set environment variables

```bash
export ASK_AGI_TELEGRAM_BOT_TOKEN="your-bot-token"
export ASK_AGI_TELEGRAM_CHAT_ID="your-chat-id"
```

Add these to your shell config (e.g. `~/.zshrc`) so they persist.

### 4. Start your bot

Open your bot in Telegram and press **Start** (or send any message).

## Usage

The Pi model calls `ask_agi` when it decides escalation would help:

```
question: "What to ask the frontier model"
context:  "All relevant code, errors, constraints"
```

### What happens

1. Pi compiles the prompt using the target model's official prompting guide
2. Sends it to Telegram (short prompts as text, long prompts as `.txt` files)
3. Returns immediately — you can keep chatting with Pi
4. You paste the prompt into GPT-5.4 / Claude / etc.
5. You **reply directly** to the Telegram message with the frontier response
6. Pi injects the response back into the conversation

### Commands

| Command | Description |
|---------|-------------|
| `/ask-agi-status` | Show active requests |

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `question` | Yes* | The core question for the frontier model |
| `context` | No | All relevant context the frontier model needs |
| `target_model` | No | Model ID (default: `gpt-5.4`) |
| `output_format` | No | `prose`, `code`, `structured`, `diff` |
| `reasoning_depth` | No | `standard`, `deep`, `exhaustive` |
| `prompt` | No* | Advanced: skip compilation and send this exact prompt |

\* Either `question` or `prompt` is required.

## Configuration

Models are configured in `~/.ask-agi/config.json` (auto-created on first run):

```json
{
  "defaultModel": "gpt-5.4",
  "models": [
    {
      "id": "gpt-5.4",
      "name": "GPT-5.4",
      "guideUrl": "https://developers.openai.com/docs/guides/prompt-guidance.md"
    },
    {
      "id": "claude",
      "name": "Claude",
      "guideUrl": "https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices.md"
    }
  ]
}
```

Add models by appending to the `models` array with a `guideUrl` pointing to the provider's official prompting guide.

## How it works

- **Foreground**: Pi fetches the target model's official prompting guide and uses the current model to compile an optimal prompt
- **Background**: The prompt is sent to Telegram and Pi waits for a reply
- **Reply matching**: Uses Telegram's reply-to-message threading — reply directly to the prompt message/file
- **Multiple requests**: Each request has its own listener; a shared polling loop prevents update races
- **Document support**: Replies can be plain text or `.txt` file attachments

## License

MIT
