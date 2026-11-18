// Minimal Telegram Bot API client over fetch. Only the methods Deal Scout uses.

export type FetchFunction = (url: string, init: RequestInit) => Promise<Response>;

export interface InlineButton {
  text: string;
  callback_data: string;
}

export type InlineKeyboard = InlineButton[][];

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface BotCommand {
  command: string;
  description: string;
}

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly errorCode: number | null,
    readonly description: string,
  ) {
    super(`Telegram ${method} failed${errorCode === null ? "" : ` (${errorCode})`}: ${description}`);
    this.name = "TelegramApiError";
  }
}

export interface TelegramApi {
  sendMessage(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<TelegramMessage>;
  editMessageText(chatId: number, messageId: number, text: string, keyboard?: InlineKeyboard): Promise<void>;
  editMessageReplyMarkup(chatId: number, messageId: number, keyboard: InlineKeyboard | null): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  sendChatAction(chatId: number, action: "typing"): Promise<void>;
  setWebhook(url: string, secretToken: string): Promise<void>;
  setMyCommands(commands: BotCommand[]): Promise<void>;
  getWebhookInfo(): Promise<unknown>;
}

function replyMarkup(keyboard: InlineKeyboard | null | undefined): Record<string, unknown> {
  if (keyboard === undefined) {
    return {};
  }
  return { reply_markup: { inline_keyboard: keyboard ?? [] } };
}

export function createTelegramApi(botToken: string, fetchFn: FetchFunction = (url, init) => fetch(url, init)): TelegramApi {
  const baseUrl = `https://api.telegram.org/bot${botToken}`;

  async function call<Result>(method: string, body: Record<string, unknown>): Promise<Result> {
    const response = await fetchFn(`${baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let payload: { ok?: boolean; result?: unknown; description?: string; error_code?: number };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      throw new TelegramApiError(method, response.status, "response was not JSON");
    }
    if (!payload.ok) {
      throw new TelegramApiError(method, payload.error_code ?? response.status, payload.description ?? "unknown error");
    }
    return payload.result as Result;
  }

  // Pressing a button twice makes Telegram refuse an edit that changes nothing; that's fine
  async function callIgnoringUnchanged(method: string, body: Record<string, unknown>): Promise<void> {
    try {
      await call(method, body);
    } catch (error) {
      if (error instanceof TelegramApiError && error.description.includes("message is not modified")) {
        return;
      }
      throw error;
    }
  }

  return {
    sendMessage(chatId, text, keyboard) {
      return call<TelegramMessage>("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...replyMarkup(keyboard),
      });
    },
    editMessageText(chatId, messageId, text, keyboard) {
      return callIgnoringUnchanged("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...replyMarkup(keyboard),
      });
    },
    editMessageReplyMarkup(chatId, messageId, keyboard) {
      return callIgnoringUnchanged("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, ...replyMarkup(keyboard) });
    },
    async answerCallbackQuery(callbackQueryId, text) {
      await call("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
    },
    async sendChatAction(chatId, action) {
      await call("sendChatAction", { chat_id: chatId, action });
    },
    async setWebhook(url, secretToken) {
      await call("setWebhook", {
        url,
        secret_token: secretToken,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true,
      });
    },
    async setMyCommands(commands) {
      await call("setMyCommands", { commands });
    },
    getWebhookInfo() {
      return call<unknown>("getWebhookInfo", {});
    },
  };
}
