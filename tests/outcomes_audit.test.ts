import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { recordOutcome } from "../src/outcomes.js";
import { auditDecision, batchAudit } from "../src/audit.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { FakeProvider } from "../src/providers/fake.js";
import { memoryConfidence } from "../src/confidence.js";
import { createConfig } from "../src/config.js";
import type { DecisionRecord } from "../src/types.js";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(process.cwd(), "test-outcomes-audit");

describe("Outcomes & Audit", () => {
  let store: JsonStore;
  const config = createConfig({ storage: { data_dir: TEST_DIR }, expiry_days: 30 });

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    store = new JsonStore(TEST_DIR);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  function createTestRecord(id: string, overrides: Partial<DecisionRecord> = {}): DecisionRecord {
    const record: DecisionRecord = {
      id,
      key: `key_${id}`,
      question: "Test question?",
      options: ["a", "b"],
      facts: {},
      answer: "a",
      source: "jev",
      model_confidence: 0.94,
      memory_confidence: 0.70,
      human_verified: false,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      stats: { uses: 1, confirmations: 0, contradictions: 0 },
      ...overrides,
    };
    store.put(record);
    return record;
  }

  describe("recordOutcome", () => {
    it("success increases confirmations and extends expires_at", () => {
      createTestRecord("dec_1");
      recordOutcome({ decisionId: "dec_1", status: "success" }, store, config);

      const updated = store.getById("dec_1")!;
      expect(updated.stats.confirmations).toBe(1);
      expect(updated.stats.contradictions).toBe(0);
      expect(new Date(updated.expires_at).getTime()).toBeGreaterThan(Date.now());
    });

    it("failure increases contradictions and drops confidence", () => {
      const rec = createTestRecord("dec_2", { stats: { uses: 5, confirmations: 4, contradictions: 0 } });
      const before = memoryConfidence(rec, config);
      store.update("dec_2", (r) => ({ ...r, memory_confidence: before }));

      recordOutcome({ decisionId: "dec_2", status: "failure" }, store, config);

      const updated = store.getById("dec_2")!;
      expect(updated.stats.contradictions).toBe(1);
      expect(updated.memory_confidence).toBeLessThan(before);
    });

    it("unknown does not modify confirmation/contradiction counts", () => {
      createTestRecord("dec_3", { stats: { uses: 2, confirmations: 1, contradictions: 0 } });
      recordOutcome({ decisionId: "dec_3", status: "unknown" }, store, config);

      const updated = store.getById("dec_3")!;
      expect(updated.stats.confirmations).toBe(1);
      expect(updated.stats.contradictions).toBe(0);
    });

    it("throws when decision is not found", () => {
      expect(() => {
        recordOutcome({ decisionId: "dec_nonexistent", status: "success" }, store, config);
      }).toThrow(/Decision not found/);
    });
  });

  describe("auditDecision & batchAudit", () => {
    it("auditDecision agrees when provider returns matching answer", async () => {
      createTestRecord("dec_agree", { answer: "option_a" });
      const provider = new FakeProvider("jev", { answer: "option_a", confidence: 0.95 });

      const res = await auditDecision("dec_agree", store, config, provider);
      expect(res.agrees).toBe(true);
      expect(res.jevAnswer).toBe("option_a");

      const rec = store.getById("dec_agree")!;
      expect(rec.stats.confirmations).toBe(1);
    });

    it("auditDecision flags contradiction when provider disagrees", async () => {
      createTestRecord("dec_disagree", { answer: "option_a" });
      const provider = new FakeProvider("jev", { answer: "option_b", confidence: 0.95 });

      const res = await auditDecision("dec_disagree", store, config, provider);
      expect(res.agrees).toBe(false);
      expect(res.jevAnswer).toBe("option_b");

      const rec = store.getById("dec_disagree")!;
      expect(rec.stats.contradictions).toBe(1);
    });

    it("batchAudit samples decisions and computes aggregate results", async () => {
      createTestRecord("dec_10", { answer: "x" });
      createTestRecord("dec_11", { answer: "x" });
      createTestRecord("dec_12", { answer: "x" });

      const provider = new FakeProvider("jev", { answer: "x", confidence: 0.90 });

      // Run 100% sample rate batch audit
      const res = await batchAudit(store, config, provider, 1.0);
      expect(res.total).toBe(3);
      expect(res.audited).toBe(3);
      expect(res.agreements).toBe(3);
      expect(res.disagreements).toBe(0);
    });
  });
});
