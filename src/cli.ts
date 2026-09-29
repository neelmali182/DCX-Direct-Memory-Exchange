#!/usr/bin/env node

/**
 * CLI interface for Decision Memory (`dm`)
 *
 * Commands:
 *   dm review list                       List pending human review items
 *   dm review resolve <id> <answer>      Resolve a human review item
 *   dm export [dir]                      Export all decisions to CSV
 *   dm import <filePath>                 Import human corrections from CSV
 *   dm audit [sampleRate]                Run batch audit with Jev provider
 *   dm stats                             Show memory statistics and breakdown
 */

import { DecisionMemory } from "./index.js";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

function printUsage(): void {
  console.log(`
Decision Memory CLI (dm)

Usage:
  dm review list                       List items awaiting human review
  dm review resolve <id> <answer>      Resolve a review item with an answer
  dm export [dir]                      Export decisions to CSV (default: ./memory/export)
  dm import <csvFile>                  Import human edits from CSV
  dm audit [rate]                      Run audit sampling (e.g. 0.2 for 20%)
  dm stats                             Display statistics about the decision store
  dm help                              Show this help message

Options:
  --config <path>                      Path to config YAML (default: config/default.yaml)
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    printUsage();
    return;
  }

  // Parse --config if provided
  let configPath: string | undefined = undefined;
  const configIdx = args.indexOf("--config");
  if (configIdx !== -1 && args[configIdx + 1]) {
    configPath = args[configIdx + 1];
    args.splice(configIdx, 2);
  } else if (existsSync("config/default.yaml")) {
    configPath = "config/default.yaml";
  }

  const dm = new DecisionMemory({ configPath });
  const cmd = args[0];

  switch (cmd) {
    case "review": {
      const sub = args[1];
      if (sub === "list" || !sub) {
        const queue = dm.getReviewQueue().filter((item) => !item.resolved);
        if (queue.length === 0) {
          console.log("No pending items in review queue.");
          return;
        }
        console.log(`\nFound ${queue.length} pending review item(s):\n`);
        for (const item of queue) {
          console.log(`  ID:          ${item.id}`);
          console.log(`  Created:     ${item.created_at}`);
          console.log(`  Reason:      ${item.reason}`);
          console.log(`  Question:    ${item.question}`);
          console.log(`  Options:     ${item.options.join(", ")}`);
          console.log(`  Facts:       ${JSON.stringify(item.facts)}`);
          if (item.decision_id) console.log(`  Decision ID: ${item.decision_id}`);
          console.log(`  ----------------------------------------`);
        }
      } else if (sub === "resolve") {
        const id = args[2];
        const answer = args[3];
        if (!id || !answer) {
          console.error("Usage: dm review resolve <id> <answer>");
          process.exit(1);
        }
        try {
          dm.resolveReview(id, answer);
          console.log(`Successfully resolved review item ${id} with answer: "${answer}".`);
        } catch (err) {
          console.error(`Error resolving review item: ${(err as Error).message}`);
          process.exit(1);
        }
      } else {
        console.error(`Unknown review subcommand: ${sub}. Use 'dm review list' or 'dm review resolve'.`);
        process.exit(1);
      }
      break;
    }

    case "export": {
      const targetDir = args[1] ? resolve(args[1]) : undefined;
      try {
        const csvPath = dm.exportCsv(targetDir);
        console.log(`Decisions exported successfully to: ${csvPath}`);
      } catch (err) {
        console.error(`Export failed: ${(err as Error).message}`);
        process.exit(1);
      }
      break;
    }

    case "import": {
      const csvPath = args[1];
      if (!csvPath) {
        console.error("Usage: dm import <csvFilePath>");
        process.exit(1);
      }
      try {
        const res = dm.importCsv(resolve(csvPath));
        console.log(`Import summary:`);
        console.log(`  Updated:   ${res.updated}`);
        console.log(`  Unchanged: ${res.unchanged}`);
        console.log(`  Rejected:  ${res.rejected.length}`);
        if (res.rejected.length > 0) {
          console.log("  Rejections:");
          for (const rej of res.rejected) {
            console.log(`    - ID ${rej.id}: ${rej.reason}`);
          }
        }
      } catch (err) {
        console.error(`Import failed: ${(err as Error).message}`);
        process.exit(1);
      }
      break;
    }

    case "audit": {
      const rateStr = args[1];
      const rate = rateStr ? parseFloat(rateStr) : undefined;
      console.log(`Running batch audit...`);
      try {
        const auditRes = await dm.batchAudit(rate);
        const ratePct = auditRes.audited > 0 ? ((auditRes.agreements / auditRes.audited) * 100).toFixed(1) : "N/A";
        console.log(`Audit complete:`);
        console.log(`  Total decisions:  ${auditRes.total}`);
        console.log(`  Sampled/Audited:  ${auditRes.audited}`);
        console.log(`  Agreements:       ${auditRes.agreements}`);
        console.log(`  Disagreements:    ${auditRes.disagreements}`);
        console.log(`  Agreement rate:   ${ratePct}%`);
      } catch (err) {
        console.error(`Audit failed: ${(err as Error).message}`);
        process.exit(1);
      }
      break;
    }

    case "stats": {
      const records = dm.listDecisions();
      const reviewQueue = dm.getReviewQueue();
      const pendingReviews = reviewQueue.filter((r) => !r.resolved).length;

      let humanVerified = 0;
      let directlyReusable = 0;
      let totalUses = 0;
      let totalConfirmations = 0;
      let totalContradictions = 0;

      const sources: Record<string, number> = {};
      const confidenceBuckets = { "0.9-1.0": 0, "0.6-0.9": 0, "0.3-0.6": 0, "0.0-0.3": 0 };

      for (const r of records) {
        if (r.human_verified) humanVerified++;
        if (r.memory_confidence >= dm.config.thresholds.direct_reuse) directlyReusable++;
        totalUses += r.stats.uses;
        totalConfirmations += r.stats.confirmations;
        totalContradictions += r.stats.contradictions;

        sources[r.source] = (sources[r.source] || 0) + 1;

        const mc = r.memory_confidence;
        if (mc >= 0.9) confidenceBuckets["0.9-1.0"]++;
        else if (mc >= 0.6) confidenceBuckets["0.6-0.9"]++;
        else if (mc >= 0.3) confidenceBuckets["0.3-0.6"]++;
        else confidenceBuckets["0.0-0.3"]++;
      }

      console.log(`\nDecision Memory Statistics:`);
      console.log(`  Total Decisions Stored:    ${records.length}`);
      console.log(`  Directly Reusable (>=0.9): ${directlyReusable} (${records.length ? ((directlyReusable / records.length) * 100).toFixed(1) : 0}%)`);
      console.log(`  Human Verified:            ${humanVerified}`);
      console.log(`  Pending Human Reviews:     ${pendingReviews}`);
      console.log(`  Total Invocations (uses):  ${totalUses}`);
      console.log(`  Total Confirmations:       ${totalConfirmations}`);
      console.log(`  Total Contradictions:      ${totalContradictions}`);
      console.log(`\nSources:`);
      for (const [src, count] of Object.entries(sources)) {
        console.log(`  ${src.padEnd(10)}: ${count}`);
      }
      console.log(`\nConfidence Distribution:`);
      for (const [bucket, count] of Object.entries(confidenceBuckets)) {
        console.log(`  ${bucket.padEnd(10)}: ${count}`);
      }
      console.log();
      break;
    }

    default:
      console.error(`Unknown command: ${cmd}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
