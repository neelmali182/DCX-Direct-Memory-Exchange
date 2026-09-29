/**
 * Canonical key generation for decision matching.
 *
 * v0.1: exact match only. Two requests with the same normalized
 * question + sorted options + sorted facts produce the same SHA-256 hash.
 */

import { createHash } from "node:crypto";

/**
 * Normalize a string: lowercase, trim, collapse whitespace.
 */
export function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Sort object keys recursively and return a new object.
 */
function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const val = obj[key];
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      sorted[key] = sortKeys(val as Record<string, unknown>);
    } else {
      sorted[key] = val;
    }
  }
  return sorted;
}

/**
 * Build a canonical key from a question, options, and facts.
 *
 * 1. Lowercase & trim the question, collapse whitespace.
 * 2. Normalize each option the same way, then sort.
 * 3. Sort facts by key, serialize as canonical JSON.
 * 4. SHA-256 hash the combined string.
 */
export function makeKey(
  question: string,
  options: string[],
  facts: Record<string, unknown>,
): string {
  const qNorm = normalize(question);
  const optsNorm = options.map(normalize).sort().join(",");
  const factsJson = JSON.stringify(sortKeys(facts));
  const raw = `${qNorm}|${optsNorm}|${factsJson}`;
  return createHash("sha256").update(raw).digest("hex");
}
