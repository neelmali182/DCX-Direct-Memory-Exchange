/**
 * Risk policy — runs first, plain code, no model.
 *
 * If the request is tagged high risk, skip direct reuse and route
 * to a human regardless of confidence.
 */

import type { Config, RiskLevel } from "./types.js";

export interface RiskCheckResult {
  high: boolean;
  reason: string | null;
}

/**
 * Check if a request's risk level + the config's risk policy require
 * human review (blocking direct reuse).
 */
export function checkRisk(
  requestRisk: RiskLevel | undefined,
  config: Config,
): RiskCheckResult {
  const risk = requestRisk ?? "low";

  if (risk === "high") {
    return {
      high: true,
      reason: `Request tagged as high risk — policy: ${config.risk_policy.high_risk_behavior}`,
    };
  }

  return { high: false, reason: null };
}

/**
 * Check if specific action tags overlap with the configured high-risk tags.
 * Useful when the agent provides action tags instead of a simple risk level.
 */
export function checkRiskTags(
  tags: string[],
  config: Config,
): RiskCheckResult {
  const blocked = tags.filter((t) =>
    config.risk_policy.high_risk_action_tags.includes(t.toLowerCase()),
  );

  if (blocked.length > 0) {
    return {
      high: true,
      reason: `Blocked by high-risk tags: ${blocked.join(", ")}`,
    };
  }

  return { high: false, reason: null };
}
