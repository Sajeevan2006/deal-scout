# Telegram

> **In progress, may not work as expected.** The bot logic, webhook check and buttons are covered by tests against a
> mocked Telegram API, but a real bot hasn't been tested end to end yet (webhook registration, message formatting,
> button callbacks). If something misbehaves, alerts are still in `npm run logs`, and
> `npm run remote -- telegram:status` shows Telegram's last webhook error.

## Set it up

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot` and follow the prompts. It gives you a
   bot token like `123456789:AA...`.
2. Store the token, plus a webhook secret of your choice (letters, digits, `_` and `-` only):

   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
   ```

3. Register the webhook and the bot's command menu. The Worker makes these calls itself, so the token never leaves
   Cloudflare:

   ```bash
   npm run telegram:setup
   ```

4. Open your bot and send `/start <your PAIRING_CODE>`. That chat becomes the owner. Every other chat is turned away.
5. Send what you're looking for, like `air fryer under $100`.

## Using the bot

| Message | What it does |
| --- | --- |
| any text, or `/watch <text>` | Create a watch |
| `/list` | Your watches, with remove buttons |
| `/remove <id>` | Stop a watch |
| `/help` | How it works |
| 👍 / 👎 on an alert | Rate it. Once 3 alerts that scored near or below a watch's threshold get 👎, the threshold moves just above the highest of them |

## Moving it to another chat

```bash
npm run remote -- telegram:unpair
```

Then send `/start <PAIRING_CODE>` from the new chat.

## How it stays private

- Telegram sends `TELEGRAM_WEBHOOK_SECRET` in a header with every update, and the Worker rejects anything without it.
- Only the paired owner chat can create watches or press buttons. Pairing only works from a private chat, and only 10
  wrong pairing codes are accepted per day.
- Each update is handled once, even if Telegram delivers it twice.
- The Worker answers Telegram right away and does the slow LLM work afterwards, so Telegram doesn't retry.
