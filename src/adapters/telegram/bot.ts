import type { DealScoutConfig } from "../../core/config";
import {
  claimTelegramUpdate,
  deactivateWatch,
  getAppState,
  getWatch,
  listWatchesForUser,
  OWNER_CHAT_ID_KEY,
  setAppState,
} from "../../core/db/queries";
import { recordAlertFeedback } from "../../core/feedback/recordFeedback";
import type { Database } from "../../core/ports/database";
import type { Embedder } from "../../core/ports/embedder";
import type { WatchPlanner } from "../../core/ports/watchPlanner";
import type { Clock, Logger } from "../../core/types";
import { createWatch } from "../../core/watches/createWatch";
import { constantTimeEqual } from "../security";
import type { TelegramApi, TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from "./api";
import {
  escapeHtml,
  feedbackKeyboard,
  formatCreatedWatch,
  formatWatchList,
  HELP_TEXT,
  parseCallbackData,
} from "./format";

// Single owner bot: the first chat that sends /start <PAIRING_CODE> owns it, everyone else is
// turned away. Watches made from Telegram belong to the owner user.
export const OWNER_USER_ID = "owner";

export interface TelegramBotDeps {
  db: Database;
  api: TelegramApi;
  pairingCode: string | undefined;
  planner: WatchPlanner;
  embedder: Embedder;
  clock: Clock;
  logger: Logger;
  config: DealScoutConfig;
}

interface ParsedCommand {
  command: string | null;
  argument: string;
}

// "/remove@MyBot 3" -> { command: "remove", argument: "3" }; plain text has no command
export function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  const match = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) {
    return { command: null, argument: trimmed };
  }
  return { command: match[1]!.toLowerCase(), argument: (match[2] ?? "").trim() };
}

export async function getOwnerChatId(db: Database): Promise<number | null> {
  const stored = await getAppState(db, OWNER_CHAT_ID_KEY);
  if (stored === null) {
    return null;
  }
  const chatId = Number(stored);
  return Number.isSafeInteger(chatId) ? chatId : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function handlePairing(message: TelegramMessage, code: string, ownerChatId: number | null, deps: TelegramBotDeps) {
  const chatId = message.chat.id;
  if (ownerChatId === chatId) {
    await deps.api.sendMessage(chatId, `You're already paired.\n\n${HELP_TEXT}`);
    return;
  }
  if (ownerChatId !== null) {
    await deps.api.sendMessage(chatId, "This is a private Deal Scout bot and it already has an owner.");
    return;
  }
  if (!deps.pairingCode) {
    await deps.api.sendMessage(chatId, "This bot isn't set up yet: its owner needs to set the PAIRING_CODE secret.");
    return;
  }
  if (code.length === 0 || !constantTimeEqual(code, deps.pairingCode)) {
    await deps.api.sendMessage(chatId, "Send <code>/start &lt;pairing code&gt;</code> with the PAIRING_CODE you set when deploying.");
    return;
  }
  await setAppState(deps.db, OWNER_CHAT_ID_KEY, String(chatId), deps.clock.now().toISOString());
  deps.logger.info(`Telegram: paired with owner chat ${chatId}`);
  await deps.api.sendMessage(chatId, `🎉 Paired! Alerts will come to this chat.\n\n${HELP_TEXT}`);
}

async function handleCreateWatch(chatId: number, request: string, deps: TelegramBotDeps) {
  if (request.length === 0) {
    await deps.api.sendMessage(chatId, "Tell me what to watch for, like <i>/watch air fryer under $100</i>.");
    return;
  }
  await deps.api.sendChatAction(chatId, "typing").catch(() => {});
  try {
    const watch = await createWatch(OWNER_USER_ID, request, {
      db: deps.db,
      planner: deps.planner,
      embedder: deps.embedder,
      clock: deps.clock,
      config: deps.config,
    });
    const { text, keyboard } = formatCreatedWatch(watch);
    await deps.api.sendMessage(chatId, text, keyboard);
  } catch (error) {
    deps.logger.error(`Telegram: creating a watch failed: ${describeError(error)}`);
    await deps.api.sendMessage(chatId, `Couldn't create that watch: ${escapeHtml(describeError(error))}`);
  }
}

async function handleRemove(chatId: number, argument: string, deps: TelegramBotDeps) {
  const watchId = Number(argument.replace(/^#/, ""));
  if (!Number.isInteger(watchId) || watchId <= 0) {
    const { text, keyboard } = formatWatchList(await listWatchesForUser(deps.db, OWNER_USER_ID, true));
    await deps.api.sendMessage(chatId, `Which one? Use <code>/remove &lt;id&gt;</code> or a button below.\n\n${text}`, keyboard);
    return;
  }
  const watch = await getWatch(deps.db, watchId);
  if (watch === null || watch.userId !== OWNER_USER_ID || !(await deactivateWatch(deps.db, watchId))) {
    await deps.api.sendMessage(chatId, `No active watch #${watchId}.`);
    return;
  }
  await deps.api.sendMessage(chatId, `Stopped watching #${watchId} <b>${escapeHtml(watch.label)}</b>.`);
}

async function handleOwnerMessage(message: TelegramMessage, deps: TelegramBotDeps) {
  const chatId = message.chat.id;
  const { command, argument } = parseCommand(message.text ?? "");
  if (command === null || command === "watch") {
    await handleCreateWatch(chatId, argument, deps);
  } else if (command === "list") {
    const { text, keyboard } = formatWatchList(await listWatchesForUser(deps.db, OWNER_USER_ID, true));
    await deps.api.sendMessage(chatId, text, keyboard);
  } else if (command === "remove" || command === "stop") {
    await handleRemove(chatId, argument, deps);
  } else {
    await deps.api.sendMessage(chatId, HELP_TEXT);
  }
}

async function handleMessage(message: TelegramMessage, deps: TelegramBotDeps) {
  if (typeof message.text !== "string" || message.text.trim().length === 0) {
    return;
  }
  const ownerChatId = await getOwnerChatId(deps.db);
  const { command, argument } = parseCommand(message.text);
  if (command === "start") {
    await handlePairing(message, argument, ownerChatId, deps);
    return;
  }
  if (ownerChatId === null) {
    await deps.api.sendMessage(message.chat.id, "This bot isn't paired yet. Send <code>/start &lt;pairing code&gt;</code>.");
    return;
  }
  if (message.chat.id !== ownerChatId) {
    await deps.api.sendMessage(message.chat.id, "This is a private Deal Scout bot.");
    return;
  }
  await handleOwnerMessage(message, deps);
}

async function handleCallback(callback: TelegramCallbackQuery, deps: TelegramBotDeps) {
  const ownerChatId = await getOwnerChatId(deps.db);
  const message = callback.message;
  if (ownerChatId === null || message === undefined || message.chat.id !== ownerChatId) {
    await deps.api.answerCallbackQuery(callback.id, "Not allowed");
    return;
  }
  const action = parseCallbackData(callback.data);
  if (action.kind === "feedback") {
    try {
      const outcome = await recordAlertFeedback(
        deps.db,
        action.alertId,
        action.rating,
        deps.clock.now().toISOString(),
        deps.config.thresholdTuning,
      );
      await deps.api.editMessageReplyMarkup(message.chat.id, message.message_id, feedbackKeyboard(action.alertId, action.rating));
      let reply = action.rating === "up" ? "Thanks, noted 👍" : "Thanks, noted 👎";
      if (outcome.suggestion?.changed) {
        reply += ` This watch is now stricter (threshold ${outcome.suggestion.highThreshold}).`;
      }
      await deps.api.answerCallbackQuery(callback.id, reply);
    } catch (error) {
      deps.logger.error(`Telegram: feedback failed: ${describeError(error)}`);
      await deps.api.answerCallbackQuery(callback.id, `Couldn't save that: ${describeError(error)}`);
    }
    return;
  }
  if (action.kind === "remove") {
    const watch = await getWatch(deps.db, action.watchId);
    const removed = watch !== null && watch.userId === OWNER_USER_ID && (await deactivateWatch(deps.db, action.watchId));
    if (removed) {
      await deps.api.editMessageReplyMarkup(message.chat.id, message.message_id, null);
      await deps.api.sendMessage(message.chat.id, `Stopped watching #${action.watchId} <b>${escapeHtml(watch.label)}</b>.`);
    }
    await deps.api.answerCallbackQuery(callback.id, removed ? "Watch removed" : "That watch is already gone");
    return;
  }
  await deps.api.answerCallbackQuery(callback.id);
}

export async function handleTelegramUpdate(update: TelegramUpdate, deps: TelegramBotDeps): Promise<void> {
  if (typeof update.update_id !== "number") {
    return;
  }
  // Telegram retries deliveries, so each update is handled once
  if (!(await claimTelegramUpdate(deps.db, update.update_id, deps.clock.now().toISOString()))) {
    return;
  }
  if (update.callback_query) {
    await handleCallback(update.callback_query, deps);
  } else if (update.message) {
    await handleMessage(update.message, deps);
  }
}
