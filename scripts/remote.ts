import { parseArgs } from "node:util";
import { callAdminApi, runAdminCommand } from "./adminApi";

// Small client for the deployed Worker's admin API (WORKER_URL + ADMIN_TOKEN in .env).
// The Telegram bot token never leaves Cloudflare: the Worker makes the Telegram calls itself.

const USAGE = `Usage: npm run remote -- <command>
  status                         feed state, watches, judge usage, Telegram pairing
  watches                        list watches
  watch "<request>"              create a watch (e.g. "portable charger under $40")
  remove <id>                    stop a watch
  thresholds <id> <high> <low>   set a watch's thresholds
  check [--force] [--alert-existing]   run a feed check now (obeys the 2 minute guard unless --force)
  feedback <alertId> up|down     rate an alert
  unblock                        allow live fetches again after a block (look into why first)
  telegram:setup                 register the webhook and bot commands with Telegram
  telegram:status                webhook info and pairing state
  telegram:unpair                forget the paired chat`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    force: { type: "boolean", default: false },
    "alert-existing": { type: "boolean", default: false },
  },
});
const [command, ...args] = positionals;

function requireArg(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing ${name}.\n\n${USAGE}`);
  }
  return value;
}

await runAdminCommand(async () => {
  switch (command) {
    case "status":
      return callAdminApi("GET", "/api/status");
    case "watches":
      return callAdminApi("GET", "/api/watches");
    case "watch":
      return callAdminApi("POST", "/api/watches", { text: requireArg(args.join(" "), "request text") });
    case "remove":
      return callAdminApi("DELETE", `/api/watches/${encodeURIComponent(requireArg(args[0], "watch id"))}`);
    case "thresholds":
      return callAdminApi("POST", `/api/watches/${encodeURIComponent(requireArg(args[0], "watch id"))}/thresholds`, {
        high: Number(requireArg(args[1], "high threshold")),
        low: Number(requireArg(args[2], "low threshold")),
      });
    case "check":
      return callAdminApi("POST", "/api/check", { force: flags.force, alertExisting: flags["alert-existing"] });
    case "feedback":
      return callAdminApi("POST", "/api/feedback", {
        alertId: Number(requireArg(args[0], "alert id")),
        rating: requireArg(args[1], "rating (up or down)"),
      });
    case "unblock":
      return callAdminApi("POST", "/api/unblock");
    case "telegram:setup":
      return callAdminApi("POST", "/api/telegram/setup");
    case "telegram:status":
      return callAdminApi("GET", "/api/telegram/status");
    case "telegram:unpair":
      return callAdminApi("POST", "/api/telegram/unpair");
    default:
      throw new Error(USAGE);
  }
});
