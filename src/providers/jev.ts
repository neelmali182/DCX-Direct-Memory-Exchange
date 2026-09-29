/**
 * Jev provider adapter (stub).
 *
 * This is a placeholder for the real TypeSafe AI Jev SDK integration.
 * In production, this would import from '@typesafe-ai/jev' or similar.
 *
 * For v0.1, we use the FakeProvider. This file shows the interface
 * that a real implementation would follow.
 */

import type { DecisionProvider, ProviderInput, ProviderResult } from "../types.js";

/**
 * Jev adapter — wraps the TypeSafe AI SDK.
 *
 * Before implementing:
 * - Read the TypeSafe docs and confirm the SDK call shape
 * - Map Jev's typed answer/probability to ProviderResult
 * - Handle failures explicitly (timeout, error, unparseable)
 */
export class JevProvider implements DecisionProvider {
  readonly name = "jev";

  constructor(
    private readonly _apiKey?: string,
    private readonly _options?: { timeout?: number },
  ) {
    // In production, initialize the Jev client here:
    // this.client = new JevClient({ apiKey, ...options });
  }

  async decide(input: ProviderInput): Promise<ProviderResult> {
    // TODO: Replace with real Jev SDK call:
    //
    // const result = await this.client.choice({
    //   question: input.question,
    //   options: input.options,
    //   context: this.formatContext(input),
    // });
    //
    // return {
    //   answer: result.topAnswer,
    //   confidence: result.topProbability,
    // };

    throw new Error(
      "JevProvider is a stub. Use FakeProvider for testing, " +
      "or implement the real Jev SDK integration in this file.",
    );
  }

  /**
   * Format the evidence and facts into context text for Jev.
   */
  private formatContext(input: ProviderInput): string {
    const parts: string[] = [];

    if (input.description) {
      parts.push(`Context: ${input.description}`);
    }

    if (Object.keys(input.facts).length > 0) {
      parts.push(`Facts: ${JSON.stringify(input.facts)}`);
    }

    if (input.evidence) {
      parts.push(
        `Previous decision: "${input.evidence.answer}" ` +
        `(memory_confidence: ${input.evidence.memory_confidence.toFixed(2)}, ` +
        `used ${input.evidence.uses} times, ` +
        `${input.evidence.confirmations} confirmations, ` +
        `${input.evidence.contradictions} contradictions)`,
      );
    }

    return parts.join("\n");
  }
}
