// @ts-check
// Five requests, each showing one path through the cache, with real model
// calls. Run `npm run setup` first.

import { goodmemClient, judgeFromSettings, readState, settings } from "./config.js";
import { chatModel } from "./model.js";
import { SemanticCache } from "./semanticCache.js";

const { spaceId } = readState();
const { name: judgeName, judge } = judgeFromSettings();

const cache = new SemanticCache({
  client: goodmemClient(),
  spaceId,
  // With a judge, the threshold only picks candidates, so it can be low.
  similarityThreshold: judge ? 0.55 : 0.85,
  judge,
});

// Two assistants with different instructions. Each gets its own scope, so
// they never receive each other's answers.
const support = assistant("You are the support assistant for Acme Notes, a note-taking app.");
const billing = assistant("You are the billing assistant for Acme Notes, a note-taking app.");

console.log(`Chat model ${settings.chatModel}, judge ${judgeName}`);

const first = await ask("1. Nothing is cached yet", support, "How do I export my notes as PDF?");

await ask(
  "2. The same question, retyped, straight away",
  support,
  "how do I export my   notes as pdf?",
);

// The first answer is findable by exact match already. To be found by
// meaning it must be embedded, which GoodMem does in a background job.
if (first.storedMemoryId) {
  await cache.waitUntilSearchable(first.storedMemoryId);
}

await ask("3. A paraphrase", support, "Can I save a note to a PDF file?");

await ask(
  "4. A question that looks alike but needs a different answer",
  support,
  "How do I import notes from a PDF?",
);

await ask(
  "5. The first question again, asked of a different assistant",
  billing,
  "How do I export my notes as PDF?",
);

/**
 * @param {string} systemPrompt
 */
function assistant(systemPrompt) {
  const instructions = `${systemPrompt} Answer in two sentences.`;
  return {
    scope: SemanticCache.scope({ model: settings.chatModel, systemPrompt: instructions }),
    generate: chatModel({ model: settings.chatModel, systemPrompt: instructions }),
  };
}

/**
 * @param {string} title
 * @param {ReturnType<typeof assistant>} who
 * @param {string} prompt
 */
async function ask(title, who, prompt) {
  const r = await cache.getOrGenerate(prompt, who.scope, who.generate);

  const similarity = r.similarity === null ? "-" : r.similarity.toFixed(3);
  const judged = r.reuseProbability === null ? "-" : r.reuseProbability.toFixed(2);
  const timing =
    r.generateMs === null
      ? `${r.lookupMs.toFixed(0)} ms`
      : `${r.lookupMs.toFixed(0)} ms lookup + ${r.generateMs.toFixed(0)} ms model`;

  console.log(`\n${title}\n  "${prompt}"`);
  console.log(`  ${r.outcome.padEnd(8)}  similarity ${similarity}  judge ${judged}  ${timing}`);
  if (r.outcome !== "miss") {
    console.log(`  reused the answer to "${r.cachedPrompt}"`);
  }
  console.log(`  > ${r.response.replace(/\s+/g, " ").slice(0, 150)}`);
  return r;
}
