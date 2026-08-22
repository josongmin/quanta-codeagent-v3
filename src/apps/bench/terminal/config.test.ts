/**
 * TB21-03 — HELLGATE for the ONE Terminal-Bench run-config owner.
 *
 * WHY THIS FILE EXISTS. Terminal-Bench 2.0 was driven by `tools/tb-smoke/*.sh`,
 * which `export`ed knobs into the ambient shell and let harbor argv be assembled
 * by string concatenation. Two whole classes of measurement lie follow from that
 * shape: (a) an operator's stale `export QUANTA_TB_VERIFY_GATE=1` silently joins
 * a "baseline" arm, and (b) the report's `knobs.preset` is free text that no one
 * can reconcile with what the brain actually received.
 *
 * The repair is a TYPED resolution that happens EXACTLY ONCE and then owns every
 * downstream value. So the observables here are the real resolved config and the
 * real delivered knob table — never a re-assertion of a parser.
 *
 * NON-VACUITY: the FULL profile union flows through every profile assertion, and
 * `control` vs `quanta-full` are asserted to DIFFER on the levers, so a resolver
 * that returned one constant table fails. Ambient-env cases are PAIRED with a
 * control that proves the same key IS deliverable when the profile asks for it.
 */
import { describe, expect, test } from "bun:test"
import {
  resolveMaxTurnsFromEnv,
  resolveOracleLoopRounds,
  resolveTrajectoryOn,
  TB_ENV_OWNED_ENV,
  TB_OUTPUT_CONTRACT_ENV,
  TB_SELF_TEST_ENV,
  TB_VERIFY_GATE_ENV,
  TB_WRITE_TOOL_ENV,
} from "@/apps/terminal/brain-mode"
import { gateOn } from "@/shared"
import { resolveStreamCap } from "@/tool/container-exec/tool"
import {
  encodeKnobValue,
  isTerminalProfile,
  REGISTERED_KNOB_KEYS,
  resolveTerminalRunConfig,
  TERMINAL_BEST_OF_N_KNOB,
  TERMINAL_PROFILE_KNOBS,
  TERMINAL_PROFILES,
  TERMINAL_PROVIDERS,
  TERMINAL_SANDBOXES,
  type TerminalProfile,
} from "./config"
import { buildBrainDeliveryEnv } from "./harbor-command"
import { buildTerminalRunManifest } from "./manifest"

const BASE_ARGV = [
  "bun",
  "cli.ts",
  "terminal",
  "run",
  "--model",
  "gpt-5.5",
  "--provider",
  "openai",
  "--effort",
  "xhigh",
] as const

const argvFor = (profile: string, extra: readonly string[] = []): string[] => [
  ...BASE_ARGV,
  "--profile",
  profile,
  ...extra,
]

const resolve = (profile: string, extra: readonly string[] = [], env: NodeJS.ProcessEnv = {}) =>
  resolveTerminalRunConfig({ argv: argvFor(profile, extra), env })

// ─────────────────────────────────────────────────────────────────────────────
// The suite branch — Terminal is BFND-01's terminal-bench branch, never a family
// ─────────────────────────────────────────────────────────────────────────────

describe("suite identity (BFND-01 branch, not a dataset family)", () => {
  test("resolves the shared terminal-bench branch with NO datasetFamily key", () => {
    const cfg = resolve("control")
    expect(cfg.suite.benchmarkSuite).toBe("terminal-bench")
    expect(Object.keys(cfg.suite)).not.toContain("datasetFamily")
  })

  test("RED RAIL — --dataset-family on a terminal run is REFUSED (SWE-only axis)", () => {
    expect(() => resolve("control", ["--dataset-family", "verified"])).toThrow(/SWE-only/i)
    expect(() => resolve("control", ["--dataset-family=pro"])).toThrow(/SWE-only/i)
  })

  test("RED RAIL — QUANTA_SWEBENCH_DATASET_FAMILY in the env is REFUSED too", () => {
    expect(() => resolve("control", [], { QUANTA_SWEBENCH_DATASET_FAMILY: "pro" })).toThrow(
      /SWE-only/i,
    )
  })

  test("PAIRED CONTROL — with no family selector at all the same argv resolves", () => {
    expect(resolve("control").suite.benchmarkSuite).toBe("terminal-bench")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Required, validated options — a PAID run cannot start under-specified
// ─────────────────────────────────────────────────────────────────────────────

describe("required options for a paid run", () => {
  const REQUIRED: ReadonlyArray<{ readonly drop: string; readonly match: RegExp }> = [
    { drop: "--model", match: /--model/ },
    { drop: "--effort", match: /--effort/ },
    { drop: "--profile", match: /--profile/ },
  ]

  for (const req of REQUIRED) {
    test(`absent ${req.drop} FAILS`, () => {
      const argv = argvFor("control").filter((tok, i, all) => {
        const prev = all[i - 1]
        return tok !== req.drop && prev !== req.drop
      })
      expect(() => resolveTerminalRunConfig({ argv, env: {} })).toThrow(req.match)
    })
  }

  test("PAIRED CONTROL — the fully-specified argv resolves cleanly", () => {
    const cfg = resolve("quanta-full")
    expect(cfg.model).toBe("gpt-5.5")
    expect(cfg.profile).toBe("quanta-full")
    expect(cfg.effort.delivered).toBe("xhigh")
  })

  test("unknown profile FAILS and names the known set", () => {
    expect(() => resolve("quanta-fully")).toThrow(/quanta-full/)
    expect(() => resolve("baseline")).toThrow(/unknown terminal profile/i)
  })

  test("unknown provider / sandbox FAIL", () => {
    expect(() => resolve("control", ["--provider", "openai-ish"])).toThrow(/provider/i)
    expect(() => resolve("control", ["--sandbox", "podman"])).toThrow(/sandbox/i)
  })

  test("the FULL profile / provider / sandbox unions flow through (no single-literal narrowing)", () => {
    for (const profile of TERMINAL_PROFILES) {
      expect(resolve(profile).profile).toBe(profile)
    }
    // Every provider is HANDLED, and the two directions are asserted: the two
    // effort-bearing surfaces resolve, and the surface with NO reasoning-effort
    // field REFUSES rather than quietly running at the provider's own default.
    const handled: string[] = []
    for (const provider of TERMINAL_PROVIDERS) {
      if (provider === "anthropic") {
        expect(() => resolve("control", ["--provider", provider])).toThrow(/reasoning-effort/i)
      } else {
        expect(resolve("control", ["--provider", provider]).provider).toBe(provider)
      }
      handled.push(provider)
    }
    expect(handled).toEqual([...TERMINAL_PROVIDERS])
    for (const sandbox of TERMINAL_SANDBOXES) {
      expect(resolve("control", ["--sandbox", sandbox]).sandbox).toBe(sandbox)
    }
    expect(TERMINAL_SANDBOXES.length).toBeGreaterThan(1)
  })

  test("isTerminalProfile is a real predicate over the closed set", () => {
    for (const p of TERMINAL_PROFILES) expect(isTerminalProfile(p)).toBe(true)
    expect(isTerminalProfile("control ")).toBe(false)
    expect(isTerminalProfile("CONTROL")).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Reasoning effort — the DECISION is recorded, never the requested string
// ─────────────────────────────────────────────────────────────────────────────

describe("reasoning effort is validated against the WIRE, not Harbor's vocabulary", () => {
  test("a wire-deliverable effort is recorded as delivered", () => {
    const cfg = resolve("control", ["--effort", "high"])
    expect(cfg.effort).toEqual({ requested: "high", delivered: "high", kind: "delivered" })
  })

  // `max` / `default` are legal HARBOR values that quanta's Responses wire drops.
  // Starting a paid run on them would print `reasoning_effort: max` on a
  // leaderboard row the provider never saw.
  for (const bogus of ["max", "default"]) {
    test(`RED RAIL — harbor-legal but wire-rejected effort "${bogus}" FAILS before the run`, () => {
      expect(() => resolve("control", ["--effort", bogus])).toThrow(/not accepted|reasoning/i)
    })
  }

  test("anthropic + an effort FAILS (that surface has no reasoning-effort field)", () => {
    expect(() => resolve("control", ["--provider", "anthropic"])).toThrow(/reasoning-effort/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Profiles — every knob materialized, including OFF, and all REGISTERED
// ─────────────────────────────────────────────────────────────────────────────

describe("profile knob tables", () => {
  test("every profile materializes the SAME key set (OFF values are present, not omitted)", () => {
    const keysets = TERMINAL_PROFILES.map((p) => Object.keys(TERMINAL_PROFILE_KNOBS[p]).sort())
    const [first] = keysets
    expect(first).toBeDefined()
    for (const ks of keysets) expect(ks).toEqual(first as string[])
    // Anti-vacuity: the table is non-trivial and carries at least one OFF value.
    expect((first as string[]).length).toBeGreaterThanOrEqual(8)
    expect(Object.values(TERMINAL_PROFILE_KNOBS.control)).toContain(false)
  })

  test("every profile knob is REGISTERED in the existing knob registries", () => {
    const orphans: string[] = []
    for (const profile of TERMINAL_PROFILES) {
      for (const key of Object.keys(TERMINAL_PROFILE_KNOBS[profile])) {
        if (!REGISTERED_KNOB_KEYS.has(key)) orphans.push(`${profile}:${key}`)
      }
    }
    expect(orphans, `unregistered profile knobs: ${orphans.join(", ")}`).toEqual([])
    // Anti-vacuity: the registry actually rejects something.
    expect(REGISTERED_KNOB_KEYS.has("QUANTA_TOTALLY_FAKE_KNOB_ZZZ")).toBe(false)
    expect(REGISTERED_KNOB_KEYS.size).toBeGreaterThan(50)
  })

  test("control and quanta-full DIFFER on the levers (never one merged score)", () => {
    const control = TERMINAL_PROFILE_KNOBS.control
    const full = TERMINAL_PROFILE_KNOBS["quanta-full"]
    const differing = Object.keys(full).filter((k) => full[k] !== control[k])
    expect(differing.length).toBeGreaterThanOrEqual(3)
    expect(differing).toContain(TB_VERIFY_GATE_ENV)
  })

  test("neither profile activates terminal-local best-of-N", () => {
    for (const profile of TERMINAL_PROFILES) {
      expect(Object.keys(TERMINAL_PROFILE_KNOBS[profile])).not.toContain(TERMINAL_BEST_OF_N_KNOB)
    }
  })

  test("RED RAIL — an enabled QUANTA_TB_BEST_OF_N plus Harbor k is REFUSED", () => {
    expect(() => resolve("control", [], { [TERMINAL_BEST_OF_N_KNOB]: "2" })).toThrow(/best-of-n/i)
    // PAIRED CONTROL: an explicitly-disabled value is not a second sampling layer.
    expect(resolve("control", [], { [TERMINAL_BEST_OF_N_KNOB]: "0" }).profile).toBe("control")
  })

  test("RED RAIL — an unknown --knob override is a validation error", () => {
    expect(() => resolve("control", ["--knob", "QUANTA_MADE_UP_KNOB=1"])).toThrow(/unregistered/i)
    // PAIRED CONTROL: a REGISTERED knob override is accepted and materialized.
    const cfg = resolve("control", ["--knob", "QUANTA_MAX_TURNS=77"])
    expect(cfg.resolvedKnobs.QUANTA_MAX_TURNS).toBe(77)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// WIRING PROOF — the resolved knobs actually flip the REAL brain-side resolvers
// ─────────────────────────────────────────────────────────────────────────────

describe("WIRING — the delivered env flips the REAL brain-side resolvers", () => {
  const deliveredEnv = (profile: TerminalProfile): Record<string, string> => {
    const cfg = resolve(profile)
    const manifest = buildTerminalRunManifest({
      cfg,
      provenance: { packageVersion: "1.0.025", sha: "abcdef1234ab", dirty: false },
      harborVersion: "0.21.0",
      timestamp: "2026-08-22T00:00:00.000Z",
    })
    return buildBrainDeliveryEnv(manifest)
  }

  test("quanta-full's levers are ON as observed by the brain's own resolvers", () => {
    const env = deliveredEnv("quanta-full")
    expect(gateOn(env, TB_ENV_OWNED_ENV)).toBe(true)
    expect(gateOn(env, TB_VERIFY_GATE_ENV)).toBe(true)
    expect(gateOn(env, TB_SELF_TEST_ENV)).toBe(true)
    expect(gateOn(env, TB_OUTPUT_CONTRACT_ENV)).toBe(true)
    expect(gateOn(env, TB_WRITE_TOOL_ENV)).toBe(true)
    expect(resolveOracleLoopRounds(env)).toBeGreaterThan(0)
    expect(resolveTrajectoryOn(env)).toBe(true)
    expect(resolveMaxTurnsFromEnv(env)).toBe(
      TERMINAL_PROFILE_KNOBS["quanta-full"].QUANTA_MAX_TURNS as number,
    )
    expect(resolveStreamCap(env)).toBe(
      TERMINAL_PROFILE_KNOBS["quanta-full"].QUANTA_TB_STREAM_CAP as number,
    )
  })

  test("PAIRED CONTROL — control's OFF knobs are observed OFF by the same resolvers", () => {
    const env = deliveredEnv("control")
    expect(gateOn(env, TB_VERIFY_GATE_ENV)).toBe(false)
    expect(gateOn(env, TB_SELF_TEST_ENV)).toBe(false)
    expect(gateOn(env, TB_OUTPUT_CONTRACT_ENV)).toBe(false)
    expect(gateOn(env, TB_WRITE_TOOL_ENV)).toBe(false)
    expect(resolveOracleLoopRounds(env)).toBe(0)
  })

  test("STOP RULE — every profile knob key is actually delivered to the brain env", () => {
    for (const profile of TERMINAL_PROFILES) {
      const env = deliveredEnv(profile)
      for (const [key, value] of Object.entries(TERMINAL_PROFILE_KNOBS[profile])) {
        expect(env[key], `${profile}:${key} was not delivered`).toBe(encodeKnobValue(value))
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The ambient env may NOT override the resolved profile
// ─────────────────────────────────────────────────────────────────────────────

describe("ambient env cannot override a resolved profile knob", () => {
  test("an operator's stale export does NOT join the control arm", () => {
    const cfg = resolve("control", [], {
      [TB_VERIFY_GATE_ENV]: "1",
      [TB_ENV_OWNED_ENV]: "0",
      QUANTA_MAX_TURNS: "999",
    })
    expect(cfg.resolvedKnobs[TB_VERIFY_GATE_ENV]).toBe(
      TERMINAL_PROFILE_KNOBS.control[TB_VERIFY_GATE_ENV] as boolean,
    )
    expect(cfg.resolvedKnobs[TB_ENV_OWNED_ENV]).toBe(
      TERMINAL_PROFILE_KNOBS.control[TB_ENV_OWNED_ENV] as boolean,
    )
    expect(cfg.resolvedKnobs.QUANTA_MAX_TURNS).toBe(
      TERMINAL_PROFILE_KNOBS.control.QUANTA_MAX_TURNS as number,
    )
  })

  test("PAIRED CONTROL — an EXPLICIT --knob override DOES move the same key", () => {
    const cfg = resolve("control", ["--knob", `${TB_VERIFY_GATE_ENV}=1`])
    expect(cfg.resolvedKnobs[TB_VERIFY_GATE_ENV]).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Upload / promotion posture is never inferred
// ─────────────────────────────────────────────────────────────────────────────

describe("upload + promotion posture", () => {
  test("upload defaults OFF and visibility is null when not uploading", () => {
    const cfg = resolve("control")
    expect(cfg.upload).toEqual({ enabled: false, visibility: null })
  })

  test("RED RAIL — --upload without an explicit privacy posture is REFUSED, never inferred", () => {
    expect(() => resolve("control", ["--upload"])).toThrow(/--public|--private/)
  })

  test("PAIRED CONTROL — both explicit postures resolve, and they DIFFER", () => {
    expect(resolve("control", ["--upload", "--public"]).upload).toEqual({
      enabled: true,
      visibility: "public",
    })
    expect(resolve("control", ["--upload", "--private"]).upload).toEqual({
      enabled: true,
      visibility: "private",
    })
  })

  test("RED RAIL — --public and --private together is a contradiction, not a winner", () => {
    expect(() => resolve("control", ["--upload", "--public", "--private"])).toThrow(/both/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Task selection is oracle/canary ONLY
// ─────────────────────────────────────────────────────────────────────────────

describe("task selection", () => {
  test("default is the FULL dataset", () => {
    expect(resolve("control").taskSelection).toBe("full")
  })

  test("oracle and canary selections come from the pinned catalog", () => {
    const oracle = resolve("control", ["--tasks", "oracle"]).taskSelection
    const canary = resolve("control", ["--tasks", "canary"]).taskSelection
    expect(oracle).toMatchObject({ purpose: "oracle" })
    expect(canary).toMatchObject({ purpose: "canary" })
    if (oracle === "full" || canary === "full") throw new Error("narrow")
    expect(oracle.ids.length).toBe(1)
    expect(canary.ids.length).toBe(3)
  })

  test("RED RAIL — an arbitrary task include set is REFUSED (oracle/canary only)", () => {
    expect(() => resolve("control", ["--tasks", "terminal-bench/fix-git"])).toThrow(
      /oracle|canary/i,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// k / concurrency
// ─────────────────────────────────────────────────────────────────────────────

describe("k and concurrency", () => {
  test("k defaults to the upstream minimum and accepts an explicit value", () => {
    expect(resolve("control").k).toBe(5)
    expect(resolve("control", ["--k", "1"]).k).toBe(1)
  })

  test("non-positive / non-integer k and concurrency FAIL", () => {
    for (const bad of ["0", "-1", "2.5", "abc", ""]) {
      expect(() => resolve("control", ["--k", bad]), `k=${bad}`).toThrow()
      expect(() => resolve("control", ["--concurrency", bad]), `n=${bad}`).toThrow()
    }
  })
})
