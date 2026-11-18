export interface Embedder {
  // Stored with each watch, so vectors from different models are never compared
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}
