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

interface CompiledTerm {
  term: string;
  pattern: RegExp;
}

function compileTerms(excludeTerms: string[]): CompiledTerm[] {
  const compiled: CompiledTerm[] = [];
  for (const term of excludeTerms) {
    const trimmedTerm = term.trim();
    if (trimmedTerm.length > 0) {
      compiled.push({ term: trimmedTerm, pattern: buildTermPattern(trimmedTerm) });
    }
  }
  return compiled;
}

function findCompiledTerm(text: string, compiledTerms: CompiledTerm[]): string | null {
  for (const { term, pattern } of compiledTerms) {
    if (pattern.test(text)) {
      return term;
    }
  }
  return null;
}

export function findExcludedTerm(text: string, excludeTerms: string[]): string | null {
  return findCompiledTerm(text, compileTerms(excludeTerms));
}

// Every post is checked against every watch, so per post and per watch work is done once.
// Matters for CPU on the Workers free plan (10 ms per run).
interface PostFacts {
  store: string | null;
  price: number | null;
  searchableText: string;
}

const postFactsCache = new WeakMap<Post, PostFacts>();
const watchTermsCache = new WeakMap<Watch, CompiledTerm[]>();

function factsFor(post: Post): PostFacts {
  let facts = postFactsCache.get(post);
  if (facts === undefined) {
    facts = {
      store: extractStore(post.title),
      price: pickLikelyPrice(post.title),
      searchableText: `${post.title}\n${post.bodyText}`,
    };
    postFactsCache.set(post, facts);
  }
  return facts;
}

function termsFor(watch: Watch): CompiledTerm[] {
  let terms = watchTermsCache.get(watch);
  if (terms === undefined) {
    terms = compileTerms(watch.excludeTerms);
    watchTermsCache.set(watch, terms);
  }
  return terms;
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
  const facts = factsFor(post);
  const postStore = facts.store;
  const postPrice = facts.price;

  const excludedTerm = findCompiledTerm(facts.searchableText, termsFor(watch));
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
