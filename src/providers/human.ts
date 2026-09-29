/**
 * Human provider — writes to the review queue instead of
 * making a model call. A human resolves it out-of-band.
 */

import type { DecisionProvider, DecisionStore, ProviderInput, ProviderResult, ReviewItem } from "../types.js";
import { randomBytes } from "node:crypto";

/**
 * "Provider" that doesn't decide — it creates a review item
 * and throws an error so the router knows no answer was produced.
 *
 * The caller should catch HumanReviewNeeded and return a pending response.
 */
export class HumanReviewNeeded extends Error {
  constructor(
    public readonly reviewItemId: string,
    message?: string,
  ) {
    super(message ?? "Decision sent to human review queue");
    this.name = "HumanReviewNeeded";
  }
}

export class HumanProvider implements DecisionProvider {
  readonly name = "human";

  constructor(private readonly store: DecisionStore) {}

  async decide(input: ProviderInput): Promise<ProviderResult> {
    const item: ReviewItem = {
      id: `rev_${randomBytes(4).toString("hex")}`,
      decision_id: null,
      question: input.question,
      options: input.options,
      facts: input.facts as Record<string, string | number | boolean>,
      description: input.description,
      reason: input.evidence
        ? `Low confidence on existing decision (memory_confidence: ${input.evidence.memory_confidence.toFixed(2)})`
        : "No existing decision and model confidence too low",
      created_at: new Date().toISOString(),
      resolved: false,
    };

    this.store.addReviewItem(item);

    throw new HumanReviewNeeded(item.id);
  }
}
