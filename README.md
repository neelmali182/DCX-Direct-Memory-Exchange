<div align="center">

# DCX — Direct Memory Exchange

**Confidence-routed decision memory for AI agents.**
Reuse past decisions only when they've earned trust. Escalate everything else.

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat\&logo=typescript\&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat\&logo=node.js\&logoColor=white)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-Vitest-6E9F18?style=flat\&logo=vitest\&logoColor=white)](https://vitest.dev/)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

**Decision Memory • AI Agents • LLM Infrastructure • Confidence Routing**

</div>

---

## Table of Contents

* [Overview](#overview)
* [What is Decision Memory?](#what-is-decision-memory)
* [Why DCX?](#why-dcx)
* [Features](#features)
* [How It Works](#how-it-works)
* [DCX vs Traditional AI Memory](#dcx-vs-traditional-ai-memory)
* [Use Cases](#use-cases)
* [Installation](#installation)
* [Usage](#usage)
* [CLI](#cli)
* [Human Review Workflow](#human-review-workflow)
* [Configuration](#configuration)
* [Architecture](#architecture)
* [Project Structure](#project-structure)
* [Development](#development)
* [Roadmap](#roadmap)
* [Contributing](#contributing)
* [License](#license)

---

## Overview

**DCX (Direct Memory Exchange)** is an open-source **decision memory layer for AI agents**.

Autonomous agents repeatedly encounter the same operational decisions:

> *"What should I do on this 429?"*
> *"Should I retry or switch endpoints?"*
> *"How should this ticket be routed?"*
> *"Have we already solved this situation before?"*

Calling an LLM every time can be slow, expensive and non-deterministic.

A traditional cache is fast, but it can blindly reuse stale or unsafe decisions.

**DCX sits between the AI agent and its reasoning system to remember decisions, evaluate their trustworthiness, and route uncertain situations to stronger reasoning or human review.**

```text
                         AI AGENT
                            │
                            ▼
                  ┌────────────────────┐
                  │        DCX         │
                  │  Decision Memory   │
                  │       Layer        │
                  └─────────┬──────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
           Reuse          Jev/LLM       Human
          Memory         Reasoning      Review
```

The core principle is simple:

> **Don't just remember answers. Remember decisions and whether those decisions actually worked.**

---

## What is Decision Memory?

AI agent memory is often associated with conversation history, vector databases or semantic retrieval.

Those systems answer questions such as:

```text
"What did the user say?"

"What information is relevant?"

"What documents are related?"
```

DCX focuses on a different problem:

```text
"What decision did we make?"

"Why did we make it?"

"How confident were we?"

"Did it work?"

"Is it safe to reuse?"
```

A DCX memory entry can contain:

```text
Question
   +
Options
   +
Facts / Context
   +
Risk
   ↓
Decision
   +
Confidence
   +
Evidence
   +
Outcome
   ↓
Future Decision
```

This makes DCX a **decision-oriented memory system for AI agents**, rather than simply a conversation or response cache.

---

## Why DCX?

| Problem with naive caching         | How DCX handles it                                        |
| ---------------------------------- | --------------------------------------------------------- |
| Trusts an old answer forever       | Confidence is earned from real outcomes                   |
| Ignores important context          | Structured `facts` are part of the canonical decision key |
| Cannot learn from failures         | `reportOutcome()` updates decision confidence             |
| Never notices system drift         | Reused decisions can be randomly re-audited               |
| Automatically reuses risky actions | High-risk actions can require human review                |
| Requires one specific model        | Pluggable `DecisionProvider` interface                    |
| Difficult to inspect               | Decisions can be exported and reviewed through CSV        |

---

## Features

* **Earned-trust confidence** — successes increase trust while failures reduce confidence immediately
* **Decision memory** — store decisions rather than simply caching model responses
* **Canonical keying** — normalized question + sorted options + canonical `facts`, hashed with SHA-256
* **Context-aware matching** — important facts are included when determining whether two situations are equivalent
* **Routing cascade** — direct reuse → Jev → LLM → human review
* **Risk gating** — configurable high-risk action tags can always require human approval
* **Outcome tracking** — decisions become more or less trusted based on real-world outcomes
* **Audit sampling** — configurable fraction of reused decisions can be re-verified
* **Crash-safe storage** — atomic JSON store with an append-only `events.jsonl` log
* **Pluggable providers** — bring your own model through the `DecisionProvider` interface
* **CSV import/export** — allow humans to review and correct decisions using Excel or Google Sheets
* **CLI included** — `dm` for statistics, reviews, audits and data management
* **Model agnostic** — designed to work with different LLMs and reasoning systems
* **Human-in-the-loop** — uncertain or high-risk decisions can be escalated instead of automatically executed

---

## How It Works

```text
  Agent asks: question + options + facts + risk
                       │
                       ▼
              [ Risk Policy Check ]
                       │
              ┌────────┴────────┐
              │                 │
          High Risk          Normal Risk
              │                 │
              ▼                 ▼
        Human Review      [ Canonical Hash ]
                                │
                   ┌────────────┴─────────────┐
                   ▼                          ▼
              MEMORY HIT                 MEMORY MISS
                   │                          │
                   ▼                          ▼
          Evaluate Confidence          Jev / LLM
                   │                          │
          ┌────────┼────────┐                 │
          ▼        ▼        ▼                 ▼
        High     Medium     Low          New Decision
          │        │        │                 │
          ▼        ▼        ▼                 ▼
        Reuse     Jev       LLM          Store Memory
          │        │        │                 │
          └────────┴────────┴─────────────────┘
                                │
                                ▼
                         [ Agent Acts ]
                                │
                                ▼
                     [ reportOutcome() ]
                                │
                                ▼
                    Update Evidence + Audit
```

### Confidence Routing

The routing thresholds can be configured:

```text
≥ 0.90  → Direct memory reuse
≥ 0.60  → Jev + existing evidence
≥ 0.30  → LLM + Jev verification
< 0.30  → Human review
```

These thresholds are configurable and are not hard-coded into the concept of DCX.

Each decision is stored with its answer, source, confirmations, contradictions and expiry.

A single lucky answer should not automatically become trusted memory.

---

## DCX vs Traditional AI Memory

| Capability           | Conversation Memory | Vector Memory | Response Cache | DCX |
| -------------------- | ------------------: | ------------: | -------------: | --: |
| Stores conversation  |                   ✅ |             ✅ |              ❌ |   ❌ |
| Semantic retrieval   |                   ❌ |             ✅ |              ❌ |   ✅ |
| Stores decisions     |                   ❌ |            ⚠️ |              ❌ |   ✅ |
| Stores outcomes      |                   ❌ |            ⚠️ |              ❌ |   ✅ |
| Tracks confidence    |                   ❌ |             ❌ |              ❌ |   ✅ |
| Risk-aware routing   |                   ❌ |             ❌ |              ❌ |   ✅ |
| Human escalation     |                   ❌ |             ❌ |              ❌ |   ✅ |
| Decision auditing    |                   ❌ |            ⚠️ |              ❌ |   ✅ |
| Learns from outcomes |                   ❌ |            ⚠️ |              ❌ |   ✅ |

DCX is therefore intended to complement existing AI memory systems rather than replace them.

---

## Example

Imagine an AI agent interacting with an API.

The API responds:

```text
HTTP 429 — Too Many Requests
```

### Without decision memory

```text
429
 ↓
LLM
 ↓
"Retry after 10 seconds"
```

The same situation occurs again:

```text
429
 ↓
LLM
 ↓
"Retry after 10 seconds"
```

The agent repeatedly spends reasoning resources on a decision it has already encountered.

### With DCX

```text
429
 ↓
DCX
 ↓
Previous decision found
 ↓
Confidence: 0.94
 ↓
Previous outcome: Successful
 ↓
Reuse decision
```

The agent can reuse a proven decision when the context, confidence and risk policy allow it.

---

## Use Cases

### AI Agents

DCX can provide decision memory for autonomous and tool-using AI agents.

```text
Agent
  ↓
Decision
  ↓
DCX
  ↓
Known decision?
 ├── Yes → Evaluate → Reuse
 └── No  → Reason → Store
```

### API Agents

```text
429 → retry
500 → retry with backoff
timeout → switch endpoint
authentication error → refresh credentials
```

### DevOps Agents

```text
Build failure
     ↓
Previous failure pattern
     ↓
Known remediation
     ↓
Apply or escalate
```

### Customer Support Agents

```text
Incoming ticket
      ↓
Similar historical decision
      ↓
Check confidence + risk
      ↓
Reuse or escalate
```

### Autonomous Systems

```text
Situation
    ↓
Decision Memory
    ↓
Context + Confidence + Risk
    ↓
Reuse / Reason / Human
```

---

## Installation

```bash
git clone https://github.com/neelmali182/DCX-Direct-Memory-Exchange.git

cd DCX-Direct-Memory-Exchange

npm install

npm run build
```

---

## Usage

### Make a Decision

```typescript
import { DecisionMemory } from "./src/index.js";

const dm = new DecisionMemory({
  configPath: "./config/default.yaml"
});

const res = await dm.decide({
  question: "How should we handle this failed upstream request?",
  options: [
    "retry_with_delay",
    "exponential_backoff",
    "switch_endpoint",
    "fail_job"
  ],
  facts: {
    status_code: 429,
    has_retry_after: true,
    endpoint: "llm_gateway"
  },
  risk: "low",
});

console.log(res.answer);
console.log(res.path);
console.log(res.memory_confidence);
```

### Report the Outcome

```typescript
dm.reportOutcome(
  res.decision_id,
  "success"
);
```

or:

```typescript
dm.reportOutcome(
  res.decision_id,
  "failure"
);
```

Successful outcomes build evidence toward future reuse.

Failures reduce confidence and can prevent unsafe automatic reuse.

---

## High-Risk Decisions

DCX can prevent certain actions from being automatically reused.

```typescript
const res = await dm.decide({
  question: "What should we do about this billing dispute?",
  options: [
    "instant_refund",
    "escalate_billing_human",
    "deny_claim"
  ],
  facts: {
    issue: "overcharge",
    amount: 500
  },
  risk: "high",
});
```

Configured high-risk actions can be routed directly to human review.

Example risk tags:

```yaml
high_risk_action_tags:
  - delete
  - overwrite
  - payment
  - send_external
  - deploy
```

---

## Bring Your Own Model

DCX is designed to be model-agnostic.

Implement the `DecisionProvider` interface to connect your preferred model or reasoning system.

```typescript
import {
  DecisionMemory,
  type DecisionProvider,
  type ProviderInput,
  type ProviderResult
} from "./src/index.js";

class MyProvider implements DecisionProvider {
  readonly name = "my_llm";

  async decide(input: ProviderInput): Promise<ProviderResult> {
    // Call your model using:
    // input.question
    // input.options
    // input.facts
    // previous evidence

    return {
      answer: "exponential_backoff",
      confidence: 0.92
    };
  }
}

const dm = new DecisionMemory({
  jevProvider: new MyProvider()
});
```

---

## CLI

```bash
npm run dm -- <command>
```

| Command                        | Description                          |
| ------------------------------ | ------------------------------------ |
| `stats`                        | Show memory statistics and breakdown |
| `review list`                  | List items waiting for human review  |
| `review resolve <id> <answer>` | Resolve a review item                |
| `export [dir]`                 | Export decisions to CSV              |
| `import <file.csv>`            | Import human corrections             |
| `audit [rate]`                 | Run a batch audit                    |
| `--config <path>`              | Use a custom configuration           |

Example:

```bash
npm run dm -- stats
```

Run a 20% audit:

```bash
npm run dm -- audit 0.2
```

---

## Human Review Workflow

DCX supports human-in-the-loop decision correction.

### 1. Export

```bash
npm run dm -- export
```

### 2. Review

Open the generated CSV in:

* Microsoft Excel
* Google Sheets
* LibreOffice Calc

Review or correct the stored decisions.

### 3. Import

```bash
npm run dm -- import decisions.csv
```

Human decisions can receive the highest configured source trust.

---

## Configuration

All behavior can be configured through:

```text
config/default.yaml
```

Example:

```yaml
thresholds:
  direct_reuse: 0.90
  jev_with_evidence: 0.60
  llm_plus_jev: 0.30

audit_rate: 0.05

source_trust:
  human: 1.0
  jev: 0.9
  llm: 0.8

min_confirmations_for_reuse: 3

unproven_cap: 0.85

expiry_days: 90

risk_policy:
  high_risk_action_tags:
    - delete
    - overwrite
    - payment
    - send_external
    - deploy

  high_risk_behavior: require_human

storage:
  data_dir: ./memory
```

---

## Architecture

```text
                    ┌──────────────────┐
                    │     AI Agent     │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │       DCX        │
                    │ Decision Memory  │
                    └────────┬─────────┘
                             │
          ┌──────────────────┼──────────────────┐
          ▼                  ▼                  ▼
     Canonical Key       Memory Store       Risk Policy
          │                  │                  │
          └──────────────────┼──────────────────┘
                             ▼
                    ┌──────────────────┐
                    │ Decision Router  │
                    └────────┬─────────┘
                             │
                ┌────────────┼────────────┐
                ▼            ▼            ▼
             Reuse         Jev/LLM      Human
             Memory        Provider     Review
                │            │            │
                └────────────┼────────────┘
                             ▼
                          Outcome
                             │
                             ▼
                    Evidence + Audit
                             │
                             ▼
                      Decision Memory
```

---

## Decision Lifecycle

```text
INPUT
  │
  ▼
Question + Options + Facts + Risk
  │
  ▼
Canonicalization
  │
  ▼
Memory Retrieval
  │
  ▼
Confidence + Evidence Evaluation
  │
  ▼
Risk Evaluation
  │
  ├───────────────┐
  ▼               ▼
Reuse          Reasoning
  │               │
  │          Jev / LLM / Human
  │               │
  └───────┬───────┘
          ▼
       Execute
          │
          ▼
     Observe Outcome
          │
          ▼
   Update Confidence
          │
          ▼
      Audit Log
```

---

## Project Structure

```text
DCX/
├── src/
│   ├── index.ts          # Public API
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
│
├── config/
│   └── default.yaml
│
├── examples/
│   └── support-ticket/
│
├── eval/
│   └── simulation/
│
└── tests/
```

---

## Development

Install dependencies:

```bash
npm install
```

Build:

```bash
npm run build
```

Run tests:

```bash
npm test
```

Type-check:

```bash
npm run lint
```

Run the example:

```bash
npm run example
```

Run the evaluation simulation:

```bash
npm run simulate
```

---

## Roadmap

Planned areas of development include:

* [ ] Improved decision similarity and matching
* [ ] Advanced confidence calibration
* [ ] Outcome-based confidence learning
* [ ] More sophisticated risk policies
* [ ] Distributed decision memory
* [ ] Multi-agent shared memory
* [ ] Decision observability dashboard
* [ ] Additional LLM providers
* [ ] Human approval interfaces
* [ ] Persistent database backends
* [ ] Production deployment tooling
* [ ] Benchmarking against traditional caching and agent-memory approaches

---

## Contributing

Contributions are welcome.

Areas where contributions can be useful include:

* AI agent memory
* LLM infrastructure
* Decision systems
* Agentic AI
* Confidence calibration
* Risk-aware automation
* Evaluation and benchmarking
* Developer tooling

Before opening a pull request, please run:

```bash
npm run build
npm test
npm run lint
```

Issues, feature requests and discussions are welcome.

---

## Repository

**GitHub:**
https://github.com/neelmali182/DCX-Direct-Memory-Exchange

---

## License

Released under the [ISC License](https://opensource.org/licenses/ISC).

---

<div align="center">

### DCX — Direct Memory Exchange

**Remember decisions. Measure outcomes. Reuse with confidence.**

</div>
