import { thresholdsFor, type DealScoutConfig } from "../config";
import { ensureUser, insertWatch } from "../db/queries";
import { toEmbedding } from "../matching/vectors";
import type { Database } from "../ports/database";
import type { Embedder } from "../ports/embedder";
import type { WatchPlanner } from "../ports/watchPlanner";
import type { Clock, Watch } from "../types";
import { parseWatchPlan } from "./watchPlan";

export interface CreateWatchDeps {
  db: Database;
  planner: WatchPlanner;
  embedder: Embedder;
  clock: Clock;
  config: Pick<DealScoutConfig, "thresholdsByEmbeddingModel" | "defaultHighThreshold" | "defaultLowThreshold">;
}

export async function createWatch(userId: string, userRequest: string, deps: CreateWatchDeps): Promise<Watch> {
  const trimmedRequest = userRequest.trim();
  if (trimmedRequest.length === 0) {
    throw new Error("Watch request is empty");
  }
  const rawPlan = await deps.planner.planWatch(trimmedRequest);
  const plan = parseWatchPlan(rawPlan);

  // Embedded once here, then reused on every feed check
  const embeddings = await deps.embedder.embed([plan.intentDescription]);
  const firstEmbedding = embeddings[0];
  if (firstEmbedding === undefined) {
    throw new Error("Embedder returned no vector for the watch");
  }
  const intentEmbedding = toEmbedding(firstEmbedding);

  const createdAt = deps.clock.now().toISOString();
  await ensureUser(deps.db, userId, userId, createdAt);
  const thresholds = thresholdsFor(deps.config, deps.embedder.model);
  const watchId = await insertWatch(deps.db, {
    userId,
    plan,
    intentEmbedding,
    embeddingModel: deps.embedder.model,
    highThreshold: thresholds.high,
    lowThreshold: thresholds.low,
    createdAt,
  });

  return {
    ...plan,
    id: watchId,
    userId,
    intentEmbedding,
    embeddingModel: deps.embedder.model,
    highThreshold: thresholds.high,
    lowThreshold: thresholds.low,
    active: true,
    createdAt,
  };
}
