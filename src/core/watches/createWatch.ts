import type { DealScoutConfig } from "../config";
import { ensureUser, insertWatch } from "../db/queries";
import type { Database } from "../ports/database";
import type { Embedder } from "../ports/embedder";
import type { WatchPlanner } from "../ports/watchPlanner";
import type { Clock, Watch } from "../types";
import { parseCreateWatchInput } from "./watchTools";

export interface CreateWatchDeps {
  db: Database;
  planner: WatchPlanner;
  embedder: Embedder;
  clock: Clock;
  config: Pick<DealScoutConfig, "defaultHighThreshold" | "defaultLowThreshold">;
}

export async function createWatch(userId: string, userRequest: string, deps: CreateWatchDeps): Promise<Watch> {
  const trimmedRequest = userRequest.trim();
  if (trimmedRequest.length === 0) {
    throw new Error("Watch request is empty");
  }
  const rawPlan = await deps.planner.planWatch(trimmedRequest);
  const plan = parseCreateWatchInput(rawPlan);

  // Embedded once here, then reused on every feed check
  const embeddings = await deps.embedder.embed([plan.intentDescription]);
  const intentEmbedding = embeddings[0];
  if (intentEmbedding === undefined) {
    throw new Error("Embedder returned no vector for the watch");
  }

  const createdAt = deps.clock.now().toISOString();
  await ensureUser(deps.db, userId, userId, createdAt);
  const highThreshold = deps.config.defaultHighThreshold;
  const lowThreshold = deps.config.defaultLowThreshold;
  const watchId = await insertWatch(deps.db, { userId, plan, intentEmbedding, highThreshold, lowThreshold, createdAt });

  return {
    ...plan,
    id: watchId,
    userId,
    intentEmbedding,
    highThreshold,
    lowThreshold,
    active: true,
    createdAt,
  };
}
