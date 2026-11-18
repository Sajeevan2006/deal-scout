import type { Notifier } from "../core/ports/notifier";
import type { DealAlert } from "../core/types";

// Local CLI notifier: prints to the terminal. The Worker sends to Telegram instead.

function formatPrice(alert: DealAlert): string {
  if (alert.price === null) {
    return "unknown";
  }
  return `$${alert.price.toFixed(2)}`;
}

export function formatAlert(alert: DealAlert): string {
  const tagsText = alert.tags.length > 0 ? alert.tags.join(", ") : "none";
  const judgeText = alert.usedJudge ? " (judge approved)" : "";
  const lines = [
    "",
    `=== Deal match #${alert.alertId} for "${alert.watch.label}" ===`,
    `  ${alert.post.title}`,
    `  Store: ${alert.store ?? "unknown"}   Price: ${formatPrice(alert)}   Score: ${alert.score.toFixed(3)}${judgeText}`,
    `  Tags: ${tagsText}`,
    `  ${alert.post.link}`,
    `  Feedback: npm run feedback -- ${alert.alertId} up|down`,
    "",
  ];
  return lines.join("\n");
}

export function createConsoleNotifier(write: (text: string) => void = console.log): Notifier {
  return {
    async sendAlert(alert) {
      write(formatAlert(alert));
    },
  };
}
