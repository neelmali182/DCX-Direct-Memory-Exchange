/**
 * Outcome recording — first-class API for reporting what happened
 * after the agent acted on a decision.
 *
 * Without outcome reports, the system is just a cache with audit checks.
 */

import type { Config, DecisionStore, OutcomeStatus } from "./types.js";
import { memoryConfidence } from "./confidence.js";

export interface OutcomeReport {
  decisionId: string;
  status: OutcomeStatus;
}

/**
 * Record the outcome of a decision.
 *
 * - success → confirmations += 1, extends expiry
 * - failure → contradictions += 1
 * - unknown → no change to evidence counts
 */
export function recordOutcome(
  report: OutcomeReport,
  store: DecisionStore,
  config: Config,
): void {
  const now = new Date();

  const record = store.getById(report.decisionId);
  if (!record) {
    throw new Error(`Decision not found: ${report.decisionId}`);
  }

  store.update(report.decisionId, (r) => {
    const updated = { ...r, stats: { ...r.stats } };

    switch (report.status) {
      case "success":
        updated.stats.confirmations += 1;
        // Extend expiry on success
        updated.expires_at = new Date(
          now.getTime() + config.expiry_days * 86400000,
        ).toISOString();
        break;
      case "failure":
        updated.stats.contradictions += 1;
        break;
      case "unknown":
        // No evidence change
        break;
    }

    // Recompute confidence
    updated.memory_confidence = memoryConfidence(updated, config, now);
    return updated;
  });

  store.appendEvent({
    ts: now.toISOString(),
    event: "outcome",
    decision_id: report.decisionId,
    status: report.status,
  });
}
