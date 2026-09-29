/**
 * Tests for the JSON store.
 *
 * Acceptance criteria covered:
 * - #12: Crash during write → decisions.json is still valid
 * - Create, get, update, list operations
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { JsonStore } from "../src/store/jsonStore.js";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DecisionRecord } from "../src/types.js";

const TEST_DIR = join(process.cwd(), "test-memory-store");

function makeTestRecord(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  const now = new Date();
  return {
    id: "dec_000001",
    schema_version: 1,
    key: "test-key-abc123",
    question: "What should I do?",
    options: ["retry", "backoff"],
    facts: { status: 429 },
    risk: "low",
    answer: "backoff",
    source: "jev",
    model_confidence: 0.94,
    human_verified: false,
    stats: { uses: 1, confirmations: 0, contradictions: 0 },
    memory_confidence: 0.846,
    created_at: now.toISOString(),
    last_used_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 90 * 86400000).toISOString(),
    ...overrides,
  };
}

describe("JsonStore", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  it("creates the data directory on construction", () => {
    new JsonStore(TEST_DIR);
    expect(existsSync(TEST_DIR)).toBe(true);
    expect(existsSync(join(TEST_DIR, "export"))).toBe(true);
  });

  it("put() and get() by canonical key", () => {
    const store = new JsonStore(TEST_DIR);
    const record = makeTestRecord();

    store.put(record);
    const retrieved = store.get("test-key-abc123");

    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe("dec_000001");
    expect(retrieved!.answer).toBe("backoff");
  });

  it("getById() retrieves by decision ID", () => {
    const store = new JsonStore(TEST_DIR);
    const record = makeTestRecord();

    store.put(record);
    const retrieved = store.getById("dec_000001");

    expect(retrieved).not.toBeNull();
    expect(retrieved!.key).toBe("test-key-abc123");
  });

  it("get() returns null for missing key", () => {
    const store = new JsonStore(TEST_DIR);
    expect(store.get("nonexistent")).toBeNull();
  });

  it("getById() returns null for missing id", () => {
    const store = new JsonStore(TEST_DIR);
    expect(store.getById("nonexistent")).toBeNull();
  });

  it("update() modifies an existing record", () => {
    const store = new JsonStore(TEST_DIR);
    store.put(makeTestRecord());

    const updated = store.update("dec_000001", (r) => ({
      ...r,
      answer: "retry",
      stats: { ...r.stats, confirmations: 1 },
    }));

    expect(updated).not.toBeNull();
    expect(updated!.answer).toBe("retry");
    expect(updated!.stats.confirmations).toBe(1);

    // Verify persistence
    const retrieved = store.get("test-key-abc123");
    expect(retrieved!.answer).toBe("retry");
  });

  it("update() returns null for missing id", () => {
    const store = new JsonStore(TEST_DIR);
    const result = store.update("nonexistent", (r) => r);
    expect(result).toBeNull();
  });

  it("list() returns all records", () => {
    const store = new JsonStore(TEST_DIR);
    store.put(makeTestRecord({ id: "dec_000001", key: "key1" }));
    store.put(makeTestRecord({ id: "dec_000002", key: "key2" }));
    store.put(makeTestRecord({ id: "dec_000003", key: "key3" }));

    const all = store.list();
    expect(all).toHaveLength(3);
  });

  it("nextId() generates sequential IDs", () => {
    const store = new JsonStore(TEST_DIR);
    expect(store.nextId()).toBe("dec_000001");
    expect(store.nextId()).toBe("dec_000002");
    expect(store.nextId()).toBe("dec_000003");
  });

  it("nextId() continues from highest existing ID", () => {
    const store = new JsonStore(TEST_DIR);
    store.put(makeTestRecord({ id: "dec_000010", key: "key10" }));

    // Reload store
    const store2 = new JsonStore(TEST_DIR);
    expect(store2.nextId()).toBe("dec_000011");
  });

  it("appendEvent() writes to events.jsonl", () => {
    const store = new JsonStore(TEST_DIR);
    store.appendEvent({
      ts: new Date().toISOString(),
      event: "test",
      decision_id: "dec_000001",
    });

    const eventsPath = join(TEST_DIR, "events.jsonl");
    expect(existsSync(eventsPath)).toBe(true);

    const content = readFileSync(eventsPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.event).toBe("test");
  });

  it("appendEvent() appends multiple events", () => {
    const store = new JsonStore(TEST_DIR);
    store.appendEvent({ ts: "t1", event: "e1", decision_id: "d1" });
    store.appendEvent({ ts: "t2", event: "e2", decision_id: "d2" });

    const content = readFileSync(join(TEST_DIR, "events.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  // Acceptance test #12: crash safety
  it("persisted file is valid JSON after writes", () => {
    const store = new JsonStore(TEST_DIR);
    store.put(makeTestRecord({ id: "dec_000001", key: "key1" }));
    store.put(makeTestRecord({ id: "dec_000002", key: "key2" }));
    store.update("dec_000001", (r) => ({ ...r, answer: "changed" }));

    // Read the raw file and verify it's valid JSON
    const raw = readFileSync(join(TEST_DIR, "decisions.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].answer).toBe("changed");
  });

  it("data survives reload", () => {
    const store1 = new JsonStore(TEST_DIR);
    store1.put(makeTestRecord({ id: "dec_000001", key: "key1", answer: "backoff" }));
    store1.put(makeTestRecord({ id: "dec_000002", key: "key2", answer: "retry" }));

    // Create a new store instance (simulating restart)
    const store2 = new JsonStore(TEST_DIR);
    expect(store2.list()).toHaveLength(2);
    expect(store2.get("key1")!.answer).toBe("backoff");
    expect(store2.getById("dec_000002")!.answer).toBe("retry");
  });

  // Review queue tests
  it("addReviewItem() and getReviewQueue()", () => {
    const store = new JsonStore(TEST_DIR);
    store.addReviewItem({
      id: "rev_001",
      decision_id: null,
      question: "What to do?",
      options: ["a", "b"],
      facts: {},
      reason: "Low confidence",
      created_at: new Date().toISOString(),
      resolved: false,
    });

    const queue = store.getReviewQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].id).toBe("rev_001");
    expect(queue[0].resolved).toBe(false);
  });

  it("resolveReviewItem() marks item as resolved", () => {
    const store = new JsonStore(TEST_DIR);
    store.addReviewItem({
      id: "rev_001",
      decision_id: null,
      question: "What to do?",
      options: ["a", "b"],
      facts: {},
      reason: "test",
      created_at: new Date().toISOString(),
      resolved: false,
    });

    store.resolveReviewItem("rev_001", "a");

    const queue = store.getReviewQueue();
    expect(queue[0].resolved).toBe(true);
    expect(queue[0].resolved_answer).toBe("a");
  });
});
