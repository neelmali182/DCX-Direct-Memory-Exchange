/**
 * LLM provider adapter (stub).
 *
 * In the routing logic, the LLM is used to interpret the situation
 * and produce a cleaned summary that is then passed to Jev for the
 * final typed decision.
 *
 * For v0.1, use the FakeProvider for testing.
 */

import type { DecisionProvider, ProviderInput, ProviderResult } from "../types.js";

/**
 * LLM adapter — wraps an LLM API (OpenAI, Anthropic, etc.).
 */
export class LlmProvider implements DecisionProvider {
  readonly name = "llm";

  constructor(
    private readonly _apiKey?: string,
    private readonly _model?: string,
  ) {
    // In production, initialize the LLM client here
  }

  async decide(input: ProviderInput): Promise<ProviderResult> {
    // TODO: Replace with real LLM call
    //
    // const prompt = this.buildPrompt(input);
    // const response = await this.client.chat(prompt);
    // const parsed = this.parseResponse(response, input.options);
    //
    // return {
    //   answer: parsed.answer,
    //   confidence: parsed.confidence,
    // };

    throw new Error(
      "LlmProvider is a stub. Use FakeProvider for testing, " +
      "or implement a real LLM integration in this file.",
    );
  }
}
