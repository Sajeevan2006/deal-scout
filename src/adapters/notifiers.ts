import type { Notifier } from "../core/ports/notifier";
import type { DealAlert, Logger } from "../core/types";
import type { TelegramApi } from "./telegram/api";
import { formatAlertMessage } from "./telegram/format";

export function formatAlertForLog(alert: DealAlert): string {
  const price = alert.price === null ? "unknown" : `$${alert.price.toFixed(2)}`;
  const tags = alert.tags.length > 0 ? ` tags: ${alert.tags.join(", ")}` : "";
  return (
    `ALERT #${alert.alertId} [${alert.watch.label}] ${alert.post.title} | store ${alert.store ?? "unknown"}, ` +
    `price ${price}, score ${alert.score.toFixed(3)}${alert.usedJudge ? " (judge)" : ""}${tags} | ${alert.post.link}`
  );
}

// Used until Telegram is set up: alerts show up in `wrangler tail` and Workers Logs
export function createLogNotifier(logger: Logger): Notifier {
  return {
    async sendAlert(alert) {
      logger.info(formatAlertForLog(alert));
    },
  };
}

export function createTelegramNotifier(api: TelegramApi, chatId: number): Notifier {
  return {
    async sendAlert(alert) {
      const { text, keyboard } = formatAlertMessage(alert);
      await api.sendMessage(chatId, text, keyboard);
    },
  };
}
