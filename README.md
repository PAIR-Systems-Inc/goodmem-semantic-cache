# goodmem-semantic-cache

A semantic cache for LLM responses, built on [GoodMem](https://goodmem.ai) with the Node.js SDK.
It is the working example for the GoodMem blog post
[Cachemaxxing: What a Semantic Cache Is, and Building One on GoodMem](https://goodmem.ai/blog/semantic-caching-with-goodmem/).

A semantic cache returns a stored answer when a new prompt means the same thing as one already
answered, so the model is not called. The hard part is "means the same thing". Embedding
similarity measures whether two questions are about the same topic, not whether they have the same
answer, and this repository measures how often that difference serves a wrong answer and what it
takes to stop it.

## How a lookup works

```
prompt ──► 1. exact match? ──yes──► serve cached answer
               │ no
               ▼
           2. nearest entry similar enough? ──no──► miss: call the model, store the answer
               │ yes
               ▼
           3. judge: can that answer be reused? ──no──► miss
               │ yes
               ▼
           serve cached answer
```

1. **Exact match.** A metadata query for an entry with the same normalized prompt. It finds an
   entry the moment it is written, before GoodMem has embedded it.
2. **Similarity.** A vector search for the nearest entry. Below the threshold, it is a miss.
3. **Judge.** An optional second model decides whether the cached answer fits the new prompt. This
   repository uses [Jev](https://openrouter.ai/docs/guides/community/jev), a decision model that
   returns a probability, and includes a chat-model judge for comparison.

Every step only considers **live** entries: those in the same **scope** and not yet expired. The
scope is a hash of everything other than the prompt that changes the right answer: the model, the
system prompt, the tenant, and a version number.

## What the measurements showed

Two sets of labeled question pairs are in [`data/`](data/): 51 that I wrote, and 60 written
separately without access to the judge's instructions. Each pair is a cached question, a new
question, and whether the cached answer could be returned unchanged. Results are in
[`results/`](results/); embeddings are `text-embedding-3-small` unless noted.

| On the held-out 60 pairs (25 reusable)            | Wrong answers served | Reusable answers served | Judge time, median |
| ------------------------------------------------- | -------------------- | ----------------------- | ------------------ |
| Similarity only, threshold 0.50 (best precision)  | 29 of 54             | 25 of 25                | –                  |
| Similarity ≥ 0.55, then `gpt-5.4-nano` as judge   | 1 of 25              | 24 of 25                | 696 ms             |
| Similarity ≥ 0.55, then `typesafe/jev-1.13` judge | 0 of 24              | 24 of 25                | 170 ms             |

- With similarity alone, no threshold had a precision above 0.50 on either set. The look-alikes
  scored highest: "Celsius to Fahrenheit" against "Fahrenheit to Celsius" scored 0.948. Switching to
  `text-embedding-3-large` raised the best precision on the first set from 0.50 to 0.58.
- A lookup that reaches the vector search took a median of about 240 ms, most of it the embedding
  call to OpenAI. An exact hit took under 10 ms.
- These are small, hand-written sets. They show the failure clearly; they are not a benchmark, and
  your threshold should come from your own traffic.

## Run it

You need Node.js 22 or later, a GoodMem server and API key
([install](https://docs.goodmem.ai/docs/how-to/install)), an OpenAI API key, and an OpenRouter API
key for Jev.

```bash
npm install
export GOODMEM_BASE_URL=https://localhost:8080
export GOODMEM_API_KEY=gm_...
export OPENAI_API_KEY=sk-...
export OPENROUTER_API_KEY=sk-or-...
# For a local server with a self-signed or mkcert certificate:
export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"

npm run setup                                    # create an embedder and a cache space
npm run demo                                     # five requests, one per path
npm run evaluate                                 # similarity only, on data/pairs.json
npm run evaluate -- --judge jev                  # with Jev as the judge
npm run evaluate -- --pairs pairs-heldout.json --judge chat
npm run teardown                                 # delete the space and embedder
```

`npm run check` runs the type check, the unit tests (no server or keys needed), and the formatter.

## Reading the code

Start with [`src/semanticCache.js`](src/semanticCache.js). It is the whole cache, and every other
file uses it.

| File                                           | What it shows                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| [`src/semanticCache.js`](src/semanticCache.js) | storing an entry, the three-step lookup, scopes, expiry            |
| [`src/judges.js`](src/judges.js)               | asking Jev, or a chat model, whether an answer can be reused       |
| [`src/demo.js`](src/demo.js)                   | a miss, an exact hit, a paraphrase, a look-alike, another scope    |
| [`src/evaluate.js`](src/evaluate.js)           | measuring precision and recall on labeled pairs                    |
| [`src/setup.js`](src/setup.js)                 | the GoodMem resources a cache needs                                |
| [`test/`](test/)                               | the lookup paths, tested against an in-memory stand-in for GoodMem |

## Details worth knowing

- **Scores.** GoodMem's `relevanceScore` is pgvector's negative inner product, where smaller means
  closer. OpenAI embeddings have length 1, so the inner product is cosine similarity, and the cache
  negates the score to get it.
- **Filters on strings.** Metadata values are JSON. Compare them as
  `CAST(val('$.field') AS text) = '...'`; comparing the JSON value to a string literal is an error.
- **Write delay.** A new entry is embedded by a background job, about 0.6 seconds on a local server.
  Until then only the exact-match step can find it.
- **Expiry.** GoodMem has no time-to-live. Entries carry `expires_at`, lookups ignore expired ones,
  and `purgeExpired()` deletes them; run it on a schedule.
- **Isolation.** A space has an owner, roles, and grants, and an API key can be limited to one space.
  For a cache that must not share answers between customers, use a space per customer, not only a
  scope per customer.
- **What gets cached.** The cache stores whatever the model said. In the demo, `gpt-5.4-mini`
  described menus in an app that does not exist, and on two runs gave opposite answers about whether
  that app can import PDFs. A cache would serve either answer until it expired.

## License

[Apache-2.0](LICENSE)
