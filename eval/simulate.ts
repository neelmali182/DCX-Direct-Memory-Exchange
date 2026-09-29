/**
 * Evaluation & Simulation Script (Milestone 7 & Section 13)
 *
 * Simulates 300 realistic agent decisions comparing:
 *   1. Baseline: Agent calls Jev model on every decision
 *   2. Decision Memory: Agent routes through DecisionMemory
 *
 * Generates metrics for:
 *   - Wrong-reuse rate (critical safety metric)
 *   - Jev calls avoided (cost saving)
 *   - Accuracy vs ground truth
 *   - Human escalation rate
 *   - Latency per decision
 *   - Calibration by confidence bucket
 */

import { DecisionMemory, FakeProvider, type DecisionRequest } from "../src/index.js";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

interface SimulationScenario {
  question: string;
  options: string[];
  facts: Record<string, string | number | boolean>;
  risk?: "low" | "medium" | "high";
  groundTruth: string;
  weight: number; // relative frequency in workload
}

const SIM_DIR = join(process.cwd(), "memory", "eval-sim");

// Scenario pool: mix of frequent routine tasks and long-tail edge cases
const SCENARIOS: SimulationScenario[] = [
  // 1. Password reset (frequent: ~25% of all tickets)
  {
    question: "What triage action should be taken for this customer?",
    options: ["send_help_article", "reset_password_link", "escalate_tier2", "ask_human"],
    facts: { issue: "forgot_password", channel: "web", user_tier: "standard" },
    risk: "low",
    groundTruth: "reset_password_link",
    weight: 25,
  },
  // 2. Billing overcharge under $50 (frequent: ~15%)
  {
    question: "What triage action should be taken for this customer?",
    options: ["instant_refund", "escalate_billing_human", "send_faq", "deny_claim"],
    facts: { issue: "billing_overcharge", amount: 25, user_tier: "pro" },
    risk: "low",
    groundTruth: "instant_refund",
    weight: 20,
  },
  // 3. Billing overcharge over $200 (high risk: ~3%)
  {
    question: "What triage action should be taken for this customer?",
    options: ["instant_refund", "escalate_billing_human", "send_faq", "deny_claim"],
    facts: { issue: "billing_overcharge", amount: 350, user_tier: "enterprise" },
    risk: "high",
    groundTruth: "escalate_billing_human",
    weight: 3,
  },
  // 4. API 429 Rate Limit with Retry-After header (~15%)
  {
    question: "How should the agent handle the failed upstream request?",
    options: ["retry_with_delay", "exponential_backoff", "switch_endpoint", "fail_job"],
    facts: { status_code: 429, has_retry_after: true, endpoint: "llm_gateway" },
    risk: "low",
    groundTruth: "retry_with_delay",
    weight: 15,
  },
  // 5. API 429 Rate Limit without Retry-After (perturbed variant: ~10%)
  {
    question: "How should the agent handle the failed upstream request?",
    options: ["retry_with_delay", "exponential_backoff", "switch_endpoint", "fail_job"],
    facts: { status_code: 429, has_retry_after: false, endpoint: "llm_gateway" },
    risk: "low",
    groundTruth: "exponential_backoff",
    weight: 10,
  },
  // 6. Enterprise SLA Outage (high risk: ~2%)
  {
    question: "What triage action should be taken for this customer?",
    options: ["page_oncall_engineer", "post_status_page", "send_help_article", "ask_human"],
    facts: { issue: "service_outage", affected_users: 5000, user_tier: "enterprise" },
    risk: "high",
    groundTruth: "page_oncall_engineer",
    weight: 2,
  },
  // 7. How to export data (~10%)
  {
    question: "What triage action should be taken for this customer?",
    options: ["send_help_article", "escalate_tier2", "trigger_automated_export", "ask_human"],
    facts: { issue: "data_export", format: "csv", user_tier: "standard" },
    risk: "low",
    groundTruth: "send_help_article",
    weight: 10,
  },
  // 8. Security audit report request (~4%)
  {
    question: "What triage action should be taken for this customer?",
    options: ["send_soc2_portal", "escalate_compliance", "deny_request", "ask_human"],
    facts: { issue: "security_report", compliance_type: "soc2", user_tier: "enterprise" },
    risk: "medium",
    groundTruth: "send_soc2_portal",
    weight: 4,
  },
  // 9. Ambiguous account dispute (high risk: ~2%)
  {
    question: "What triage action should be taken for this customer?",
    options: ["suspend_account", "request_identity_doc", "escalate_fraud_team", "ask_human"],
    facts: { issue: "suspected_takeover", ip_mismatch: true, user_tier: "pro" },
    risk: "high",
    groundTruth: "escalate_fraud_team",
    weight: 2,
  },
  // 10. Cancellation request with high churn risk (~4%)
  {
    question: "What triage action should be taken for this customer?",
    options: ["process_cancellation", "offer_50pct_discount", "escalate_retention_specialist", "ask_human"],
    facts: { issue: "cancel_subscription", ltv: 3200, user_tier: "enterprise" },
    risk: "medium",
    groundTruth: "escalate_retention_specialist",
    weight: 4,
  },
];

// Build weighted stream of 300 requests
function generateWorkload(totalDecisions: number): SimulationScenario[] {
  const totalWeight = SCENARIOS.reduce((sum, s) => sum + s.weight, 0);
  const stream: SimulationScenario[] = [];

  for (let i = 0; i < totalDecisions; i++) {
    const rnd = Math.random() * totalWeight;
    let acc = 0;
    for (const scenario of SCENARIOS) {
      acc += scenario.weight;
      if (rnd <= acc) {
        stream.push(scenario);
        break;
      }
    }
  }

  return stream;
}

interface RunMetrics {
  total: number;
  modelCalls: number;
  directReuses: number;
  humanEscalations: number;
  correctDecisions: number;
  wrongReuses: number;
  totalLatencyMs: number;
  confidenceBuckets: Record<string, { count: number; correct: number }>;
}

async function runSimulation() {
  console.log("================================================================");
  console.log("  DECISION MEMORY EVALUATION & BENCHMARK SIMULATION");
  console.log("  Comparing Baseline (No Memory) vs. Decision Memory System");
  console.log("================================================================\n");

  if (existsSync(SIM_DIR)) rmSync(SIM_DIR, { recursive: true });

  const TOTAL_RUNS = 300;
  const workload = generateWorkload(TOTAL_RUNS);

  // Model simulation parameters:
  // Jev is accurate 94% of the time, 6% noise/edge case error
  const MODEL_ACCURACY = 0.94;
  const MODEL_CONFIDENCE = 0.93;

  function mockModelResponse(scenario: SimulationScenario): { answer: string; confidence: number } {
    const isAccurate = Math.random() < MODEL_ACCURACY;
    if (isAccurate) {
      return { answer: scenario.groundTruth, confidence: MODEL_CONFIDENCE };
    } else {
      // Pick a random incorrect option
      const wrongOpts = scenario.options.filter((o) => o !== scenario.groundTruth);
      const wrongAns = wrongOpts[Math.floor(Math.random() * wrongOpts.length)];
      return { answer: wrongAns, confidence: 0.72 };
    }
  }

  // ─── 1. Run Baseline (Every decision calls Jev) ──────────────────────────
  console.log(`Running Baseline (${TOTAL_RUNS} decisions directly to model)...`);
  const baselineMetrics: RunMetrics = {
    total: TOTAL_RUNS,
    modelCalls: TOTAL_RUNS,
    directReuses: 0,
    humanEscalations: 0,
    correctDecisions: 0,
    wrongReuses: 0,
    totalLatencyMs: 0,
    confidenceBuckets: {},
  };

  for (const item of workload) {
    const start = performance.now();
    // Simulated model call latency (typically ~100-250ms for hosted model)
    const modelLat = 120 + Math.random() * 50;
    const res = mockModelResponse(item);
    const lat = performance.now() - start + modelLat;

    baselineMetrics.totalLatencyMs += lat;
    if (res.answer === item.groundTruth) {
      baselineMetrics.correctDecisions++;
    }
  }

  // ─── 2. Run Decision Memory ──────────────────────────────────────────────
  console.log(`Running Decision Memory (${TOTAL_RUNS} decisions with routing & outcomes)...`);

  const jevProvider = new FakeProvider("jev");
  const llmProvider = new FakeProvider("llm");

  const dm = new DecisionMemory({
    config: {
      storage: { data_dir: SIM_DIR },
      audit_rate: 0.10, // 10% audit sampling
      thresholds: {
        direct_reuse: 0.90,
        jev_with_evidence: 0.60,
        llm_plus_jev: 0.30,
        escalate_to_human: 0.70,
        unproven_cap: 0.88,
      },
    },
    jevProvider,
    llmProvider,
  });

  const memoryMetrics: RunMetrics = {
    total: TOTAL_RUNS,
    modelCalls: 0,
    directReuses: 0,
    humanEscalations: 0,
    correctDecisions: 0,
    wrongReuses: 0,
    totalLatencyMs: 0,
    confidenceBuckets: {
      "0.9-1.0": { count: 0, correct: 0 },
      "0.8-0.9": { count: 0, correct: 0 },
      "0.7-0.8": { count: 0, correct: 0 },
      "0.6-0.7": { count: 0, correct: 0 },
      "<0.6": { count: 0, correct: 0 },
    },
  };

  for (let i = 0; i < workload.length; i++) {
    const item = workload[i];
    const req: DecisionRequest = {
      question: item.question,
      options: item.options,
      facts: item.facts,
      risk: item.risk,
    };

    // Configure model answer dynamically for this scenario
    const modelAns = mockModelResponse(item);
    jevProvider.setAnswer(modelAns.answer, modelAns.confidence);
    llmProvider.setAnswer(modelAns.answer, modelAns.confidence);

    const callStart = performance.now();
    const result = await dm.decide(req);
    let totalLat = performance.now() - callStart;

    // Track model calls and latency
    if (result.path === "direct_reuse") {
      memoryMetrics.directReuses++;
      // Memory hit latency is local disk/memory: ~1-3ms
    } else {
      memoryMetrics.modelCalls++;
      // Simulated model network overhead when model was contacted
      totalLat += 120 + Math.random() * 50;
    }

    if (result.path === "human_review" || result.path === "human_escalation" || result.decision_id === "pending") {
      memoryMetrics.humanEscalations++;
      // A human operator resolves the item with the verified ground truth
      const pendingItems = dm.getReviewQueue().filter((r) => !r.resolved);
      for (const p of pendingItems) {
        dm.resolveReview(p.id, item.groundTruth);
      }
      result.answer = item.groundTruth;
    }

    memoryMetrics.totalLatencyMs += totalLat;

    // Ground truth comparison
    const isCorrect = result.answer === item.groundTruth;
    if (isCorrect) {
      memoryMetrics.correctDecisions++;
    }

    if (result.path === "direct_reuse" && !isCorrect) {
      memoryMetrics.wrongReuses++;
    }

    // Confidence calibration bucketing
    const mc = result.memory_confidence;
    let bKey = "<0.6";
    if (mc >= 0.9) bKey = "0.9-1.0";
    else if (mc >= 0.8) bKey = "0.8-0.9";
    else if (mc >= 0.7) bKey = "0.7-0.8";
    else if (mc >= 0.6) bKey = "0.6-0.7";

    memoryMetrics.confidenceBuckets[bKey].count++;
    if (isCorrect) {
      memoryMetrics.confidenceBuckets[bKey].correct++;
    }

    // Outcome feedback: Agent acts and reports outcome
    // Only report outcomes for actual decisions (not pending human reviews)
    if (result.decision_id !== "pending" && result.path !== "human_review") {
      dm.reportOutcome(result.decision_id, isCorrect ? "success" : "failure");
    }
  }

  // ─── 3. Print Results & Comparison ───────────────────────────────────────
  const reuseRate = (memoryMetrics.directReuses / TOTAL_RUNS) * 100;
  const callsAvoided = TOTAL_RUNS - memoryMetrics.modelCalls;
  const savingsPct = (callsAvoided / TOTAL_RUNS) * 100;
  const wrongReuseRate = memoryMetrics.directReuses > 0
    ? (memoryMetrics.wrongReuses / memoryMetrics.directReuses) * 100
    : 0;

  const baselineAcc = (baselineMetrics.correctDecisions / TOTAL_RUNS) * 100;
  const memoryAcc = (memoryMetrics.correctDecisions / TOTAL_RUNS) * 100;

  const baselineAvgLat = baselineMetrics.totalLatencyMs / TOTAL_RUNS;
  const memoryAvgLat = memoryMetrics.totalLatencyMs / TOTAL_RUNS;

  console.log("\n================================================================");
  console.log("  SIMULATION RESULTS SUMMARY (300 Decisions)");
  console.log("================================================================\n");

  console.log(`| Metric                         | Baseline      | Decision Memory | Delta / Benefit       |`);
  console.log(`|--------------------------------|---------------|-----------------|-----------------------|`);
  console.log(`| Total Decisions                | ${TOTAL_RUNS.toString().padEnd(13)} | ${TOTAL_RUNS.toString().padEnd(15)} | -                     |`);
  console.log(`| Model Calls (Jev/LLM)          | ${baselineMetrics.modelCalls.toString().padEnd(13)} | ${memoryMetrics.modelCalls.toString().padEnd(15)} | ${callsAvoided} avoided (${savingsPct.toFixed(1)}%) |`);
  console.log(`| Direct Reuse Count (Cache)     | 0             | ${memoryMetrics.directReuses.toString().padEnd(15)} | ${reuseRate.toFixed(1)}% of all traffic |`);
  console.log(`| Overall Accuracy               | ${baselineAcc.toFixed(1)}%        | ${memoryAcc.toFixed(1)}%          | ${memoryAcc >= baselineAcc ? "+" : ""}${(memoryAcc - baselineAcc).toFixed(1)}%                 |`);
  console.log(`| Wrong-Reuse Rate (Safety)      | N/A           | ${wrongReuseRate.toFixed(2)}%          | ${wrongReuseRate <= 2.0 ? "PASS (<2.0%)" : "FAIL (>2.0%)"}          |`);
  console.log(`| Human Escalations              | 0             | ${memoryMetrics.humanEscalations.toString().padEnd(15)} | Low (${((memoryMetrics.humanEscalations / TOTAL_RUNS) * 100).toFixed(1)}%)            |`);
  console.log(`| Avg Latency per Decision       | ${baselineAvgLat.toFixed(1)} ms      | ${memoryAvgLat.toFixed(1)} ms        | ${((1 - memoryAvgLat / baselineAvgLat) * 100).toFixed(1)}% faster          |`);

  console.log("\n================================================================");
  console.log("  CALIBRATION ANALYSIS BY CONFIDENCE BUCKET");
  console.log("================================================================\n");
  console.log(`| Memory Confidence Bucket | Decision Count | Real Accuracy | Status      |`);
  console.log(`|--------------------------|----------------|---------------|-------------|`);
  for (const [bucket, stats] of Object.entries(memoryMetrics.confidenceBuckets)) {
    const acc = stats.count > 0 ? ((stats.correct / stats.count) * 100).toFixed(1) + "%" : "N/A";
    const status = stats.count === 0 ? "Empty" : (stats.correct / stats.count >= 0.90 ? "High Trust" : "Supervised");
    console.log(`| ${bucket.padEnd(24)} | ${stats.count.toString().padEnd(14)} | ${acc.padEnd(13)} | ${status.padEnd(11)} |`);
  }

  console.log("\n================================================================");
  console.log("  ACCEPTANCE & SUCCESS CRITERIA VERIFICATION (v0.1)");
  console.log("================================================================\n");

  const c1 = wrongReuseRate <= 2.0;
  const c2 = callsAvoided > 0;
  const c3 = memoryAcc >= baselineAcc - 1.0; // within 1% of baseline or higher
  const c4 = memoryMetrics.humanEscalations < TOTAL_RUNS * 0.10;

  console.log(`1. Wrong-reuse rate under 2.0%:                 ${c1 ? "PASS" : "FAIL"} (${wrongReuseRate.toFixed(2)}%)`);
  console.log(`2. Model calls avoided meaningfully above 0:    ${c2 ? "PASS" : "FAIL"} (${callsAvoided} calls avoided, ${savingsPct.toFixed(1)}%)`);
  console.log(`3. Accuracy not significantly worse than baseline: ${c3 ? "PASS" : "FAIL"} (${memoryAcc.toFixed(1)}% vs ${baselineAcc.toFixed(1)}%)`);
  console.log(`4. Human escalation remains low (<10%):         ${c4 ? "PASS" : "FAIL"} (${memoryMetrics.humanEscalations} escalations)`);

  const allPassed = c1 && c2 && c3 && c4;
  console.log(`\nOverall Evaluation Status: ${allPassed ? "ALL CRITERIA PASSED" : "REVIEW NEEDED"}\n`);
}

runSimulation().catch((err) => {
  console.error("Simulation failed:", err);
  process.exit(1);
});
