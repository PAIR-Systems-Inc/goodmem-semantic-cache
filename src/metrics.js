// @ts-check

/**
 * One labeled pair: a question whose answer is cached, a new question, and
 * whether the cached answer could be returned unchanged for the new one.
 *
 * @typedef {object} ScoredPair
 * @property {string} cached
 * @property {string} query
 * @property {boolean} same the label
 * @property {string} kind how the two questions differ
 * @property {number} similarity cosine similarity between them
 * @property {number | null} reuseProbability the judge's verdict, if a judge ran
 */

/**
 * Counts what a cache would have done with a set of labeled pairs, given a
 * rule for accepting a cached answer.
 *
 *   served:    pairs where the cache returned the cached answer
 *   wrong:     served, but the label says the answer did not fit
 *   missed:    not served, although the cached answer would have fit
 *   precision: the share of served answers that were right
 *   recall:    the share of reusable answers that were served
 *
 * @param {ScoredPair[]} pairs
 * @param {(pair: ScoredPair) => boolean} accept
 */
export function tally(pairs, accept) {
  const served = pairs.filter(accept);
  const right = served.filter((p) => p.same).length;
  const reusable = pairs.filter((p) => p.same).length;
  return {
    served: served.length,
    wrong: served.length - right,
    missed: reusable - right,
    precision: served.length ? right / served.length : null,
    recall: reusable ? right / reusable : null,
  };
}

/**
 * Returns the value at a percentile of a list of numbers.
 *
 * @param {number[]} values
 * @param {number} p between 0 and 1
 */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}
