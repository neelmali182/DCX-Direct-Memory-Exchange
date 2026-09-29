/**
 * Audit — background sampling of direct-reuse decisions.
 *
 * For audit_rate % of direct-reuse hits, also call Jev in the
 * background and compare. This is how the system notices drift
 * without waiting for outcome reports.
 */

import type { Config, DecisionProvider, DecisionStore } from "./types.js";
import { memoryConfidence } from "./confidence.js";

/**
 * Run an audit check on a specific decision record.
 * Called from the router during direct-reuse sampling.
 */
export async function auditDecision(
  decisionId: string,
  store: DecisionStore,
  config: Config,
  jevProvider: DecisionProvider,
): Promise<{ agrees: boolean; jevAnswer: string }> {
  const now = new Date();
  const record = store.getById(decisionId);

  if (!record) {
    throw new Error(`Decision not found: ${decisionId}`);
  }

  const result = await jevProvider.decide({
    question: record.question,
    options: record.options,
    facts: record.facts,
  });

  const agrees = result.answer === record.answer;

  store.update(decisionId, (r) => {
    const updated = { ...r, stats: { ...r.stats } };
    if (agrees) {
      updated.stats.confirmations += 1;
    } else {
      updated.stats.contradictions += 1;
    }
    updated.memory_confidence = memoryConfidence(updated, config, now);
    return updated;
  });

  store.appendEvent({
    ts: now.toISOString(),
    event: "audit",
    decision_id: decisionId,
    jev_answer: result.answer,
    stored_answer: record.answer,
    agrees,
  });

  // If Jev disagrees, flag for review
  if (!agrees) {
    store.appendEvent({
      ts: now.toISOString(),
      event: "audit_flag",
      decision_id: decisionId,
      reason: `Audit disagreement: stored "${record.answer}", Jev says "${result.answer}"`,
    });
  }

  return { agrees, jevAnswer: result.answer };
}

/**
 * Run a batch audit on a random sample of decisions.
 * Useful for scheduled/periodic audits.
 */
export async function batchAudit(
  store: DecisionStore,
  config: Config,
  jevProvider: DecisionProvider,
  sampleRate?: number,
): Promise<{ total: number; audited: number; agreements: number; disagreements: number }> {
  const rate = sampleRate ?? config.audit_rate;
  const all = store.list();
  let audited = 0;
  let agreements = 0;
  let disagreements = 0;

  for (const record of all) {
    if (Math.random() > rate) continue;

    try {
      const result = await auditDecision(record.id, store, config, jevProvider);
      audited++;
      if (result.agrees) {
        agreements++;
      } else {
        disagreements++;
      }
    } catch {
      // Skip failures
    }
  }

  return { total: all.length, audited, agreements, disagreements };
}
