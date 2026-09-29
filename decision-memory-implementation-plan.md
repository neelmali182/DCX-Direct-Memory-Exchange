# Decision Memory: Revised Design & Implementation Plan

**One-line idea:** When an agent asks Jev (or an LLM, or a human) a decision question, save the question, options, answer and confidence. If the same question comes back, check memory first and only call a model when memory is not trustworthy enough.

**Status:** MVP plan (v0.1). Replaces the earlier 60-section design. Scope is deliberately small.

---

## 1. What changed from the first version (the fixes)

| # | Problem found | Fix in this plan |
|---|---|---|
| 1 | "Confidence of the past answer" was just Jev's old probability, so memory could repeat a wrong answer at 95% forever | New **memory confidence** = model confidence x source trust, updated by real evidence (successes, failures, audit checks, human verification). See section 5 |
| 2 | One score drove all routing, so brand-new questions would go straight to a human | **Two signals**: memory score decides whether to skip Jev; Jev's own probability decides whether to escalate. New questions go to Jev first. See section 6 |
| 3 | "Similar question" matching can reuse a wrong answer | v0.1 uses **exact matching on a normalized key**. Semantic matching is deferred to v0.2. See section 4 |
| 4 | Small details change the right answer (e.g. 429 with vs without a Retry-After header) | The agent passes a small **`facts`** object, and it is part of the match key. See section 4 |
| 5 | Excel is a poor live database | **JSON is the source of truth**, Excel/CSV is an export (and optional import for human corrections). See section 7 |
| 6 | Silent drift: old answers go stale, confidence never decays | **Expiry**, **audit sampling** (re-check a slice of reused decisions), and **earned trust** (no direct reuse until enough confirmations, unless human-verified). See section 8 |
| 7 | Risky actions could be auto-reused | A separate **risk policy** runs first and can block direct reuse regardless of confidence. See section 6 |
| 8 | Jev returns no reasoning text | The record does not require a "why". Optional explanation can be added later by a chat model. See section 12 |
| 9 | No way to know if a decision worked | **Outcome recording** is a first-class API call. Without it, the system is only a cache. See section 8 |

---

## 2. What Jev is (assumption to verify)

Based on public information: Jev is a hosted "System One" decision model from TypeSafe AI. It takes text plus a typed question and returns a typed answer with probabilities. It does not return prose or reasoning. It has TypeScript and Python SDKs.

**Before building the provider (Milestone 3), read the TypeSafe docs and confirm:**
- the exact SDK call for a Choice question,
- the shape of the returned probabilities,
- input length limits (how much past-decision evidence fits),
- pricing and rate limits,
- the published failure modes ("jaggedness" page).

The provider is written behind an interface, so none of these details affect the rest of the system.

---

## 3. Core flow

```text
Agent asks: question + options + facts
        |
        v
Risk policy check  ------ high risk -----> never direct reuse (see 6.1)
        |
        v
Normalize + hash -> look up in memory
        |
   +----+-------------------------+
   |                              |
 HIT (compute memory_confidence)  MISS
   |                              |
   |                              v
   |                     Cascade from Jev (6.3)
   v
 Route by memory_confidence (6.2)
   >= 0.90        -> reuse memory (no model call)
   0.60 - 0.90    -> Jev, with the past decision as evidence
   0.30 - 0.60    -> LLM + Jev, with the past decision as evidence
   <  0.30        -> treat like a miss: cascade from Jev
        |
        v
 Final answer -> agent acts -> outcome reported (optional but important)
        |
        v
 Save / update memory + append to audit log
```

---

## 4. Matching (v0.1: exact only)

### 4.1 Inputs the agent provides

```ts
{
  question: "What should I do next?",
  options: ["retry", "backoff", "switch_api", "ask_human"],
  facts: { status: 429, has_retry_after: false, endpoint: "payments" },
  risk: "low"            // optional, see 6.1
}
```

- `facts` is a small, flat object of the details that **change the right answer**. The developer chooses them. This is what prevents "similar looking, different situation" mistakes.
- Free-text description (if any) is passed to Jev but is **not** part of the key.

### 4.2 Canonical key

1. Lowercase and trim the question, collapse whitespace.
2. Normalize each option the same way, then **sort** the options (order should not matter).
3. Sort `facts` by key, serialize as canonical JSON.
4. `key = sha256(question_norm + "|" + options_sorted.join(",") + "|" + facts_json)`.

Two requests with the same key are "the same question".

### 4.3 What is not in v0.1

Semantic or fuzzy matching. It is where wrong reuse creeps in. Add it in v0.2 only after measuring the wrong-reuse rate on exact matching, and never allow *direct reuse* on a fuzzy match without the extra checks in section 11.

---

## 5. Memory confidence (the key formula)

Memory confidence answers: **"How much should we trust this saved answer for this question right now?"**

### 5.1 Ingredients

- `model_confidence`: the probability the source reported when it made the decision (Jev's top probability, etc.). Null for humans.
- **Source trust** (configurable): human = 1.0, jev = 0.9, llm = 0.8.
- **Evidence counts**, stored per record:
  - `confirmations`: outcome success, audit re-check where Jev agreed, human approval.
  - `contradictions`: outcome failure, audit re-check where Jev disagreed, human override.

### 5.2 Formula

```text
initial = human_verified ? 0.98 : model_confidence x source_trust

memory_confidence =
    (confirmations + k x initial) / (confirmations + contradictions + k)
```

`k` (default 2) is how strongly the initial estimate resists early evidence.

Then two safety rules:

1. **Earned trust cap:** if not human-verified and `confirmations < 3`, cap at `0.85`. So a decision cannot be directly reused (needs >= 0.90) until it has proven itself or a human verified it.
2. **Expiry:** if past `expires_at`, multiply by `0.5`.

### 5.3 Worked example

Jev answered "backoff" at 0.94. `initial = 0.94 x 0.9 = 0.846`.

| Situation | Calculation | Result |
|---|---|---|
| Just created | (0 + 2 x 0.846) / 2 | 0.846 (not reusable yet) |
| 3 confirmations | (3 + 1.692) / 5 | 0.938 (reusable) |
| 3 confirmations + 1 failure | (3 + 1.692) / 6 | 0.782 (goes back to Jev + evidence) |
| Human verifies it | initial = 0.98 | 0.98 |
| Expired | 0.938 x 0.5 | 0.469 (re-ask) |

### 5.4 Honest limit

This is a **reuse score, not a calibrated probability**. Treat "0.93" as "ranks high", not "93% likely correct", until the calibration check in section 13 has been done on real data.

---

## 6. Routing

### 6.1 Risk policy (runs first, plain code, no model)

```yaml
risk_policy:
  high_risk_action_tags: [delete, overwrite, payment, send_external, deploy]
  high_risk_behavior: require_human       # never auto-reuse, never auto-act
```

- If the request is tagged high risk, skip direct reuse and route to a human (or to the review queue) regardless of confidence.
- Models may recommend; **code decides what is permitted**.

### 6.2 Routing on a memory hit

| memory_confidence | Path | What is sent to the model |
|---|---|---|
| >= 0.90 | **Direct reuse**, no model call | n/a |
| 0.60 to < 0.90 | **Jev + past decision** | question, options, facts, past answer + its stats |
| 0.30 to < 0.60 | **LLM + Jev + past decision** | LLM interprets, Jev gives the typed decision |
| < 0.30 | Treat as a miss (6.3) | ignore the weak memory as evidence, or include it flagged as "weak" |

If Jev disagrees with the past answer, that counts as a contradiction (section 5.1) and the new answer is saved.

### 6.3 Routing on a miss (no memory, or very weak memory)

Use **Jev's own probability** to decide escalation:

| Jev confidence | Action |
|---|---|
| >= 0.60 | Accept Jev's answer, save as **unverified** |
| 0.30 to < 0.60 | Ask the LLM, then Jev again with the LLM's analysis as context, save the result |
| < 0.30 | Send to the **human review queue** |

This fixes the earlier problem: a genuinely new question does not go to a human just because memory is empty.

### 6.4 Audit sampling

For `audit_rate` (default 5%) of direct-reuse hits, **also call Jev in the background** and compare:
- agree -> `confirmations += 1`,
- disagree -> `contradictions += 1` and flag for review.

This is how the system notices drift without waiting for outcome reports.

### 6.5 Thresholds live in config

```yaml
thresholds:
  direct_reuse: 0.90
  jev_with_evidence: 0.60
  llm_plus_jev: 0.30
audit_rate: 0.05
source_trust: { human: 1.0, jev: 0.9, llm: 0.8 }
k: 2
min_confirmations_for_reuse: 3
unproven_cap: 0.85
expiry_days: 90
```

Never hard-code these. Tune them using section 13.

---

## 7. Storage

### 7.1 Files

```text
memory/
  decisions.json        # current state of every decision (source of truth)
  events.jsonl          # append-only audit log, one event per line
  review_queue.json     # items waiting for a human
  export/
    decisions.csv       # human-readable export (opens in Excel)
    decisions.xlsx      # optional, generated on demand
```

- `decisions.json` is written **atomically** (write to a temp file, then rename) so a crash cannot corrupt it.
- `events.jsonl` is append-only. Every reuse, model call, outcome and human action is an event. This is the audit trail.
- Good up to roughly tens of thousands of records. Move to **SQLite** at that point; the store interface (section 9) means nothing else changes.

### 7.2 Record schema

```ts
type Source = "jev" | "llm" | "human";

interface DecisionRecord {
  id: string;                      // "dec_000123"
  schema_version: 1;
  key: string;                     // canonical hash (section 4.2)

  question: string;
  options: string[];
  facts: Record<string, string | number | boolean>;
  risk: "low" | "high";

  answer: string;
  source: Source;                  // who produced the current answer
  model_confidence: number | null;
  human_verified: boolean;

  stats: {
    uses: number;                  // times served from memory
    confirmations: number;
    contradictions: number;
  };
  memory_confidence: number;       // recomputed on every change

  created_at: string;              // ISO 8601
  last_used_at: string | null;
  expires_at: string;
}
```

### 7.3 Event log line

```json
{"ts":"2026-09-28T10:15:02Z","event":"reuse","decision_id":"dec_000123","memory_confidence":0.938,"path":"direct"}
{"ts":"2026-09-28T10:15:09Z","event":"outcome","decision_id":"dec_000123","status":"success"}
{"ts":"2026-09-28T10:20:41Z","event":"audit","decision_id":"dec_000123","jev_answer":"backoff","agrees":true}
```

### 7.4 Excel export columns (one row per decision)

`id, question, options, facts, answer, source, model_confidence, human_verified, uses, confirmations, contradictions, memory_confidence, last_used_at, expires_at`

### 7.5 Excel import (human corrections)

- A human edits the `answer` cell (or ticks a `verified` column) in the exported file.
- `import` reads the file, matches by `id`, and for changed rows: sets the new answer, `source = "human"`, `human_verified = true`, logs an event.
- Rows that changed in unexpected columns are rejected with a report, not silently applied.

---

## 8. Learning loop

### 8.1 What gets saved on each path

| Path taken | What is saved / updated |
|---|---|
| Direct reuse | `uses += 1`, `last_used_at`, log event. No new record |
| Jev + evidence | If Jev agrees with memory: `confirmations += 1`. If it disagrees: `contradictions += 1` on the old record and a **new/updated answer** saved with `source = jev` |
| LLM + Jev | Save the result, `source = llm` or `jev` (whichever produced the final typed answer) |
| Miss -> Jev | Create new record, unverified |
| Human | Create/update record with `source = human`, `human_verified = true` |

### 8.2 Outcome recording

The agent reports what happened after acting:

```ts
memory.recordOutcome({ decisionId: "dec_000123", status: "success" | "failure" | "unknown" });
```

- `success` -> `confirmations += 1`
- `failure` -> `contradictions += 1`
- `unknown` -> no change

Without outcome reports, only audit checks and human review can raise or lower trust. If the agent cannot tell whether a decision worked, say so, and accept that the system is then a cache with audit checks.

### 8.3 Expiry

Every record gets `expires_at = created_at + expiry_days`. Reconfirmation (outcome success, audit agree, human verify) extends it. Expired records are not deleted; their confidence is halved so they route back through a model.

---

## 9. Code structure (TypeScript)

TypeScript is suggested because Jev's SDK is TypeScript-first. Python works equally well if you prefer it; the design does not change.

```text
decision-memory/
  README.md
  package.json
  tsconfig.json
  config/default.yaml
  memory/                     # data files (gitignored)
  src/
    types.ts                  # DecisionRecord, request/response types
    canonical.ts              # normalize + hash
    confidence.ts             # memoryConfidence()
    router.ts                 # decide()
    risk.ts                   # risk policy
    store/
      store.ts                # interface: get, put, update, list
      jsonStore.ts            # JSON + JSONL implementation
    providers/
      provider.ts             # DecisionProvider interface
      jev.ts                  # Jev adapter
      llm.ts                  # LLM adapter
      human.ts                # writes to review queue
    audit.ts                  # sampling + comparison
    outcomes.ts               # recordOutcome()
    excel.ts                  # export / import
    index.ts                  # public API: DecisionMemory
  examples/
    support_ticket_triage.ts
  tests/
    canonical.test.ts
    confidence.test.ts
    router.test.ts
    store.test.ts
    excel.test.ts
  eval/
    simulate.ts               # baseline vs memory experiment
```

### 9.1 Provider interface

```ts
interface ProviderResult { answer: string; confidence: number }

interface DecisionProvider {
  decide(input: {
    question: string;
    options: string[];
    facts: Record<string, unknown>;
    evidence?: { answer: string; memory_confidence: number; uses: number;
                 confirmations: number; contradictions: number };
  }): Promise<ProviderResult>;
}
```

`jev.ts`, `llm.ts` and a fake provider for tests all implement this. Swapping Jev for something else touches only one file.

### 9.2 Key function sketches

```ts
// canonical.ts
export function makeKey(q: string, options: string[], facts: object): string {
  const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");
  const opts = options.map(norm).sort().join(",");
  const f = JSON.stringify(sortKeys(facts));
  return sha256(`${norm(q)}|${opts}|${f}`);
}
```

```ts
// confidence.ts
export function memoryConfidence(r: DecisionRecord, cfg: Config, now = new Date()): number {
  const trust = { human: 1.0, jev: cfg.source_trust.jev, llm: cfg.source_trust.llm }[r.source];
  const initial = r.human_verified ? 0.98 : (r.model_confidence ?? 0.5) * trust;
  const { confirmations: c, contradictions: x } = r.stats;
  let m = (c + cfg.k * initial) / (c + x + cfg.k);
  if (!r.human_verified && c < cfg.min_confirmations_for_reuse) m = Math.min(m, cfg.unproven_cap);
  if (now > new Date(r.expires_at)) m *= 0.5;
  return Math.max(0, Math.min(1, m));
}
```

```ts
// router.ts (outline)
async function decide(req) {
  const key = makeKey(req.question, req.options, req.facts);
  const rec = store.get(key);
  const highRisk = riskPolicy(req).high;

  if (rec) {
    const m = memoryConfidence(rec, cfg);
    if (!highRisk && m >= cfg.direct_reuse) return reuse(rec, m);            // + audit sampling
    if (m >= cfg.jev_with_evidence)         return viaJev(req, rec);          // Jev + evidence
    if (m >= cfg.llm_plus_jev)              return viaLlmAndJev(req, rec);    // LLM + Jev + evidence
    // else fall through: treat as a miss
  }
  return cascadeFromJev(req, highRisk);   // Jev -> LLM -> human, by Jev's own confidence
}
```

---

## 10. Milestones

Rough sizes assume one developer; adjust to your pace.

### M0: Setup (0.5 day)
- [ ] Repo, TypeScript, Vitest, lint
- [ ] `config/default.yaml` loader
- [ ] Read the Jev docs and answer the questions in section 2

### M1: Core data + storage (1-2 days)
- [ ] `types.ts`, `canonical.ts` (+ tests: option order, whitespace, facts order all give the same key)
- [ ] `store` interface and `jsonStore` with atomic writes and `events.jsonl`
- [ ] Tests: create, get, update, crash-safe write

### M2: Confidence + router with fake providers (2 days)
- [ ] `confidence.ts` (+ tests reproducing the table in 5.3)
- [ ] `router.ts` with all tiers, using a fake provider that returns scripted answers
- [ ] Risk policy
- [ ] Tests for every branch: reuse, Jev+evidence, LLM+Jev, miss cascade, human queue, high risk blocked

### M3: Jev provider (1 day)
- [ ] `providers/jev.ts` implementing `DecisionProvider`
- [ ] Map Jev's typed answer/probability to `ProviderResult`
- [ ] Evidence formatting: how the past decision is put into the input text
- [ ] Handle failures explicitly (timeout, error, unparseable): an outage must **never** look like a normal answer. Fall back to the review queue

### M4: LLM provider + human queue (1-2 days)
- [ ] `providers/llm.ts` (interprets the situation, passes a cleaned summary to Jev)
- [ ] `providers/human.ts` writes to `review_queue.json`; a small CLI (`dm review`) lists and answers items
- [ ] Human answers saved as `human_verified`

### M5: Outcomes, audit, expiry (1-2 days)
- [ ] `recordOutcome()`
- [ ] Audit sampling (background Jev check on a share of reuses)
- [ ] Expiry handling and reconfirmation
- [ ] Tests: confidence rises with confirmations and drops with failures

### M6: Excel/CSV export and import (1 day)
- [ ] Export to CSV (and optional `.xlsx` via a library)
- [ ] Import human edits by `id`, mark as verified, reject unexpected changes
- [ ] Round-trip test

### M7: Demo + evaluation (2-3 days)
- [ ] Example agent: support-ticket triage (a repeated decision where a hand-written rule is not obvious; this is where memory earns its keep)
- [ ] Simulation script (section 13)
- [ ] Short README with results

### v0.2 candidates (after measuring)
- Semantic matching, with guardrails (section 11)
- SQLite store
- Calibration analysis and threshold tuning
- Optional explanations via a chat model
- Simple dashboard

---

## 11. Guardrails for semantic matching (v0.2, not now)

If you add fuzzy matching later:
- Only allow it to **inform** Jev/LLM as evidence, not to trigger direct reuse, until the wrong-reuse rate is measured.
- Require the `facts` objects to match exactly on the fields marked `must_match`.
- Cap confidence on any non-exact match (for example 0.80) so it cannot pass the direct-reuse threshold.

---

## 12. Known limits (be honest about these)

- **Jev has no reasoning text.** Records do not explain *why*. If you need explanations for audit, add a chat-model explanation step later.
- **Model confidence is not truth.** A 0.95 from Jev can still be wrong. That is why trust is built from outcomes and audits, not from the first answer alone.
- **Vendor calibration is not your calibration.** Verify it on your own decisions (section 13).
- **Outcome signals may not exist** for some decisions. Then confidence rests on audits and human review only.
- **Repeated identical questions are needed.** If your agent rarely sees the same decision twice, exact matching will rarely hit and the benefit will be small. Measure the repeat rate first (section 13, step 1).

---

## 13. Evaluation plan

### Step 1: Measure repeat rate (before building anything big)
Log the decisions your real agent would ask over a few days. How many share an exact key? If it is low (say under 10%), exact-match memory will not pay off and the idea needs semantic matching or a different task.

### Step 2: Simulation
Build ~200-500 decisions from one task (e.g. ticket triage) with realistic repeats, plus **perturbed** variants (same question, one changed fact) and some with deliberately wrong first answers.

Compare two systems on the same stream:

| System | Flow |
|---|---|
| Baseline | Agent -> Jev on every decision |
| Decision Memory | Agent -> memory -> router -> Jev/LLM/human |

### Step 3: Metrics

| Metric | Why it matters |
|---|---|
| **Wrong-reuse rate** (reused answer differs from ground truth) | The most important safety number |
| Reuse rate | How often memory skips a call |
| Jev calls avoided | The cost saving |
| Accuracy vs ground truth | Should not be worse than baseline |
| Human escalation rate | Should stay low |
| Latency per decision | Memory hits should be near-instant |
| Recovery time | How fast a corrected/failed decision stops being reused |

### Step 4: Calibration check
Bucket decisions by memory confidence (0.6-0.7, 0.7-0.8, 0.8-0.9, 0.9-1.0) and compute the real success rate in each bucket. If the 0.9+ bucket is not clearly the most accurate, raise the direct-reuse threshold.

### Success criteria for v0.1
- Wrong-reuse rate is low and does not exceed a limit you set in advance (decide it now, e.g. under 2%).
- Jev calls avoided is meaningfully above zero on a repeat-heavy task.
- Accuracy is not worse than the baseline.
- A corrected decision (human override) stops being reused wrongly on the very next request.

---

## 14. Test checklist (acceptance)

1. Same question, options in a different order -> same key, memory hit.
2. Same question, one `facts` value changed -> different key, **no** memory hit.
3. New decision from Jev at 0.94 -> saved unverified, **not** directly reusable yet.
4. After 3 successful outcomes -> directly reusable (>= 0.90) with no Jev call.
5. After a reported failure -> drops below 0.90, routes to Jev + evidence.
6. Human corrects an answer -> `human_verified`, used immediately, confidence 0.98.
7. High-risk request with confidence 0.99 -> never auto-reused.
8. Jev unavailable -> goes to review queue, is **not** treated as an answer.
9. Expired record -> re-asked, not directly reused.
10. Export -> edit answer in Excel -> import -> record updated and verified; unexpected column edits rejected.
11. Audit sample where Jev disagrees -> contradiction recorded and flagged.
12. Crash during write -> `decisions.json` is still valid.

---

## 15. Decisions you still need to make

1. **How will your agent know if a decision worked?** (Outcome signal: tests passing, user feedback, no error afterward, etc.) This determines how much trust the system can honestly build.
2. **Which task is the demo?** Pick one with repeated decisions and no obvious hand-written rule.
3. **Which facts belong in `facts` for that task?** Start with 2-4.
4. **What is your acceptable wrong-reuse rate?** Decide before you look at results.
5. **Language:** TypeScript (matches Jev's SDK) or Python (if you prefer it for evaluation scripts).

---

## 16. Out of scope for v0.1

Semantic search, vector databases, dashboards, decision graphs, multi-agent support, training or fine-tuning, distributed workers, authentication and multi-tenant isolation, PII handling. Revisit these only after the section 13 results look good.

---

## 17. Summary

Save every decision with its confidence and source. Match exact questions, including the facts that matter. Trust a saved answer only as far as evidence supports (outcomes, audits, human review), reuse it above 0.90 when it is low-risk, and send everything else through Jev, the LLM, or a human. Every path updates memory, and the log records why.

The first thing to do is not code. It is Step 1 of section 13: measure how often your agent actually repeats the same decision.
