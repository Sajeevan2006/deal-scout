import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { FeedSource } from "../core/ports/feedSource";

// Replays a saved capture, fully offline. Never touches the live guard state.
export function createFileFeedSource(filePath: string): FeedSource {
  const absolutePath = path.resolve(filePath);
  return {
    feedUrl: pathToFileURL(absolutePath).href,
    isLive: false,
    async fetchLatest() {
      const xml = await readFile(absolutePath, "utf8");
      return { outcome: "ok", xml, etag: null, lastModified: null, requestedAt: null };
    },
  };
}
