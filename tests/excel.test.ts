/**
 * Tests for CSV export and import.
 *
 * Acceptance criteria covered:
 * - #10: Export → edit answer in Excel → import → record updated and verified;
 *        unexpected column edits rejected
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { exportToCsv, importFromCsv } from "../src/excel.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { createConfig } from "../src/config.js";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { DecisionRecord } from "../src/types.js";

const TEST_DIR = join(process.cwd(), "test-memory-excel");
const EXPORT_DIR = join(TEST_DIR, "export");

const config = createConfig({
  storage: { data_dir: TEST_DIR },
});

function makeRecord(id: string, key: string, answer: string): DecisionRecord {
  const now = new Date();
  return {
    id,
    schema_version: 1,
    key,
    question: "What should I do?",
    options: ["retry", "backoff"],
    facts: { status: 429 },
    risk: "low",
    answer,
    source: "jev",
    model_confidence: 0.94,
    human_verified: false,
    stats: { uses: 3, confirmations: 2, contradictions: 0 },
    memory_confidence: 0.85,
    created_at: now.toISOString(),
    last_used_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 90 * 86400000).toISOString(),
  };
}

describe("Excel export/import", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("exports to CSV with correct headers", () => {
    const store = new JsonStore(TEST_DIR);
    store.put(makeRecord("dec_000001", "key1", "backoff"));
    store.put(makeRecord("dec_000002", "key2", "retry"));

    const filePath = exportToCsv(store, EXPORT_DIR);
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");

    // Header + 2 data rows
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("id,question,options,facts,answer");
  });

  it("round-trip: export then import with no changes → no updates", () => {
    const store = new JsonStore(TEST_DIR);
    store.put(makeRecord("dec_000001", "key1", "backoff"));

    const filePath = exportToCsv(store, EXPORT_DIR);
    const result = importFromCsv(filePath, store, config);

    expect(result.updated).toBe(0);
    expect(result.unchanged).toBe(1);
    expect(result.rejected).toHaveLength(0);
  });

  // Acceptance test #10: edit answer → import → updated and verified
  it("import updates answer and marks as human_verified", () => {
    const store = new JsonStore(TEST_DIR);
    store.put(makeRecord("dec_000001", "key1", "backoff"));

    const filePath = exportToCsv(store, EXPORT_DIR);

    // Simulate human editing the CSV: change only the answer column
    let content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    // Header is line 0, data is line 1
    // Columns: id,question,options,facts,answer,source,...
    // We need to replace the answer field (5th column, index 4)
    const cols = lines[1].split(",");
    // Find the answer column by counting — it comes after facts (which is JSON with commas, so it's quoted)
    // Safer approach: reconstruct the line with the answer changed
    // The answer column value "backoff" appears as a standalone field after the facts JSON
    // Use a regex that targets the answer field specifically
    lines[1] = lines[1].replace(/,backoff,jev,/, ",retry,jev,");
    content = lines.join("\n");
    writeFileSync(filePath, content, "utf-8");

    const result = importFromCsv(filePath, store, config);

    expect(result.updated).toBe(1);

    const record = store.getById("dec_000001");
    expect(record!.answer).toBe("retry");
    expect(record!.human_verified).toBe(true);
    expect(record!.source).toBe("human");
  });

  // Acceptance test #10: unexpected column edits rejected
  it("rejects changes to non-editable columns", () => {
    const store = new JsonStore(TEST_DIR);
    store.put(makeRecord("dec_000001", "key1", "backoff"));

    const filePath = exportToCsv(store, EXPORT_DIR);

    // Simulate editing the question (not allowed)
    let content = readFileSync(filePath, "utf-8");
    content = content.replace("What should I do?", "Totally different question");
    writeFileSync(filePath, content, "utf-8");

    const result = importFromCsv(filePath, store, config);

    expect(result.rejected.length).toBeGreaterThanOrEqual(1);
    expect(result.rejected[0].reason).toContain("question");

    // Original record should be unchanged
    const record = store.getById("dec_000001");
    expect(record!.question).toBe("What should I do?");
  });

  it("import handles missing decision IDs gracefully", () => {
    const store = new JsonStore(TEST_DIR);
    store.put(makeRecord("dec_000001", "key1", "backoff"));

    const filePath = exportToCsv(store, EXPORT_DIR);

    // Add a row with a nonexistent ID
    let content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");
    const lastLine = lines[lines.length - 1].replace("dec_000001", "dec_999999");
    content = content.trim() + "\n" + lastLine + "\n";
    writeFileSync(filePath, content, "utf-8");

    const result = importFromCsv(filePath, store, config);

    expect(result.rejected.some((r) => r.id === "dec_999999")).toBe(true);
  });

  it("handles CSV values with commas and quotes", () => {
    const store = new JsonStore(TEST_DIR);
    const record = makeRecord("dec_000001", "key1", "backoff");
    record.question = 'What should I do, "really"?';
    store.put(record);

    const filePath = exportToCsv(store, EXPORT_DIR);
    const content = readFileSync(filePath, "utf-8");

    // Should be properly escaped
    expect(content).toContain('"What should I do, ""really""?"');

    // Import should round-trip correctly
    const result = importFromCsv(filePath, store, config);
    expect(result.unchanged).toBe(1);
  });
});
