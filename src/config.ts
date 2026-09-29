/**
 * Configuration loader.
 *
 * Reads config/default.yaml and merges with any overrides.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";
import type { Config } from "./types.js";

const DEFAULT_CONFIG: Config = {
  thresholds: {
    direct_reuse: 0.90,
    jev_with_evidence: 0.60,
    llm_plus_jev: 0.30,
  },
  audit_rate: 0.05,
  source_trust: { human: 1.0, jev: 0.9, llm: 0.8 },
  k: 2,
  min_confirmations_for_reuse: 3,
  unproven_cap: 0.85,
  expiry_days: 90,
  risk_policy: {
    high_risk_action_tags: ["delete", "overwrite", "payment", "send_external", "deploy"],
    high_risk_behavior: "require_human",
  },
  storage: {
    data_dir: "./memory",
  },
};

/**
 * Load configuration from a YAML file, falling back to defaults.
 */
export function loadConfig(configPath?: string): Config {
  if (!configPath) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = readFileSync(resolve(configPath), "utf-8");
    const parsed = (yaml.load(raw) ?? {}) as Record<string, unknown>;
    return deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, parsed) as unknown as Config;
  } catch {
    console.warn(`Could not load config from ${configPath}, using defaults.`);
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Deep merge two objects. Values from `override` take precedence.
 */
function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const baseVal = base[key];
    const overVal = override[key];
    if (
      baseVal && overVal &&
      typeof baseVal === "object" && !Array.isArray(baseVal) &&
      typeof overVal === "object" && !Array.isArray(overVal)
    ) {
      result[key] = deepMerge(baseVal as Record<string, unknown>, overVal as Record<string, unknown>);
    } else if (overVal !== undefined) {
      result[key] = overVal;
    }
  }
  return result;
}

/**
 * Create a config object directly from partial overrides (useful in tests).
 */
export function createConfig(overrides?: Partial<Config>): Config {
  if (!overrides) return { ...DEFAULT_CONFIG };
  return deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, overrides as unknown as Record<string, unknown>) as unknown as Config;
}
