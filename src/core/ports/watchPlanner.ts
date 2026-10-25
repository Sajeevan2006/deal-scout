import type { WatchPlan } from "../types";

export interface WatchPlanner {
  // TODO(integration): big LLM call with tool calling (see watches/watchTools.ts)
  planWatch(userRequest: string): Promise<WatchPlan>;
}
