import { describe, expect, it } from "vitest";
import { buildMatchText, extractPrices, extractStore, extractTags, pickLikelyPrice } from "../src/core/matching/postText";
import { makePost } from "./helpers";

// Real titles from test/fixtures/hot-deals-feed.xml
const realTitles = {
  coffeeMaker: "[Costco] Ninja Dual Brew Coffee Maker",
  breadmaker: "[Costco] Panasonic SD-R2550S automatic breadmaker in-store clearance $149.97",
  coffeeBeans: "[Amazon.ca] 35% off Ethical Bean Whole Bean coffee (907g) w/ 1st Subscribe & Save (~$16.50)",
  router: "[Staples] ASUS RT-BE86U BE6800 Dual Band WiFi 7 Smart AiMesh Extendable Router ($279.99 in store only)",
  bandages: "[Amazon.ca] Nexcare™ Fabric Bandages HD202-CA, Assorted Sizes, 40 for $0.97 ATL",
  warehouseSale: "Spier & Mackay Warehouse Sale",
  ipad: "[Walmart] 13-inch iPad Pro Wi-Fi 256GB $1,798.98",
  charger: "[Amazon.com] UGREEN Nexode 100W 5-Port GaN USB-C Charger | $39.99",
  tireKit: "[Canadian Tire] $99.99 MAXIMUM Tire Change Kit, 9-pc",
  evProgram: "[Flo] Flo EV Charger Program - Starts November 2",
};

describe("extractStore", () => {
  it("reads the leading bracket on real titles", () => {
    expect(extractStore(realTitles.coffeeMaker)).toBe("Costco");
    expect(extractStore(realTitles.coffeeBeans)).toBe("Amazon.ca");
    expect(extractStore(realTitles.tireKit)).toBe("Canadian Tire");
    expect(extractStore(realTitles.charger)).toBe("Amazon.com");
  });

  it("returns null when there is no leading bracket", () => {
    expect(extractStore(realTitles.warehouseSale)).toBeNull();
    expect(extractStore("Great deal [Costco] later in title")).toBeNull();
    expect(extractStore("[] empty brackets")).toBeNull();
  });
});

describe("extractPrices", () => {
  it("finds every dollar amount", () => {
    expect(extractPrices(realTitles.ipad)).toEqual([1798.98]);
    expect(extractPrices(realTitles.bandages)).toEqual([0.97]);
    expect(extractPrices(realTitles.coffeeBeans)).toEqual([16.5]);
    expect(extractPrices("Was $49.99, now $29.99")).toEqual([49.99, 29.99]);
  });

  it("handles a trailing dollar sign like the real body text", () => {
    expect(extractPrices("Pixel 11 pro bring it back 40$")).toEqual([40]);
  });

  it("ignores percentages and bare numbers", () => {
    expect(extractPrices("35% off 907g bag, 3 pack")).toEqual([]);
  });
});

describe("pickLikelyPrice", () => {
  it("picks the sale price on real titles", () => {
    expect(pickLikelyPrice(realTitles.breadmaker)).toBe(149.97);
    expect(pickLikelyPrice(realTitles.router)).toBe(279.99);
    expect(pickLikelyPrice(realTitles.charger)).toBe(39.99);
    expect(pickLikelyPrice(realTitles.tireKit)).toBe(99.99);
    expect(pickLikelyPrice(realTitles.ipad)).toBe(1798.98);
    expect(pickLikelyPrice(realTitles.coffeeBeans)).toBe(16.5);
  });

  it("returns null when there is no price", () => {
    expect(pickLikelyPrice(realTitles.coffeeMaker)).toBeNull();
    expect(pickLikelyPrice(realTitles.evProgram)).toBeNull();
  });

  it("skips regular and was prices", () => {
    expect(pickLikelyPrice("[Best Buy] Sony WH-1000XM5 Reg $499.99, now $349.99")).toBe(349.99);
    expect(pickLikelyPrice("[Amazon] Air fryer (was $129) $79")).toBe(79);
    expect(pickLikelyPrice("[Costco] TV $799 (Reg. $1,099)")).toBe(799);
    expect(pickLikelyPrice("[Costco] TV $799 Reg $1,099")).toBe(799);
    expect(pickLikelyPrice("[Walmart] Blender regular price: $89, sale $59")).toBe(59);
  });

  it("skips discount amounts", () => {
    expect(pickLikelyPrice("[Amazon] $20 off Anker charger, now $25.99")).toBe(25.99);
    expect(pickLikelyPrice("[Visa] Get $50 back when you spend $200")).toBe(200);
  });

  it("returns null when only a regular price or discount is present", () => {
    expect(pickLikelyPrice("[Staples] Router reg $419.99 in store only")).toBeNull();
    expect(pickLikelyPrice("[Amazon] $15 off coupon on Ethical Bean")).toBeNull();
  });
});

describe("extractTags", () => {
  it("finds tags in real titles", () => {
    expect(extractTags(realTitles.bandages)).toEqual(["ATL"]);
    expect(extractTags(realTitles.router)).toEqual(["In store only"]);
    expect(extractTags(realTitles.breadmaker)).toEqual(["In store only", "Clearance"]);
    expect(extractTags(realTitles.coffeeMaker)).toEqual([]);
  });

  it("finds the other tag formats", () => {
    expect(extractTags("[Amazon] PRICE ERROR Monitor $9 YMMV")).toEqual(["YMMV", "Price error"]);
    expect(extractTags("[Walmart] TV online only $199")).toEqual(["Online only"]);
    expect(extractTags("[Best Buy] Laptop (In-Store Only) atl")).toEqual(["ATL", "In store only"]);
    expect(extractTags("[Costco] instore only deal")).toEqual(["In store only"]);
  });

  it("does not match tags inside other words", () => {
    expect(extractTags("[Lowes] Atlas shelving, Battlefield game")).toEqual([]);
  });
});

describe("buildMatchText", () => {
  it("joins the title with the first 300 body characters", () => {
    const longBody = "word ".repeat(200);
    const matchText = buildMatchText(makePost({ title: "Title here", bodyText: longBody }));
    const [titleLine, bodyLine] = matchText.split("\n");
    expect(titleLine).toBe("Title here");
    expect(bodyLine!.length).toBeLessThanOrEqual(300);
  });

  it("is just the title when the body is empty", () => {
    expect(buildMatchText(makePost({ title: "Only title", bodyText: "" }))).toBe("Only title");
  });
});
