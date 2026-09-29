/**
 * Mock/Fake Jev provider for testing and local development.
 *
 * Returns configurable scripted answers. Simulates Jev's behavior:
 * - Takes question + options + facts + optional evidence
 * - Returns a typed answer with a probability
 */

import type { DecisionProvider, ProviderInput, ProviderResult } from "../types.js";

export interface ScriptedAnswer {
  /** The answer to return (must be one of the options). */
  answer: string;
  /** The confidence to return (0-1). */
  confidence: number;
}

/**
 * A fake provider that returns scripted or default answers.
 *
 * Usage:
 *   const fake = new FakeProvider("jev");
 *   fake.setAnswer("retry", 0.94);          // default answer for all questions
 *   fake.scriptAnswer("What to do?", "backoff", 0.87); // answer for a specific question
 */
export class FakeProvider implements DecisionProvider {
  readonly name: string;
  private defaultAnswer: ScriptedAnswer;
  private scriptedAnswers: Map<string, ScriptedAnswer> = new Map();
  private callLog: ProviderInput[] = [];
  private shouldFail: boolean = false;
  private failError: string = "Provider unavailable";

  constructor(name: string, defaultAnswer?: ScriptedAnswer) {
    this.name = name;
    this.defaultAnswer = defaultAnswer ?? { answer: "", confidence: 0.7 };
  }

  /** Set the default answer for unscripted questions. */
  setAnswer(answer: string, confidence: number): void {
    this.defaultAnswer = { answer, confidence };
  }

  /** Script a specific answer for a question. */
  scriptAnswer(questionSubstring: string, answer: string, confidence: number): void {
    this.scriptedAnswers.set(questionSubstring.toLowerCase(), { answer, confidence });
  }

  /** Make the provider fail on the next call (simulates outage). */
  setFailing(fail: boolean, error?: string): void {
    this.shouldFail = fail;
    if (error) this.failError = error;
  }

  /** Get all calls that were made (for test assertions). */
  getCalls(): ProviderInput[] {
    return [...this.callLog];
  }

  /** Clear call log. */
  clearCalls(): void {
    this.callLog = [];
  }

  async decide(input: ProviderInput): Promise<ProviderResult> {
    this.callLog.push(input);

    if (this.shouldFail) {
      throw new Error(this.failError);
    }

    // Check scripted answers
    const q = input.question.toLowerCase();
    for (const [substring, scripted] of this.scriptedAnswers) {
      if (q.includes(substring)) {
        return { answer: scripted.answer, confidence: scripted.confidence };
      }
    }

    // Fall back to default, using the first option if no answer set
    const answer = this.defaultAnswer.answer || input.options[0] || "unknown";
    return { answer, confidence: this.defaultAnswer.confidence };
  }
}
