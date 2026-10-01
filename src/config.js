// @ts-check
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Goodmem } from "@pairsystems/goodmem";
import { chatModelJudge, jevJudge } from "./judges.js";

/** Settings shared by the scripts. Every one can be overridden from the environment. */
export const settings = {
  goodmemBaseUrl: process.env.GOODMEM_BASE_URL ?? "https://localhost:8080",
  /** Any embedding model GoodMem knows; see the SDK's EmbedderModelIdentifier. */
  embeddingModel: /** @type {import("@pairsystems/goodmem").EmbedderModelIdentifier} */ (
    process.env.EMBEDDING_MODEL ?? "text-embedding-3-small"
  ),
  chatModel: process.env.CHAT_MODEL ?? "gpt-5.4-mini",
  /** "jev", "chat", or "none" */
  judge: process.env.JUDGE ?? "jev",
  jevModel: process.env.JEV_MODEL ?? "typesafe/jev-1.13",
  chatJudgeModel: process.env.CHAT_JUDGE_MODEL ?? "gpt-5.4-nano",
};

/**
 * @param {string} name
 * @returns {string}
 */
export function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Set ${name} before running this script.`);
  }
  return value;
}

export function goodmemClient() {
  return new Goodmem({
    baseUrl: settings.goodmemBaseUrl,
    apiKey: requireEnv("GOODMEM_API_KEY"),
    timeoutMs: 30_000,
  });
}

/**
 * Builds the judge named by `settings.judge`, with its display name.
 *
 * @param {string} [kind]
 * @returns {{ name: string, judge: import("./semanticCache.js").Judge | null }}
 */
export function judgeFromSettings(kind = settings.judge) {
  switch (kind) {
    case "jev":
      return {
        name: settings.jevModel,
        judge: jevJudge({ apiKey: requireEnv("OPENROUTER_API_KEY"), model: settings.jevModel }),
      };
    case "chat":
      return {
        name: settings.chatJudgeModel,
        judge: chatModelJudge({ model: settings.chatJudgeModel }),
      };
    case "none":
      return { name: "none", judge: null };
    default:
      throw new Error(`Unknown judge "${kind}". Use jev, chat, or none.`);
  }
}

// `npm run setup` records the space and embedder it created, so the other
// scripts can find them and `npm run teardown` can delete them.
const STATE_FILE = new URL("../.cache-state.json", import.meta.url);

/**
 * @typedef {object} CacheState
 * @property {string} spaceId
 * @property {string} embedderId
 * @property {string} embeddingModel
 */

/** @returns {CacheState} */
export function readState() {
  if (!existsSync(STATE_FILE)) {
    throw new Error("No cache space found. Run `npm run setup` first.");
  }
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}

/** @param {CacheState} state */
export function writeState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

export function clearState() {
  rmSync(STATE_FILE, { force: true });
}
