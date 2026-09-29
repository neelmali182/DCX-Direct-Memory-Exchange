/**
 * JSON file-backed store for decision records.
 *
 * - decisions.json is written atomically (write to temp, then rename).
 * - events.jsonl is append-only (one event per line).
 * - review_queue.json holds items awaiting human review.
 *
 * Good up to ~tens of thousands of records. Swap for SQLite via the
 * DecisionStore interface when needed.
 */

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  renameSync,
  copyFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { DecisionRecord, DecisionStore, EventLogEntry, ReviewItem } from "../types.js";

export class JsonStore implements DecisionStore {
  private readonly dataDir: string;
  private readonly decisionsPath: string;
  private readonly eventsPath: string;
  private readonly reviewPath: string;

  private decisions: Map<string, DecisionRecord>; // keyed by canonical key
  private decisionsById: Map<string, DecisionRecord>; // keyed by id
  private counter: number;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.decisionsPath = join(dataDir, "decisions.json");
    this.eventsPath = join(dataDir, "events.jsonl");
    this.reviewPath = join(dataDir, "review_queue.json");

    // Ensure directories exist
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(dataDir, "export"), { recursive: true });

    // Load existing data
    this.decisions = new Map();
    this.decisionsById = new Map();
    this.counter = 0;

    this.loadDecisions();
  }

  // ─── Read ───────────────────────────────────────────────────────────────────

  get(key: string): DecisionRecord | null {
    return this.decisions.get(key) ?? null;
  }

  getById(id: string): DecisionRecord | null {
    return this.decisionsById.get(id) ?? null;
  }

  list(): DecisionRecord[] {
    return Array.from(this.decisions.values());
  }

  // ─── Write ──────────────────────────────────────────────────────────────────

  put(record: DecisionRecord): void {
    this.decisions.set(record.key, record);
    this.decisionsById.set(record.id, record);
    this.persistDecisions();
  }

  update(
    id: string,
    updater: (record: DecisionRecord) => DecisionRecord,
  ): DecisionRecord | null {
    const existing = this.decisionsById.get(id);
    if (!existing) return null;

    const updated = updater({ ...existing, stats: { ...existing.stats } });
    // If the key changed (shouldn't normally), remove old key entry
    if (updated.key !== existing.key) {
      this.decisions.delete(existing.key);
    }
    this.decisions.set(updated.key, updated);
    this.decisionsById.set(updated.id, updated);
    this.persistDecisions();
    return updated;
  }

  nextId(): string {
    this.counter++;
    return `dec_${String(this.counter).padStart(6, "0")}`;
  }

  // ─── Event Log ──────────────────────────────────────────────────────────────

  appendEvent(event: EventLogEntry): void {
    const line = JSON.stringify(event) + "\n";
    appendFileSync(this.eventsPath, line, "utf-8");
  }

  // ─── Review Queue ─────────────────────────────────────────────────────────

  getReviewQueue(): ReviewItem[] {
    return this.loadReviewQueue();
  }

  addReviewItem(item: ReviewItem): void {
    const queue = this.loadReviewQueue();
    queue.push(item);
    this.persistReviewQueue(queue);
  }

  resolveReviewItem(itemId: string, answer: string): void {
    const queue = this.loadReviewQueue();
    const item = queue.find((i) => i.id === itemId);
    if (!item) return;

    item.resolved = true;
    item.resolved_at = new Date().toISOString();
    item.resolved_answer = answer;
    this.persistReviewQueue(queue);
  }

  // ─── Persistence (atomic writes) ────────────────────────────────────────

  private loadDecisions(): void {
    if (!existsSync(this.decisionsPath)) return;

    try {
      const raw = readFileSync(this.decisionsPath, "utf-8");
      const records: DecisionRecord[] = JSON.parse(raw);

      for (const r of records) {
        this.decisions.set(r.key, r);
        this.decisionsById.set(r.id, r);
        // Track the highest counter
        const num = parseInt(r.id.replace("dec_", ""), 10);
        if (!isNaN(num) && num > this.counter) {
          this.counter = num;
        }
      }
    } catch {
      // If the file is corrupted, start fresh (the events log is the audit trail)
      console.error(`Warning: Could not load ${this.decisionsPath}, starting with empty store.`);
    }
  }

  private atomicWrite(targetPath: string, content: string, prefix: string): void {
    const tmpPath = join(this.dataDir, `${prefix}.tmp.${randomBytes(4).toString("hex")}`);
    writeFileSync(tmpPath, content, "utf-8");
    try {
      renameSync(tmpPath, targetPath);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "EPERM" || code === "EBUSY" || code === "EEXIST") {
        copyFileSync(tmpPath, targetPath);
        try {
          unlinkSync(tmpPath);
        } catch {
          // Ignore cleanup errors on temp file
        }
      } else {
        throw err;
      }
    }
  }

  private persistDecisions(): void {
    const records = Array.from(this.decisions.values());
    const json = JSON.stringify(records, null, 2);
    this.atomicWrite(this.decisionsPath, json, "decisions");
  }

  private loadReviewQueue(): ReviewItem[] {
    if (!existsSync(this.reviewPath)) return [];

    try {
      const raw = readFileSync(this.reviewPath, "utf-8");
      return JSON.parse(raw) as ReviewItem[];
    } catch {
      return [];
    }
  }

  private persistReviewQueue(queue: ReviewItem[]): void {
    const json = JSON.stringify(queue, null, 2);
    this.atomicWrite(this.reviewPath, json, "review_queue");
  }
}
