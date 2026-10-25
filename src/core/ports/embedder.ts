export interface Embedder {
  // TODO(integration): Workers AI embedding model goes behind this
  embed(texts: string[]): Promise<number[][]>;
}
