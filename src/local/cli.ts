import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { consoleLogger, MIN_FETCH_INTERVAL_MS, systemClock, type DealScoutConfig } from "../core/config";
import {
  deactivateWatch,
  ensureUser,
  getAlert,
  getWatch,
  insertFeedback,
  listFeedbackForWatch,
  listWatchesForUser,
  updateWatchHighThreshold,
} from "../core/db/queries";
import { suggestThreshold } from "../core/feedback/tuneThreshold";
import { runFeedCheck, type FeedCheckSummary } from "../core/pipeline/runFeedCheck";
import type { FeedSource } from "../core/ports/feedSource";
import type { FeedbackRating, Watch } from "../core/types";
import { createWatch } from "../core/watches/createWatch";
import { createConsoleNotifier } from "./consoleNotifier";
import { createFakeEmbedder } from "./fakeEmbedder";
import { createFileFeedSource } from "./fileFeedSource";
import { createLiveFeedSource } from "./liveFeedSource";
import {
  captureFileName,
  capturesDir,
  DEFAULT_LOCAL_USER_ID,
  DEFAULT_LOCAL_USER_NAME,
  loadLocalConfig,
  openLocalDatabase,
  projectRoot,
} from "./localSetup";
import type { SqliteDatabase } from "./sqliteDatabase";
import { createStubBorderlineJudge } from "./stubBorderlineJudge";
import { createStubWatchPlanner } from "./stubWatchPlanner";

const USAGE = `Usage:
  npm run watch:add -- "<request>"
  npm run watch:list
  npm run watch:remove -- <watchId>
  npm run check [-- --file <path>] [--force] [--alert-existing] [--save-captures] [--verbose]
  npm run check:loop [-- --interval-minutes <n>] [--alert-existing] [--save-captures] [--verbose]
  npm run feedback -- <alertId> up|down`;

function formatWatch(watch: Watch): string {
  const status = watch.active ? "active" : "removed";
  const maxPriceText = watch.maxPrice === null ? "-" : `$${watch.maxPrice}`;
  const excludesText = watch.excludeTerms.length > 0 ? watch.excludeTerms.join(", ") : "-";
  const storesText = watch.stores.length > 0 ? watch.stores.join(", ") : "any";
  return [
    `#${watch.id} [${status}] ${watch.label}`,
    `    intent: ${watch.intentDescription}`,
    `    max price: ${maxPriceText}   exclude: ${excludesText}   stores: ${storesText}`,
    `    thresholds: high ${watch.highThreshold}  low ${watch.lowThreshold}`,
  ].join("\n");
}

async function addWatch(db: SqliteDatabase, config: DealScoutConfig, requestWords: string[]): Promise<void> {
  const userRequest = requestWords.join(" ").trim();
  if (userRequest.length === 0) {
    throw new Error('Give the watch request, e.g. npm run watch:add -- "portable charger under $40"');
  }
  await ensureUser(db, DEFAULT_LOCAL_USER_ID, DEFAULT_LOCAL_USER_NAME, systemClock.now().toISOString());
  const watch = await createWatch(DEFAULT_LOCAL_USER_ID, userRequest, {
    db,
    planner: createStubWatchPlanner(),
    embedder: createFakeEmbedder(config.embeddingDimensions),
    clock: systemClock,
    config,
  });
  console.log("Created watch:");
  console.log(formatWatch(watch));
}

async function listWatches(db: SqliteDatabase): Promise<void> {
  const watches = await listWatchesForUser(db, DEFAULT_LOCAL_USER_ID);
  if (watches.length === 0) {
    console.log('No watches yet. Add one with npm run watch:add -- "portable charger"');
    return;
  }
  for (const watch of watches) {
    console.log(formatWatch(watch));
  }
}

function parseId(rawValue: string | undefined, name: string): number {
  const parsed = Number(rawValue);
  if (rawValue === undefined || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive whole number`);
  }
  return parsed;
}

async function removeWatch(db: SqliteDatabase, rawWatchId: string | undefined): Promise<void> {
  const watchId = parseId(rawWatchId, "watchId");
  const removed = await deactivateWatch(db, watchId);
  if (removed) {
    console.log(`Watch #${watchId} deactivated.`);
  } else {
    console.log(`No active watch #${watchId}.`);
  }
}

async function recordFeedback(db: SqliteDatabase, config: DealScoutConfig, args: string[]): Promise<void> {
  const alertId = parseId(args[0], "alertId");
  const ratingText = args[1];
  if (ratingText !== "up" && ratingText !== "down") {
    throw new Error("Rating must be up or down");
  }
  const rating: FeedbackRating = ratingText;
  const alert = await getAlert(db, alertId);
  if (alert === null) {
    throw new Error(`No alert #${alertId}`);
  }
  await insertFeedback(db, alertId, rating, systemClock.now().toISOString());
  console.log(`Recorded thumbs ${rating} for alert #${alertId} (score ${alert.score.toFixed(3)}).`);

  const watch = await getWatch(db, alert.watchId);
  if (watch === null) {
    return;
  }
  const feedback = await listFeedbackForWatch(db, watch.id);
  const suggestion = suggestThreshold(watch, feedback, config.thresholdTuning);
  if (suggestion.changed) {
    await updateWatchHighThreshold(db, watch.id, suggestion.highThreshold);
    console.log(`Watch #${watch.id} high threshold ${watch.highThreshold} -> ${suggestion.highThreshold} (${suggestion.reason}).`);
  } else {
    console.log(`Watch #${watch.id} high threshold stays at ${watch.highThreshold} (${suggestion.reason}).`);
  }
}

// Wraps a source so every fresh feed body is also saved as a capture
function withCaptureSaving(feedSource: FeedSource): FeedSource {
  return {
    feedUrl: feedSource.feedUrl,
    isLive: feedSource.isLive,
    async fetchLatest(state) {
      const result = await feedSource.fetchLatest(state);
      if (result.outcome === "ok") {
        await mkdir(capturesDir, { recursive: true });
        const capturePath = path.join(capturesDir, captureFileName(new Date()));
        await writeFile(capturePath, result.xml, "utf8");
        console.log(`Saved capture ${path.relative(projectRoot, capturePath)}`);
      }
      return result;
    },
  };
}

interface CheckFlags {
  file?: string;
  force: boolean;
  alertExisting: boolean;
  saveCaptures: boolean;
  verbose: boolean;
}

function printSummary(summary: FeedCheckSummary, verbose: boolean): void {
  if (verbose) {
    for (const decision of summary.decisions) {
      const marker = decision.shouldAlert ? "ALERT" : "skip ";
      console.log(`  ${marker} ${decision.score.toFixed(3)} [${decision.watch.label}] ${decision.post.title} (${decision.reason}: ${decision.detail})`);
    }
  }
  console.log("");
  console.log(`Check summary (${summary.outcome}${summary.firstRun ? ", first run" : ""})`);
  console.log(`  fetched ${summary.fetched}  new ${summary.newPosts}  matched ${summary.matched}  alerted ${summary.alerted}  judge calls ${summary.judgeCalls}`);
  if (summary.duplicatesSkipped > 0 || summary.failedAlerts > 0) {
    console.log(`  duplicates skipped ${summary.duplicatesSkipped}  failed alerts ${summary.failedAlerts}`);
  }
  console.log(`  ${summary.message}`);
}

async function runCheckOnce(db: SqliteDatabase, config: DealScoutConfig, flags: CheckFlags): Promise<FeedCheckSummary> {
  let feedSource: FeedSource;
  if (flags.file) {
    feedSource = createFileFeedSource(flags.file);
  } else {
    feedSource = createLiveFeedSource(config, { force: flags.force });
  }
  if (flags.saveCaptures && feedSource.isLive) {
    feedSource = withCaptureSaving(feedSource);
  }
  const judge = createStubBorderlineJudge();
  return runFeedCheck(
    {
      db,
      feedSource,
      embedder: createFakeEmbedder(config.embeddingDimensions),
      judge,
      notifier: createConsoleNotifier(),
      clock: systemClock,
      logger: consoleLogger,
      config,
    },
    { alertExisting: flags.alertExisting },
  );
}

function exitCodeFor(summary: FeedCheckSummary): number {
  if (summary.outcome === "blocked") {
    return 2;
  }
  if (summary.outcome === "error") {
    return 1;
  }
  return 0;
}

function parseCheckFlags(args: string[], allowFileAndForce: boolean) {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      file: { type: "string" },
      force: { type: "boolean", default: false },
      "alert-existing": { type: "boolean", default: false },
      "save-captures": { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      "interval-minutes": { type: "string" },
    },
  });
  if (!allowFileAndForce && (values.file !== undefined || values.force)) {
    throw new Error("check:loop only runs against the live feed and does not accept --file or --force");
  }
  const flags: CheckFlags = {
    file: values.file,
    force: values.force,
    alertExisting: values["alert-existing"],
    saveCaptures: values["save-captures"],
    verbose: values.verbose,
  };
  return { flags, intervalMinutesText: values["interval-minutes"] };
}

async function checkOnce(db: SqliteDatabase, config: DealScoutConfig, args: string[]): Promise<void> {
  const { flags } = parseCheckFlags(args, true);
  const summary = await runCheckOnce(db, config, flags);
  printSummary(summary, flags.verbose);
  process.exitCode = exitCodeFor(summary);
}

// TODO(integration): on Cloudflare the cron trigger calling worker.scheduled replaces this loop
async function checkLoop(db: SqliteDatabase, config: DealScoutConfig, args: string[]): Promise<void> {
  const { flags, intervalMinutesText } = parseCheckFlags(args, false);
  let intervalMs = config.checkIntervalMs;
  if (intervalMinutesText !== undefined) {
    const intervalMinutes = Number(intervalMinutesText);
    if (!Number.isFinite(intervalMinutes)) {
      throw new Error("--interval-minutes must be a number");
    }
    intervalMs = Math.round(intervalMinutes * 60 * 1000);
  }
  if (intervalMs < MIN_FETCH_INTERVAL_MS) {
    throw new Error(`Refusing an interval under ${MIN_FETCH_INTERVAL_MS / 60000} minutes. Be nice to RFD.`);
  }
  console.log(`Checking the live feed every ${intervalMs / 60000} minutes. Ctrl+C to stop.`);
  while (true) {
    const summary = await runCheckOnce(db, config, flags);
    printSummary(summary, flags.verbose);
    if (summary.outcome === "blocked") {
      console.error("Stopping the loop because RFD blocked the request. Not retrying.");
      process.exitCode = 2;
      return;
    }
    let waitMs = intervalMs;
    if (summary.retryInSeconds !== null) {
      const retryWaitMs = (summary.retryInSeconds + 1) * 1000;
      waitMs = Math.max(waitMs, retryWaitMs);
    }
    const nextCheckAt = new Date(Date.now() + waitMs);
    console.log(`Next check at ${nextCheckAt.toLocaleTimeString()}`);
    await systemClock.sleep(waitMs);
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }
  const config = loadLocalConfig();
  const db = openLocalDatabase();
  process.once("SIGINT", () => {
    db.close();
    process.exit(130);
  });
  try {
    if (command === "watch:add") {
      await addWatch(db, config, args);
    } else if (command === "watch:list") {
      await listWatches(db);
    } else if (command === "watch:remove") {
      await removeWatch(db, args[0]);
    } else if (command === "check") {
      await checkOnce(db, config, args);
    } else if (command === "check:loop") {
      await checkLoop(db, config, args);
    } else if (command === "feedback") {
      await recordFeedback(db, config, args);
    } else {
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
