/**
 * Memory confidence calculation.
 *
 * memory_confidence answers: "How much should we trust this saved answer
 * for this question right now?"
 *
 * Formula:
 *   initial = human_verified ? 0.98 : model_confidence × source_trust
 *   memory_confidence = (confirmations + k × initial) / (confirmations + contradictions + k)
 *
 * Safety rules:
 *   1. Earned trust cap: if not human-verified and confirmations < min_confirmations_for_reuse,
 *      cap at unproven_cap (default 0.85).
 *   2. Expiry: if past expires_at, multiply by 0.5.
 */

import type { DecisionRecord, Config } from "./types.js";

/**
 * Compute the memory confidence for a decision record.
 */
export function memoryConfidence(
  record: DecisionRecord,
  config: Config,
  now: Date = new Date(),
): number {
  const trustMap: Record<string, number> = {
    human: config.source_trust.human,
    jev: config.source_trust.jev,
    llm: config.source_trust.llm,
  };

  const sourceTrust = trustMap[record.source] ?? 0.5;

  // Initial estimate: human-verified gets 0.98, otherwise model_confidence × source_trust
  const initial = record.human_verified
    ? 0.98
    : (record.model_confidence ?? 0.5) * sourceTrust;

  const { confirmations, contradictions } = record.stats;
  const k = config.k;

  // Bayesian-style update with prior strength k
  let m = (confirmations + k * initial) / (confirmations + contradictions + k);

  // Safety rule 1: earned trust cap
  if (!record.human_verified && confirmations < config.min_confirmations_for_reuse) {
    m = Math.min(m, config.unproven_cap);
  }

  // Safety rule 2: expiry penalty
  if (now > new Date(record.expires_at)) {
    m *= 0.5;
  }

  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, m));
}
