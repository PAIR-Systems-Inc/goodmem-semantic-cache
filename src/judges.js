// @ts-check
import OpenAI from "openai";

/** @typedef {import("./semanticCache.js").Judge} Judge */

/**
 * The question both judges answer. Naming the kinds of difference that change
 * an answer matters: an embedding model scores "Q3" and "Q4" as nearly the
 * same, and a judge left to its own defaults can too.
 */
const QUESTION =
  "Can the answer already written for the cached question be returned, unchanged, " +
  "as a correct answer to the new question?";
const SAME = "Both questions ask for the same information, even if they are worded differently.";
const DIFFERENT =
  "The questions differ in a way that changes the answer, such as a different date, " +
  "number, name, place, direction, or a negation.";

/**
 * A judge backed by Jev, TypeSafe's decision model, through OpenRouter.
 *
 * Jev does not generate text. It takes a state object and typed questions and
 * returns typed answers with probabilities. A `noul` question (yes or no)
 * returns the probability of yes, which is exactly what a cache judge needs:
 * the cut-off becomes a setting instead of something parsed out of prose.
 *
 * Pin a version such as "typesafe/jev-1.13" rather than "~typesafe/jev-latest",
 * so that a threshold you measured keeps meaning the same thing.
 *
 * @param {object} options
 * @param {string} options.apiKey an OpenRouter API key
 * @param {string} [options.model]
 * @returns {Judge}
 */
export function jevJudge({ apiKey, model = "typesafe/jev-1.13" }) {
  return async (cachedPrompt, newPrompt) => {
    const response = await fetch("https://openrouter.ai/api/alpha/decisions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        state: { cached_question: cachedPrompt, new_question: newPrompt },
        questions: {
          reusable: {
            type: "noul",
            instructions: QUESTION,
            criteria: { true: SAME, false: DIFFERENT },
          },
        },
      }),
    });
    if (!response.ok) {
      throw new Error(`Jev returned HTTP ${response.status}: ${await response.text()}`);
    }
    const body = await response.json();
    return body.answers.reusable.noul;
  };
}

/**
 * A judge backed by an ordinary chat model, for comparison. A chat model
 * answers in text, so the best it can give is YES or NO: probability 1 or 0.
 *
 * @param {object} options
 * @param {OpenAI} [options.openai]
 * @param {string} [options.model]
 * @returns {Judge}
 */
export function chatModelJudge({ openai = new OpenAI(), model = "gpt-5.4-nano" } = {}) {
  return async (cachedPrompt, newPrompt) => {
    const completion = await openai.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content: `${QUESTION} Answer YES if: ${SAME} Answer NO if: ${DIFFERENT} Reply with only YES or NO.`,
        },
        { role: "user", content: `Cached question: ${cachedPrompt}\nNew question: ${newPrompt}` },
      ],
    });
    return /^\s*yes/i.test(completion.choices[0]?.message.content ?? "") ? 1 : 0;
  };
}
