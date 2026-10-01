// @ts-check
// Deletes the space (and every cache entry in it) and the embedder.

import { clearState, goodmemClient, readState } from "./config.js";

const client = goodmemClient();
const { spaceId, embedderId } = readState();

await client.spaces.delete(spaceId);
await client.embedders.delete(embedderId);
clearState();
console.log(`Deleted space ${spaceId} and embedder ${embedderId}.`);
