import { runFeedCheck } from "../core/pipeline/runFeedCheck";
import { buildDepsFromEnv, type Env } from "./deps";
import { handleRequest, type DepsBuilder, type ExecutionContextLike } from "./routes";

// Cloudflare Worker entry point.
// - scheduled: the cron trigger (every 10 minutes) checks the feed
// - fetch: the Telegram webhook and the admin API (see README)

export interface ScheduledEventLike {
  cron: string;
  scheduledTime: number;
}

export function createWorker(buildDeps: DepsBuilder) {
  return {
    fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
      return handleRequest(request, env, ctx, buildDeps);
    },

    async scheduled(event: ScheduledEventLike, env: Env, _ctx: ExecutionContextLike): Promise<void> {
      const deps = buildDeps(env);
      const summary = await runFeedCheck(deps);
      const line = `Scheduled check (${event.cron}): ${summary.message}`;
      if (summary.outcome === "error" || summary.outcome === "blocked") {
        deps.logger.error(line);
      } else {
        deps.logger.info(line);
      }
    },
  };
}

export default createWorker(buildDepsFromEnv);

export type { Env } from "./deps";
