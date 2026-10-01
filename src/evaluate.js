// @ts-check
// Measures how well a cache tells reusable answers from look-alikes, on a file
// of labeled question pairs.
//
//   npm run evaluate                                   similarity only
//   npm run evaluate -- --judge jev                    with Jev as the judge
//   npm run evaluate -- --pairs pairs-heldout.json --judge chat
//
// Each cached question is stored in its own scope, so every new question is
// compared with exactly the one question it is paired with. The cached
// "answers" are placeholders; no chat model is called except a chat judge.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { goodmemClient, judgeFromSettings, readState, settings } from "./config.js";
import { percentile, tally } from "./metrics.js";
import { SemanticCache } from "./semanticCache.js";

/** @typedef {import("./metrics.js").ScoredPair} ScoredPair */

const { values: args } = parseArgs({
  options: {
    pairs: { type: "string", default: "pairs.json" },
    judge: { type: "string", default: "none" },
    floor: { type: "string", default: "0.55" },
    "min-probability": { type: "string", default: "0.5" },
  },
});
const floor = Number(args.floor);
const minProbability = Number(args["min-probability"]);

/** @type {{ cached: string, query: string, same: boolean, kind: string }[]} */
const pairs = JSON.parse(readFileSync(new URL(`../data/${args.pairs}`, import.meta.url), "utf8"));
const { spaceId, embeddingModel } = readState();
const { name: judgeName, judge } = judgeFromSettings(args.judge);
const client = goodmemClient();

// The cache is used here only to store entries and measure similarity, so its
// threshold is set where nothing passes and no judge is attached.
const cache = new SemanticCache({ client, spaceId, similarityThreshold: Infinity });
const runId = String(Date.now());
/** @param {string} cached */
const scopeFor = (cached) =>
  SemanticCache.scope({ model: "evaluation", systemPrompt: cached, version: runId });

// 1. Store each distinct cached question and wait until all are embedded.
const cachedQuestions = [...new Set(pairs.map((p) => p.cached))];
const memoryIds = await Promise.all(
  cachedQuestions.map((q) => cache.store(q, `(placeholder answer to: ${q})`, scopeFor(q))),
);
await Promise.all(memoryIds.map((id) => cache.waitUntilSearchable(id)));

// 2. Score every pair: similarity always, the judge's verdict if there is one.
/** @type {ScoredPair[]} */
const scored = [];
/** @type {number[]} */
const lookupMs = [];
/** @type {number[]} */
const judgeMs = [];
for (const pair of pairs) {
  const found = await cache.lookup(pair.query, scopeFor(pair.cached));
  lookupMs.push(found.lookupMs);
  let reuseProbability = null;
  if (judge) {
    const started = performance.now();
    reuseProbability = await judge(pair.cached, pair.query);
    judgeMs.push(performance.now() - started);
  }
  scored.push({ ...pair, similarity: found.similarity ?? -1, reuseProbability });
}

// 3. Clean up this run's entries.
await client.memories.batchDelete({ requests: memoryIds.map((memoryId) => ({ memoryId })) });

// 4. Report.
const reusable = scored.filter((p) => p.same).length;
console.log(
  `${args.pairs}: ${pairs.length} pairs, ${reusable} reusable, embeddings from ${embeddingModel}\n`,
);

console.log("Similarity threshold alone:");
const thresholdRows = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95].map((threshold) => ({
  threshold,
  ...tally(scored, (p) => p.similarity >= threshold),
}));
printTable(thresholdRows, "threshold");

console.log("\nLook-alikes that scored highest:");
for (const p of top(
  scored.filter((x) => !x.same),
  (x) => x.similarity,
  6,
)) {
  console.log(`  ${p.similarity.toFixed(3)}  "${p.cached}" / "${p.query}"`);
}
console.log("\nReusable pairs that scored lowest:");
for (const p of top(
  scored.filter((x) => x.same),
  (x) => -x.similarity,
  4,
)) {
  console.log(`  ${p.similarity.toFixed(3)}  "${p.cached}" / "${p.query}"`);
}

/** @type {object[] | null} */
let judgeRows = null;
if (judge) {
  console.log(`\nWith ${judgeName} as judge, on candidates with similarity >= ${floor}:`);
  judgeRows = [0.1, 0.25, 0.5, 0.75, 0.9].map((min) => ({
    "min prob": min,
    ...tally(scored, (p) => p.similarity >= floor && (p.reuseProbability ?? 0) >= min),
  }));
  printTable(judgeRows, "min prob");

  const disagreements = scored.filter(
    (p) => (p.reuseProbability ?? 0) >= minProbability !== p.same,
  );
  console.log(
    `\nThe judge disagreed with ${disagreements.length} of ${scored.length} labels at ${minProbability}:`,
  );
  for (const p of disagreements) {
    console.log(
      `  p=${(p.reuseProbability ?? 0).toFixed(2)}, labeled ${p.same ? "reusable" : "different"}: "${p.cached}" / "${p.query}"`,
    );
  }
}

console.log(
  `\nLookup time (exact check, embedding, vector search): median ${fmtMs(percentile(lookupMs, 0.5))}, ` +
    `95th percentile ${fmtMs(percentile(lookupMs, 0.95))}`,
);
if (judge) {
  console.log(`Judge time: median ${fmtMs(percentile(judgeMs, 0.5))}`);
}

const resultsDir = new URL("../results/", import.meta.url);
mkdirSync(resultsDir, { recursive: true });
const file = `${args.pairs.replace(/\.json$/, "")}--${embeddingModel}--${judge ? judgeName.replace(/\W+/g, "-") : "no-judge"}.json`;
writeFileSync(
  new URL(file, resultsDir),
  JSON.stringify(
    {
      pairs: args.pairs,
      embeddingModel,
      judge: judge ? judgeName : null,
      floor,
      minProbability,
      medianLookupMs: percentile(lookupMs, 0.5),
      medianJudgeMs: percentile(judgeMs, 0.5),
      thresholdRows,
      judgeRows,
      scored,
    },
    null,
    2,
  ) + "\n",
);
console.log(`\nSaved results/${file}`);

/**
 * @template T
 * @param {T[]} items
 * @param {(item: T) => number} key
 * @param {number} n
 */
function top(items, key, n) {
  return [...items].sort((a, b) => key(b) - key(a)).slice(0, n);
}

/** @param {number | null} ms */
function fmtMs(ms) {
  return ms === null ? "-" : `${ms.toFixed(0)} ms`;
}

/**
 * @param {Array<Record<string, any>>} rows
 * @param {string} first the name of the first column
 */
function printTable(rows, first) {
  const fmt = (/** @type {number | null} */ x) => (x === null ? "-" : x.toFixed(2));
  console.log(`  ${first.padStart(9)}  served  wrong  missed  precision  recall`);
  for (const r of rows) {
    console.log(
      `  ${r[first].toFixed(2).padStart(9)}  ${String(r.served).padStart(6)}  ${String(r.wrong).padStart(5)}  ` +
        `${String(r.missed).padStart(6)}  ${fmt(r.precision).padStart(9)}  ${fmt(r.recall).padStart(6)}`,
    );
  }
}
