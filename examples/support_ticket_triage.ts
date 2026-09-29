/**
 * Example Agent: Customer Support Ticket Triage
 *
 * Demonstrates Decision Memory in action for a real-world agent task.
 * The agent triages incoming customer service tickets, deciding the best
 * next action based on ticket details and customer facts.
 *
 * Key behaviors demonstrated:
 * 1. Initial decision routes to model (cascade)
 * 2. Unverified decisions require multiple confirmations before direct reuse
 * 3. Exact matching on question + options + facts
 * 4. High-risk decisions (e.g. high-value refunds) never auto-reused
 * 5. Outcome reporting (success/failure) adjusts memory confidence
 * 6. Audit sampling checks background consistency
 */

import { DecisionMemory, FakeProvider, type DecisionRequest, type OutcomeStatus } from "../src/index.js";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

interface Ticket {
  id: string;
  customer: string;
  issue: string;
  tier: "free" | "pro" | "enterprise";
  amount?: number;
  sentiment: "neutral" | "angry" | "happy";
  is_outage?: boolean;
}

const DEMO_STORE_DIR = join(process.cwd(), "memory", "triage-demo");

async function runDemo() {
  console.log("================================================================");
  console.log("  DECISION MEMORY: Support Ticket Triage Agent Demo");
  console.log("================================================================\n");

  if (existsSync(DEMO_STORE_DIR)) {
    rmSync(DEMO_STORE_DIR, { recursive: true });
  }

  // Setup simulated providers
  const jev = new FakeProvider("jev", { answer: "send_help_article", confidence: 0.92 });
  const llm = new FakeProvider("llm", { answer: "escalate_tier2_support", confidence: 0.85 });

  const dm = new DecisionMemory({
    config: {
      storage: { data_dir: DEMO_STORE_DIR },
      audit_rate: 0.25, // 25% audit sampling for demo
      thresholds: {
        direct_reuse: 0.90,
        jev_with_evidence: 0.60,
        llm_plus_jev: 0.30,
        escalate_to_human: 0.70,
        unproven_cap: 0.88,
      },
    },
    jevProvider: jev,
    llmProvider: llm,
  });

  const options = [
    "instant_refund",
    "send_help_article",
    "escalate_tier2_support",
    "offer_retention_discount",
    "escalate_engineering",
    "ask_human",
  ];

  // Helper to map ticket into decision request
  function ticketToRequest(ticket: Ticket): DecisionRequest {
    const isHighValue = (ticket.amount ?? 0) > 100;
    return {
      question: "What is the recommended triage action for this customer support ticket?",
      options,
      facts: {
        issue: ticket.issue,
        customer_tier: ticket.tier,
        has_monetary_impact: (ticket.amount ?? 0) > 0,
        high_value: isHighValue,
        is_outage: ticket.is_outage ?? false,
      },
      risk: isHighValue ? "high" : "low",
      description: `Ticket ${ticket.id} from ${ticket.customer}: ${ticket.issue} (sentiment: ${ticket.sentiment})`,
    };
  }

  // Ground truth simulator for the triage logic
  function groundTruthAction(ticket: Ticket): string {
    if (ticket.is_outage) return "escalate_engineering";
    if (ticket.issue === "forgot_password" || ticket.issue === "how_to_export") return "send_help_article";
    if (ticket.issue === "billing_overcharge" && (ticket.amount ?? 0) <= 50) return "instant_refund";
    if (ticket.issue === "billing_overcharge" && (ticket.amount ?? 0) > 50) return "ask_human";
    if (ticket.issue === "wants_to_cancel" && ticket.tier === "enterprise") return "offer_retention_discount";
    return "escalate_tier2_support";
  }

  // Stream of tickets simulating real operations
  const incomingTickets: Ticket[] = [
    // 1-4: Standard repeated tickets (password resets)
    { id: "T-101", customer: "Acme Corp", issue: "forgot_password", tier: "pro", sentiment: "neutral" },
    { id: "T-102", customer: "Beta LLC", issue: "forgot_password", tier: "pro", sentiment: "neutral" },
    { id: "T-103", customer: "Gamma Inc", issue: "forgot_password", tier: "pro", sentiment: "neutral" },
    { id: "T-104", customer: "Delta Co", issue: "forgot_password", tier: "pro", sentiment: "neutral" },

    // 5-7: Small refund requests
    { id: "T-105", customer: "User 1", issue: "billing_overcharge", tier: "free", amount: 20, sentiment: "angry" },
    { id: "T-106", customer: "User 2", issue: "billing_overcharge", tier: "free", amount: 20, sentiment: "angry" },
    { id: "T-107", customer: "User 3", issue: "billing_overcharge", tier: "free", amount: 20, sentiment: "angry" },

    // 8: High-risk refund request ($500)
    { id: "T-108", customer: "Vip Enterprise", issue: "billing_overcharge", tier: "enterprise", amount: 500, sentiment: "angry" },

    // 9: System outage ticket
    { id: "T-109", customer: "Big Bank", issue: "api_down", tier: "enterprise", is_outage: true, sentiment: "angry" },

    // 10: Repeated password reset (now fully trusted)
    { id: "T-110", customer: "Epsilon Ltd", issue: "forgot_password", tier: "pro", sentiment: "neutral" },
  ];

  console.log(`Processing stream of ${incomingTickets.length} support tickets...\n`);

  for (let i = 0; i < incomingTickets.length; i++) {
    const ticket = incomingTickets[i];
    const expected = groundTruthAction(ticket);

    // Configure model answer to simulate accurate model response
    jev.setAnswer(expected, 0.94);

    const req = ticketToRequest(ticket);
    const start = performance.now();
    const decision = await dm.decide(req);
    const latencyMs = (performance.now() - start).toFixed(2);

    console.log(`[Ticket ${ticket.id}] Issue: "${ticket.issue}" (Tier: ${ticket.tier}, Risk: ${req.risk})`);
    console.log(`  -> Path:               ${decision.path}`);
    console.log(`  -> Action:             ${decision.answer}`);
    console.log(`  -> Source:             ${decision.source}`);
    console.log(`  -> Memory Confidence:  ${decision.memory_confidence.toFixed(3)}`);
    console.log(`  -> Is New Decision:    ${decision.is_new}`);
    console.log(`  -> Latency:            ${latencyMs} ms`);

    // Simulate real outcome if decision was resolved
    if (decision.path === "human_review" || decision.decision_id === "pending") {
      console.log(`  -> [Review Queue] Decision pending human review (no action taken yet)`);
    } else {
      const outcome: OutcomeStatus = decision.answer === expected ? "success" : "failure";
      dm.reportOutcome(decision.decision_id, outcome);
      console.log(`  -> Outcome Reported:   ${outcome}`);
    }

    if (decision.audit_sampled) {
      console.log(`  -> [Audit] Sampled for background verification!`);
    }

    console.log("");
  }

  // Demonstrate human review handling
  console.log("----------------------------------------------------------------");
  console.log("  Demonstrating Review Queue Handling");
  console.log("----------------------------------------------------------------");

  // Create an ambiguous situation that triggers low confidence
  jev.setAnswer("ask_human", 0.40); // low model confidence
  llm.setAnswer("ask_human", 0.45);

  const ambiguousTicket: Ticket = {
    id: "T-999",
    customer: "Special Case Inc",
    issue: "unusual_contract_exception",
    tier: "enterprise",
    sentiment: "neutral",
  };

  const ambReq = ticketToRequest(ambiguousTicket);
  const ambDecision = await dm.decide(ambReq);

  console.log(`Ambiguous Ticket Decision Path: ${ambDecision.path}`);
  console.log(`Answer returned: ${ambDecision.answer}`);

  const pending = dm.getReviewQueue().filter((r) => !r.resolved);
  console.log(`Pending review queue count: ${pending.length}`);
  if (pending.length > 0) {
    const item = pending[0];
    console.log(`Resolving review item ${item.id} with manual human answer 'escalate_tier2_support'...`);
    dm.resolveReview(item.id, "escalate_tier2_support");
    console.log("Resolved! New decisions with this exact key will now have human_verified = true (0.98 confidence).");
  }

  // Summary statistics
  console.log("\n----------------------------------------------------------------");
  console.log("  Triage Agent Run Summary");
  console.log("----------------------------------------------------------------");
  const stored = dm.listDecisions();
  console.log(`Total Unique Scenarios Stored: ${stored.length}`);
  for (const rec of stored) {
    console.log(`  - [Key: ${rec.key.slice(0, 8)}...] Answer: ${rec.answer.padEnd(24)} Conf: ${rec.memory_confidence.toFixed(2)} | Uses: ${rec.stats.uses} | Confirms: ${rec.stats.confirmations} | Verified: ${rec.human_verified}`);
  }
  console.log("\nDemo completed successfully!\n");
}

runDemo().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
