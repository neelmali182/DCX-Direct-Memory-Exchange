<div align="center">

# DCX — Direct Memory Exchange

**Confidence-routed decision memory for AI agents.**
Reuse past decisions only when they've earned trust. Escalate everything else.

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-Vitest-6E9F18?style=flat&logo=vitest&logoColor=white)](https://vitest.dev/)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

</div>

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [How It Works](#how-it-works)
- [Installation](#installation)
- [Usage](#usage)
- [CLI](#cli)
- [Human Review Workflow](#human-review-workflow)
- [Configuration](#configuration)
- [Project Structure](#project-structure)
- [Development](#development)
- [License](#license)

---

## Overview

Autonomous agents answer the same questions again and again: *"What should I do on this 429?"*, *"How should this ticket be routed?"*. Calling an LLM every time is slow, costly and non-deterministic. A plain cache is fast, but unsafe:

| Problem with naive caching | How DCX handles it |
|---|---|
| Trusts an old answer forever | Confidence is earned from real outcomes, not just the first score |
| Ignores small but critical differences | Keys include structured `facts`, so a 429 *with* `Retry-After` never matches one *without* |
| Never notices drift | Reused decisions are randomly re-audited in the background |
| Auto-reuses risky actions | High-risk requests are never reused unattended |

---

## Features

- **Earned-trust confidence** — successes raise confidence, failures drop it immediately below the reuse threshold
- **Canonical keying** — normalized question + sorted options + canonical `facts`, hashed with SHA-256
- **Routing cascade** — direct reuse → Jev → LLM → human review
- **Risk gating** — configurable high-risk action tags always route to a human
- **Audit sampling** — configurable fraction of reuses re-verified to catch silent drift
- **Crash-safe storage** — atomic JSON store with an append-only `events.jsonl` log
- **Pluggable providers** — bring your own model via the `DecisionProvider` interface
- **CSV import/export** — let humans review and correct decisions in Excel
- **CLI included** — `dm` for stats, review queue, export/import and audits

---

## How It Works

```text
  Agent asks: question + options + facts + risk
                       │
                       ▼
              [ Risk Policy Check ] ── high risk ──► Human review
                       │
                       ▼
           [ Canonical Hash (SHA-256) ]
                       │
          ┌────────────┴─────────────┐
          ▼                          ▼
     MEMORY HIT                 MEMORY MISS
  (memory confidence)                │
          │                          │
   ≥ 0.90  Reuse directly     ≥ 0.60  Jev answer (unproven)
   ≥ 0.60  Jev + evidence     ≥ 0.30  LLM + Jev verification
   ≥ 0.30  LLM + evidence     < 0.30  Human review queue
   < 0.30  Treat as miss
          │                          │
          └────────────┬─────────────┘
                       ▼
               [ Agent acts ]
                       │
                       ▼
        [ reportOutcome: success / failure ]
                       │
                       ▼
        [ Update evidence + audit log ]
```

Each decision is stored with its answer, source, confirmations, contradictions and expiry. Reuse is only allowed once a decision has enough confirmations, so a single lucky answer can never be trusted blindly.

---

## Installation

```bash
git clone https://github.com/neelmali182/DCX---Direct-Memory-Exchange.git
cd DCX---Direct-Memory-Exchange
npm install
npm run build
```

---

## Usage

### Make a decision

```typescript
import { DecisionMemory } from "./src/index.js";

const dm = new DecisionMemory({ configPath: "./config/default.yaml" });

const res = await dm.decide({
  question: "How should we handle this failed upstream request?",
  options: ["retry_with_delay", "exponential_backoff", "switch_endpoint", "fail_job"],
  facts: { status_code: 429, has_retry_after: true, endpoint: "llm_gateway" },
  risk: "low",
});

console.log(res.answer);             // chosen action
console.log(res.path);               // how it was decided
console.log(res.memory_confidence);  // trust in the memory entry
```

### Report the outcome

```typescript
dm.reportOutcome(res.decision_id, "success"); // builds trust toward direct reuse
dm.reportOutcome(res.decision_id, "failure"); // drops confidence, blocks unsafe reuse
```

### Gate high-risk actions

```typescript
const res = await dm.decide({
  question: "What should we do about this billing dispute?",
  options: ["instant_refund", "escalate_billing_human", "deny_claim"],
  facts: { issue: "overcharge", amount: 500 },
  risk: "high", // never auto-reused, goes to human review
});
```

### Bring your own model

```typescript
import { DecisionMemory, type DecisionProvider, type ProviderInput, type ProviderResult } from "./src/index.js";

class MyProvider implements DecisionProvider {
  readonly name = "my_llm";

  async decide(input: ProviderInput): Promise<ProviderResult> {
    // Call your model with input.question, input.options, input.facts and past evidence
    return { answer: "exponential_backoff", confidence: 0.92 };
  }
}

const dm = new DecisionMemory({ jevProvider: new MyProvider() });
```

---

## CLI

```bash
npm run dm -- <command>
```

| Command | Description |
|---|---|
| `stats` | Show memory statistics and breakdown |
| `review list` | List items waiting for human review |
| `review resolve <id> <answer>` | Resolve a review item |
| `export [dir]` | Export all decisions to CSV |
| `import <file.csv>` | Import human corrections from CSV |
| `audit [rate]` | Run a batch audit, e.g. `0.2` for 20% |
| `--config <path>` | Use a custom config file |

---

## Human Review Workflow

1. Run `dm export` to write decisions and the review queue to CSV.
2. Open the file in Excel or Google Sheets and correct or approve answers.
3. Run `dm import <file.csv>` to load the human decisions back into memory.

Human answers carry the highest source trust, so they quickly become reusable.

---

## Configuration

All behavior is controlled from `config/default.yaml`:

```yaml
thresholds:
  direct_reuse: 0.90
  jev_with_evidence: 0.60
  llm_plus_jev: 0.30

audit_rate: 0.05            # fraction of reuses re-checked
source_trust:
  human: 1.0
  jev: 0.9
  llm: 0.8

min_confirmations_for_reuse: 3
unproven_cap: 0.85          # max confidence before enough confirmations
expiry_days: 90

risk_policy:
  high_risk_action_tags: [delete, overwrite, payment, send_external, deploy]
  high_risk_behavior: require_human

storage:
  data_dir: ./memory
```

---

## Project Structure

```text
DCX/
├── src/
│   ├── index.ts          # Public API (DecisionMemory)
│   ├── router.ts         # Routing cascade
│   ├── confidence.ts     # Confidence scoring
│   ├── canonical.ts      # Canonical keys and hashing
│   ├── risk.ts           # Risk policy
│   ├── outcomes.ts       # Outcome reporting
│   ├── audit.ts          # Audit sampling
│   ├── excel.ts          # CSV import/export
│   ├── cli.ts            # dm command line tool
│   ├── providers/        # Jev, LLM, human and fake providers
│   └── store/            # Atomic JSON store
├── config/default.yaml
├── examples/             # Support ticket triage demo
├── eval/                 # Simulation and evaluation
└── tests/                # Vitest test suite
```

---

## Development

```bash
npm run build      # compile TypeScript to dist/
npm test           # run the test suite
npm run lint       # type-check
npm run example    # support ticket triage demo
npm run simulate   # evaluation simulation
```

---

## License

Released under the [ISC License](https://opensource.org/licenses/ISC).
