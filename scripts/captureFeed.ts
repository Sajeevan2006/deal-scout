import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { getFeedState, saveFeedValidators } from "../src/core/db/queries";
import { parseFeed } from "../src/core/feed/parseFeed";
import { recordFetchAttempt } from "../src/core/pipeline/runFeedCheck";
import type { FeedState } from "../src/core/types";
import { createLiveFeedSource } from "../src/local/liveFeedSource";
import {
  captureFileName,
  captureStateKey,
  capturesDir,
  fixtureFeedPath,
  loadLocalConfig,
  openLocalDatabase,
  projectRoot,
} from "../src/local/localSetup";

const { values: flags } = parseArgs({ options: { force: { type: "boolean", default: false } } });

const config = loadLocalConfig();
const db = openLocalDatabase();

try {
  const mainState = await getFeedState(db, config.feedUrl);
  const captureState = await getFeedState(db, captureStateKey(config.feedUrl));
  // Guard info comes from the shared row, validators from the capture row
  const fetchState: FeedState = {
    ...mainState,
    etag: captureState.etag,
    lastModified: captureState.lastModified,
  };

  const feedSource = createLiveFeedSource(config, { force: flags.force });
  const result = await feedSource.fetchLatest(fetchState);
  await recordFetchAttempt(db, config.feedUrl, result, config);

  if (result.outcome === "ok") {
    await mkdir(capturesDir, { recursive: true });
    const capturePath = path.join(capturesDir, captureFileName(new Date()));
    await writeFile(capturePath, result.xml, "utf8");
    await saveFeedValidators(db, captureStateKey(config.feedUrl), result.etag, result.lastModified);
    const posts = parseFeed(result.xml);
    console.log(`Saved ${path.relative(projectRoot, capturePath)} (${result.xml.length} bytes, ${posts.length} posts)`);
    console.log(`ETag: ${result.etag ?? "(none)"}  Last-Modified: ${result.lastModified ?? "(none)"}`);
    if (!existsSync(fixtureFeedPath)) {
      await mkdir(path.dirname(fixtureFeedPath), { recursive: true });
      await copyFile(capturePath, fixtureFeedPath);
      console.log(`Copied to ${path.relative(projectRoot, fixtureFeedPath)} for tests`);
    }
  } else if (result.outcome === "not_modified") {
    console.log("Feed unchanged since the last capture, nothing saved.");
  } else if (result.outcome === "blocked") {
    console.error(`Capture blocked: status ${result.status}, final URL ${result.finalUrl}. ${result.message}`);
    process.exitCode = 2;
  } else {
    console.error(`Capture did not run: ${result.outcome}`);
    process.exitCode = 1;
  }
} finally {
  db.close();
}
