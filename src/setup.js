// @ts-check
// Creates the two GoodMem resources the cache needs: an embedder, which turns
// text into vectors, and a space, which stores the cache entries.

import { goodmemClient, requireEnv, settings, writeState } from "./config.js";

const client = goodmemClient();

const embedder = await client.embedders.create(
  {
    displayName: `semantic cache: ${settings.embeddingModel}`,
    modelIdentifier: settings.embeddingModel,
  },
  { apiKey: requireEnv("OPENAI_API_KEY") },
);

const space = await client.spaces.create({
  name: `semantic-cache-${Date.now()}`,
  spaceEmbedders: [{ embedderId: embedder.embedderId }],
  // A cached prompt is one entry, not a document of passages.
  defaultChunkingConfig: { none: {} },
});

writeState({
  spaceId: space.spaceId,
  embedderId: embedder.embedderId,
  embeddingModel: settings.embeddingModel,
});
console.log(`Created embedder ${embedder.embedderId} (${settings.embeddingModel})`);
console.log(`Created space    ${space.spaceId}`);
