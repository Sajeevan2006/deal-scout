// Embeddings are stored as base64 float32 bytes instead of JSON number arrays.
// A 768 dimension vector is ~4 KB this way vs ~15 KB of JSON, and decoding it costs far less
// CPU than JSON.parse, which matters with only 10 ms of CPU per run on the Workers free plan.
// Byte order is the platform's (little endian on every machine and Workers host we target).

const FLOAT32_PREFIX = "f32:";

export function toEmbedding(values: ArrayLike<number>): Float32Array {
  return values instanceof Float32Array ? values : Float32Array.from(values);
}

export function encodeEmbedding(values: ArrayLike<number>): string {
  const floats = toEmbedding(values);
  const bytes = new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
  let binary = "";
  const chunkSize = 0x2000;
  for (let start = 0; start < bytes.length; start += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunkSize));
  }
  return FLOAT32_PREFIX + btoa(binary);
}

// Also reads the JSON arrays older databases stored
export function decodeEmbedding(stored: string): Float32Array {
  if (stored.startsWith(FLOAT32_PREFIX)) {
    const binary = atob(stored.slice(FLOAT32_PREFIX.length));
    if (binary.length % 4 !== 0) {
      throw new Error("Stored embedding has a broken length");
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Float32Array(bytes.buffer);
  }
  const parsed: unknown = JSON.parse(stored);
  if (!Array.isArray(parsed)) {
    throw new Error("Stored embedding is not an array");
  }
  const values = new Float32Array(parsed.length);
  for (const [index, item] of parsed.entries()) {
    if (typeof item !== "number") {
      throw new Error("Stored embedding has a non number value");
    }
    values[index] = item;
  }
  return values;
}
