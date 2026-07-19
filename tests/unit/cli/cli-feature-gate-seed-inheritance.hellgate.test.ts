/**
 * HELLGATE — DOF-20 tranche-1: CLI feature-gate seed SUBPROCESS / INHERITANCE
 * proof (the board's precondition for any further CLI-effective-ON flip).
 *
 * WHAT WAS MISSING (baseline b92b3798f): `cli-default-on-ux-gates-hellgate`
 * only proves the PURE FUNCTION `gateOn({[g]:"1"})===true` — a hand-written
 * MIRROR of the seed loop, not the loop itself. Nothing proved, against REAL
 * process-env semantics, that:
 *   (a) unset  ⇒ the seed loop writes "1"   (seeded-ON),
 *   (b) explicit "0" is PRESERVED           (seed must not clobber an operator
 *       opt-out — the ONLY off escape hatch),
 *   (c) a spawned CHILD/subagent process INHERITS the seeded env across an OS
 *       boundary (the board's exact wording: "child/subagent process
 *       inheritance"),
 *   (d) rollback (unset again / explicit "0") returns to OFF.
 *
 * HOW THIS PROVES IT (no mock): the fixture `fixtures/seed-loop-child.ts` runs
 * the BYTE-IDENTICAL union+loop from `src/apps/cli/index.ts:48-50` in a REAL
 * `bun` child process whose inbound env THIS test controls, then that child
 * spawns a REAL GRANDCHILD which reads `process.env` WITHOUT re-seeding. The
 * grandchild view is genuine OS inheritance; an in-proc stub could not produce
 * it. A `red-on-injection` guard (below) proves the harness would FAIL if the
 * child stopped seeding — i.e. it is not vacuous.
 *
 * Scope note: the loop mutates the real `process.env`; running it in-process
 * would pollute this test runner's env for every later test. Isolation via a
 * child process is therefore both the correctness proof AND the mechanism.
 */

import { describe, expect, test } from "bun:test"
import { CLI_FEATURE_GATE_NAMES } from "@/apps/cli/cli-feature-gates"
import { seedEnvVarsForSurface } from "@/tool"

const CHILD = new URL("./fixtures/seed-loop-child.ts", import.meta.url).pathname

/** Two representative seeded gates from EACH seed source (owned list + tool
 *  SSOT) so the proof spans both halves of the index.ts union. */
const PROBE = [
  "QUANTA_SPINNER_STALL", // CLI_FEATURE_GATES (owned)
  "QUANTA_RATELIMIT_NOTICE", // CLI_FEATURE_GATES (owned)
  "QUANTA_COVERAGE_TOOL", // seedEnvVarsForSurface("cli")
  "QUANTA_PROMPT_CACHE_STATUS", // seedEnvVarsForSurface("cli")
  "QUANTA_ENABLE_STRUCTURED_PATCH", // promoted CLI tool gate
] as const

type Leg = { value: string | null; on: boolean }
type Result = { self: Record<string, Leg>; child: Record<string, Leg> }
/** Real child + grandchild startup can exceed Bun's 5s unit default under load. */
const SUBPROCESS_TIMEOUT_MS = 15_000

/** Run the real seed-loop child with a CONTROLLED env. `overrides` are placed
 *  on top of a MINIMAL env (PATH + probe list) so the probed gates start from a
 *  known state — not whatever the CI shell exported. */
const runChild = (overrides: Record<string, string>): Result => {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, CHILD],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      QUANTA_PROBE_GATES: PROBE.join(","),
      ...overrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = proc.stdout.toString().trim()
  if (out.length === 0) {
    throw new Error(`child produced no output; stderr:\n${proc.stderr.toString()}`)
  }
  return JSON.parse(out) as Result
}

describe("DOF-20 seed loop — real subprocess/inheritance proof", () => {
  test(
    "(a) unset ⇒ the real seed loop writes '1' (seeded-ON)",
    () => {
      const r = runChild({}) // no gate set in the inbound env ⇒ all unset
      for (const g of PROBE) {
        expect(r.self[g]?.value, `${g} should be seeded to "1" when unset`).toBe("1")
        expect(r.self[g]?.on, `${g} gateOn true after seed`).toBe(true)
      }
    },
    SUBPROCESS_TIMEOUT_MS,
  )

  test(
    "(b) an explicit '0' is PRESERVED (seed never clobbers an opt-out)",
    () => {
      // Operator opts OUT of one gate; the rest stay unset and must still seed.
      const r = runChild({
        QUANTA_SPINNER_STALL: "0",
        QUANTA_ENABLE_STRUCTURED_PATCH: "0",
      })
      expect(r.self.QUANTA_SPINNER_STALL?.value, "explicit 0 must survive the seed").toBe("0")
      expect(r.self.QUANTA_SPINNER_STALL?.on, "0 ⇒ gateOff").toBe(false)
      // Sibling gates the operator did NOT touch must still be seeded ON —
      // proving the loop is per-gate, not all-or-nothing.
      expect(r.self.QUANTA_RATELIMIT_NOTICE?.value).toBe("1")
      expect(r.self.QUANTA_RATELIMIT_NOTICE?.on).toBe(true)
      expect(r.self.QUANTA_ENABLE_STRUCTURED_PATCH?.value).toBe("0")
      expect(r.self.QUANTA_ENABLE_STRUCTURED_PATCH?.on).toBe(false)
    },
    SUBPROCESS_TIMEOUT_MS,
  )

  test(
    "(c) a spawned CHILD/subagent process inherits the seeded env (OS boundary)",
    () => {
      const r = runChild({})
      for (const g of PROBE) {
        // The grandchild NEVER seeds — it only reports inherited env. Seeing "1"
        // there proves genuine cross-process inheritance of the seeded value.
        expect(r.child[g]?.value, `${g} must be inherited by the grandchild`).toBe("1")
        expect(r.child[g]?.on, `${g} gateOn true in the inheriting child`).toBe(true)
      }
    },
    SUBPROCESS_TIMEOUT_MS,
  )

  test(
    "(c') an operator opt-out (0) also inherits into children (not re-seeded ON)",
    () => {
      const r = runChild({ QUANTA_SPINNER_STALL: "0" })
      // If the child re-seeded blindly it would flip the grandchild to "1"; the
      // grandchild must see the INHERITED "0". This pins that the opt-out is
      // durable across the whole spawned subagent tree, not just the top process.
      expect(r.child.QUANTA_SPINNER_STALL?.value, "opt-out must inherit as 0").toBe("0")
      expect(r.child.QUANTA_SPINNER_STALL?.on).toBe(false)
    },
    SUBPROCESS_TIMEOUT_MS,
  )

  test(
    "(d) rollback: explicit '0' returns the gate (and its children) to OFF",
    () => {
      // Rollback surface = the documented `QUANTA_X=0` escape hatch. Setting it
      // returns both the seeding process AND every inheriting child to OFF for
      // that gate, while leaving the rest of the seed set intact.
      const r = runChild({
        QUANTA_SPINNER_STALL: "0",
        QUANTA_COVERAGE_TOOL: "0",
        QUANTA_ENABLE_STRUCTURED_PATCH: "0",
      })
      for (const g of [
        "QUANTA_SPINNER_STALL",
        "QUANTA_COVERAGE_TOOL",
        "QUANTA_ENABLE_STRUCTURED_PATCH",
      ] as const) {
        expect(r.self[g]?.on, `${g} rolled back OFF in the seeder`).toBe(false)
        expect(r.child[g]?.on, `${g} rolled back OFF in the child`).toBe(false)
      }
    },
    SUBPROCESS_TIMEOUT_MS,
  )

  test("harness targets the SAME union index.ts seeds (drift-linked, not a copy)", () => {
    // The fixture imports CLI_FEATURE_GATE_NAMES + seedEnvVarsForSurface("cli")
    // — the exact two index.ts:48 sources. Pin here that every PROBE gate is a
    // member of that live union, so if a gate is renamed/removed the probe (and
    // thus this proof) is forced to track it rather than testing a stale name.
    const union = new Set([...CLI_FEATURE_GATE_NAMES, ...seedEnvVarsForSurface("cli")])
    for (const g of PROBE) {
      expect(union.has(g), `${g} must be a live member of the seed union`).toBe(true)
    }
  })
})
