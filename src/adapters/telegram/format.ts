import type { DealAlert, FeedbackRating, Watch } from "../../core/types";
import type { InlineKeyboard } from "./api";

// Messages use Telegram's HTML parse mode, so every piece of outside text is escaped

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function feedbackCallbackData(alertId: number, rating: FeedbackRating): string {
  return `fb:${alertId}:${rating}`;
}

export function removeCallbackData(watchId: number): string {
  return `rm:${watchId}`;
}

export type CallbackAction =
  | { kind: "feedback"; alertId: number; rating: FeedbackRating }
  | { kind: "remove"; watchId: number }
  | { kind: "unknown" };

export function parseCallbackData(data: string | undefined): CallbackAction {
  const feedbackMatch = /^fb:(\d+):(up|down)$/.exec(data ?? "");
  if (feedbackMatch) {
    return { kind: "feedback", alertId: Number(feedbackMatch[1]), rating: feedbackMatch[2] as FeedbackRating };
  }
  const removeMatch = /^rm:(\d+)$/.exec(data ?? "");
  if (removeMatch) {
    return { kind: "remove", watchId: Number(removeMatch[1]) };
  }
  return { kind: "unknown" };
}

export function feedbackKeyboard(alertId: number, chosen: FeedbackRating | null = null): InlineKeyboard {
  return [
    [
      { text: chosen === "up" ? "✅ 👍 Good match" : "👍 Good match", callback_data: feedbackCallbackData(alertId, "up") },
      { text: chosen === "down" ? "✅ 👎 Not for me" : "👎 Not for me", callback_data: feedbackCallbackData(alertId, "down") },
    ],
  ];
}

function formatPrice(price: number): string {
  return `$${price.toFixed(2)}`;
}

export function formatAlertMessage(alert: DealAlert): { text: string; keyboard: InlineKeyboard } {
  const details: string[] = [];
  details.push(`🏪 ${escapeHtml(alert.store ?? "Unknown store")}`);
  details.push(`💲 ${alert.price === null ? "price unknown" : formatPrice(alert.price)}`);
  details.push(`🎯 ${alert.score.toFixed(2)}${alert.usedJudge ? " (AI checked)" : ""}`);
  const lines = [
    `🔔 <b>${escapeHtml(alert.watch.label)}</b>`,
    `<a href="${escapeHtml(alert.post.link)}">${escapeHtml(alert.post.title)}</a>`,
    details.join("  ·  "),
  ];
  if (alert.tags.length > 0) {
    lines.push(`🏷 ${escapeHtml(alert.tags.join(", "))}`);
  }
  return { text: lines.join("\n"), keyboard: feedbackKeyboard(alert.alertId) };
}

export function formatWatchSummary(watch: Watch): string {
  const limits = [
    `max ${watch.maxPrice === null ? "any price" : formatPrice(watch.maxPrice)}`,
    `excludes ${watch.excludeTerms.length > 0 ? watch.excludeTerms.join(", ") : "nothing"}`,
    `stores ${watch.stores.length > 0 ? watch.stores.join(", ") : "any"}`,
  ];
  return `#${watch.id} <b>${escapeHtml(watch.label)}</b>\n<i>${escapeHtml(limits.join(" · "))}</i>`;
}

export function formatCreatedWatch(watch: Watch): { text: string; keyboard: InlineKeyboard } {
  const description = watch.intentDescription.length > 300 ? `${watch.intentDescription.slice(0, 297)}...` : watch.intentDescription;
  const text = [`✅ Now watching:`, formatWatchSummary(watch), "", escapeHtml(description)].join("\n");
  return { text, keyboard: [[{ text: "🗑 Remove", callback_data: removeCallbackData(watch.id) }]] };
}

export function formatWatchList(watches: Watch[]): { text: string; keyboard: InlineKeyboard } {
  if (watches.length === 0) {
    return { text: "No watches yet. Send me what you're looking for, like <i>portable charger under $40</i>.", keyboard: [] };
  }
  const text = [`<b>Your watches</b>`, ...watches.map(formatWatchSummary)].join("\n\n");
  const keyboard = watches.map((watch) => [{ text: `🗑 Remove #${watch.id} ${watch.label}`.slice(0, 60), callback_data: removeCallbackData(watch.id) }]);
  return { text, keyboard };
}

export const HELP_TEXT = [
  "<b>Deal Scout</b> watches the RedFlagDeals Hot Deals feed for you.",
  "",
  "Send what you're looking for as a normal message, for example:",
  "<i>portable charger under $40, no cables</i>",
  "",
  "/list – your watches",
  "/remove &lt;id&gt; – stop a watch",
  "/watch &lt;text&gt; – same as sending a normal message",
  "/help – this message",
  "",
  "Use 👍 / 👎 on alerts. Enough 👎 makes that watch stricter.",
].join("\n");

export const BOT_COMMANDS = [
  { command: "list", description: "Show your watches" },
  { command: "watch", description: "Watch for something, e.g. /watch air fryer under $100" },
  { command: "remove", description: "Stop a watch: /remove <id>" },
  { command: "help", description: "How Deal Scout works" },
];
