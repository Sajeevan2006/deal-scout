import type { DealAlert } from "../types";

export interface Notifier {
  // Telegram when configured, logs otherwise
  sendAlert(alert: DealAlert): Promise<void>;
}
