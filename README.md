# Decision Memory

> **Decision caching and confidence-routed memory for AI agents.**

When an agent asks Jev, an LLM, or a human a structured decision question, Decision Memory saves the question, options, answer, context facts, and confidence. If an identical decision scenario arises later, Decision Memory inspects stored memory first and only routes to external models when past evidence is insufficient or risk is high.

---

## Key Features

- **Evidence-Based Memory Confidence**: Does not blindly trust a past 95% model score. Confidence is earned through real outcomes (confirmations vs. contradictions), audit checks, and human verifications.
- **Exact Canonical Keying**: Prevents incorrect reuse by hashing normalized questions, sorted options, and structured `facts` (details that change the right answer, such as HTTP status, headers, or customer tiers).
- **Two-Signal Routing Cascade**:
  - High Memory Confidence ($\ge 0.90$) $\rightarrow$ **Direct Reuse** (zero model calls, $\approx 1$–$3$ ms latency).
  - Moderate Memory Confidence ($0.60$–$0.90$) $\rightarrow$ **Jev with Evidence** (past decision passed as context).
  - Low Memory Confidence ($0.30$–$0.60$) $\rightarrow$ **LLM + Jev with Evidence**.
  - New Question / Miss ($< 0.30$) $\rightarrow$ **Cascade from Jev** (Jev $\rightarrow$ LLM $\rightarrow$ Human Review Queue).
- **Hard Risk Policy**: High-risk actions (e.g. large monetary refunds, disruptive system outages) bypass direct auto-reuse and enforce human oversight or model re-validation.
- **First-Class Outcome Feedback**: Agents report back `success` or `failure` after executing actions, actively calibrating memory trust in real time.
- **Background Audit Sampling**: Automatically selects a configurable percentage of reused decisions for background verification against fresh model opinions to detect silent drift.
- **Human Review Queue & CLI (`dm`)**: Escalates low-confidence or high-risk items to a human queue that can be resolved via CLI or CSV export/import.

---

## Architecture Flow

```text
Agent asks: question + options + facts + risk
                   │
                   ▼
          Risk Policy Check ──[high risk]──► Never direct reuse (enforce human / cascade)
                   │
                   ▼
     Canonical Key Lookup (SHA-256)
                   │
         ┌─────────┴─────────────────────┐
         ▼                               ▼
    Memory Hit                      Memory Miss
 (compute confidence)                    │
         │                               │
         ├───────────────────────────────┤
         ▼                               ▼
  Route by Memory Confidence         Route by Model Confidence (Cascade)
   ≥ 0.90  Direct Reuse (no call)     ≥ 0.60  Jev answer saved
   0.60    Jev + Evidence             0.30    LLM + Jev
   0.30    LLM + Jev + Evidence       < 0.30  Human Review Queue
   < 0.30  Cascade
         │                               │
         └───────────────┬───────────────┘
                         ▼
             Agent Acts on Decision
                         │
                         ▼
        Report Outcome (success / failure)
                         │
                         ▼
           Update Memory & Audit Trail
```

---

## Installation & Setup

```bash
# Clone and install dependencies
git clone <repo-url>
cd DCX
npm install

# Build TypeScript
npm run build

# Run Vitest test suite (65 tests)
npm test

# Type-check
npm run lint
```

---

## Quickstart

### 1. Basic Usage in TypeScript

```typescript
import { DecisionMemory } from "decision-memory";

// Initialize decision memory
const dm = new DecisionMemory({
  configPath: "./config/default.yaml",
});

// 1. Ask a decision
const decision = await dm.decide({
  question: "How should the agent handle the failed upstream request?",
  options: ["retry_with_delay", "exponential_backoff", "fail_job"],
  facts: {
    status_code: 429,
    has_retry_after: true,
    endpoint: "llm_gateway",
  },
  risk: "low",
});

console.log(`Action: ${decision.answer} (via ${decision.path}, confidence: ${decision.memory_confidence})`);

// 2. Act on the decision and report the outcome
try {
  // execute decision.answer ...
  dm.reportOutcome(decision.decision_id, "success");
} catch (error) {
  dm.reportOutcome(decision.decision_id, "failure");
}
```

---

## Evaluation Benchmark & Simulation

We conducted an evaluation simulating **300 realistic agent decisions** (a mix of frequent tasks, perturbed edge cases, high-risk scenarios, and model noise) comparing a **Baseline** (always calling model) against **Decision Memory**:

### Results Summary (300 Decisions)

| Metric | Baseline (No Memory) | Decision Memory | Delta / Benefit |
| :--- | :--- | :--- | :--- |
| **Total Decisions** | 300 | 300 | — |
| **Model Calls** | 300 | 43 | **257 avoided (85.7% savings)** |
| **Direct Reuse Count** | 0 | 257 | **85.7% cache hit rate** |
| **Overall Accuracy** | 93.3% | 99.7% | **+6.4% improvement** |
| **Wrong-Reuse Rate (Safety)** | N/A | **0.00%** | **PASS (< 2.0% threshold)** |
| **Human Escalation Rate** | 0 | 20 (6.7%) | **Controlled oversight (< 10%)** |
| **Average Latency** | 147.7 ms | 22.3 ms | **84.9% faster** |

### Calibration Analysis by Confidence Bucket

| Memory Confidence Bucket | Decision Count | Real Accuracy | Status |
| :--- | :--- | :--- | :--- |
| **0.90 – 1.00** | 257 | **100.0%** | High Trust (Direct Reuse) |
| **0.80 – 0.90** | 18 | **100.0%** | High Trust |
| **0.70 – 0.80** | 2 | **100.0%** | Supervised |
| **0.60 – 0.70** | 2 | **50.0%** | Supervised (routes to model with evidence) |
| **< 0.60** | 21 | **100.0%** (via human resolution) | Escalated |

To re-run the benchmark simulation:
```bash
npx tsx eval/simulate.ts
```

To run the interactive Customer Support Ticket Triage example:
```bash
npx tsx examples/support_ticket_triage.ts
```

---

## Command Line Interface (`dm`)

Decision Memory provides a CLI tool for human operators and audits:

```bash
# View review queue
node dist/cli.js review list

# Resolve a review item
node dist/cli.js review resolve rev_01d6af7c escalate_tier2_support

# Show database and confidence statistics
node dist/cli.js stats

# Run audit sampling across stored decisions
node dist/cli.js audit 0.2

# Export all decisions to CSV for review
node dist/cli.js export ./memory/export

# Import corrected decisions from CSV
node dist/cli.js import ./memory/export/decisions_edited.csv
```

---

## Acceptance Criteria Checklist (v0.1)

- [x] **Criterion 1**: Same question, options in different order $\rightarrow$ identical canonical key, memory hit.
- [x] **Criterion 2**: Same question, one changed fact $\rightarrow$ different key, no memory collision.
- [x] **Criterion 3**: New decision from Jev at 0.94 $\rightarrow$ saved unverified, unproven confidence capped (not directly reusable).
- [x] **Criterion 4**: After 3 successful outcomes $\rightarrow$ directly reusable ($\ge 0.90$) with 0 model calls.
- [x] **Criterion 5**: After reported failure $\rightarrow$ drops below 0.90, routes back to model with evidence.
- [x] **Criterion 6**: Human corrects answer $\rightarrow$ marked `human_verified`, confidence 0.98, used immediately.
- [x] **Criterion 7**: High-risk request with confidence 0.99 $\rightarrow$ never auto-reused directly.
- [x] **Criterion 8**: Jev unavailable / error $\rightarrow$ safely routes to human review queue without falsifying output.
- [x] **Criterion 9**: Expired record $\rightarrow$ confidence halved, re-queried rather than directly reused.
- [x] **Criterion 10**: CSV export $\rightarrow$ edit in Excel/editor $\rightarrow$ CSV import updates records as verified, rejects unexpected schema edits.
- [x] **Criterion 11**: Audit sample disagreement $\rightarrow$ contradiction logged, memory confidence decremented.
- [x] **Criterion 12**: Crash-safe atomic persistence $\rightarrow$ cross-platform atomic writes prevent file corruption.

---

## License

ISC
