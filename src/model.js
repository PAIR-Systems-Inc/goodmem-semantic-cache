// @ts-check
import OpenAI from "openai";

/**
 * Returns a function that answers a prompt with a chat model. This is the
 * call a cache hit avoids.
 *
 * @param {object} options
 * @param {string} options.model
 * @param {string} options.systemPrompt
 * @param {OpenAI} [options.openai]
 * @returns {(prompt: string) => Promise<string>}
 */
export function chatModel({ model, systemPrompt, openai = new OpenAI() }) {
  return async (prompt) => {
    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
    });
    return completion.choices[0]?.message.content ?? "";
  };
}
