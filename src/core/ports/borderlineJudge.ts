import type { Post, Watch } from "../types";

export interface BorderlineJudge {
  // TODO(integration): small LLM yes/no check for scores between the thresholds
  isMatch(post: Post, watch: Watch): Promise<boolean>;
}
