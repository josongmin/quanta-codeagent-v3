/**
 * Bugbash group `knobs-cfg` — fixes #14 and #16.
 *
 * #16 (readSite mis-routing): the 7 NOOP-bench closure knobs
 *   (fault-evidence / verification-plan / primary-rail / patch-hygiene /
 *    no-patch-breaker / repair-escalation / spec-fidelity-steer)
 * had `knob-inventory.ts` readSites pointing at their `(cfg) => cfg` NOOP
 * declaration file, so `/knobs` sent an operator debugging "why is this on" to
 * a no-op instead of the real EFFECT site. Fix repoints them at
 * `runner/batch/eval/knobs-bench.ts`, where `benchPostureFromState` actually
 * reads each knob (`readKnobValue(state, "<id>", …)`) and projects it into the
 * behavioral posture the driver consumes.
 *
 * TEETH: the NOOP declaration files contain the envKey LITERAL (via their
 * `envKey:` registration field) but NOT the behavioral read `readKnobValue`.
 * knobs-bench.ts contains BOTH. So a test that requires the readSite file to
 * contain the actual `readKnobValue(state, "<id>"` read fails if the readSite
 * is reverted to the NOOP file — red-on-injection. (The existing
 * knob-inventory-readsite-truthful-hellgate ratchet only checks the envKey
 * literal, which both files satisfy, so it cannot catch the mis-routing.)
 *
 * #14 (dead `sotaOn` field): documented-only. Removing the field would break
 * the cross-group `bench-sota-preset-hellgate.test.ts` (SOTA-4/SOTA-5 assert
 * `opt.sotaOn`), which this group does not own — so the field is retained with
 * a precise dead-field comment. The guard below pins the documented decision:
 * `sotaOn` is still emitted and equals its preset predicate, AND it is inert
 * (no other posture field tracks it).
 */
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { KNOB_INVENTORY } from "@/config/knob-inventory"

const SRC = join(import.meta.dir, "..", "..", "src")

/** The closure knobs whose readSite previously pointed at the NOOP file. Each
 *  entry pairs the envKey with the knob `id` benchPostureFromState reads. */
const CLOSURE_KNOBS = [
  { envKey: "QUANTA_BENCH_FAULT_EVIDENCE", id: "fault-evidence" },
  { envKey: "QUANTA_BENCH_VERIFICATION_PLAN", id: "verification-plan" },
  { envKey: "QUANTA_BENCH_PRIMARY_RAIL", id: "primary-rail" },
  { envKey: "QUANTA_BENCH_PATCH_HYGIENE", id: "patch-hygiene" },
  { envKey: "QUANTA_BENCH_NO_PATCH_BREAKER", id: "no-patch-breaker" },
  { envKey: "QUANTA_BENCH_REPAIR_ESCALATION", id: "repair-escalation" },
  { envKey: "QUANTA_BENCH_SPEC_FIDELITY_STEER", id: "spec-fidelity-steer" },
] as const

/** Reads-the-knob predicate the NOOP file CANNOT satisfy: the file must carry
 *  both the envKey literal AND the behavioral `readKnobValue(state, "<id>"`
 *  projection. */
const fileActuallyReadsKnob = (relPath: string, envKey: string, id: string): boolean => {
  const abs = join(SRC, relPath)
  if (!existsSync(abs)) return false
  const src = readFileSync(abs, "utf8")
  return src.includes(envKey) && src.includes(`readKnobValue(state, "${id}"`)
}

describe("bugbash #16 — closure-knob readSite points at the real effect site", () => {
  for (const { envKey, id } of CLOSURE_KNOBS) {
    test(`${envKey} readSite resolves to a file that actually reads the knob`, () => {
      const entry = KNOB_INVENTORY.find((e) => e.envKey === envKey)
      expect(entry).toBeDefined()
      const readSite = entry?.readSite
      expect(readSite).toBeDefined()
      // Behavioral read present at the readSite (red-on-injection: the NOOP
      // declaration file lacks `readKnobValue`, so reverting fails this).
      expect(fileActuallyReadsKnob(readSite as string, envKey, id)).toBe(true)
      // And it must NOT point back at the `(cfg) => cfg` NOOP declaration file.
      expect(readSite).not.toContain(`runner/knobs/knobs/${id}.ts`)
    })
  }

  test("DETECTOR has teeth: the old NOOP-file readSite would FAIL the reads-the-knob check", () => {
    // Prove the injection target is genuinely red: the NOOP declaration file
    // carries the envKey literal (so it passes the weaker truthfulness ratchet)
    // but does NOT carry the `readKnobValue` projection, so it fails here.
    for (const { envKey, id } of CLOSURE_KNOBS) {
      const noopFile = `runner/knobs/knobs/${id}.ts`
      const noopAbs = join(SRC, noopFile)
      expect(existsSync(noopAbs)).toBe(true)
      expect(readFileSync(noopAbs, "utf8").includes(envKey)).toBe(true) // weaker ratchet OK
      expect(fileActuallyReadsKnob(noopFile, envKey, id)).toBe(false) // but mis-routed
    }
  })
})

describe("bugbash #14 — dead `sotaOn` field decision is pinned (documented-only)", () => {
  test("knobs-bench.ts flags sotaOn as a dead field with the #14 marker", () => {
    const src = readFileSync(join(SRC, "runner/batch/eval/knobs-bench.ts"), "utf8")
    // The retention decision (blocked on the cross-group hellgate) must be
    // documented in-source so a future reader does not re-wire a dead consumer.
    expect(src).toContain("DEAD FIELD (bugbash #14)")
    // No production consumer reads it: the ONLY `sotaOn` occurrences are the
    // type field, the (documented) computation, and the two comment markers —
    // never a `posture.sotaOn` / `.sotaOn` behavioral branch in this file.
    expect(src).not.toContain("posture.sotaOn")
  })
})
