import type { DealAlert } from "../types";

export interface Notifier {
  // TODO(integration): Telegram bot message goes behind this
  sendAlert(alert: DealAlert): Promise<void>;
}
