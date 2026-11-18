import { thresholdsFor, type DealScoutConfig } from "../config";
import { updateWatchEmbedding } from "../db/queries";
import { toEmbedding } from "../matching/vectors";
import type { Database } from "../ports/database";
import type { Embedder } from "../ports/embedder";
import type { Logger, Watch } from "../types";

// Re-embeds any watch whose vector came from a different embedding model than the one in use
// (after switching models, or watches made with the offline fake embedder). Thresholds go back
// to the new model's defaults, since scores from one model mean nothing for another.
export async function refreshStaleEmbeddings(
  db: Database,
  watches: Watch[],
  embedder: Embedder,
  config: Pick<DealScoutConfig, "thresholdsByEmbeddingModel" | "defaultHighThreshold" | "defaultLowThreshold">,
  logger: Logger,
): Promise<Watch[]> {
  const staleWatches = watches.filter((watch) => watch.embeddingModel !== embedder.model);
  if (staleWatches.length === 0) {
    return watches;
  }
  const vectors = await embedder.embed(staleWatches.map((watch) => watch.intentDescription));
  if (vectors.length !== staleWatches.length) {
    throw new Error(`Embedder returned ${vectors.length} vectors for ${staleWatches.length} watches`);
  }
  const thresholds = thresholdsFor(config, embedder.model);
  const refreshedById = new Map<number, Watch>();
  for (const [index, watch] of staleWatches.entries()) {
    const intentEmbedding = toEmbedding(vectors[index]!);
    await updateWatchEmbedding(db, watch.id, intentEmbedding, embedder.model, thresholds.high, thresholds.low);
    refreshedById.set(watch.id, {
      ...watch,
      intentEmbedding,
      embeddingModel: embedder.model,
      highThreshold: thresholds.high,
      lowThreshold: thresholds.low,
    });
    logger.info(`Re-embedded watch #${watch.id} "${watch.label}" with ${embedder.model} (was ${watch.embeddingModel})`);
  }
  return watches.map((watch) => refreshedById.get(watch.id) ?? watch);
}
