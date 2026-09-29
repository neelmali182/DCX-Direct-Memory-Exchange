/**
 * Tests for memory confidence calculation.
 *
 * Reproduces the worked example table from section 5.3:
 *   - Just created: 0.846
 *   - 3 confirmations: 0.938
 *   - 3 confirmations + 1 failure: 0.782
 *   - Human verifies: 0.98
 *   - Expired: 0.469
 *
 * Acceptance criteria covered:
 * - #3: New decision from Jev at 0.94 → not directly reusable
 * - #4: After 3 successful outcomes → directly reusable (>= 0.90)
 * - #5: After a reported failure → drops below 0.90
 * - #6: Human corrects → confidence 0.98
 * - #9: Expired record → not directly reusable
 */

import { describe, it, expect } from "vitest";
import { memoryConfidence } from "../src/confidence.js";
import type { Config, DecisionRecord } from "../src/types.js";
import { createConfig } from "../src/config.js";

function makeRecord(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  const now = new Date();
  return {
    id: "dec_000001",
    schema_version: 1,
    key: "test-key",
    question: "What should I do?",
    options: ["retry", "backoff"],
    facts: { status: 429 },
    risk: "low",
    answer: "backoff",
    source: "jev",
    model_confidence: 0.94,
    human_verified: false,
    stats: { uses: 1, confirmations: 0, contradictions: 0 },
    memory_confidence: 0,
    created_at: now.toISOString(),
    last_used_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 90 * 86400000).toISOString(),
    ...overrides,
  };
}

const config = createConfig();

describe("memoryConfidence", () => {
  // Section 5.3: Jev answered "backoff" at 0.94
  // initial = 0.94 × 0.9 = 0.846

  it("just created: (0 + 2 × 0.846) / 2 = 0.846 — not directly reusable", () => {
    const record = makeRecord();
    const mc = memoryConfidence(record, config);

    // initial = 0.94 * 0.9 = 0.846
    // (0 + 2 * 0.846) / (0 + 0 + 2) = 0.846
    // But earned trust cap applies (confirmations < 3, not human-verified) → min(0.846, 0.85) = 0.846
    expect(mc).toBeCloseTo(0.846, 2);
    expect(mc).toBeLessThan(config.thresholds.direct_reuse); // Not reusable
  });

  it("3 confirmations: (3 + 1.692) / 5 = 0.938 — directly reusable", () => {
    const record = makeRecord({
      stats: { uses: 4, confirmations: 3, contradictions: 0 },
    });
    const mc = memoryConfidence(record, config);

    // (3 + 2 * 0.846) / (3 + 0 + 2) = (3 + 1.692) / 5 = 0.9384
    expect(mc).toBeCloseTo(0.938, 2);
    expect(mc).toBeGreaterThanOrEqual(config.thresholds.direct_reuse); // Reusable!
  });

  it("3 confirmations + 1 failure: (3 + 1.692) / 6 = 0.782", () => {
    const record = makeRecord({
      stats: { uses: 5, confirmations: 3, contradictions: 1 },
    });
    const mc = memoryConfidence(record, config);

    // (3 + 1.692) / (3 + 1 + 2) = 4.692 / 6 = 0.782
    expect(mc).toBeCloseTo(0.782, 2);
    expect(mc).toBeLessThan(config.thresholds.direct_reuse); // Not reusable
    expect(mc).toBeGreaterThanOrEqual(config.thresholds.jev_with_evidence); // Routes to Jev + evidence
  });

  it("human verifies: initial = 0.98", () => {
    const record = makeRecord({
      human_verified: true,
      source: "human",
    });
    const mc = memoryConfidence(record, config);

    // initial = 0.98 (human_verified)
    // (0 + 2 * 0.98) / (0 + 0 + 2) = 0.98
    // No earned trust cap for human-verified
    expect(mc).toBeCloseTo(0.98, 2);
    expect(mc).toBeGreaterThanOrEqual(config.thresholds.direct_reuse); // Immediately reusable
  });

  it("expired: 0.938 × 0.5 = 0.469 — re-ask", () => {
    const pastExpiry = new Date(Date.now() - 1000); // already expired
    const record = makeRecord({
      stats: { uses: 4, confirmations: 3, contradictions: 0 },
      expires_at: pastExpiry.toISOString(),
    });
    const mc = memoryConfidence(record, config);

    // Base would be 0.938, but expired → 0.938 * 0.5 = 0.469
    expect(mc).toBeCloseTo(0.469, 2);
    expect(mc).toBeLessThan(config.thresholds.direct_reuse); // Not reusable
  });

  // Acceptance test #3: earned trust cap
  it("new decision with high model confidence is capped at 0.85 (unproven)", () => {
    const record = makeRecord({ model_confidence: 0.99 });
    const mc = memoryConfidence(record, config);

    // initial = 0.99 * 0.9 = 0.891
    // (0 + 2 * 0.891) / 2 = 0.891
    // But earned trust cap: min(0.891, 0.85) = 0.85
    expect(mc).toBeCloseTo(0.85, 2);
    expect(mc).toBeLessThan(config.thresholds.direct_reuse); // Still not directly reusable
  });

  it("LLM source uses lower trust factor", () => {
    const record = makeRecord({ source: "llm", model_confidence: 0.94 });
    const mc = memoryConfidence(record, config);

    // initial = 0.94 * 0.8 = 0.752
    // (0 + 2 * 0.752) / 2 = 0.752
    expect(mc).toBeCloseTo(0.752, 2);
  });

  it("null model_confidence defaults to 0.5", () => {
    const record = makeRecord({ model_confidence: null });
    const mc = memoryConfidence(record, config);

    // initial = 0.5 * 0.9 = 0.45
    // (0 + 2 * 0.45) / 2 = 0.45
    expect(mc).toBeCloseTo(0.45, 2);
  });

  it("clamps to [0, 1]", () => {
    // Even with extreme values, result stays in bounds
    const record = makeRecord({
      stats: { uses: 100, confirmations: 100, contradictions: 0 },
    });
    const mc = memoryConfidence(record, config);
    expect(mc).toBeGreaterThanOrEqual(0);
    expect(mc).toBeLessThanOrEqual(1);
  });
});
