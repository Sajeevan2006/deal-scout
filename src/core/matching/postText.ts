import type { Post } from "../types";

const DEFAULT_BODY_CHARS = 300;

// Matches $1,299.99 / $ 40 / 40$ / 1,299.99$
const PRICE_PATTERN = /\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)|(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s?\$/g;

// Words right before a price that mean "this is not the sale price"
const NOT_SALE_PRICE_BEFORE =
  /\b(?:reg(?:ular)?|was|orig(?:inal(?:ly)?)?|msrp|retail|list|usually|normally|save|saving|extra)\b\.?\s*(?:price)?\s*[:=]?\s*~?\s*$/i;

// Words right after a price that mean it's a discount, not a price
const NOT_SALE_PRICE_AFTER =
  /^\s*(?:off|back|cash\s?back|credit|rebate|cheaper|discount|savings?|gift\s?cards?|gc)\b/i;

const TAG_PATTERNS: { tag: string; pattern: RegExp }[] = [
  { tag: "YMMV", pattern: /\bymmv\b/i },
  { tag: "ATL", pattern: /\batl\b/i },
  { tag: "In store only", pattern: /\b(?:in[- ]?store|b&m)\s*(?:only|clearance|exclusive)\b/i },
  { tag: "Online only", pattern: /\bonline\s*(?:only|exclusive)\b/i },
  { tag: "Price error", pattern: /\b(?:price|pricing)\s*(?:error|mistake)\b/i },
  { tag: "Clearance", pattern: /\bclearance\b/i },
];

interface PriceMatch {
  value: number;
  start: number;
  end: number;
}

function findPriceMatches(text: string): PriceMatch[] {
  const matches: PriceMatch[] = [];
  for (const match of text.matchAll(PRICE_PATTERN)) {
    const digits = match[1] ?? match[2];
    if (digits === undefined || match.index === undefined) {
      continue;
    }
    const value = Number(digits.replace(/,/g, ""));
    if (!Number.isFinite(value)) {
      continue;
    }
    matches.push({ value, start: match.index, end: match.index + match[0].length });
  }
  return matches;
}

export function extractStore(title: string): string | null {
  const storeMatch = /^\s*\[([^\]]+)\]/.exec(title);
  if (!storeMatch || storeMatch[1] === undefined) {
    return null;
  }
  const store = storeMatch[1].trim();
  if (store.length === 0) {
    return null;
  }
  return store;
}

export function extractPrices(text: string): number[] {
  const prices: number[] = [];
  for (const priceMatch of findPriceMatches(text)) {
    prices.push(priceMatch.value);
  }
  return prices;
}

// First price that isn't a regular price or a discount amount
export function pickLikelyPrice(title: string): number | null {
  for (const priceMatch of findPriceMatches(title)) {
    const textBefore = title.slice(Math.max(0, priceMatch.start - 20), priceMatch.start);
    const textAfter = title.slice(priceMatch.end, priceMatch.end + 20);
    const markedAsNotSale = NOT_SALE_PRICE_BEFORE.test(textBefore) || NOT_SALE_PRICE_AFTER.test(textAfter);
    if (!markedAsNotSale) {
      return priceMatch.value;
    }
  }
  return null;
}

export function extractTags(title: string): string[] {
  const tags: string[] = [];
  for (const { tag, pattern } of TAG_PATTERNS) {
    if (pattern.test(title)) {
      tags.push(tag);
    }
  }
  return tags;
}

// The text that gets embedded for a post
export function buildMatchText(post: Post, bodyChars: number = DEFAULT_BODY_CHARS): string {
  const bodyStart = post.bodyText.slice(0, bodyChars).trim();
  if (bodyStart.length === 0) {
    return post.title;
  }
  return `${post.title}\n${bodyStart}`;
}
