import { consoleLogger } from "../core/config";
import type { BorderlineJudge } from "../core/ports/borderlineJudge";
import type { Logger } from "../core/types";

export interface StubBorderlineJudge extends BorderlineJudge {
  callCount(): number;
}

// Offline judge: always says no, but logs each call so you can see how often the LLM judge would run
export function createStubBorderlineJudge(logger: Logger = consoleLogger): StubBorderlineJudge {
  let calls = 0;
  return {
    async isMatch(post, watch) {
      calls += 1;
      logger.info(`[judge stub] borderline: "${post.title}" vs watch "${watch.label}" -> no (the LLM judge would decide here)`);
      return false;
    },
    callCount() {
      return calls;
    },
  };
}
