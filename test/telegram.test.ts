import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTelegramApi, TelegramApiError, type TelegramApi, type TelegramUpdate } from "../src/adapters/telegram/api";
import {
  handleTelegramUpdate,
  MAX_PAIRING_ATTEMPTS_PER_DAY,
  OWNER_USER_ID,
  parseCommand,
  type TelegramBotDeps,
} from "../src/adapters/telegram/bot";
import { escapeHtml, formatAlertMessage, parseCallbackData } from "../src/adapters/telegram/format";
import { buildConfig, FAKE_EMBEDDING_MODEL, silentLogger } from "../src/core/config";
import { claimAlert, getAppState, getWatch, listActiveWatches, OWNER_CHAT_ID_KEY, setAppState } from "../src/core/db/queries";
import type { Clock } from "../src/core/types";
import { createRuleWatchPlanner } from "../src/core/watches/rulePlanner";
import { createFakeEmbedder } from "../src/local/fakeEmbedder";
import { openSqliteDatabase, type SqliteDatabase } from "../src/local/sqliteDatabase";
import { fixturesDir, makePost, makeWatch } from "./helpers";

const migrationsDir = path.join(fixturesDir, "..", "..", "migrations");
const OWNER_CHAT = 1001;
const STRANGER_CHAT = 2002;

const fixedClock: Clock = {
  now() {
    return new Date("2026-10-26T12:00:00.000Z");
  },
  async sleep() {},
};

interface Sent {
  method: string;
  chatId?: number;
  text?: string;
  keyboard?: unknown;
  callbackText?: string;
}

function fakeApi(): TelegramApi & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    async sendMessage(chatId, text, keyboard) {
      sent.push({ method: "sendMessage", chatId, text, keyboard });
      return { message_id: sent.length, chat: { id: chatId, type: "private" } };
    },
    async editMessageText(chatId, _messageId, text, keyboard) {
      sent.push({ method: "editMessageText", chatId, text, keyboard });
    },
    async editMessageReplyMarkup(chatId, _messageId, keyboard) {
      sent.push({ method: "editMessageReplyMarkup", chatId, keyboard });
    },
    async answerCallbackQuery(_id, text) {
      sent.push({ method: "answerCallbackQuery", ...(text === undefined ? {} : { callbackText: text }) });
    },
    async sendChatAction(chatId) {
      sent.push({ method: "sendChatAction", chatId });
    },
    async setWebhook() {},
    async setMyCommands() {},
    async getWebhookInfo() {
      return {};
    },
  };
}

let db: SqliteDatabase;
let api: ReturnType<typeof fakeApi>;
let nextUpdateId: number;

function deps(overrides: Partial<TelegramBotDeps> = {}): TelegramBotDeps {
  return {
    db,
    api,
    pairingCode: "secret-code",
    planner: createRuleWatchPlanner(),
    embedder: createFakeEmbedder(),
    clock: fixedClock,
    logger: silentLogger,
    config: buildConfig(),
    ...overrides,
  };
}

function message(chatId: number, text: string): TelegramUpdate {
  nextUpdateId += 1;
  return { update_id: nextUpdateId, message: { message_id: nextUpdateId, chat: { id: chatId, type: "private" }, text } };
}

function callback(chatId: number, data: string): TelegramUpdate {
  nextUpdateId += 1;
  return {
    update_id: nextUpdateId,
    callback_query: {
      id: `cb${nextUpdateId}`,
      from: { id: chatId },
      data,
      message: { message_id: 77, chat: { id: chatId, type: "private" } },
    },
  };
}

async function pairOwner(): Promise<void> {
  await setAppState(db, OWNER_CHAT_ID_KEY, String(OWNER_CHAT), "2026-10-26T00:00:00.000Z");
}

function lastText(): string {
  const messages = api.sent.filter((entry) => entry.method === "sendMessage");
  return messages[messages.length - 1]?.text ?? "";
}

beforeEach(() => {
  db = openSqliteDatabase(":memory:", migrationsDir);
  api = fakeApi();
  nextUpdateId = 0;
});

afterEach(() => {
  db.close();
});

describe("pairing", () => {
  it("pairs the first chat with the right code", async () => {
    await handleTelegramUpdate(message(OWNER_CHAT, "/start secret-code"), deps());
    expect(await getAppState(db, OWNER_CHAT_ID_KEY)).toBe(String(OWNER_CHAT));
    expect(lastText()).toMatch(/Paired/);
  });

  it("refuses a wrong or missing code", async () => {
    await handleTelegramUpdate(message(OWNER_CHAT, "/start wrong"), deps());
    await handleTelegramUpdate(message(OWNER_CHAT, "/start"), deps());
    expect(await getAppState(db, OWNER_CHAT_ID_KEY)).toBeNull();
    expect(lastText()).toMatch(/pairing code/);
  });

  it("explains when no pairing code is configured", async () => {
    await handleTelegramUpdate(message(OWNER_CHAT, "/start anything"), deps({ pairingCode: undefined }));
    expect(lastText()).toMatch(/PAIRING_CODE/);
    expect(await getAppState(db, OWNER_CHAT_ID_KEY)).toBeNull();
  });

  it("refuses to pair from a group chat", async () => {
    nextUpdateId += 1;
    const groupStart: TelegramUpdate = {
      update_id: nextUpdateId,
      message: { message_id: 1, chat: { id: -500, type: "group" }, text: "/start secret-code" },
    };
    await handleTelegramUpdate(groupStart, deps());
    expect(await getAppState(db, OWNER_CHAT_ID_KEY)).toBeNull();
    expect(lastText()).toMatch(/private chat/);
  });

  it("stops accepting codes after too many wrong ones in a day", async () => {
    for (let attempt = 0; attempt < MAX_PAIRING_ATTEMPTS_PER_DAY; attempt += 1) {
      await handleTelegramUpdate(message(STRANGER_CHAT, `/start guess${attempt}`), deps());
    }
    await handleTelegramUpdate(message(OWNER_CHAT, "/start secret-code"), deps());
    expect(await getAppState(db, OWNER_CHAT_ID_KEY)).toBeNull();
    expect(lastText()).toMatch(/Too many wrong pairing codes/);
  });

  it("keeps the first owner even if someone else has the code", async () => {
    await pairOwner();
    await handleTelegramUpdate(message(STRANGER_CHAT, "/start secret-code"), deps());
    expect(await getAppState(db, OWNER_CHAT_ID_KEY)).toBe(String(OWNER_CHAT));
    expect(lastText()).toMatch(/already has an owner/);
  });

  it("turns away other chats and does nothing before pairing", async () => {
    await handleTelegramUpdate(message(STRANGER_CHAT, "air fryer"), deps());
    expect(lastText()).toMatch(/isn't paired/);
    await pairOwner();
    await handleTelegramUpdate(message(STRANGER_CHAT, "air fryer"), deps());
    expect(lastText()).toMatch(/private/);
    expect(await listActiveWatches(db)).toHaveLength(0);
  });
});

describe("owner commands", () => {
  beforeEach(pairOwner);

  it("creates a watch from plain text", async () => {
    await handleTelegramUpdate(message(OWNER_CHAT, "air fryer under $100, no refurbished"), deps());
    const [watch] = await listActiveWatches(db);
    expect(watch).toMatchObject({ userId: OWNER_USER_ID, label: "air fryer", maxPrice: 100, excludeTerms: ["refurbished"] });
    expect(lastText()).toMatch(/Now watching/);
    expect(api.sent.some((entry) => entry.method === "sendChatAction")).toBe(true);
  });

  it("creates a watch with /watch and lists watches", async () => {
    await handleTelegramUpdate(message(OWNER_CHAT, "/watch@DealScoutBot portable charger"), deps());
    await handleTelegramUpdate(message(OWNER_CHAT, "/list"), deps());
    expect(lastText()).toContain("portable charger");
  });

  it("removes a watch by id and handles unknown ids", async () => {
    await handleTelegramUpdate(message(OWNER_CHAT, "air fryer"), deps());
    const [watch] = await listActiveWatches(db);
    await handleTelegramUpdate(message(OWNER_CHAT, `/remove ${watch!.id}`), deps());
    expect(await listActiveWatches(db)).toHaveLength(0);
    expect(lastText()).toMatch(/Stopped watching/);
    await handleTelegramUpdate(message(OWNER_CHAT, "/remove 999"), deps());
    expect(lastText()).toMatch(/No active watch #999/);
  });

  it("reports a failed watch creation instead of crashing", async () => {
    const brokenEmbedder = {
      model: "x",
      async embed(): Promise<number[][]> {
        throw new Error("AI <down>");
      },
    };
    await handleTelegramUpdate(message(OWNER_CHAT, "air fryer"), deps({ embedder: brokenEmbedder }));
    expect(lastText()).toBe("Couldn't create that watch: AI &lt;down&gt;");
  });

  it("shows help for unknown commands", async () => {
    await handleTelegramUpdate(message(OWNER_CHAT, "/whatever"), deps());
    expect(lastText()).toMatch(/Deal Scout/);
  });

  it("handles each update id once", async () => {
    const update = message(OWNER_CHAT, "air fryer");
    await handleTelegramUpdate(update, deps());
    await handleTelegramUpdate(update, deps());
    expect(await listActiveWatches(db)).toHaveLength(1);
  });
});

describe("buttons", () => {
  beforeEach(pairOwner);

  async function addWatchAndAlert(): Promise<{ watchId: number; alertId: number }> {
    await handleTelegramUpdate(message(OWNER_CHAT, "air fryer"), deps());
    const [watch] = await listActiveWatches(db);
    const alertId = (await claimAlert(db, watch!.id, "post-1", 0.7, false, "2026-10-26T12:00:00.000Z", watch!.embeddingModel))!;
    return { watchId: watch!.id, alertId };
  }

  it("records feedback and marks the chosen button", async () => {
    const { alertId } = await addWatchAndAlert();
    await handleTelegramUpdate(callback(OWNER_CHAT, `fb:${alertId}:down`), deps());
    const edit = api.sent.find((entry) => entry.method === "editMessageReplyMarkup")!;
    expect(JSON.stringify(edit.keyboard)).toContain("✅ 👎");
    expect(api.sent[api.sent.length - 1]!.callbackText).toMatch(/noted/);
    const row = await db.prepare("SELECT rating FROM feedback WHERE alert_id = ?").bind(alertId).first<{ rating: string }>();
    expect(row?.rating).toBe("down");
  });

  it("raises the threshold after enough thumbs down", async () => {
    const { watchId } = await addWatchAndAlert();
    const before = (await getWatch(db, watchId))!.highThreshold;
    for (const postId of ["a", "b", "c"]) {
      // Just above the threshold: alerts the user keeps rejecting
      const alertId = (await claimAlert(db, watchId, postId, before + 0.01, false, "2026-10-26T12:00:00.000Z", FAKE_EMBEDDING_MODEL))!;
      await handleTelegramUpdate(callback(OWNER_CHAT, `fb:${alertId}:down`), deps());
    }
    expect(api.sent[api.sent.length - 1]!.callbackText).toMatch(/stricter/);
    expect((await getWatch(db, watchId))!.highThreshold).toBeGreaterThan(before);
  });

  it("ignores thumbs down on alerts scored by an older embedding model", async () => {
    const { watchId } = await addWatchAndAlert();
    const before = (await getWatch(db, watchId))!.highThreshold;
    for (const postId of ["a", "b", "c"]) {
      const alertId = (await claimAlert(db, watchId, postId, before + 0.01, false, "2026-10-26T12:00:00.000Z", "old/model"))!;
      await handleTelegramUpdate(callback(OWNER_CHAT, `fb:${alertId}:down`), deps());
    }
    expect((await getWatch(db, watchId))!.highThreshold).toBe(before);
  });

  it("removes a watch from its button", async () => {
    const { watchId } = await addWatchAndAlert();
    await handleTelegramUpdate(callback(OWNER_CHAT, `rm:${watchId}`), deps());
    expect(await listActiveWatches(db)).toHaveLength(0);
    expect(api.sent[api.sent.length - 1]!.callbackText).toBe("Watch removed");
  });

  it("ignores button presses from other chats", async () => {
    const { alertId } = await addWatchAndAlert();
    await handleTelegramUpdate(callback(STRANGER_CHAT, `fb:${alertId}:up`), deps());
    expect(api.sent[api.sent.length - 1]!.callbackText).toBe("Not allowed");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM feedback").first<{ n: number }>()).toEqual({ n: 0 });
  });
});

describe("formatting", () => {
  it("escapes HTML in alerts and links", () => {
    const watch = makeWatch({ label: "Chargers <fast>" });
    const post = makePost({ title: "[A&B] Charger <b>$10</b>", link: 'https://x.dev/?a=1&b="2"' });
    const { text, keyboard } = formatAlertMessage({
      alertId: 5,
      post,
      watch,
      score: 0.8123,
      store: "A&B",
      price: 10,
      priceUnknown: false,
      tags: ["YMMV"],
      usedJudge: true,
    });
    expect(text).toContain("Chargers &lt;fast&gt;");
    expect(text).toContain('href="https://x.dev/?a=1&amp;b=&quot;2&quot;"');
    expect(text).toContain("[A&amp;B] Charger &lt;b&gt;$10&lt;/b&gt;");
    expect(text).toContain("$10.00");
    expect(text).toContain("AI checked");
    expect(keyboard[0]!.map((button) => button.callback_data)).toEqual(["fb:5:up", "fb:5:down"]);
  });

  it("parses commands and callback data", () => {
    expect(parseCommand("/remove@Bot 3")).toEqual({ command: "remove", argument: "3" });
    expect(parseCommand("  air fryer ")).toEqual({ command: null, argument: "air fryer" });
    expect(parseCallbackData("fb:12:up")).toEqual({ kind: "feedback", alertId: 12, rating: "up" });
    expect(parseCallbackData("rm:4")).toEqual({ kind: "remove", watchId: 4 });
    expect(parseCallbackData("fb:x:up")).toEqual({ kind: "unknown" });
    expect(escapeHtml(`<&">`)).toBe("&lt;&amp;&quot;&gt;");
  });
});

describe("Telegram API client", () => {
  it("posts JSON to the bot URL and returns the result", async () => {
    const requests: { url: string; body: any }[] = [];
    const fetchFn = async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 9, chat: { id: 1, type: "private" } } }));
    };
    const client = createTelegramApi("123:abc", fetchFn);
    const sentMessage = await client.sendMessage(1, "<b>hi</b>", [[{ text: "x", callback_data: "y" }]]);
    expect(sentMessage.message_id).toBe(9);
    expect(requests[0]!.url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    expect(requests[0]!.body).toMatchObject({ chat_id: 1, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "x", callback_data: "y" }]] } });

    await client.setWebhook("https://w.dev/telegram/webhook", "s3cret");
    expect(requests[1]!.body).toMatchObject({ secret_token: "s3cret", allowed_updates: ["message", "callback_query"] });
  });

  it("throws Telegram's error, but ignores 'message is not modified' on edits", async () => {
    const failing = createTelegramApi("t", async () => new Response(JSON.stringify({ ok: false, error_code: 403, description: "Forbidden: bot was blocked" })));
    await expect(failing.sendMessage(1, "x")).rejects.toThrow(TelegramApiError);
    const unchanged = createTelegramApi(
      "t",
      async () => new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message is not modified" })),
    );
    await expect(unchanged.editMessageReplyMarkup(1, 2, null)).resolves.toBeUndefined();
  });
});
