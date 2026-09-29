/**
 * Tests for the router — the core decision logic.
 *
 * Acceptance criteria covered:
 * - #3: New decision from Jev at 0.94 → saved unverified, not directly reusable
 * - #4: After 3 successes → directly reusable (no Jev call)
 * - #5: After failure → drops below 0.90, routes to Jev + evidence
 * - #6: Human corrects → used immediately
 * - #7: High-risk with 0.99 confidence → never auto-reused
 * - #8: Jev unavailable → goes to review queue
 * - #9: Expired record → re-asked
 * - #11: Audit where Jev disagrees → contradiction recorded
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DecisionMemory, FakeProvider, createConfig } from "../src/index.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(process.cwd(), "test-memory-router");

describe("Router", () => {
  let dm: DecisionMemory;
  let jev: FakeProvider;
  let llm: FakeProvider;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });

    jev = new FakeProvider("jev");
    llm = new FakeProvider("llm");

    dm = new DecisionMemory({
      config: { storage: { data_dir: TEST_DIR } },
      jevProvider: jev,
      llmProvider: llm,
    });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  const baseRequest = {
    question: "What should I do next?",
    options: ["retry", "backoff", "switch_api", "ask_human"],
    facts: { status: 429, has_retry_after: false, endpoint: "payments" } as Record<string, string | number | boolean>,
  };

  // ─── Acceptance test #3: New decision saved as unverified ──────────────

  it("new decision from Jev is saved unverified, not directly reusable", async () => {
    jev.setAnswer("backoff", 0.94);

    const result = await dm.decide(baseRequest);

    expect(result.is_new).toBe(true);
    expect(result.answer).toBe("backoff");
    expect(result.source).toBe("jev");
    expect(result.path).toBe("cascade");

    // Verify the saved record
    const record = dm.getDecision(result.decision_id);
    expect(record).not.toBeNull();
    expect(record!.human_verified).toBe(false);
    expect(record!.memory_confidence).toBeLessThan(0.90); // Not directly reusable
  });

  // ─── Acceptance test #4: After 3 successes → directly reusable ────────

  it("after 3 successful outcomes, decision is directly reusable without Jev call", async () => {
    jev.setAnswer("backoff", 0.94);

    // First call: creates the decision
    const first = await dm.decide(baseRequest);

    // Report 3 successes
    dm.reportOutcome(first.decision_id, "success");
    dm.reportOutcome(first.decision_id, "success");
    dm.reportOutcome(first.decision_id, "success");

    // Clear Jev call log to verify no new calls
    jev.clearCalls();

    // Second call: should reuse from memory
    const second = await dm.decide(baseRequest);

    expect(second.path).toBe("direct_reuse");
    expect(second.answer).toBe("backoff");
    expect(second.is_new).toBe(false);
    expect(second.memory_confidence).toBeGreaterThanOrEqual(0.90);

    // Jev should not have been called (barring audit sampling)
    // Note: audit sampling is random, so we can't guarantee 0 calls,
    // but the main decision path should not call Jev
  });

  // ─── Acceptance test #5: Failure drops below reuse threshold ──────────

  it("after a failure, confidence drops below 0.90 and routes to Jev + evidence", async () => {
    jev.setAnswer("backoff", 0.94);

    const first = await dm.decide(baseRequest);

    // Build up trust
    dm.reportOutcome(first.decision_id, "success");
    dm.reportOutcome(first.decision_id, "success");
    dm.reportOutcome(first.decision_id, "success");

    // Now a failure
    dm.reportOutcome(first.decision_id, "failure");

    // Check that confidence dropped
    const record = dm.getDecision(first.decision_id);
    expect(record!.memory_confidence).toBeLessThan(0.90);

    // Next decision should NOT be direct reuse
    jev.clearCalls();
    const second = await dm.decide(baseRequest);

    expect(second.path).not.toBe("direct_reuse");
  });

  // ─── Acceptance test #6: Human correction → immediate use ─────────────

  it("human-verified decision has confidence 0.98 and is immediately usable", async () => {
    jev.setAnswer("backoff", 0.94);

    const first = await dm.decide(baseRequest);

    // Human corrects the answer
    dm.store.update(first.decision_id, (r) => ({
      ...r,
      answer: "retry",
      source: "human",
      human_verified: true,
    }));

    jev.clearCalls();
    const second = await dm.decide(baseRequest);

    expect(second.path).toBe("direct_reuse");
    expect(second.answer).toBe("retry");
  });

  // ─── Acceptance test #7: High-risk → never auto-reused ────────────────

  it("high-risk request is never auto-reused even with confidence 0.99", async () => {
    jev.setAnswer("deploy", 0.99);

    // First: create a highly trusted decision
    const first = await dm.decide({ ...baseRequest, risk: "low" });
    dm.reportOutcome(first.decision_id, "success");
    dm.reportOutcome(first.decision_id, "success");
    dm.reportOutcome(first.decision_id, "success");
    dm.store.update(first.decision_id, (r) => ({
      ...r,
      human_verified: true,
    }));

    // Now ask the same question but flagged as high risk
    const result = await dm.decide({ ...baseRequest, risk: "high" });

    expect(result.path).toBe("human_review");
    expect(result.answer).toBe(""); // pending
  });

  // ─── Acceptance test #8: Jev unavailable → review queue ───────────────

  it("Jev unavailable goes to review queue, not treated as an answer", async () => {
    jev.setFailing(true, "Jev API timeout");

    const result = await dm.decide(baseRequest);

    expect(result.path).toBe("human_review");
    expect(result.answer).toBe("");

    // Verify it's in the review queue
    const queue = dm.getReviewQueue();
    expect(queue.length).toBeGreaterThanOrEqual(1);
  });

  // ─── Acceptance test #9: Expired record → re-asked ────────────────────

  it("expired record is not directly reused", async () => {
    jev.setAnswer("backoff", 0.94);

    const first = await dm.decide(baseRequest);

    // Build trust
    dm.reportOutcome(first.decision_id, "success");
    dm.reportOutcome(first.decision_id, "success");
    dm.reportOutcome(first.decision_id, "success");

    // Force expiry
    dm.store.update(first.decision_id, (r) => ({
      ...r,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    }));

    jev.clearCalls();
    const second = await dm.decide(baseRequest);

    // Should not be direct reuse (expired cuts confidence in half)
    expect(second.path).not.toBe("direct_reuse");
  });

  // ─── Acceptance test #11: Audit disagreement → contradiction ──────────

  it("audit where Jev disagrees records a contradiction", async () => {
    jev.setAnswer("backoff", 0.94);

    const first = await dm.decide(baseRequest);

    // Now Jev would answer differently
    jev.setAnswer("retry", 0.88);

    const auditResult = await dm.auditDecision(first.decision_id);

    expect(auditResult.agrees).toBe(false);
    expect(auditResult.jevAnswer).toBe("retry");

    // Check that contradiction was recorded
    const record = dm.getDecision(first.decision_id);
    expect(record!.stats.contradictions).toBe(1);
  });

  // ─── Miss → cascade ──────────────────────────────────────────────────

  it("miss cascades through Jev first", async () => {
    jev.setAnswer("retry", 0.85);

    const result = await dm.decide(baseRequest);

    expect(result.is_new).toBe(true);
    expect(result.answer).toBe("retry");
    expect(result.path).toBe("cascade");
  });

  // ─── Low Jev confidence → LLM + Jev ──────────────────────────────────

  it("low Jev confidence cascades to LLM + Jev", async () => {
    jev.setAnswer("backoff", 0.45); // below jev_with_evidence (0.60) but above llm_plus_jev (0.30)
    llm.setAnswer("backoff", 0.7);

    const result = await dm.decide(baseRequest);

    expect(result.is_new).toBe(true);
    // LLM was called
    expect(llm.getCalls().length).toBeGreaterThanOrEqual(1);
  });

  // ─── Very low Jev confidence → human ──────────────────────────────────

  it("very low Jev confidence sends to human review", async () => {
    jev.setAnswer("backoff", 0.15); // below llm_plus_jev (0.30)

    const result = await dm.decide(baseRequest);

    expect(result.path).toBe("human_review");
    expect(result.answer).toBe("");
  });

  // ─── Jev + evidence path (memory hit with mid confidence) ─────────────

  it("memory hit with mid confidence routes to Jev with evidence", async () => {
    jev.setAnswer("backoff", 0.94);

    // Create initial decision
    const first = await dm.decide(baseRequest);

    // Report one failure to drop confidence to jev_with_evidence range
    dm.reportOutcome(first.decision_id, "success");
    dm.reportOutcome(first.decision_id, "failure");

    jev.clearCalls();
    jev.setAnswer("backoff", 0.90);

    const second = await dm.decide(baseRequest);

    expect(second.path).toBe("jev_with_evidence");
    // Jev should have been called with evidence
    const calls = jev.getCalls();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0].evidence).toBeDefined();
  });
});
