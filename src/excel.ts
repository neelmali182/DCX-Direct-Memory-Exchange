/**
 * Excel/CSV export and import.
 *
 * Export: decisions.json → CSV (opens in Excel)
 * Import: human edits answer/verified columns → update records
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config, DecisionRecord, DecisionStore, Source } from "./types.js";
import { memoryConfidence } from "./confidence.js";

// ─── CSV Export ─────────────────────────────────────────────────────────────

const CSV_HEADERS = [
  "id",
  "question",
  "options",
  "facts",
  "answer",
  "source",
  "model_confidence",
  "human_verified",
  "uses",
  "confirmations",
  "contradictions",
  "memory_confidence",
  "last_used_at",
  "expires_at",
] as const;

function escapeCsv(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function recordToCsvRow(r: DecisionRecord): string {
  const values = [
    r.id,
    r.question,
    JSON.stringify(r.options),
    JSON.stringify(r.facts),
    r.answer,
    r.source,
    r.model_confidence?.toString() ?? "",
    r.human_verified ? "TRUE" : "FALSE",
    r.stats.uses.toString(),
    r.stats.confirmations.toString(),
    r.stats.contradictions.toString(),
    r.memory_confidence.toFixed(4),
    r.last_used_at ?? "",
    r.expires_at,
  ];
  return values.map(escapeCsv).join(",");
}

/**
 * Export all decisions to a CSV file.
 */
export function exportToCsv(store: DecisionStore, exportDir: string): string {
  mkdirSync(exportDir, { recursive: true });
  const filePath = join(exportDir, "decisions.csv");

  const header = CSV_HEADERS.join(",");
  const rows = store.list().map(recordToCsvRow);
  const content = [header, ...rows].join("\n") + "\n";

  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// ─── CSV Import ─────────────────────────────────────────────────────────────

export interface ImportResult {
  updated: number;
  rejected: { id: string; reason: string }[];
  unchanged: number;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        values.push(current);
        current = "";
      } else {
        current += char;
      }
    }
  }
  values.push(current);
  return values;
}

/**
 * The only columns a human should edit. Changes to other columns are rejected.
 */
const EDITABLE_COLUMNS = new Set(["answer", "human_verified"]);

/**
 * Import human corrections from a CSV file.
 *
 * Rules:
 * - Matches by `id` column
 * - Only `answer` and `human_verified` columns can be changed
 * - Changed rows get: source = "human", human_verified = true
 * - Unexpected column changes are rejected (not silently applied)
 */
export function importFromCsv(
  csvPath: string,
  store: DecisionStore,
  config: Config,
): ImportResult {
  const now = new Date();
  const content = readFileSync(csvPath, "utf-8");
  const lines = content.split("\n").filter((l: string) => l.trim().length > 0);

  if (lines.length < 2) {
    return { updated: 0, rejected: [], unchanged: 0 };
  }

  // Parse header
  const headers = parseCsvLine(lines[0]);
  const headerIndex = new Map(headers.map((h, i) => [h.trim(), i]));

  const getCol = (row: string[], col: string): string => {
    const idx = headerIndex.get(col);
    return idx !== undefined ? row[idx] : "";
  };

  const result: ImportResult = { updated: 0, rejected: [], unchanged: 0 };

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const id = getCol(values, "id");

    if (!id) continue;

    const existing = store.getById(id);
    if (!existing) {
      result.rejected.push({ id, reason: "Decision not found" });
      continue;
    }

    // Check what changed
    const csvAnswer = getCol(values, "answer");
    const csvVerified = getCol(values, "human_verified").toUpperCase() === "TRUE";

    // Check for unexpected column changes
    const unexpectedChanges: string[] = [];
    const csvQuestion = getCol(values, "question");
    const csvSource = getCol(values, "source");
    const csvOptions = getCol(values, "options");
    const csvFacts = getCol(values, "facts");

    if (csvQuestion && csvQuestion !== existing.question) unexpectedChanges.push("question");
    if (csvSource && csvSource !== existing.source && csvSource !== "human") unexpectedChanges.push("source");
    if (csvOptions) {
      try {
        const parsed = JSON.parse(csvOptions);
        if (JSON.stringify(parsed) !== JSON.stringify(existing.options)) unexpectedChanges.push("options");
      } catch { /* ignore parse errors */ }
    }
    if (csvFacts) {
      try {
        const parsed = JSON.parse(csvFacts);
        if (JSON.stringify(parsed) !== JSON.stringify(existing.facts)) unexpectedChanges.push("facts");
      } catch { /* ignore parse errors */ }
    }

    if (unexpectedChanges.length > 0) {
      result.rejected.push({
        id,
        reason: `Unexpected changes in columns: ${unexpectedChanges.join(", ")}`,
      });
      continue;
    }

    // Check if answer or verified status actually changed
    const answerChanged = csvAnswer !== existing.answer;
    const verifiedChanged = csvVerified !== existing.human_verified;

    if (!answerChanged && !verifiedChanged) {
      result.unchanged++;
      continue;
    }

    // Apply the changes
    store.update(id, (r) => {
      const updated = { ...r };
      if (answerChanged) {
        updated.answer = csvAnswer;
      }
      updated.source = "human" as Source;
      updated.human_verified = true;
      updated.memory_confidence = memoryConfidence(updated, config, now);
      return updated;
    });

    store.appendEvent({
      ts: now.toISOString(),
      event: "human_import",
      decision_id: id,
      old_answer: existing.answer,
      new_answer: csvAnswer,
      answer_changed: answerChanged,
      verified_changed: verifiedChanged,
    });

    result.updated++;
  }

  return result;
}
