import { describe, expect, it } from "vitest";
import { decodeHtmlEntities, htmlToText, parseFeed } from "../src/core/feed/parseFeed";
import { createRecordingLogger, readFixture } from "./helpers";

describe("parseFeed on the real captured feed", () => {
  const logger = createRecordingLogger();
  const posts = parseFeed(readFixture("hot-deals-feed.xml"), logger);

  it("parses every entry without warnings", () => {
    expect(posts.length).toBe(15);
    expect(logger.messages).toEqual([]);
  });

  it("reads id, link, author and dates", () => {
    const firstPost = posts[0]!;
    expect(firstPost.id).toBe("https://forums.redflagdeals.com/viewtopic.php?t=2830082&p=41325979#p41325979");
    expect(firstPost.link).toBe(firstPost.id);
    expect(firstPost.title).toBe("[Costco] Ninja Dual Brew Coffee Maker");
    expect(firstPost.author).toBe("forevergone");
    expect(firstPost.publishedAt).toBe("2026-10-25T22:37:46.000Z");
    expect(firstPost.updatedAt).toBe("2026-10-25T22:37:46.000Z");
  });

  it("strips html and the statistics footer from the body", () => {
    const firstPost = posts[0]!;
    expect(firstPost.bodyText).toBe("Found at Elgin Mills Costco");
    for (const post of posts) {
      expect(post.bodyText).not.toMatch(/Statistics: Posted by/);
      expect(post.bodyText).not.toMatch(/<[a-z]/i);
    }
  });

  it("decodes entities inside CDATA titles", () => {
    const titles = posts.map((post) => post.title);
    expect(titles).toContain("Spier & Mackay Warehouse Sale");
    expect(titles).toContain(
      '[Best Buy] Lenovo ThinkPad E14 Gen 7 14" FHD+ Touch Copilot+ PC, Intel Core Ultra 7 258V, 32GB LPDDR5x, 1TB SSD, Intel Arc Graphics',
    );
  });

  it("handles updated values with trailing whitespace", () => {
    const sensorPost = posts.find((post) => post.title.includes("Nest Temperature Sensor"))!;
    expect(sensorPost.updatedAt).toBe("2026-10-25T21:27:33.000Z");
  });

  it("ignores the enclosure link and keeps the topic link", () => {
    for (const post of posts) {
      expect(post.link.startsWith("https://forums.redflagdeals.com/viewtopic.php")).toBe(true);
    }
  });

  it("collapses whitespace and decodes body entities", () => {
    const coffeePost = posts.find((post) => post.title.includes("Ethical Bean"))!;
    expect(coffeePost.bodyText).toContain("first S&S order");
    expect(coffeePost.bodyText).not.toMatch(/\s{2,}/);
  });
});

describe("parseFeed edge cases", () => {
  it("handles a feed with a single entry", () => {
    const posts = parseFeed(readFixture("single-entry-feed.xml"), createRecordingLogger());
    expect(posts).toHaveLength(1);
    expect(posts[0]!.title).toBe("[Amazon.com] UGREEN Nexode 100W 5-Port GaN USB-C Charger | $39.99");
  });

  it("skips malformed entries with a warning instead of crashing", () => {
    const logger = createRecordingLogger();
    const posts = parseFeed(readFixture("malformed-entry-feed.xml"), logger);
    const titles = posts.map((post) => post.title);
    expect(titles).toEqual(["[Costco] Ninja Dual Brew Coffee Maker", "[Staples] ASUS RT-BE86U Router ($279.99 in store only)"]);
    const warnings = logger.messages.filter((entry) => entry.level === "warn");
    expect(warnings).toHaveLength(3);
    expect(warnings[0]!.message).toMatch(/missing <id>/);
    expect(warnings[1]!.message).toMatch(/missing <title>/);
    expect(warnings[2]!.message).toMatch(/missing <link>/);
  });

  it("keeps a post with an unparseable date but sets the date to null", () => {
    const posts = parseFeed(readFixture("malformed-entry-feed.xml"), createRecordingLogger());
    const routerPost = posts.find((post) => post.title.includes("ASUS"))!;
    expect(routerPost.publishedAt).toBeNull();
    expect(routerPost.bodyText).toBe("");
  });

  it("handles a feed with no entries", () => {
    const xml = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>x</title></feed>';
    expect(parseFeed(xml, createRecordingLogger())).toEqual([]);
  });

  it("throws on something that is not an Atom feed", () => {
    expect(() => parseFeed("<html><body>Just a moment...</body></html>", createRecordingLogger())).toThrow(/Not an Atom feed/);
  });
});

describe("html helpers", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeHtmlEntities("Tom &amp; Jerry &#39;s &#x1F91E; &quot;hi&quot; &bogus;")).toBe("Tom & Jerry 's 🤞 \"hi\" &bogus;");
  });

  it("does not double decode", () => {
    expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
  });

  it("separates words split by tags", () => {
    expect(htmlToText("one<br>two<p>three</p>")).toBe("one two three");
  });
});
