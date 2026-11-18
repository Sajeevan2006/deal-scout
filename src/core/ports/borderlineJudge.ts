import type { Post, Watch } from "../types";

export interface BorderlineJudge {
  // Asked only for scores between a watch's low and high thresholds
  isMatch(post: Post, watch: Watch): Promise<boolean>;
}
