import type { ThresholdTuningConfig } from "../config";
import {
  getAlert,
  getWatch,
  insertFeedback,
  listFeedbackForWatch,
  updateWatchHighThreshold,
  type AlertRecord,
} from "../db/queries";
import type { Database } from "../ports/database";
import type { FeedbackRating, Watch } from "../types";
import { suggestThreshold, type ThresholdSuggestion } from "./tuneThreshold";

export interface FeedbackOutcome {
  alert: AlertRecord;
  watch: Watch | null;
  previousHighThreshold: number | null;
  suggestion: ThresholdSuggestion | null;
}

// Records a thumbs up or down and lets the watch's high threshold react to it.
// Used by the CLI, the admin API and the Telegram buttons.
export async function recordAlertFeedback(
  db: Database,
  alertId: number,
  rating: FeedbackRating,
  createdAt: string,
  tuning: ThresholdTuningConfig,
): Promise<FeedbackOutcome> {
  const alert = await getAlert(db, alertId);
  if (alert === null) {
    throw new Error(`No alert #${alertId}`);
  }
  await insertFeedback(db, alertId, rating, createdAt);
  const watch = await getWatch(db, alert.watchId);
  if (watch === null) {
    return { alert, watch: null, previousHighThreshold: null, suggestion: null };
  }
  const feedback = await listFeedbackForWatch(db, watch.id, watch.embeddingModel);
  const suggestion = suggestThreshold(watch, feedback, tuning);
  if (suggestion.changed) {
    await updateWatchHighThreshold(db, watch.id, suggestion.highThreshold);
  }
  return { alert, watch, previousHighThreshold: watch.highThreshold, suggestion };
}

export function describeFeedbackOutcome(outcome: FeedbackOutcome, rating: FeedbackRating): string {
  const parts = [`Recorded thumbs ${rating} for alert #${outcome.alert.id} (score ${outcome.alert.score.toFixed(3)}).`];
  if (outcome.watch !== null && outcome.suggestion !== null) {
    if (outcome.suggestion.changed) {
      parts.push(
        `Watch #${outcome.watch.id} high threshold ${outcome.previousHighThreshold} -> ${outcome.suggestion.highThreshold} (${outcome.suggestion.reason}).`,
      );
    } else {
      parts.push(`Watch #${outcome.watch.id} high threshold stays at ${outcome.watch.highThreshold} (${outcome.suggestion.reason}).`);
    }
  }
  return parts.join(" ");
}
