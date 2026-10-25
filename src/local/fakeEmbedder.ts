import type { Embedder } from "../core/ports/embedder";

// PLACEHOLDER embedder: a hashed bag of words. It only captures word overlap, not meaning,
// so "portable charger" will NOT match "power bank". Real embeddings fix that.
// TODO(integration): replace with the Workers AI embedder (e.g. @cf/baai/bge-base-en-v1.5)

const STOP_WORDS = new Set(["the", "and", "or", "for", "with", "of", "to", "in", "on", "at", "is", "it", "this", "that", "my", "w"]);

// FNV-1a, 32 bit
function hashWord(word: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < word.length; index += 1) {
    hash ^= word.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function l2Normalize(vector: number[]): number[] {
  let squaredSum = 0;
  for (const value of vector) {
    squaredSum += value * value;
  }
  if (squaredSum === 0) {
    return vector;
  }
  const norm = Math.sqrt(squaredSum);
  const normalized: number[] = [];
  for (const value of vector) {
    normalized.push(value / norm);
  }
  return normalized;
}

export function embedTextWithHashing(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const words = text.toLowerCase().split(/[^a-z0-9]+/);
  for (const word of words) {
    if (word.length < 2 || STOP_WORDS.has(word)) {
      continue;
    }
    const bucket = hashWord(word) % dimensions;
    vector[bucket] = (vector[bucket] ?? 0) + 1;
  }
  return l2Normalize(vector);
}

export function createFakeEmbedder(dimensions = 256): Embedder {
  return {
    async embed(texts) {
      const vectors: number[][] = [];
      for (const text of texts) {
        vectors.push(embedTextWithHashing(text, dimensions));
      }
      return vectors;
    },
  };
}
