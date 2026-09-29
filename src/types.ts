/**
 * Decision Memory — Core Types
 *
 * All shared types, interfaces, and enums for the decision memory system.
 */

// ─── Source Types ───────────────────────────────────────────────────────────────

export type Source = "jev" | "llm" | "human";
export type RiskLevel = "low" | "high";
export type OutcomeStatus = "success" | "failure" | "unknown";
export type RoutePath = "direct_reuse" | "jev_with_evidence" | "llm_plus_jev" | "cascade" | "human_review";

// ─── Decision Record ────────────────────────────────────────────────────────────

export interface DecisionStats {
  uses: number;
  confirmations: number;
  contradictions: number;
}

export interface DecisionRecord {
  id: string;
  schema_version: 1;
  key: string;

  question: string;
  options: string[];
  facts: Record<string, string | number | boolean>;
  risk: RiskLevel;

  answer: string;
  source: Source;
  model_confidence: number | null;
  human_verified: boolean;

  stats: DecisionStats;
  memory_confidence: number;

  created_at: string;
  last_used_at: string | null;
  expires_at: string;
}

// ─── Request / Response ─────────────────────────────────────────────────────────

export interface DecisionRequest {
  question: string;
  options: string[];
  facts: Record<string, string | number | boolean>;
  risk?: RiskLevel;
  description?: string; // free-text, passed to provider but NOT part of the key
}

export interface DecisionResponse {
  decision_id: string;
  answer: string;
  source: Source;
  memory_confidence: number;
  path: RoutePath;
  is_new: boolean;
}

// ─── Provider ───────────────────────────────────────────────────────────────────

export interface ProviderResult {
  answer: string;
  confidence: number;
}

export interface EvidencePayload {
  answer: string;
  memory_confidence: number;
  uses: number;
  confirmations: number;
  contradictions: number;
}

export interface ProviderInput {
  question: string;
  options: string[];
  facts: Record<string, unknown>;
  description?: string;
  evidence?: EvidencePayload;
}

export interface DecisionProvider {
  readonly name: string;
  decide(input: ProviderInput): Promise<ProviderResult>;
}

// ─── Store ──────────────────────────────────────────────────────────────────────

export interface EventLogEntry {
  ts: string;
  event: string;
  decision_id: string;
  [key: string]: unknown;
}

export interface ReviewItem {
  id: string;
  decision_id: string | null;
  question: string;
  options: string[];
  facts: Record<string, string | number | boolean>;
  description?: string;
  reason: string;
  created_at: string;
  resolved: boolean;
  resolved_at?: string;
  resolved_answer?: string;
}

export interface DecisionStore {
  get(key: string): DecisionRecord | null;
  getById(id: string): DecisionRecord | null;
  put(record: DecisionRecord): void;
  update(id: string, updater: (record: DecisionRecord) => DecisionRecord): DecisionRecord | null;
  list(): DecisionRecord[];
  nextId(): string;

  appendEvent(event: EventLogEntry): void;

  getReviewQueue(): ReviewItem[];
  addReviewItem(item: ReviewItem): void;
  resolveReviewItem(itemId: string, answer: string): void;
}

// ─── Config ─────────────────────────────────────────────────────────────────────

export interface Config {
  thresholds: {
    direct_reuse: number;
    jev_with_evidence: number;
    llm_plus_jev: number;
  };
  audit_rate: number;
  source_trust: {
    human: number;
    jev: number;
    llm: number;
  };
  k: number;
  min_confirmations_for_reuse: number;
  unproven_cap: number;
  expiry_days: number;
  risk_policy: {
    high_risk_action_tags: string[];
    high_risk_behavior: string;
  };
  storage: {
    data_dir: string;
  };
}
