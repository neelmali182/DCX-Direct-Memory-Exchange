/**
 * Decision Memory — Public API
 *
 * The single entry point for the decision memory system.
 *
 * Usage:
 *   const dm = new DecisionMemory({ configPath: "./config/default.yaml" });
 *
 *   const result = await dm.decide({
 *     question: "What should I do next?",
 *     options: ["retry", "backoff", "switch_api", "ask_human"],
 *     facts: { status: 429, has_retry_after: false, endpoint: "payments" },
 *     risk: "low",
 *   });
 *
 *   // After acting on the decision:
 *   dm.recordOutcome({ decisionId: result.decision_id, status: "success" });
 */

import type {
  Config,
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
  DecisionStore,
  OutcomeStatus,
} from "./types.js";
import { loadConfig, createConfig } from "./config.js";
import { JsonStore } from "./store/jsonStore.js";
import { decide, type RouterDeps } from "./router.js";
import { recordOutcome } from "./outcomes.js";
import { auditDecision, batchAudit } from "./audit.js";
import { exportToCsv, importFromCsv, type ImportResult } from "./excel.js";
import { FakeProvider } from "./providers/fake.js";
import { HumanProvider } from "./providers/human.js";
import { join } from "node:path";

export interface DecisionMemoryOptions {
  /** Path to config YAML file. If omitted, uses defaults. */
  configPath?: string;
  /** Override config directly (useful for tests). */
  config?: Partial<Config>;
  /** Custom store implementation (defaults to JsonStore). */
  store?: DecisionStore;
  /** Custom Jev provider (defaults to FakeProvider). */
  jevProvider?: DecisionProvider;
  /** Custom LLM provider (defaults to FakeProvider). */
  llmProvider?: DecisionProvider;
  /** Custom human provider (defaults to HumanProvider). */
  humanProvider?: DecisionProvider;
}

export class DecisionMemory {
  readonly config: Config;
  readonly store: DecisionStore;
  private readonly deps: RouterDeps;

  constructor(options: DecisionMemoryOptions = {}) {
    // Load config
    if (options.config) {
      this.config = createConfig(options.config);
    } else {
      this.config = loadConfig(options.configPath);
    }

    // Initialize store
    this.store = options.store ?? new JsonStore(this.config.storage.data_dir);

    // Initialize providers
    const jevProvider = options.jevProvider ?? new FakeProvider("jev", { answer: "unknown", confidence: 0.7 });
    const llmProvider = options.llmProvider ?? new FakeProvider("llm", { answer: "unknown", confidence: 0.6 });
    const humanProvider = options.humanProvider ?? new HumanProvider(this.store);

    this.deps = {
      store: this.store,
      config: this.config,
      jevProvider,
      llmProvider,
      humanProvider,
    };
  }

  // ─── Core API ───────────────────────────────────────────────────────────

  /**
   * Ask a decision question. Checks memory, routes through providers as needed.
   */
  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    return decide(request, this.deps);
  }

  /**
   * Record the outcome of a decision (success/failure/unknown).
   * This is how the system learns whether its decisions are working.
   */
  reportOutcome(decisionId: string, status: OutcomeStatus): void {
    recordOutcome({ decisionId, status }, this.store, this.config);
  }

  // ─── Human review ─────────────────────────────────────────────────────

  /**
   * Get the list of decisions waiting for human review.
   */
  getReviewQueue() {
    return this.store.getReviewQueue();
  }

  /**
   * Resolve a human review item with an answer.
   * Creates or updates the decision record with human_verified = true.
   */
  resolveReview(reviewItemId: string, answer: string): void {
    const queue = this.store.getReviewQueue();
    const item = queue.find((i) => i.id === reviewItemId);
    if (!item) {
      throw new Error(`Review item not found: ${reviewItemId}`);
    }

    this.store.resolveReviewItem(reviewItemId, answer);

    // If there's an existing decision, update it
    if (item.decision_id) {
      this.store.update(item.decision_id, (r) => ({
        ...r,
        answer,
        source: "human",
        human_verified: true,
      }));
    }

    // Log the event
    this.store.appendEvent({
      ts: new Date().toISOString(),
      event: "human_review_resolved",
      decision_id: item.decision_id ?? "none",
      review_item_id: reviewItemId,
      answer,
    });
  }

  // ─── Audit ──────────────────────────────────────────────────────────────

  /**
   * Run an audit check on a specific decision.
   */
  async auditDecision(decisionId: string): Promise<{ agrees: boolean; jevAnswer: string }> {
    return auditDecision(decisionId, this.store, this.config, this.deps.jevProvider);
  }

  /**
   * Run a batch audit on a random sample of decisions.
   */
  async batchAudit(sampleRate?: number) {
    return batchAudit(this.store, this.config, this.deps.jevProvider, sampleRate);
  }

  // ─── Export / Import ──────────────────────────────────────────────────

  /**
   * Export all decisions to CSV.
   */
  exportCsv(exportDir?: string): string {
    const dir = exportDir ?? join(this.config.storage.data_dir, "export");
    return exportToCsv(this.store, dir);
  }

  /**
   * Import human corrections from a CSV file.
   */
  importCsv(csvPath: string): ImportResult {
    return importFromCsv(csvPath, this.store, this.config);
  }

  // ─── Inspection ─────────────────────────────────────────────────────────

  /**
   * List all stored decisions.
   */
  listDecisions() {
    return this.store.list();
  }

  /**
   * Get a specific decision by ID.
   */
  getDecision(id: string) {
    return this.store.getById(id);
  }
}

// ─── Re-exports ─────────────────────────────────────────────────────────────

export { makeKey } from "./canonical.js";
export { memoryConfidence } from "./confidence.js";
export { loadConfig, createConfig } from "./config.js";
export { JsonStore } from "./store/jsonStore.js";
export { FakeProvider } from "./providers/fake.js";
export { HumanProvider, HumanReviewNeeded } from "./providers/human.js";
export { JevProvider } from "./providers/jev.js";
export { LlmProvider } from "./providers/llm.js";
export { recordOutcome } from "./outcomes.js";
export { auditDecision, batchAudit } from "./audit.js";
export { exportToCsv, importFromCsv, type ImportResult } from "./excel.js";
export { checkRisk, checkRiskTags } from "./risk.js";

export type {
  Config,
  DecisionRecord,
  DecisionRequest,
  DecisionResponse,
  DecisionProvider,
  DecisionStore,
  ProviderResult,
  ProviderInput,
  EvidencePayload,
  EventLogEntry,
  ReviewItem,
  Source,
  RiskLevel,
  OutcomeStatus,
  RoutePath,
} from "./types.js";
