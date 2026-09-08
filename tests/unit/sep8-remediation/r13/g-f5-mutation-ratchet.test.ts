/**
 * G-F5 mutation rail — restoring the boxGrade whole-bootstrap early-return or
 * a universal ~/swebench-python probe must fail. Call/structural patterns, not
 * bare identifiers.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "../../../..")
const PHASES = join(ROOT, "src/apps/bench/remote/box-session/bootstrap-phases.ts")
const READY = join(ROOT, "src/apps/bench/remote/box-session/profile-readiness.ts")
const LIFECYCLE = join(ROOT, "src/apps/bench/remote/box-session/ec2-lifecycle.ts")
const PROFILE = join(ROOT, "src/apps/bench/profiles/family-box-readiness.ts")

const SHIM_GATE = /familyRequiresSwebenchShim\s*\(/
const FAMILY_SETUP_CALL = /setupBoxForFamily\s*\(/
const SETUP_AFTER_SHIM = /maybeWriteSwebenchShim\s*\([^)]*\)\s*\n\s*await setupBoxForFamily\s*\(/
const ASSERT_READY = /assertBoxProfileReady\s*\(/
const PROBE_CALL = /boxProfileReadinessProbe\s*\(/
const READY_CALL = /isBoxProfileReady\s*\(/
const BOXGRADE_EARLY_RETURN = /\.boxGrade\s*!==\s*undefined[\s\S]{0,500}?\breturn\b/
const UNIVERSAL_SWEBENCH_PROBE =
  /test -x ~\/\.bun\/bin\/bun && test -x ~\/swebench-python && test -d ~\/quanta\/src/

type Gf5Check = {
  readonly hits: number
  readonly failures: readonly string[]
}

const requireHit = (ok: boolean, hits: number, failures: string[], message: string): number => {
  if (ok) return hits + 1
  failures.push(message)
  return hits
}

export const checkGf5Contract = (files: {
  readonly phases: string
  readonly ready: string
  readonly lifecycle: string
  readonly profile: string
}): Gf5Check => {
  const failures: string[] = []
  let hits = 0
  hits = requireHit(
    SHIM_GATE.test(files.phases),
    hits,
    failures,
    "familyRequiresSwebenchShim( missing from phase executor",
  )
  hits = requireHit(
    FAMILY_SETUP_CALL.test(files.phases),
    hits,
    failures,
    "setupBoxForFamily( call missing from phase executor",
  )
  hits = requireHit(
    SETUP_AFTER_SHIM.test(files.phases),
    hits,
    failures,
    "setupBoxForFamily( must follow maybeWriteSwebenchShim( unconditionally",
  )
  hits = requireHit(
    ASSERT_READY.test(files.phases),
    hits,
    failures,
    "assertBoxProfileReady( missing from phase executor",
  )
  hits = requireHit(
    PROBE_CALL.test(files.ready) && READY_CALL.test(files.lifecycle),
    hits,
    failures,
    "boxProfileReadinessProbe( / isBoxProfileReady( wiring missing",
  )
  if (BOXGRADE_EARLY_RETURN.test(files.phases)) {
    failures.push("boxGrade whole-bootstrap early-return restored in phase executor")
  }
  if (
    UNIVERSAL_SWEBENCH_PROBE.test(files.ready) ||
    UNIVERSAL_SWEBENCH_PROBE.test(files.lifecycle)
  ) {
    failures.push("universal swebench-python probe restored")
  }
  hits = requireHit(
    files.profile.includes("familyRequiresSwebenchShim") &&
      files.profile.includes("swebench-python"),
    hits,
    failures,
    "profile readiness owner lost the gated swebench probe",
  )
  return { hits, failures }
}

describe("G-F5 structural ratchet", () => {
  const files = {
    phases: readFileSync(PHASES, "utf8"),
    ready: readFileSync(READY, "utf8"),
    lifecycle: readFileSync(LIFECYCLE, "utf8"),
    profile: readFileSync(PROFILE, "utf8"),
  }

  test("anti-vacuum: shim gate, family setup call, probe wiring, profile owner", () => {
    const check = checkGf5Contract(files)
    expect(check.hits).toBeGreaterThanOrEqual(6)
  })

  test("live sources satisfy the G-F5 contract", () => {
    const check = checkGf5Contract(files)
    expect(check.failures).toEqual([])
  })

  test("red-on-injection: restoring boxGrade early-return fails", () => {
    const mutated = files.phases.replace(
      "await maybeWriteSwebenchShim(session, cfg)",
      `if (resolveDatasetFamilyProfile(family).boxGrade !== undefined) {\n    return\n  }\n  await maybeWriteSwebenchShim(session, cfg)`,
    )
    expect(mutated).not.toBe(files.phases)
    const check = checkGf5Contract({ ...files, phases: mutated })
    expect(check.failures.length).toBeGreaterThan(0)
    expect(check.failures.some((f) => f.includes("early-return"))).toBe(true)
  })

  test("red-on-injection: restoring universal swebench probe fails", () => {
    const mutated = files.lifecycle.replace(
      "isBoxProfileReady(ssh, family)",
      `ssh("test -x ~/.bun/bin/bun && test -x ~/swebench-python && test -d ~/quanta/src && echo OK").then((p) => p.code === 0)`,
    )
    expect(mutated).not.toBe(files.lifecycle)
    const check = checkGf5Contract({ ...files, lifecycle: mutated })
    expect(check.failures.length).toBeGreaterThan(0)
    expect(check.failures.some((f) => f.includes("universal"))).toBe(true)
  })

  test("red-on-injection: gating family setup on shim-required fails", () => {
    const mutated = files.phases.replace(
      "await maybeWriteSwebenchShim(session, cfg)\n  await setupBoxForFamily({",
      "await maybeWriteSwebenchShim(session, cfg)\n  if (familyRequiresSwebenchShim(profile)) await setupBoxForFamily({",
    )
    expect(mutated).not.toBe(files.phases)
    const check = checkGf5Contract({ ...files, phases: mutated })
    expect(check.failures.some((f) => f.includes("unconditionally"))).toBe(true)
  })

  test("red-on-injection: dropping final readiness assert fails", () => {
    const mutated = files.phases.replace(
      "await assertBoxProfileReady((cmd) => ssh(cmd), family)",
      "",
    )
    expect(mutated).not.toBe(files.phases)
    const check = checkGf5Contract({ ...files, phases: mutated })
    expect(check.failures.some((f) => f.includes("assertBoxProfileReady"))).toBe(true)
  })
})
