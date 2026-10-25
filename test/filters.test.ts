import { describe, expect, it } from "vitest";
import { applyHardFilters, findExcludedTerm, normalizeStoreName } from "../src/core/matching/filters";
import { makePost, makeWatch } from "./helpers";

const chargerPost = makePost({
  title: "[Amazon.com] UGREEN Nexode 100W 5-Port GaN USB-C Charger | $39.99",
  bodyText: "Can charge 65w and 30w concurrently which works for my laptop/phone but may not for others",
});
const coffeeMakerPost = makePost({ title: "[Costco] Ninja Dual Brew Coffee Maker", bodyText: "Found at Elgin Mills Costco" });

describe("exclude terms", () => {
  it("rejects when the title contains an exclude term", () => {
    const result = applyHardFilters(chargerPost, makeWatch({ excludeTerms: ["gan"] }));
    expect(result).toMatchObject({ passed: false, rejection: "exclude_term" });
  });

  it("rejects when only the body contains an exclude term", () => {
    const result = applyHardFilters(chargerPost, makeWatch({ excludeTerms: ["laptop"] }));
    expect(result).toMatchObject({ passed: false, rejection: "exclude_term" });
  });

  it("treats singular and plural as the same term", () => {
    expect(findExcludedTerm("USB-C cable 2 pack", ["cables"])).toBe("cables");
    expect(findExcludedTerm("three cables included", ["cable"])).toBe("cable");
  });

  it("does not match inside other words and ignores blank terms", () => {
    expect(findExcludedTerm("Cablevision promo", ["cable"])).toBeNull();
    expect(findExcludedTerm("anything", ["  ", ""])).toBeNull();
  });

  it("passes when no exclude term is present", () => {
    expect(applyHardFilters(chargerPost, makeWatch({ excludeTerms: ["refurbished"] })).passed).toBe(true);
  });
});

describe("stores", () => {
  it("normalizes store names", () => {
    expect(normalizeStoreName("Amazon.ca")).toBe("amazon");
    expect(normalizeStoreName("amazon.com")).toBe("amazon");
    expect(normalizeStoreName("Best Buy")).toBe("bestbuy");
    expect(normalizeStoreName("Canadian Tire")).toBe("canadiantire");
  });

  it("accepts a post from an allowed store", () => {
    expect(applyHardFilters(chargerPost, makeWatch({ stores: ["Amazon"] })).passed).toBe(true);
  });

  it("rejects a post from another store", () => {
    const result = applyHardFilters(coffeeMakerPost, makeWatch({ stores: ["Amazon.ca", "Best Buy"] }));
    expect(result).toMatchObject({ passed: false, rejection: "store", postStore: "Costco" });
  });

  it("rejects a post with no store when the watch has stores", () => {
    const noStorePost = makePost({ title: "Spier & Mackay Warehouse Sale" });
    expect(applyHardFilters(noStorePost, makeWatch({ stores: ["Costco"] }))).toMatchObject({ passed: false, rejection: "store" });
  });

  it("accepts any store when the watch has none", () => {
    expect(applyHardFilters(coffeeMakerPost, makeWatch({ stores: [] })).passed).toBe(true);
  });
});

describe("max price", () => {
  it("rejects a post over the max price", () => {
    const result = applyHardFilters(chargerPost, makeWatch({ maxPrice: 30 }));
    expect(result).toMatchObject({ passed: false, rejection: "over_max_price", postPrice: 39.99 });
  });

  it("accepts a post at or under the max price", () => {
    expect(applyHardFilters(chargerPost, makeWatch({ maxPrice: 39.99 })).passed).toBe(true);
    expect(applyHardFilters(chargerPost, makeWatch({ maxPrice: 40 })).passed).toBe(true);
  });

  it("does not reject when the post has no price, and reports the price as unknown", () => {
    const result = applyHardFilters(coffeeMakerPost, makeWatch({ maxPrice: 10 }));
    expect(result).toEqual({ passed: true, postPrice: null, postStore: "Costco" });
  });
});
