import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

// Rough CPU check for the Workers free plan (10 ms of CPU per invocation).
// A cron run usually lands on a cold isolate, so the first call matters most.
// Node runs the same V8 engine as Workers, so this is a fair proxy, not an exact number.
// Real numbers: Cloudflare dashboard -> Workers -> deal-scout -> Metrics -> CPU time.

const { values: flags } = parseArgs({
  options: {
    watches: { type: "string", default: "20" },
    dimensions: { type: "string", default: "768" },
  },
});
const watchCount = Number(flags.watches);
const dimensions = Number(flags.dimensions);

const importStart = performance.now();
const { parseFeed } = await import("../src/core/feed/parseFeed");
const { silentLogger } = await import("../src/core/config");
const { cosineSimilarity } = await import("../src/core/matching/similarity");
const { applyHardFilters } = await import("../src/core/matching/filters");
const { buildMatchText } = await import("../src/core/matching/postText");
const { decodeEmbedding, encodeEmbedding } = await import("../src/core/matching/vectors");
const importMs = performance.now() - importStart;

const xml = readFileSync(new URL("../test/fixtures/hot-deals-feed.xml", import.meta.url), "utf8");

function randomVector(): number[] {
  const vector: number[] = [];
  for (let index = 0; index < dimensions; index += 1) {
    vector.push(Math.random() - 0.5);
  }
  return vector;
}

function timeIt(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

let posts: ReturnType<typeof parseFeed> = [];
const coldParseMs = timeIt(() => {
  posts = parseFeed(xml, silentLogger);
});
const watches = Array.from({ length: watchCount }, (_, index) => ({
  id: index + 1,
  userId: "bench",
  label: "bench",
  intentDescription: "bench",
  intentEmbedding: Float32Array.from(randomVector()),
  embeddingModel: "bench",
  maxPrice: 40,
  excludeTerms: ["cable", "refurbished"],
  stores: [],
  highThreshold: 0.8,
  lowThreshold: 0.6,
  active: true,
  createdAt: "",
}));
// What D1 and Workers AI hand back: stored embedding text, and JSON from the embedding model
const storedEmbeddings = watches.map((watch) => encodeEmbedding(watch.intentEmbedding));
const embeddingResponseJson = JSON.stringify({ shape: [posts.length, dimensions], data: posts.map(() => randomVector()) });

function matchAll(): void {
  for (const stored of storedEmbeddings) {
    decodeEmbedding(stored);
  }
  const response = JSON.parse(embeddingResponseJson) as { data: number[][] };
  for (const [postIndex, post] of posts.entries()) {
    buildMatchText(post, 300);
    for (const watch of watches) {
      cosineSimilarity(response.data[postIndex]!, watch.intentEmbedding);
      applyHardFilters(post, watch);
    }
  }
}

const coldMatchMs = timeIt(matchAll);
const rounds = 100;
let warmParseTotal = 0;
let warmMatchTotal = 0;
for (let round = 0; round < rounds; round += 1) {
  warmParseTotal += timeIt(() => parseFeed(xml, silentLogger));
  warmMatchTotal += timeIt(matchAll);
}

console.log(`Feed: ${posts.length} posts, ${xml.length} bytes. Watches: ${watchCount}, ${dimensions} dimensions.`);
console.log(`module load        ${importMs.toFixed(2)} ms (startup, not counted per run by Workers)`);
console.log(`parse   cold       ${coldParseMs.toFixed(2)} ms   warm ${(warmParseTotal / rounds).toFixed(2)} ms`);
console.log(`match   cold       ${coldMatchMs.toFixed(2)} ms   warm ${(warmMatchTotal / rounds).toFixed(2)} ms`);
console.log(`worst case per run ~${(coldParseMs + coldMatchMs).toFixed(2)} ms of a 10 ms budget (all ${posts.length} posts new, every watch scored)`);
