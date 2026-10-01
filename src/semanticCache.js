// @ts-check
import { createHash } from "node:crypto";

/**
 * @typedef {import("@pairsystems/goodmem").Goodmem} Goodmem
 * @typedef {import("@pairsystems/goodmem").MemoryResponseShape} Memory
 */

/**
 * Decides whether a cached answer can be reused for a new prompt.
 * Returns the probability, from 0 to 1, that it can.
 *
 * @callback Judge
 * @param {string} cachedPrompt the prompt the cached answer was written for
 * @param {string} newPrompt the prompt being looked up
 * @returns {Promise<number>}
 */

/**
 * The result of a lookup.
 *
 * `outcome` is "exact" when the normalized prompt was cached before,
 * "semantic" when a similar prompt was cached and passed every check, and
 * "miss" otherwise. `similarity` and `reuseProbability` are reported on misses
 * too, because they are what you look at when tuning the cache.
 *
 * @typedef {object} LookupResult
 * @property {"exact" | "semantic" | "miss"} outcome
 * @property {string | null} response the cached answer, or null on a miss
 * @property {string | null} cachedPrompt the prompt that answer was written for
 * @property {number | null} similarity cosine similarity to the nearest live entry
 * @property {number | null} reuseProbability the judge's verdict, if the judge ran
 * @property {number} lookupMs time spent in the lookup
 */

/**
 * The nearest live cache entry to a prompt.
 *
 * @typedef {object} Neighbour
 * @property {number} similarity cosine similarity, 1.0 for identical direction
 * @property {Memory} memory the cache entry
 */

/**
 * A semantic cache for LLM responses, stored in one GoodMem space.
 *
 * Each cache entry is one GoodMem memory:
 *   - its content is the prompt, which is the text GoodMem embeds and searches;
 *   - its metadata holds the response, the scope, a hash of the normalized
 *     prompt, and an expiry time.
 *
 * A lookup makes up to three checks, cheapest first:
 *   1. Exact: is there a live entry with the same normalized prompt?
 *   2. Similar: is the nearest live entry's similarity at least the threshold?
 *   3. Judge (optional): does a judge model agree the answer can be reused?
 *
 * "Live" means in the same scope and not expired. The scope is a hash of
 * everything other than the prompt that changes the right answer: the model,
 * the system prompt, the tenant, and a version you can bump to invalidate.
 */
export class SemanticCache {
  /** @type {Goodmem} */ #client;
  /** @type {string} */ #spaceId;
  /** @type {number} */ #similarityThreshold;
  /** @type {number} */ #ttlSeconds;
  /** @type {Judge | null} */ #judge;
  /** @type {number} */ #judgeMinProbability;

  /**
   * @param {object} options
   * @param {Goodmem} options.client a GoodMem SDK client
   * @param {string} options.spaceId the space that holds cache entries
   * @param {number} options.similarityThreshold minimum cosine similarity for a
   *   semantic match. Without a judge this is the only safeguard, so it must be
   *   tuned on your own traffic. With a judge it can be low (0.5 to 0.6), because
   *   it only decides which candidates the judge sees.
   * @param {number} [options.ttlSeconds] how long an entry stays eligible
   * @param {Judge | null} [options.judge] optional verifier for semantic matches
   * @param {number} [options.judgeMinProbability] minimum judge probability
   */
  constructor({
    client,
    spaceId,
    similarityThreshold,
    ttlSeconds = 24 * 60 * 60,
    judge = null,
    judgeMinProbability = 0.5,
  }) {
    this.#client = client;
    this.#spaceId = spaceId;
    this.#similarityThreshold = similarityThreshold;
    this.#ttlSeconds = ttlSeconds;
    this.#judge = judge;
    this.#judgeMinProbability = judgeMinProbability;
  }

  /**
   * Returns the scope for a request: a hash of everything, other than the
   * prompt, that changes the right answer. Requests share cache entries only
   * when their scopes are equal.
   *
   * @param {object} parts
   * @param {string} parts.model the model that writes the answers
   * @param {string} [parts.systemPrompt] instructions sent with every prompt
   * @param {string} [parts.tenant] customer, user, or segment that must not share answers
   * @param {string} [parts.version] change this to invalidate every entry in the scope
   * @returns {string} 64 hex characters
   */
  static scope({ model, systemPrompt = "", tenant = "", version = "1" }) {
    return sha256(JSON.stringify({ model, systemPrompt, tenant, version }));
  }

  /**
   * Looks a prompt up without calling any model.
   *
   * @param {string} prompt
   * @param {string} scope from {@link SemanticCache.scope}
   * @returns {Promise<LookupResult>}
   */
  async lookup(prompt, scope) {
    const started = performance.now();
    const elapsed = () => performance.now() - started;

    // 1. Exact match. This is a metadata query, not a vector search, so it
    //    also finds entries that GoodMem has not finished embedding yet.
    const exact = await this.#findExact(prompt, scope);
    if (exact) {
      return result("exact", exact, 1, null, elapsed());
    }

    // 2. Nearest neighbour by meaning.
    const nearest = await this.findNearest(prompt, scope);
    if (!nearest || nearest.similarity < this.#similarityThreshold) {
      return result("miss", null, nearest?.similarity ?? null, null, elapsed());
    }

    // 3. Optional judge. Similarity measures topic, not whether two questions
    //    have the same answer, so a near match is only a candidate.
    if (!this.#judge) {
      return result("semantic", nearest.memory, nearest.similarity, null, elapsed());
    }
    const probability = await this.#judge(cachedPromptOf(nearest.memory), prompt);
    const reusable = probability >= this.#judgeMinProbability;
    return result(
      reusable ? "semantic" : "miss",
      reusable ? nearest.memory : null,
      nearest.similarity,
      probability,
      elapsed(),
    );
  }

  /**
   * Stores an answer. The entry can be found by exact match at once and by
   * similarity once GoodMem's background job has embedded it, usually well
   * under a second later.
   *
   * @param {string} prompt
   * @param {string} response
   * @param {string} scope
   * @returns {Promise<string>} the new entry's memory ID
   */
  async store(prompt, response, scope) {
    const now = Date.now();
    const memory = await this.#client.memories.create({
      spaceId: this.#spaceId,
      originalContent: prompt,
      contentType: "text/plain",
      // One prompt, one vector. Chunking would split a long prompt into
      // passages and let a match on one passage stand for the whole prompt.
      chunkingConfig: { none: {} },
      metadata: {
        scope,
        prompt_sha256: sha256(normalize(prompt)),
        prompt,
        response,
        created_at: now,
        expires_at: now + this.#ttlSeconds * 1000,
      },
    });
    return memory.memoryId;
  }

  /**
   * The usual entry point: return a cached answer if one passes every check,
   * otherwise call `generate`, store what it returns, and return that.
   *
   * @param {string} prompt
   * @param {string} scope
   * @param {(prompt: string) => Promise<string>} generate calls the model
   * @returns {Promise<LookupResult & { response: string, generateMs: number | null, storedMemoryId: string | null }>}
   */
  async getOrGenerate(prompt, scope, generate) {
    const found = await this.lookup(prompt, scope);
    if (found.response !== null) {
      return { ...found, response: found.response, generateMs: null, storedMemoryId: null };
    }
    const started = performance.now();
    const response = await generate(prompt);
    const generateMs = performance.now() - started;
    const storedMemoryId = await this.store(prompt, response, scope);
    return { ...found, response, generateMs, storedMemoryId };
  }

  /**
   * Finds the live entry closest in meaning to a prompt, whatever its
   * similarity. `lookup` uses it; it is public because it is what you need
   * when choosing a threshold.
   *
   * @param {string} prompt
   * @param {string} scope
   * @returns {Promise<Neighbour | null>}
   */
  async findNearest(prompt, scope) {
    // RetrieveMemory streams events. With fetchMemory set, each matching
    // memory arrives once as a `memoryDefinition`, and each matching chunk as
    // a `retrievedItem` that points back to it by position (`memoryIndex`).
    /** @type {Memory[]} */
    const memories = [];
    /** @type {{ similarity: number, memoryIndex: number } | null} */
    let best = null;

    for await (const event of this.#client.memories.retrieve({
      message: prompt,
      spaceKeys: [{ spaceId: this.#spaceId, filter: liveFilter(scope) }],
      requestedSize: 1,
      fetchMemory: true,
      fetchMemoryContent: false,
    })) {
      if (event.memoryDefinition) {
        memories.push(event.memoryDefinition);
      }
      const chunk = event.retrievedItem?.chunk;
      if (chunk) {
        // GoodMem reports pgvector's negative inner product, where smaller
        // means closer. OpenAI embeddings are normalized to length 1, so the
        // inner product is the cosine similarity, and negating restores it.
        const similarity = -chunk.relevanceScore;
        if (!best || similarity > best.similarity) {
          best = { similarity, memoryIndex: chunk.memoryIndex };
        }
      }
    }

    const memory = best ? memories[best.memoryIndex] : undefined;
    return best && memory ? { similarity: best.similarity, memory } : null;
  }

  /**
   * Waits until an entry can be found by similarity, not only by exact match.
   *
   * @param {string} memoryId
   * @param {number} [timeoutMs]
   */
  async waitUntilSearchable(memoryId, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { processingStatus } = await this.#client.memories.get(memoryId);
      if (processingStatus === "COMPLETED") return;
      if (processingStatus === "FAILED") throw new Error(`Embedding failed for ${memoryId}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`${memoryId} was not searchable after ${timeoutMs} ms`);
  }

  /**
   * Deletes expired entries. Lookups already ignore them; this reclaims the
   * space. GoodMem has no built-in expiry, so run this on a schedule.
   */
  async purgeExpired() {
    await this.#client.memories.batchDelete({
      requests: [
        {
          filterSelector: {
            spaceId: this.#spaceId,
            filter: `CAST(val('$.expires_at') AS bigint) <= ${Date.now()}`,
          },
        },
      ],
    });
  }

  /**
   * @param {string} prompt
   * @param {string} scope
   * @returns {Promise<Memory | null>}
   */
  async #findExact(prompt, scope) {
    const hash = sha256(normalize(prompt));
    const page = await this.#client.memories.list(this.#spaceId, {
      filter: `${liveFilter(scope)} AND CAST(val('$.prompt_sha256') AS text) = '${hash}'`,
      maxResults: 1,
    });
    return page.items[0] ?? null;
  }
}

/**
 * Normalizes a prompt for exact matching: Unicode compatibility forms, case,
 * and runs of whitespace stop mattering. Nothing else is changed, because
 * anything more aggressive starts to change meaning.
 *
 * @param {string} prompt
 */
export function normalize(prompt) {
  return prompt.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The GoodMem filter that selects live entries: same scope, not yet expired.
 *
 * Two details of the filter language matter here. Metadata values are JSON,
 * so a string comparison needs CAST(... AS text); comparing the JSON value to
 * a string literal directly is an error. And the scope is spliced into the
 * filter text, so it is checked to be a hash before it is used.
 *
 * @param {string} scope
 */
export function liveFilter(scope) {
  if (!/^[0-9a-f]{64}$/.test(scope)) {
    throw new Error("scope must come from SemanticCache.scope()");
  }
  return (
    `CAST(val('$.scope') AS text) = '${scope}' ` +
    `AND CAST(val('$.expires_at') AS bigint) > ${Date.now()}`
  );
}

/** @param {string} text */
function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * @param {Memory} memory
 * @returns {string}
 */
function cachedPromptOf(memory) {
  return String(memory.metadata?.prompt ?? "");
}

/**
 * @param {LookupResult["outcome"]} outcome
 * @param {Memory | null} memory
 * @param {number | null} similarity
 * @param {number | null} reuseProbability
 * @param {number} lookupMs
 * @returns {LookupResult}
 */
function result(outcome, memory, similarity, reuseProbability, lookupMs) {
  return {
    outcome,
    response: memory ? String(memory.metadata?.response ?? "") : null,
    cachedPrompt: memory ? cachedPromptOf(memory) : null,
    similarity,
    reuseProbability,
    lookupMs,
  };
}
