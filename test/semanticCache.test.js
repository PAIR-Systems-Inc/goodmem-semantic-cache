// @ts-check
// Unit tests with an in-memory stand-in for the GoodMem client. They need no
// server and no API keys: `npm test`.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SemanticCache, liveFilter, normalize } from "../src/semanticCache.js";

const SCOPE = SemanticCache.scope({ model: "test-model", systemPrompt: "Be brief." });

/**
 * A fake of the four SDK calls the cache makes. Vector search returns the
 * stored entry with the similarity the test chooses, reported the way
 * GoodMem reports it: as a negative inner product.
 *
 * @param {{ similarity?: number }} [options]
 */
function fakeClient({ similarity = 0.9 } = {}) {
  /** @type {any[]} */
  const memories = [];
  const calls = { list: 0, retrieve: 0, create: 0 };
  const client = {
    memories: {
      /** @param {any} request */
      async create(request) {
        calls.create++;
        const memory = {
          memoryId: `m${memories.length}`,
          metadata: request.metadata,
          processingStatus: "COMPLETED",
        };
        memories.push(memory);
        return memory;
      },
      /**
       * @param {string} _spaceId
       * @param {{ filter: string }} options
       */
      async list(_spaceId, { filter }) {
        calls.list++;
        const items = memories.filter(
          (m) => filter.includes(m.metadata.scope) && filter.includes(m.metadata.prompt_sha256),
        );
        return { items };
      },
      /** @param {any} request */
      async *retrieve(request) {
        calls.retrieve++;
        const live = memories.filter((m) => request.spaceKeys[0].filter.includes(m.metadata.scope));
        if (live.length === 0) return;
        yield { memoryDefinition: live[0] };
        yield { retrievedItem: { chunk: { memoryIndex: 0, relevanceScore: -similarity } } };
      },
      /** @param {string} memoryId */
      async get(memoryId) {
        return memories.find((m) => m.memoryId === memoryId);
      },
    },
  };
  return { client: /** @type {any} */ (client), calls };
}

describe("lookup", () => {
  it("serves an exact repeat without a vector search", async () => {
    const { client, calls } = fakeClient();
    const cache = new SemanticCache({ client, spaceId: "s", similarityThreshold: 0.8 });
    await cache.store("How do I export notes?", "Use File > Export.", SCOPE);

    const result = await cache.lookup("  how do i EXPORT notes? ", SCOPE);

    assert.equal(result.outcome, "exact");
    assert.equal(result.response, "Use File > Export.");
    assert.equal(calls.retrieve, 0);
  });

  it("serves a similar prompt at or above the threshold", async () => {
    const { client } = fakeClient({ similarity: 0.82 });
    const cache = new SemanticCache({ client, spaceId: "s", similarityThreshold: 0.8 });
    await cache.store("How do I export notes?", "Use File > Export.", SCOPE);

    const result = await cache.lookup("Can I save my notes to a file?", SCOPE);

    assert.equal(result.outcome, "semantic");
    assert.equal(result.cachedPrompt, "How do I export notes?");
    assert.equal(result.similarity, 0.82, "GoodMem's negative inner product is negated");
  });

  it("misses below the threshold and still reports the similarity", async () => {
    const { client } = fakeClient({ similarity: 0.7 });
    const cache = new SemanticCache({ client, spaceId: "s", similarityThreshold: 0.8 });
    await cache.store("How do I export notes?", "Use File > Export.", SCOPE);

    const result = await cache.lookup("How do I import notes?", SCOPE);

    assert.equal(result.outcome, "miss");
    assert.equal(result.response, null);
    assert.equal(result.similarity, 0.7);
  });

  it("misses when the judge rejects a similar prompt", async () => {
    const { client } = fakeClient({ similarity: 0.93 });
    const judge = async () => 0.02;
    const cache = new SemanticCache({ client, spaceId: "s", similarityThreshold: 0.5, judge });
    await cache.store("Summarize the Q3 call.", "Revenue rose 4%.", SCOPE);

    const result = await cache.lookup("Summarize the Q4 call.", SCOPE);

    assert.equal(result.outcome, "miss");
    assert.equal(result.reuseProbability, 0.02);
  });

  it("does not ask the judge about candidates below the threshold", async () => {
    const { client } = fakeClient({ similarity: 0.3 });
    let judgeCalls = 0;
    const judge = async () => (judgeCalls++, 1);
    const cache = new SemanticCache({ client, spaceId: "s", similarityThreshold: 0.5, judge });
    await cache.store("How do I export notes?", "Use File > Export.", SCOPE);

    await cache.lookup("What is the capital of France?", SCOPE);

    assert.equal(judgeCalls, 0);
  });

  it("never returns an entry from another scope", async () => {
    const { client } = fakeClient({ similarity: 0.99 });
    const cache = new SemanticCache({ client, spaceId: "s", similarityThreshold: 0.5 });
    await cache.store("How do I export notes?", "Support answer.", SCOPE);
    const billing = SemanticCache.scope({
      model: "test-model",
      systemPrompt: "You handle billing.",
    });

    const result = await cache.lookup("How do I export notes?", billing);

    assert.equal(result.outcome, "miss");
  });
});

describe("getOrGenerate", () => {
  it("calls the model and stores the answer on a miss, and not on a hit", async () => {
    const { client, calls } = fakeClient();
    const cache = new SemanticCache({ client, spaceId: "s", similarityThreshold: 0.8 });
    let modelCalls = 0;
    const generate = async () => (modelCalls++, "Use File > Export.");

    const first = await cache.getOrGenerate("How do I export notes?", SCOPE, generate);
    const second = await cache.getOrGenerate("How do I export notes?", SCOPE, generate);

    assert.equal(first.outcome, "miss");
    assert.equal(first.storedMemoryId, "m0");
    assert.equal(second.outcome, "exact");
    assert.equal(second.storedMemoryId, null);
    assert.equal(modelCalls, 1);
    assert.equal(calls.create, 1);
  });
});

describe("normalize", () => {
  it("ignores case, surrounding space, and runs of whitespace", () => {
    assert.equal(normalize("  How do I\texport   NOTES? "), "how do i export notes?");
  });

  it("keeps everything else, including punctuation", () => {
    assert.notEqual(normalize("Export notes?"), normalize("Export notes!"));
  });
});

describe("liveFilter", () => {
  it("selects entries in the scope that have not expired", () => {
    const filter = liveFilter(SCOPE);
    assert.match(filter, new RegExp(`CAST\\(val\\('\\$\\.scope'\\) AS text\\) = '${SCOPE}'`));
    assert.match(filter, /CAST\(val\('\$\.expires_at'\) AS bigint\) > \d+/);
  });

  it("refuses anything that is not a scope hash, since it is spliced into the filter", () => {
    assert.throws(() => liveFilter("x' OR TRUE OR '"), /scope must come from SemanticCache.scope/);
  });
});

describe("scope", () => {
  it("differs when anything that changes the answer differs", () => {
    const base = { model: "m", systemPrompt: "p", tenant: "t" };
    const scopes = new Set([
      SemanticCache.scope(base),
      SemanticCache.scope({ ...base, model: "m2" }),
      SemanticCache.scope({ ...base, systemPrompt: "p2" }),
      SemanticCache.scope({ ...base, tenant: "t2" }),
      SemanticCache.scope({ ...base, version: "2" }),
    ]);
    assert.equal(scopes.size, 5);
  });
});
