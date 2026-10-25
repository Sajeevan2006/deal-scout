export function cosineSimilarity(vectorA: number[], vectorB: number[]): number {
  if (vectorA.length !== vectorB.length) {
    throw new Error(
      `cosineSimilarity: vector lengths differ (${vectorA.length} vs ${vectorB.length}). Were these made by different embedders?`,
    );
  }
  let dotProduct = 0;
  let squaredNormA = 0;
  let squaredNormB = 0;
  for (let index = 0; index < vectorA.length; index += 1) {
    const valueA = vectorA[index]!;
    const valueB = vectorB[index]!;
    dotProduct += valueA * valueB;
    squaredNormA += valueA * valueA;
    squaredNormB += valueB * valueB;
  }
  if (squaredNormA === 0 || squaredNormB === 0) {
    return 0;
  }
  return dotProduct / (Math.sqrt(squaredNormA) * Math.sqrt(squaredNormB));
}
