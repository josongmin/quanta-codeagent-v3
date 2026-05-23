var {require}=import.meta;import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMemoryConfig,
  buildSkillsConfig,
  buildStore,
  buildSubagentConfig,
  buildVerifyGuardConfig,
  parseRecallTiers,
  pickProvider
} from "../../src/apps/cli/internal";
const ENV_KEYS = [
  "QUANTA_PROVIDER",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "QUANTA_MEMORY",
  "QUANTA_MEMORY_PATH",
  "QUANTA_MEMORY_RECALL_LIMIT",
  "QUANTA_MEMORY_RECALL_TIERS",
  "QUANTA_MEMORY_DISTILL",
  "QUANTA_MEMORY_CONSOLIDATE",
  "QUANTA_MEMORY_SELF_EDIT",
  "QUANTA_SUBAGENT",
  "QUANTA_SUBAGENT_MAX_DEPTH",
  "QUANTA_VERIFY_GUARD",
  "QUANTA_VERIFY_GUARD_MAX_TRIPS",
  "QUANTA_SKILLS_DIR",
  "QUANTA_SKILLS",
  "QUANTA_PREFS_HOME"
];
const snapshot = () => {
  const m = new Map;
  for (const k of ENV_KEYS)
    m.set(k, process.env[k]);
  return m;
};
const restore = (m) => {
  for (const [k, v] of m) {
    if (v === undefined)
      delete process.env[k];
    else
      process.env[k] = v;
  }
};
let saved;
let prefsHome = null;
beforeEach(() => {
  saved = snapshot();
  for (const k of ENV_KEYS)
    delete process.env[k];
  prefsHome = mkdtempSync(join(tmpdir(), "env-knob-prefs-"));
  process.env.QUANTA_PREFS_HOME = prefsHome;
});
afterEach(() => {
  if (prefsHome !== null) {
    try {
      rmSync(prefsHome, { recursive: true, force: true });
    } catch {}
    prefsHome = null;
  }
  restore(saved);
});
describe("pickProvider \u2014 QUANTA_PROVIDER branches + auto-detect", () => {
  test("explicit QUANTA_PROVIDER=openai wins over any key fallback", () => {
    process.env.QUANTA_PROVIDER = "openai";
    process.env.ANTHROPIC_API_KEY = "ak-only";
    expect(pickProvider()).toBe("openai");
  });
  test("explicit QUANTA_PROVIDER=anthropic wins over OPENAI_API_KEY", () => {
    process.env.QUANTA_PROVIDER = "anthropic";
    process.env.OPENAI_API_KEY = "ok-only";
    expect(pickProvider()).toBe("anthropic");
  });
  test("invalid QUANTA_PROVIDER \u2192 falls through to key auto-detect, NOT a crash", () => {
    process.env.QUANTA_PROVIDER = "rabbit-hat";
    process.env.OPENAI_API_KEY = "ok";
    expect(pickProvider()).toBe("openai");
  });
  test("no explicit + ANTHROPIC_API_KEY present \u2192 anthropic", () => {
    process.env.ANTHROPIC_API_KEY = "ak";
    expect(pickProvider()).toBe("anthropic");
  });
  test("no explicit + only OPENAI_API_KEY \u2192 openai", () => {
    process.env.OPENAI_API_KEY = "ok";
    expect(pickProvider()).toBe("openai");
  });
  test("no explicit + both keys present \u2192 anthropic wins (declared order)", () => {
    process.env.ANTHROPIC_API_KEY = "ak";
    process.env.OPENAI_API_KEY = "ok";
    expect(pickProvider()).toBe("anthropic");
  });
  test("no explicit + no keys \u2192 anthropic default (key-error surfaces at buildLLM, not here)", () => {
    expect(pickProvider()).toBe("anthropic");
  });
});
describe("buildStore \u2014 QUANTA_MEMORY branches", () => {
  test("unset \u2192 undefined (default-OFF, byte-identical)", () => {
    expect(buildStore()).toBeUndefined();
  });
  test("QUANTA_MEMORY=off \u2192 undefined (explicit opt-out)", () => {
    process.env.QUANTA_MEMORY = "off";
    expect(buildStore()).toBeUndefined();
  });
  test("QUANTA_MEMORY=memory \u2192 InMemoryStore instance (volatile)", () => {
    process.env.QUANTA_MEMORY = "memory";
    const s = buildStore();
    expect(s).toBeDefined();
    expect(typeof s?.recall).toBe("function");
  });
  test("QUANTA_MEMORY=sqlite + custom path \u2192 store constructed with that path", () => {
    const { mkdtempSync, rmSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const dir = mkdtempSync(join(tmpdir(), "env-knob-sqlite-"));
    try {
      process.env.QUANTA_MEMORY = "sqlite";
      process.env.QUANTA_MEMORY_PATH = join(dir, "test-memory.sqlite");
      const s = buildStore();
      expect(s).toBeDefined();
      expect(typeof s?.recall).toBe("function");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("QUANTA_MEMORY=unknown-kind \u2192 undefined (unrecognised value is treated as off)", () => {
    process.env.QUANTA_MEMORY = "redis";
    expect(buildStore()).toBeUndefined();
  });
});
describe("buildMemoryConfig \u2014 sub-knob branches", () => {
  test("no store + no knobs \u2192 undefined (key omitted)", () => {
    expect(buildMemoryConfig(undefined)).toBeUndefined();
  });
  test("store present + no knobs \u2192 empty block (still returned so loop wires the store)", () => {
    process.env.QUANTA_MEMORY = "memory";
    const store = buildStore();
    const cfg = buildMemoryConfig(store);
    expect(cfg).toBeDefined();
  });
  test("recallLimit honors valid integer; rejects NaN/empty", () => {
    process.env.QUANTA_MEMORY_RECALL_LIMIT = "12";
    expect(buildMemoryConfig(undefined)).toMatchObject({ recallLimit: 12 });
    process.env.QUANTA_MEMORY_RECALL_LIMIT = "not-a-number";
    expect(buildMemoryConfig(undefined)?.recallLimit).toBeUndefined();
  });
  test("distill / consolidate / selfEditTools opt-out via 'off' literal", () => {
    process.env.QUANTA_MEMORY_DISTILL = "off";
    process.env.QUANTA_MEMORY_CONSOLIDATE = "off";
    process.env.QUANTA_MEMORY_SELF_EDIT = "off";
    expect(buildMemoryConfig(undefined)).toMatchObject({
      distill: false,
      consolidate: false,
      selfEditTools: false
    });
  });
  test("distill='OFF' (uppercase) does NOT opt out (literal lowercase only)", () => {
    process.env.QUANTA_MEMORY_DISTILL = "OFF";
    expect(buildMemoryConfig(undefined)?.distill).toBeUndefined();
  });
});
describe("parseRecallTiers \u2014 comma-separated tier list", () => {
  test("undefined input \u2192 undefined", () => {
    expect(parseRecallTiers(undefined)).toBeUndefined();
  });
  test("empty / whitespace \u2192 undefined", () => {
    expect(parseRecallTiers("")).toBeUndefined();
    expect(parseRecallTiers(",,, ")).toBeUndefined();
  });
  test("episodic alone \u2192 ['episodic']", () => {
    expect(parseRecallTiers("episodic")).toEqual(["episodic"]);
  });
  test("both, with whitespace + mixed case \u2192 dedup'd to lowercase", () => {
    expect(parseRecallTiers(" Episodic , semantic , EPISODIC ")).toEqual(["episodic", "semantic"]);
  });
  test("invalid tokens \u2192 filtered, surviving valid kept", () => {
    expect(parseRecallTiers("episodic,rabbit,banana,semantic")).toEqual(["episodic", "semantic"]);
  });
  test("only invalid tokens \u2192 undefined (none survive)", () => {
    expect(parseRecallTiers("rabbit,banana")).toBeUndefined();
  });
});
describe("buildSubagentConfig \u2014 QUANTA_SUBAGENT + max-depth", () => {
  test("unset \u2192 undefined (default-OFF, byte-identical)", () => {
    expect(buildSubagentConfig()).toBeUndefined();
  });
  test("set to any value + no max-depth \u2192 empty block (uses runner default)", () => {
    process.env.QUANTA_SUBAGENT = "1";
    expect(buildSubagentConfig()).toEqual({});
  });
  test("max-depth integer \u2192 block includes maxDepth", () => {
    process.env.QUANTA_SUBAGENT = "1";
    process.env.QUANTA_SUBAGENT_MAX_DEPTH = "3";
    expect(buildSubagentConfig()).toEqual({ maxDepth: 3 });
  });
  test("max-depth non-integer \u2192 ignored, falls back to empty block", () => {
    process.env.QUANTA_SUBAGENT = "1";
    process.env.QUANTA_SUBAGENT_MAX_DEPTH = "many";
    expect(buildSubagentConfig()).toEqual({});
  });
});
describe("buildVerifyGuardConfig \u2014 QUANTA_VERIFY_GUARD + max-trips", () => {
  test("unset \u2192 undefined (default-OFF, key omitted)", () => {
    expect(buildVerifyGuardConfig()).toBeUndefined();
  });
  test("set without max-trips \u2192 empty block (uses loop's default 1)", () => {
    process.env.QUANTA_VERIFY_GUARD = "1";
    expect(buildVerifyGuardConfig()).toEqual({});
  });
  test("set with valid integer max-trips \u2192 block carries it", () => {
    process.env.QUANTA_VERIFY_GUARD = "1";
    process.env.QUANTA_VERIFY_GUARD_MAX_TRIPS = "5";
    expect(buildVerifyGuardConfig()).toEqual({ maxTrips: 5 });
  });
  test("max-trips non-integer \u2192 ignored (falls back to default)", () => {
    process.env.QUANTA_VERIFY_GUARD = "1";
    process.env.QUANTA_VERIFY_GUARD_MAX_TRIPS = "infinity-plus-one";
    expect(buildVerifyGuardConfig()).toEqual({});
  });
  test("max-trips=0 \u2192 preserved (explicit opt-out of forced retries)", () => {
    process.env.QUANTA_VERIFY_GUARD = "1";
    process.env.QUANTA_VERIFY_GUARD_MAX_TRIPS = "0";
    expect(buildVerifyGuardConfig()).toEqual({ maxTrips: 0 });
  });
});
describe("buildSkillsConfig \u2014 QUANTA_SKILLS_DIR", () => {
  test("unset \u2192 undefined (no skill discovery, no Skill/ToolSearch tools)", () => {
    expect(buildSkillsConfig()).toBeUndefined();
  });
  test("empty string \u2192 undefined (treated as unset)", () => {
    process.env.QUANTA_SKILLS_DIR = "";
    expect(buildSkillsConfig()).toBeUndefined();
  });
  test("path set \u2192 { dir }", () => {
    process.env.QUANTA_SKILLS_DIR = "/etc/quanta/skills";
    expect(buildSkillsConfig()).toEqual({ dir: "/etc/quanta/skills" });
  });
  test("QUANTA_SKILLS=1 (no dir) \u2192 {} (bundled system skills only \u2014 ADR-0045 follow-up)", () => {
    process.env.QUANTA_SKILLS = "1";
    expect(buildSkillsConfig()).toEqual({});
  });
  test("QUANTA_SKILLS=1 + QUANTA_SKILLS_DIR set \u2192 { dir } wins (dir is the superset)", () => {
    process.env.QUANTA_SKILLS = "1";
    process.env.QUANTA_SKILLS_DIR = "/custom/skills";
    expect(buildSkillsConfig()).toEqual({ dir: "/custom/skills" });
  });
  test("QUANTA_SKILLS unset/non-1 \u2192 undefined (byte-identical default-OFF preserved)", () => {
    process.env.QUANTA_SKILLS = "yes";
    expect(buildSkillsConfig()).toBeUndefined();
  });
});
