import type { FilterRejection, Post, Watch } from "../types";
import { extractStore, pickLikelyPrice } from "./postText";

export type FilterResult =
  | { passed: true; postPrice: number | null; postStore: string | null }
  | { passed: false; rejection: FilterRejection; detail: string; postPrice: number | null; postStore: string | null };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// "cables" also catches "cable", and the other way round
function buildTermPattern(term: string): RegExp {
  const lowered = term.toLowerCase();
  let stem = lowered;
  if (lowered.length > 3 && lowered.endsWith("s")) {
    stem = lowered.slice(0, -1);
  }
  return new RegExp(`(?<![a-z0-9])${escapeRegExp(stem)}s?(?![a-z0-9])`, "i");
}

export function findExcludedTerm(text: string, excludeTerms: string[]): string | null {
  for (const term of excludeTerms) {
    const trimmedTerm = term.trim();
    if (trimmedTerm.length === 0) {
      continue;
    }
    if (buildTermPattern(trimmedTerm).test(text)) {
      return trimmedTerm;
    }
  }
  return null;
}

// "Amazon.ca", "amazon" and "Amazon.com" all compare as "amazon"
export function normalizeStoreName(store: string): string {
  const lowered = store.toLowerCase().trim();
  const withoutDomain = lowered.replace(/\.(ca|com)$/, "");
  return withoutDomain.replace(/[^a-z0-9]/g, "");
}

function storeIsAllowed(postStore: string | null, allowedStores: string[]): boolean {
  if (postStore === null) {
    return false;
  }
  const normalizedPostStore = normalizeStoreName(postStore);
  for (const allowedStore of allowedStores) {
    if (normalizeStoreName(allowedStore) === normalizedPostStore) {
      return true;
    }
  }
  return false;
}

export function applyHardFilters(post: Post, watch: Watch): FilterResult {
  const postStore = extractStore(post.title);
  const postPrice = pickLikelyPrice(post.title);

  const searchableText = `${post.title}\n${post.bodyText}`;
  const excludedTerm = findExcludedTerm(searchableText, watch.excludeTerms);
  if (excludedTerm !== null) {
    return {
      passed: false,
      rejection: "exclude_term",
      detail: `contains excluded term "${excludedTerm}"`,
      postPrice,
      postStore,
    };
  }

  if (watch.stores.length > 0 && !storeIsAllowed(postStore, watch.stores)) {
    return {
      passed: false,
      rejection: "store",
      detail: `store ${postStore ?? "(none)"} not in ${watch.stores.join(", ")}`,
      postPrice,
      postStore,
    };
  }

  if (watch.maxPrice !== null && postPrice !== null && postPrice > watch.maxPrice) {
    return {
      passed: false,
      rejection: "over_max_price",
      detail: `price $${postPrice} is over max $${watch.maxPrice}`,
      postPrice,
      postStore,
    };
  }

  return { passed: true, postPrice, postStore };
}
