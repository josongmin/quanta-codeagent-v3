/**
 * Env-knob branch coverage — R-Phase3 P2-2.
 *
 * The CLI bootstrap reads ~20 env knobs to assemble `AgentConfig`. The
 * happy paths are exercised via integration suites (resume-e2e, memory,
 * skill, subagent, etc.); the BRANCH coverage of each knob's allowed
 * values + invalid-fallback paths was not pinned. This file closes that —
 * one focused unit test per exported builder in `src/apps/cli/internal.ts`
 * (all are pure functions over `process.env`, so they're trivially
 * env-mockable).
 *
 * Convention: every test saves + restores the env it touches via
 * `beforeEach/afterEach` so cross-test contamination is impossible.
 *
 * Knobs covered here:
 *   QUANTA_PROVIDER, QUANTA_MEMORY (+ _PATH, _EMBED, _EMBED_MODEL,
 *   _RECALL_LIMIT, _RECALL_TIERS, _DISTILL, _CONSOLIDATE, _SELF_EDIT),
 *   QUANTA_SUBAGENT (+ _MAX_DEPTH), QUANTA_VERIFY_GUARD (+ _MAX_TRIPS),
 *   QUANTA_SKILLS_DIR, OPENAI_API_KEY / ANTHROPIC_API_KEY auto-detect.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildMemoryConfig,
  buildSkillsConfig,
  buildStore,
  buildSubagentConfig,
  buildVerifyGuardConfig,
  parseRecallTiers,
  pickProvider,
} from "../../src/apps/cli/internal"

/** Save + restore the env keys we touch. Avoids cross-test contamination
 *  even when tests fail mid-run (the afterEach always restores). */
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
  // ADR-0094 (ChatGPT-OAuth provider) — `pickProvider` probes
  // `$QUANTA_PREFS_HOME/auth/chatgpt.json`. Point it at a fresh temp dir
  // for every test so a real `/login` token on the host machine does not
  // leak into `chatgpt-oauth` selection.
  "QUANTA_PREFS_HOME",
] as const

const snapshot = (): Map<string, string | undefined> => {
  const m = new Map<string, string | undefined>()
  for (const k of ENV_KEYS) m.set(k, process.env[k])
  return m
}

const restore = (m: Map<string, string | undefined>): void => {
  for (const [k, v] of m) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

let saved: Map<string, string | undefined>
let prefsHome: string | null = null
beforeEach(() => {
  saved = snapshot()
  for (const k of ENV_KEYS) delete process.env[k]
  // Isolate the chatgpt-oauth token probe: point `QUANTA_PREFS_HOME` at a
  // fresh empty dir so `pickProvider` never sees a stray on-disk token.
  prefsHome = mkdtempSync(join(tmpdir(), "env-knob-prefs-"))
  process.env.QUANTA_PREFS_HOME = prefsHome
})
afterEach(() => {
  if (prefsHome !== null) {
    try {
      rmSync(prefsHome, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
    prefsHome = null
  }
  restore(saved)
})

describe("pickProvider — QUANTA_PROVIDER branches + auto-detect", () => {
  test("explicit QUANTA_PROVIDER=openai wins over any key fallback", () => {
    process.env.QUANTA_PROVIDER = "openai"
    process.env.ANTHROPIC_API_KEY = "ak-only"
    expect(pickProvider()).toBe("openai")
  })

  test("explicit QUANTA_PROVIDER=anthropic wins over OPENAI_API_KEY", () => {
    process.env.QUANTA_PROVIDER = "anthropic"
    process.env.OPENAI_API_KEY = "ok-only"
    expect(pickProvider()).toBe("anthropic")
  })

  test("invalid QUANTA_PROVIDER → falls through to key auto-detect, NOT a crash", () => {
    process.env.QUANTA_PROVIDER = "rabbit-hat"
    process.env.OPENAI_API_KEY = "ok"
    // The invalid token is ignored; OPENAI_API_KEY presence wins.
    expect(pickProvider()).toBe("openai")
  })

  test("no explicit + ANTHROPIC_API_KEY present → anthropic", () => {
    process.env.ANTHROPIC_API_KEY = "ak"
    expect(pickProvider()).toBe("anthropic")
  })

  test("no explicit + only OPENAI_API_KEY → openai", () => {
    process.env.OPENAI_API_KEY = "ok"
    expect(pickProvider()).toBe("openai")
  })

  test("no explicit + both keys present → anthropic wins (declared order)", () => {
    process.env.ANTHROPIC_API_KEY = "ak"
    process.env.OPENAI_API_KEY = "ok"
    expect(pickProvider()).toBe("anthropic")
  })

  test("no explicit + no keys → anthropic default (key-error surfaces at buildLLM, not here)", () => {
    expect(pickProvider()).toBe("anthropic")
  })
})

describe("buildStore — QUANTA_MEMORY branches", () => {
  test("unset → undefined (default-OFF, byte-identical)", () => {
    expect(buildStore()).toBeUndefined()
  })

  test("QUANTA_MEMORY=off → undefined (explicit opt-out)", () => {
    process.env.QUANTA_MEMORY = "off"
    expect(buildStore()).toBeUndefined()
  })

  test("QUANTA_MEMORY=memory → InMemoryStore instance (volatile)", () => {
    process.env.QUANTA_MEMORY = "memory"
    const s = buildStore()
    expect(s).toBeDefined()
    // Duck-type: every store has init/insert/recall/all/update/delete/size.
    expect(typeof s?.recall).toBe("function")
  })

  test("QUANTA_MEMORY=sqlite + custom path → store constructed with that path", () => {
    // The SqliteStore constructor (bun:sqlite Database) opens the file
    // EAGERLY, so the path must exist (or its parent must). Use a tmpdir
    // we control. The store is constructed but not init()'d here — we just
    // need the builder branch to fire and return the right kind.
    const { mkdtempSync, rmSync } = require("node:fs")
    const { tmpdir } = require("node:os")
    const { join } = require("node:path")
    const dir = mkdtempSync(join(tmpdir(), "env-knob-sqlite-")) as string
    try {
      process.env.QUANTA_MEMORY = "sqlite"
      process.env.QUANTA_MEMORY_PATH = join(dir, "test-memory.sqlite")
      const s = buildStore()
      expect(s).toBeDefined()
      expect(typeof s?.recall).toBe("function")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("QUANTA_MEMORY=unknown-kind → undefined (unrecognised value is treated as off)", () => {
    process.env.QUANTA_MEMORY = "redis"
    expect(buildStore()).toBeUndefined()
  })
})

describe("buildMemoryConfig — sub-knob branches", () => {
  test("no store + no knobs → undefined (key omitted)", () => {
    expect(buildMemoryConfig(undefined)).toBeUndefined()
  })

  test("store present + no knobs → empty block (still returned so loop wires the store)", () => {
    process.env.QUANTA_MEMORY = "memory"
    const store = buildStore()
    const cfg = buildMemoryConfig(store)
    // The block is empty but TRUTHY — the loop checks `config.store` separately.
    expect(cfg).toBeDefined()
  })

  test("recallLimit honors valid integer; rejects NaN/empty", () => {
    process.env.QUANTA_MEMORY_RECALL_LIMIT = "12"
    expect(buildMemoryConfig(undefined)).toMatchObject({ recallLimit: 12 })
    process.env.QUANTA_MEMORY_RECALL_LIMIT = "not-a-number"
    expect(buildMemoryConfig(undefined)?.recallLimit).toBeUndefined()
  })

  test("distill / consolidate / selfEditTools opt-out via 'off' literal", () => {
    process.env.QUANTA_MEMORY_DISTILL = "off"
    process.env.QUANTA_MEMORY_CONSOLIDATE = "off"
    process.env.QUANTA_MEMORY_SELF_EDIT = "off"
    expect(buildMemoryConfig(undefined)).toMatchObject({
      distill: false,
      consolidate: false,
      selfEditTools: false,
    })
  })

  test("distill='OFF' (uppercase) does NOT opt out (literal lowercase only)", () => {
    process.env.QUANTA_MEMORY_DISTILL = "OFF"
    expect(buildMemoryConfig(undefined)?.distill).toBeUndefined()
  })
})

describe("parseRecallTiers — comma-separated tier list", () => {
  test("undefined input → undefined", () => {
    expect(parseRecallTiers(undefined)).toBeUndefined()
  })

  test("empty / whitespace → undefined", () => {
    expect(parseRecallTiers("")).toBeUndefined()
    expect(parseRecallTiers(",,, ")).toBeUndefined()
  })

  test("episodic alone → ['episodic']", () => {
    expect(parseRecallTiers("episodic")).toEqual(["episodic"])
  })

  test("both, with whitespace + mixed case → dedup'd to lowercase", () => {
    expect(parseRecallTiers(" Episodic , semantic , EPISODIC ")).toEqual(["episodic", "semantic"])
  })

  test("invalid tokens → filtered, surviving valid kept", () => {
    expect(parseRecallTiers("episodic,rabbit,banana,semantic")).toEqual(["episodic", "semantic"])
  })

  test("only invalid tokens → undefined (none survive)", () => {
    expect(parseRecallTiers("rabbit,banana")).toBeUndefined()
  })
})

describe("buildSubagentConfig — QUANTA_SUBAGENT + max-depth", () => {
  test("unset → undefined (default-OFF, byte-identical)", () => {
    expect(buildSubagentConfig()).toBeUndefined()
  })

  test("set to any value + no max-depth → empty block (uses runner default)", () => {
    process.env.QUANTA_SUBAGENT = "1"
    expect(buildSubagentConfig()).toEqual({})
  })

  test("max-depth integer → block includes maxDepth", () => {
    process.env.QUANTA_SUBAGENT = "1"
    process.env.QUANTA_SUBAGENT_MAX_DEPTH = "3"
    expect(buildSubagentConfig()).toEqual({ maxDepth: 3 })
  })

  test("max-depth non-integer → ignored, falls back to empty block", () => {
    process.env.QUANTA_SUBAGENT = "1"
    process.env.QUANTA_SUBAGENT_MAX_DEPTH = "many"
    expect(buildSubagentConfig()).toEqual({})
  })
})

describe("buildVerifyGuardConfig — QUANTA_VERIFY_GUARD + max-trips", () => {
  test("unset → undefined (default-OFF, key omitted)", () => {
    expect(buildVerifyGuardConfig()).toBeUndefined()
  })

  test("set without max-trips → empty block (uses loop's default 1)", () => {
    process.env.QUANTA_VERIFY_GUARD = "1"
    expect(buildVerifyGuardConfig()).toEqual({})
  })

  test("set with valid integer max-trips → block carries it", () => {
    process.env.QUANTA_VERIFY_GUARD = "1"
    process.env.QUANTA_VERIFY_GUARD_MAX_TRIPS = "5"
    expect(buildVerifyGuardConfig()).toEqual({ maxTrips: 5 })
  })

  test("max-trips non-integer → ignored (falls back to default)", () => {
    process.env.QUANTA_VERIFY_GUARD = "1"
    process.env.QUANTA_VERIFY_GUARD_MAX_TRIPS = "infinity-plus-one"
    expect(buildVerifyGuardConfig()).toEqual({})
  })

  test("max-trips=0 → preserved (explicit opt-out of forced retries)", () => {
    process.env.QUANTA_VERIFY_GUARD = "1"
    process.env.QUANTA_VERIFY_GUARD_MAX_TRIPS = "0"
    expect(buildVerifyGuardConfig()).toEqual({ maxTrips: 0 })
  })
})

describe("buildSkillsConfig — QUANTA_SKILLS_DIR", () => {
  test("unset → undefined (no skill discovery, no Skill/ToolSearch tools)", () => {
    expect(buildSkillsConfig()).toBeUndefined()
  })

  test("empty string → undefined (treated as unset)", () => {
    process.env.QUANTA_SKILLS_DIR = ""
    expect(buildSkillsConfig()).toBeUndefined()
  })

  test("path set → { dir }", () => {
    process.env.QUANTA_SKILLS_DIR = "/etc/quanta/skills"
    expect(buildSkillsConfig()).toEqual({ dir: "/etc/quanta/skills" })
  })

  test("QUANTA_SKILLS=1 (no dir) → {} (bundled system skills only — ADR-0045 follow-up)", () => {
    process.env.QUANTA_SKILLS = "1"
    expect(buildSkillsConfig()).toEqual({})
  })

  test("QUANTA_SKILLS=1 + QUANTA_SKILLS_DIR set → { dir } wins (dir is the superset)", () => {
    process.env.QUANTA_SKILLS = "1"
    process.env.QUANTA_SKILLS_DIR = "/custom/skills"
    expect(buildSkillsConfig()).toEqual({ dir: "/custom/skills" })
  })

  test("QUANTA_SKILLS unset/non-1 → undefined (byte-identical default-OFF preserved)", () => {
    process.env.QUANTA_SKILLS = "yes" // not exactly "1"
    expect(buildSkillsConfig()).toBeUndefined()
  })
})
