// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { percentile, tally } from "../src/metrics.js";

/**
 * @param {boolean} same
 * @param {number} similarity
 */
const pair = (same, similarity) => ({
  cached: "a",
  query: "b",
  kind: "test",
  same,
  similarity,
  reuseProbability: null,
});

describe("tally", () => {
  it("counts served, wrong, and missed answers", () => {
    const pairs = [pair(true, 0.9), pair(true, 0.6), pair(false, 0.95), pair(false, 0.4)];

    const t = tally(pairs, (p) => p.similarity >= 0.8);

    assert.deepEqual(t, { served: 2, wrong: 1, missed: 1, precision: 0.5, recall: 0.5 });
  });

  it("reports no precision when nothing is served", () => {
    assert.equal(tally([pair(true, 0.1)], () => false).precision, null);
  });
});

describe("percentile", () => {
  it("returns the median of an unsorted list", () => {
    assert.equal(percentile([30, 10, 20], 0.5), 20);
  });

  it("returns null for an empty list", () => {
    assert.equal(percentile([], 0.5), null);
  });
});
