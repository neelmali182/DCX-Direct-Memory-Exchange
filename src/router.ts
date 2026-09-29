/**
 * Router — the core decision logic.
 *
 * Implements the flow from section 3 of the design:
 *   1. Risk policy check
 *   2. Normalize + hash → look up in memory
 *   3. Route by memory_confidence (hit) or cascade from Jev (miss)
 *   4. Save/update memory + append to audit log
 */

import type {
  Config,
  DecisionProvider,
  DecisionRecord,
  DecisionRequest,
  DecisionResponse,
  DecisionStore,
  EvidencePayload,
  RoutePath,
  Source,
} from "./types.js";
import { makeKey } from "./canonical.js";
import { memoryConfidence } from "./confidence.js";
import { checkRisk } from "./risk.js";
import { HumanReviewNeeded } from "./providers/human.js";

export interface RouterDeps {
  store: DecisionStore;
  config: Config;
  jevProvider: DecisionProvider;
  llmProvider: DecisionProvider;
  humanProvider: DecisionProvider;
}

/**
 * The main decision function.
 *
 * Given a request, check memory, route through providers as needed,
 * and return the decision.
 */
export async function decide(
  req: DecisionRequest,
  deps: RouterDeps,
): Promise<DecisionResponse> {
  const { store, config, jevProvider, llmProvider, humanProvider } = deps;
  const now = new Date();

  // 1. Risk policy check
  const riskResult = checkRisk(req.risk, config);
  const highRisk = riskResult.high;

  // 2. Look up in memory
  const key = makeKey(req.question, req.options, req.facts);
  const existing = store.get(key);

  if (existing) {
    const mc = memoryConfidence(existing, config, now);
    // Update the stored confidence
    store.update(existing.id, (r) => ({ ...r, memory_confidence: mc }));

    // High risk: skip ALL memory-based paths, go straight to human
    if (highRisk) {
      return handleCascade(req, key, store, config, jevProvider, llmProvider, humanProvider, highRisk, now);
    }

    // 3a. Route by memory confidence (memory hit)
    if (mc >= config.thresholds.direct_reuse) {
      return handleDirectReuse(existing, mc, store, config, jevProvider, now);
    }

    if (mc >= config.thresholds.jev_with_evidence) {
      return handleJevWithEvidence(req, existing, mc, store, config, jevProvider, now);
    }

    if (mc >= config.thresholds.llm_plus_jev) {
      return handleLlmPlusJev(req, existing, mc, store, config, jevProvider, llmProvider, now);
    }

    // Very low confidence: treat as miss
  }

  // 3b. Miss (or very weak memory): cascade from Jev
  return handleCascade(req, key, store, config, jevProvider, llmProvider, humanProvider, highRisk, now);
}

// ─── Hit handlers ───────────────────────────────────────────────────────────

async function handleDirectReuse(
  record: DecisionRecord,
  mc: number,
  store: DecisionStore,
  config: Config,
  jevProvider: DecisionProvider,
  now: Date,
): Promise<DecisionResponse> {
  // Update usage stats
  store.update(record.id, (r) => ({
    ...r,
    stats: { ...r.stats, uses: r.stats.uses + 1 },
    last_used_at: now.toISOString(),
  }));

  // Log the reuse event
  store.appendEvent({
    ts: now.toISOString(),
    event: "reuse",
    decision_id: record.id,
    memory_confidence: mc,
    path: "direct",
  });

  // Audit sampling: for audit_rate % of reuses, also call Jev in the background
  if (Math.random() < config.audit_rate) {
    runAuditCheck(record, store, config, jevProvider, now).catch(() => {
      // audit failures are not critical
    });
  }

  return {
    decision_id: record.id,
    answer: record.answer,
    source: record.source,
    memory_confidence: mc,
    path: "direct_reuse",
    is_new: false,
  };
}

async function handleJevWithEvidence(
  req: DecisionRequest,
  record: DecisionRecord,
  mc: number,
  store: DecisionStore,
  config: Config,
  jevProvider: DecisionProvider,
  now: Date,
): Promise<DecisionResponse> {
  const evidence = makeEvidence(record, mc);

  try {
    const result = await jevProvider.decide({
      question: req.question,
      options: req.options,
      facts: req.facts,
      description: req.description,
      evidence,
    });

    // Did Jev agree or disagree?
    const agrees = result.answer === record.answer;

    if (agrees) {
      // Confirmation: update stats
      const updated = store.update(record.id, (r) => ({
        ...r,
        stats: { ...r.stats, confirmations: r.stats.confirmations + 1, uses: r.stats.uses + 1 },
        model_confidence: result.confidence,
        last_used_at: now.toISOString(),
        memory_confidence: memoryConfidence(
          { ...r, stats: { ...r.stats, confirmations: r.stats.confirmations + 1 } },
          config,
          now,
        ),
      }))!;

      store.appendEvent({
        ts: now.toISOString(),
        event: "jev_confirm",
        decision_id: record.id,
        memory_confidence: updated.memory_confidence,
        path: "jev_with_evidence",
      });

      return {
        decision_id: record.id,
        answer: result.answer,
        source: "jev",
        memory_confidence: updated.memory_confidence,
        path: "jev_with_evidence",
        is_new: false,
      };
    } else {
      // Contradiction: record it and save the new answer
      store.update(record.id, (r) => ({
        ...r,
        stats: { ...r.stats, contradictions: r.stats.contradictions + 1 },
      }));

      const updated = store.update(record.id, (r) => ({
        ...r,
        answer: result.answer,
        source: "jev" as Source,
        model_confidence: result.confidence,
        human_verified: false,
        last_used_at: now.toISOString(),
        stats: { ...r.stats, uses: r.stats.uses + 1 },
        memory_confidence: memoryConfidence(
          { ...r, answer: result.answer, source: "jev", model_confidence: result.confidence },
          config,
          now,
        ),
      }))!;

      store.appendEvent({
        ts: now.toISOString(),
        event: "jev_override",
        decision_id: record.id,
        old_answer: record.answer,
        new_answer: result.answer,
        memory_confidence: updated.memory_confidence,
        path: "jev_with_evidence",
      });

      return {
        decision_id: record.id,
        answer: result.answer,
        source: "jev",
        memory_confidence: updated.memory_confidence,
        path: "jev_with_evidence",
        is_new: false,
      };
    }
  } catch (err) {
    // Jev failed: fall back to existing memory answer but don't direct-reuse
    store.appendEvent({
      ts: now.toISOString(),
      event: "provider_error",
      decision_id: record.id,
      provider: "jev",
      error: String(err),
    });

    // Return existing answer with a note that it's degraded
    return {
      decision_id: record.id,
      answer: record.answer,
      source: record.source,
      memory_confidence: mc,
      path: "jev_with_evidence",
      is_new: false,
    };
  }
}

async function handleLlmPlusJev(
  req: DecisionRequest,
  record: DecisionRecord,
  mc: number,
  store: DecisionStore,
  config: Config,
  jevProvider: DecisionProvider,
  llmProvider: DecisionProvider,
  now: Date,
): Promise<DecisionResponse> {
  const evidence = makeEvidence(record, mc);

  try {
    // First: LLM interprets the situation
    const llmResult = await llmProvider.decide({
      question: req.question,
      options: req.options,
      facts: req.facts,
      description: req.description,
      evidence,
    });

    // Then: Jev gives the typed decision (with LLM's analysis as context)
    const jevResult = await jevProvider.decide({
      question: req.question,
      options: req.options,
      facts: req.facts,
      description: `LLM analysis suggests "${llmResult.answer}" (confidence: ${llmResult.confidence.toFixed(2)})`,
      evidence,
    });

    const finalAnswer = jevResult.answer;
    const agrees = finalAnswer === record.answer;

    if (agrees) {
      store.update(record.id, (r) => ({
        ...r,
        stats: { ...r.stats, confirmations: r.stats.confirmations + 1, uses: r.stats.uses + 1 },
        model_confidence: jevResult.confidence,
        last_used_at: now.toISOString(),
      }));
    } else {
      store.update(record.id, (r) => ({
        ...r,
        stats: { ...r.stats, contradictions: r.stats.contradictions + 1, uses: r.stats.uses + 1 },
        answer: finalAnswer,
        source: "jev" as Source,
        model_confidence: jevResult.confidence,
        human_verified: false,
        last_used_at: now.toISOString(),
      }));
    }

    const updated = store.getById(record.id)!;
    const newMc = memoryConfidence(updated, config, now);
    store.update(record.id, (r) => ({ ...r, memory_confidence: newMc }));

    store.appendEvent({
      ts: now.toISOString(),
      event: agrees ? "llm_jev_confirm" : "llm_jev_override",
      decision_id: record.id,
      llm_answer: llmResult.answer,
      jev_answer: jevResult.answer,
      memory_confidence: newMc,
      path: "llm_plus_jev",
    });

    return {
      decision_id: record.id,
      answer: finalAnswer,
      source: "jev",
      memory_confidence: newMc,
      path: "llm_plus_jev",
      is_new: false,
    };
  } catch (err) {
    store.appendEvent({
      ts: now.toISOString(),
      event: "provider_error",
      decision_id: record.id,
      provider: "llm_plus_jev",
      error: String(err),
    });

    // Degrade: return existing answer
    return {
      decision_id: record.id,
      answer: record.answer,
      source: record.source,
      memory_confidence: mc,
      path: "llm_plus_jev",
      is_new: false,
    };
  }
}

// ─── Miss handler (cascade) ────────────────────────────────────────────────

async function handleCascade(
  req: DecisionRequest,
  key: string,
  store: DecisionStore,
  config: Config,
  jevProvider: DecisionProvider,
  llmProvider: DecisionProvider,
  humanProvider: DecisionProvider,
  highRisk: boolean,
  now: Date,
): Promise<DecisionResponse> {
  // High risk: always go to human
  if (highRisk) {
    return sendToHuman(req, key, store, humanProvider, config, now, "high_risk");
  }

  try {
    // Try Jev first
    const jevResult = await jevProvider.decide({
      question: req.question,
      options: req.options,
      facts: req.facts,
      description: req.description,
    });

    if (jevResult.confidence >= config.thresholds.jev_with_evidence) {
      // Jev is confident enough: save and return
      return saveNewDecision(req, key, "jev", jevResult.answer, jevResult.confidence, store, config, now, "cascade");
    }

    if (jevResult.confidence >= config.thresholds.llm_plus_jev) {
      // Mid confidence: try LLM, then Jev again
      try {
        const llmResult = await llmProvider.decide({
          question: req.question,
          options: req.options,
          facts: req.facts,
          description: req.description,
        });

        const jevRetry = await jevProvider.decide({
          question: req.question,
          options: req.options,
          facts: req.facts,
          description: `LLM analysis suggests "${llmResult.answer}" (confidence: ${llmResult.confidence.toFixed(2)})`,
        });

        return saveNewDecision(req, key, "jev", jevRetry.answer, jevRetry.confidence, store, config, now, "cascade");
      } catch {
        // LLM or second Jev failed: use first Jev result
        return saveNewDecision(req, key, "jev", jevResult.answer, jevResult.confidence, store, config, now, "cascade");
      }
    }

    // Low confidence: send to human
    return sendToHuman(req, key, store, humanProvider, config, now, "low_confidence");

  } catch (err) {
    // Jev unavailable: send to human review queue
    store.appendEvent({
      ts: now.toISOString(),
      event: "provider_error",
      decision_id: "none",
      provider: "jev",
      error: String(err),
    });

    return sendToHuman(req, key, store, humanProvider, config, now, "provider_error");
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeEvidence(record: DecisionRecord, mc: number): EvidencePayload {
  return {
    answer: record.answer,
    memory_confidence: mc,
    uses: record.stats.uses,
    confirmations: record.stats.confirmations,
    contradictions: record.stats.contradictions,
  };
}

function saveNewDecision(
  req: DecisionRequest,
  key: string,
  source: Source,
  answer: string,
  modelConfidence: number,
  store: DecisionStore,
  config: Config,
  now: Date,
  path: RoutePath,
): DecisionResponse {
  const id = store.nextId();
  const expiresAt = new Date(now.getTime() + config.expiry_days * 86400000).toISOString();

  const record: DecisionRecord = {
    id,
    schema_version: 1,
    key,
    question: req.question,
    options: req.options,
    facts: req.facts,
    risk: req.risk ?? "low",
    answer,
    source,
    model_confidence: modelConfidence,
    human_verified: false,
    stats: { uses: 1, confirmations: 0, contradictions: 0 },
    memory_confidence: 0, // will be computed
    created_at: now.toISOString(),
    last_used_at: now.toISOString(),
    expires_at: expiresAt,
  };

  record.memory_confidence = memoryConfidence(record, config, now);
  store.put(record);

  store.appendEvent({
    ts: now.toISOString(),
    event: "new_decision",
    decision_id: id,
    source,
    answer,
    model_confidence: modelConfidence,
    memory_confidence: record.memory_confidence,
    path,
  });

  return {
    decision_id: id,
    answer,
    source,
    memory_confidence: record.memory_confidence,
    path,
    is_new: true,
  };
}

async function sendToHuman(
  req: DecisionRequest,
  key: string,
  store: DecisionStore,
  humanProvider: DecisionProvider,
  config: Config,
  now: Date,
  reason: string,
): Promise<DecisionResponse> {
  try {
    await humanProvider.decide({
      question: req.question,
      options: req.options,
      facts: req.facts,
      description: req.description,
    });
  } catch (err) {
    if (err instanceof HumanReviewNeeded) {
      store.appendEvent({
        ts: now.toISOString(),
        event: "sent_to_human",
        decision_id: "pending",
        review_item_id: err.reviewItemId,
        reason,
      });
    }
  }

  // Return a "pending" response — no answer yet
  return {
    decision_id: "pending",
    answer: "",
    source: "human",
    memory_confidence: 0,
    path: "human_review",
    is_new: true,
  };
}

// ─── Audit ──────────────────────────────────────────────────────────────────

async function runAuditCheck(
  record: DecisionRecord,
  store: DecisionStore,
  config: Config,
  jevProvider: DecisionProvider,
  now: Date,
): Promise<void> {
  try {
    const result = await jevProvider.decide({
      question: record.question,
      options: record.options,
      facts: record.facts,
    });

    const agrees = result.answer === record.answer;

    store.update(record.id, (r) => ({
      ...r,
      stats: {
        ...r.stats,
        confirmations: agrees ? r.stats.confirmations + 1 : r.stats.confirmations,
        contradictions: agrees ? r.stats.contradictions : r.stats.contradictions + 1,
      },
    }));

    // Recompute confidence after audit
    const updated = store.getById(record.id)!;
    const newMc = memoryConfidence(updated, config, now);
    store.update(record.id, (r) => ({ ...r, memory_confidence: newMc }));

    store.appendEvent({
      ts: now.toISOString(),
      event: "audit",
      decision_id: record.id,
      jev_answer: result.answer,
      agrees,
      memory_confidence: newMc,
    });
  } catch (err) {
    store.appendEvent({
      ts: now.toISOString(),
      event: "audit_error",
      decision_id: record.id,
      error: String(err),
    });
  }
}
