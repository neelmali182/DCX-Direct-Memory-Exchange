/**
 * Tests for canonical key generation.
 *
 * Acceptance criteria covered:
 * - #1: Same question, options in different order → same key
 * - #2: Same question, one facts value changed → different key
 */

import { describe, it, expect } from "vitest";
import { makeKey, normalize } from "../src/canonical.js";

describe("normalize", () => {
  it("lowercases text", () => {
    expect(normalize("Hello World")).toBe("hello world");
  });

  it("trims whitespace", () => {
    expect(normalize("  hello  ")).toBe("hello");
  });

  it("collapses multiple spaces", () => {
    expect(normalize("hello    world")).toBe("hello world");
  });

  it("handles mixed whitespace", () => {
    expect(normalize("  Hello   WORLD  ")).toBe("hello world");
  });
});

describe("makeKey", () => {
  const baseQuestion = "What should I do next?";
  const baseOptions = ["retry", "backoff", "switch_api", "ask_human"];
  const baseFacts = { status: 429, has_retry_after: false, endpoint: "payments" };

  it("produces a sha256 hex string", () => {
    const key = makeKey(baseQuestion, baseOptions, baseFacts);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic for the same inputs", () => {
    const key1 = makeKey(baseQuestion, baseOptions, baseFacts);
    const key2 = makeKey(baseQuestion, baseOptions, baseFacts);
    expect(key1).toBe(key2);
  });

  // Acceptance test #1: options in different order → same key
  it("produces the same key regardless of option order", () => {
    const key1 = makeKey(baseQuestion, ["retry", "backoff", "switch_api", "ask_human"], baseFacts);
    const key2 = makeKey(baseQuestion, ["ask_human", "switch_api", "backoff", "retry"], baseFacts);
    expect(key1).toBe(key2);
  });

  it("produces the same key regardless of question casing", () => {
    const key1 = makeKey("What should I do next?", baseOptions, baseFacts);
    const key2 = makeKey("WHAT SHOULD I DO NEXT?", baseOptions, baseFacts);
    expect(key1).toBe(key2);
  });

  it("produces the same key regardless of extra whitespace", () => {
    const key1 = makeKey("What should I do next?", baseOptions, baseFacts);
    const key2 = makeKey("  What   should  I  do   next?  ", baseOptions, baseFacts);
    expect(key1).toBe(key2);
  });

  it("produces the same key regardless of facts key order", () => {
    const key1 = makeKey(baseQuestion, baseOptions, { a: 1, b: 2, c: 3 });
    const key2 = makeKey(baseQuestion, baseOptions, { c: 3, a: 1, b: 2 });
    expect(key1).toBe(key2);
  });

  // Acceptance test #2: one facts value changed → different key
  it("produces a DIFFERENT key when a facts value changes", () => {
    const key1 = makeKey(baseQuestion, baseOptions, { status: 429, has_retry_after: false });
    const key2 = makeKey(baseQuestion, baseOptions, { status: 429, has_retry_after: true });
    expect(key1).not.toBe(key2);
  });

  it("produces a DIFFERENT key when question text changes", () => {
    const key1 = makeKey("What should I do next?", baseOptions, baseFacts);
    const key2 = makeKey("How should I handle this?", baseOptions, baseFacts);
    expect(key1).not.toBe(key2);
  });

  it("produces a DIFFERENT key when an option is added", () => {
    const key1 = makeKey(baseQuestion, ["retry", "backoff"], baseFacts);
    const key2 = makeKey(baseQuestion, ["retry", "backoff", "skip"], baseFacts);
    expect(key1).not.toBe(key2);
  });

  it("handles empty facts", () => {
    const key = makeKey(baseQuestion, baseOptions, {});
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });

  it("handles empty options", () => {
    const key = makeKey(baseQuestion, [], baseFacts);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });
});
