import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/core/config";
import { checkFetchGuard, fetchFeed, parseRetryAfter, type FetchFunction } from "../src/core/feed/fetchFeed";
import { emptyFeedState } from "../src/core/db/queries";
import type { Clock, FeedState } from "../src/core/types";
import { createRecordingLogger, readFixture } from "./helpers";

const config = buildConfig();
const FEED_URL = config.feedUrl;
const NOW = new Date("2026-10-25T12:00:00.000Z");

function fakeClock(start: Date = NOW): Clock & { sleeps: number[] } {
  let currentMs = start.getTime();
  const sleeps: number[] = [];
  return {
    sleeps,
    now() {
      return new Date(currentMs);
    },
    async sleep(milliseconds) {
      sleeps.push(milliseconds);
      currentMs += milliseconds;
    },
  };
}

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  redirect: string | undefined;
}

function scriptedFetch(responses: (Response | Error)[]): FetchFunction & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    requests.push({ url, headers: init.headers as Record<string, string>, redirect: init.redirect });
    const next = responses.shift();
    if (next === undefined) {
      throw new Error("No more scripted responses");
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  return Object.assign(fetchFn, { requests });
}

function stateWith(overrides: Partial<FeedState>): FeedState {
  return { ...emptyFeedState(FEED_URL), ...overrides };
}

const feedXml = readFixture("hot-deals-feed.xml");

describe("2 minute fetch guard", () => {
  it("allows the first ever request", () => {
    expect(checkFetchGuard(emptyFeedState(FEED_URL), NOW, config.minFetchIntervalMs, false)).toEqual({ allowed: true });
  });

  it("refuses when the last live request was under 2 minutes ago", () => {
    const state = stateWith({ lastCheckedAt: "2026-10-25T11:58:30.000Z" });
    const decision = checkFetchGuard(state, NOW, config.minFetchIntervalMs, false);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.retryInSeconds).toBe(30);
    }
  });

  it("allows at exactly 2 minutes", () => {
    const state = stateWith({ lastCheckedAt: "2026-10-25T11:58:00.000Z" });
    expect(checkFetchGuard(state, NOW, config.minFetchIntervalMs, false).allowed).toBe(true);
  });

  it("lets --force skip the 2 minute rule", () => {
    const state = stateWith({ lastCheckedAt: "2026-10-25T11:59:59.000Z" });
    expect(checkFetchGuard(state, NOW, config.minFetchIntervalMs, true).allowed).toBe(true);
  });

  it("refuses after a block unless forced", () => {
    const state = stateWith({ lastCheckedAt: "2026-10-25T10:00:00.000Z", lastStatus: "blocked" });
    expect(checkFetchGuard(state, NOW, config.minFetchIntervalMs, false).allowed).toBe(false);
    expect(checkFetchGuard(state, NOW, config.minFetchIntervalMs, true).allowed).toBe(true);
  });

  it("respects a Retry-After back off even with --force", () => {
    const state = stateWith({ lastCheckedAt: "2026-10-25T10:00:00.000Z", retryAfterUntil: "2026-10-25T12:05:00.000Z" });
    const decision = checkFetchGuard(state, NOW, config.minFetchIntervalMs, true);
    expect(decision.allowed).toBe(false);
  });

  it("never touches the network when the guard refuses", async () => {
    const fetchFn = scriptedFetch([]);
    const state = stateWith({ lastCheckedAt: "2026-10-25T11:59:00.000Z" });
    const result = await fetchFeed(state, config, { fetchFn, clock: fakeClock(), logger: createRecordingLogger() });
    expect(result.outcome).toBe("guarded");
    expect(fetchFn.requests).toHaveLength(0);
  });
});

describe("fetchFeed", () => {
  it("sends an honest user agent and conditional headers", async () => {
    const fetchFn = scriptedFetch([new Response(null, { status: 304 })]);
    const state = stateWith({ etag: '"abc"', lastModified: "Sun, 25 Oct 2026 22:37:46 GMT" });
    const result = await fetchFeed(state, config, { fetchFn, clock: fakeClock(), logger: createRecordingLogger() });
    expect(result.outcome).toBe("not_modified");
    const request = fetchFn.requests[0]!;
    expect(request.url).toBe(FEED_URL);
    expect(request.headers["User-Agent"]).toBe(config.userAgent);
    expect(request.headers["If-None-Match"]).toBe('"abc"');
    expect(request.headers["If-Modified-Since"]).toBe("Sun, 25 Oct 2026 22:37:46 GMT");
    expect(request.redirect).toBe("manual");
  });

  it("returns ok with the xml and new validators", async () => {
    const response = new Response(feedXml, { status: 200, headers: { "Last-Modified": "Sun, 25 Oct 2026 22:37:46 GMT", ETag: '"v2"' } });
    const fetchFn = scriptedFetch([response]);
    const result = await fetchFeed(emptyFeedState(FEED_URL), config, { fetchFn, clock: fakeClock(), logger: createRecordingLogger() });
    expect(result.outcome).toBe("ok");
    if (result.outcome === "ok") {
      expect(result.xml).toBe(feedXml);
      expect(result.etag).toBe('"v2"');
      expect(result.lastModified).toBe("Sun, 25 Oct 2026 22:37:46 GMT");
      expect(result.requestedAt).toBe(NOW.toISOString());
    }
  });

  it("treats a 403 as blocked and logs status and url", async () => {
    const fetchFn = scriptedFetch([new Response("Forbidden", { status: 403 })]);
    const logger = createRecordingLogger();
    const result = await fetchFeed(emptyFeedState(FEED_URL), config, { fetchFn, clock: fakeClock(), logger });
    expect(result).toMatchObject({ outcome: "blocked", status: 403, finalUrl: FEED_URL });
    expect(fetchFn.requests).toHaveLength(1);
    expect(logger.messages.some((entry) => entry.level === "error" && entry.message.includes("403"))).toBe(true);
  });

  it("treats a redirect to another host as blocked without following it", async () => {
    const redirect = new Response(null, { status: 302, headers: { Location: "https://rfd.tollbit.com/feed/forum/9" } });
    const fetchFn = scriptedFetch([redirect]);
    const result = await fetchFeed(emptyFeedState(FEED_URL), config, { fetchFn, clock: fakeClock(), logger: createRecordingLogger() });
    expect(result).toMatchObject({ outcome: "blocked", status: 302, finalUrl: "https://rfd.tollbit.com/feed/forum/9" });
    expect(fetchFn.requests).toHaveLength(1);
  });

  it("follows a same host redirect", async () => {
    const redirect = new Response(null, { status: 301, headers: { Location: "/feed/forum/9?x=1" } });
    const fetchFn = scriptedFetch([redirect, new Response(feedXml, { status: 200 })]);
    const result = await fetchFeed(emptyFeedState(FEED_URL), config, { fetchFn, clock: fakeClock(), logger: createRecordingLogger() });
    expect(result.outcome).toBe("ok");
    expect(fetchFn.requests[1]!.url).toBe("https://forums.redflagdeals.com/feed/forum/9?x=1");
  });

  it("treats a 200 that is not a feed as blocked", async () => {
    const fetchFn = scriptedFetch([new Response("<html>Just a moment...</html>", { status: 200 })]);
    const result = await fetchFeed(emptyFeedState(FEED_URL), config, { fetchFn, clock: fakeClock(), logger: createRecordingLogger() });
    expect(result.outcome).toBe("blocked");
  });

  it("returns rate_limited with Retry-After and does not retry", async () => {
    const fetchFn = scriptedFetch([new Response(null, { status: 429, headers: { "Retry-After": "600" } })]);
    const result = await fetchFeed(emptyFeedState(FEED_URL), config, { fetchFn, clock: fakeClock(), logger: createRecordingLogger() });
    expect(result).toMatchObject({ outcome: "rate_limited", retryAfterSeconds: 600 });
    expect(fetchFn.requests).toHaveLength(1);
  });

  it("retries errors at most twice with exponential backoff that respects the 2 minute rule", async () => {
    const clock = fakeClock();
    const fetchFn = scriptedFetch([
      new Response("oops", { status: 503 }),
      new Error("ECONNRESET"),
      new Response("oops", { status: 500 }),
    ]);
    const result = await fetchFeed(emptyFeedState(FEED_URL), config, { fetchFn, clock, logger: createRecordingLogger() });
    expect(result).toMatchObject({ outcome: "error", status: 500 });
    expect(fetchFn.requests).toHaveLength(3);
    expect(clock.sleeps).toEqual([120_000, 240_000]);
  });

  it("recovers when a retry succeeds", async () => {
    const fetchFn = scriptedFetch([new Error("ETIMEDOUT"), new Response(feedXml, { status: 200 })]);
    const result = await fetchFeed(emptyFeedState(FEED_URL), config, { fetchFn, clock: fakeClock(), logger: createRecordingLogger() });
    expect(result.outcome).toBe("ok");
  });

  it("does not retry a 404", async () => {
    const fetchFn = scriptedFetch([new Response("nope", { status: 404 })]);
    const result = await fetchFeed(emptyFeedState(FEED_URL), config, { fetchFn, clock: fakeClock(), logger: createRecordingLogger() });
    expect(result).toMatchObject({ outcome: "error", status: 404 });
    expect(fetchFn.requests).toHaveLength(1);
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds and http dates", () => {
    expect(parseRetryAfter("120", NOW)).toBe(120);
    expect(parseRetryAfter("Sun, 25 Oct 2026 12:10:00 GMT", NOW)).toBe(600);
    expect(parseRetryAfter(null, NOW)).toBeNull();
    expect(parseRetryAfter("soon", NOW)).toBeNull();
  });
});
