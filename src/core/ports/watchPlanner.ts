import type { WatchPlan } from "../types";

export interface WatchPlanner {
  // Turns a free text request ("portable charger under $40, no cables") into a watch plan
  planWatch(userRequest: string): Promise<WatchPlan>;
}
