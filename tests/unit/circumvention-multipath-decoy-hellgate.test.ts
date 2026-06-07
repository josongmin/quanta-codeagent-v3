/**
 * jun-7-misc 04 (b) — ROUND-4 hellgate: multi-path decoy circumvention.
 *
 * THE HOLE (round-4 finding 1, MEDIUM): a single bash command can write MORE
 * THAN ONE path. The v1 single-effect API (`extractWriteEffect`) returned only
 * the FIRST write target, so a manipulated agent could prefix a harmless decoy
 * redirect before the real (soft-denied) one —
 *
 *     echo decoy > /repo/DECOY ; echo evil > /repo/SECRET
 *
 * — and the detector, only ever checking `/repo/DECOY`, NEVER saw the
 * circumvention of `/repo/SECRET`. This is the most trivial circumvention move
 * possible (a one-line shell chain) and routes around the feature's own
 * contract. The fix: extract ALL literal write targets and match/note EVERY one.
 *
 * Red-on-injection: revert `extractWriteEffects` to return only the first path
 * (or stop iterating all effects in the tracker drive) and the decoy cases fail.
 */
import { describe, expect, test } from "bun:test"
import {
  CircumventionTracker,
  type EffectSignature,
  extractWriteEffect,
  extractWriteEffects,
} from "@/permission/circumvention"

const cwd = "/repo"

describe("circumvention multi-path decoy (round-4)", () => {
  test("extractWriteEffects returns EVERY literal write target, not just the first", () => {
    const cmd = "echo decoy > /repo/DECOY; echo evil > /repo/SECRET"
    const effs = extractWriteEffects("bash", null, cmd, cwd)
    const paths = effs.map((e) => e.path).sort()
    // Both targets MUST be present — the single-effect API dropped /repo/SECRET.
    expect(paths).toEqual(["/repo/DECOY", "/repo/SECRET"])
  })

  test("a decoy-prefixed redirect to a soft-denied path IS still matched", () => {
    // Edit /repo/SECRET soft-denied at turn 1.
    const t = new CircumventionTracker()
    t.noteDenied({ kind: "write", path: "/repo/SECRET" }, "Edit", 1)

    const cmd = "echo decoy > /repo/DECOY; echo evil > /repo/SECRET"
    const effs = extractWriteEffects("bash", null, cmd, cwd)

    // Drive the tracker over EVERY effect (the gate/policy must do the same).
    const hits = effs
      .map((e) => t.matchCircumvention(e, "bash", 2))
      .filter((s): s is NonNullable<typeof s> => s !== undefined)

    expect(hits.length).toBe(1)
    expect(hits[0]?.path).toBe("/repo/SECRET")
    expect(hits[0]?.deniedByTool).toBe("Edit")
  })

  test("noteDenied over all effects records EVERY soft-denied path (defence-in-depth)", () => {
    // A bash action that writes two paths is soft-denied: BOTH must be remembered
    // so a later tool-switch to EITHER is caught.
    const t = new CircumventionTracker()
    const cmd = "echo a > /repo/A; echo b > /repo/B"
    const effs = extractWriteEffects("bash", null, cmd, cwd)
    for (const e of effs) t.noteDenied(e, "bash", 1)
    expect(t.size()).toBe(2)

    // Later Edit to /repo/B (different tool) ⇒ circumvention.
    const sigB: EffectSignature = { kind: "write", path: "/repo/B" }
    expect(t.matchCircumvention(sigB, "Edit", 2)?.path).toBe("/repo/B")
  })

  test("read-only fence still holds for the plural extractor (no write effects)", () => {
    // isReadOnly === true ⇒ NO effects, even with redirect-looking text.
    const effs = extractWriteEffects("bash", null, "echo x > /repo/X", cwd, true)
    expect(effs).toEqual([])
  })

  test("single-path back-compat: extractWriteEffect's first == extractWriteEffects[0]", () => {
    const cmd = "echo evil > /repo/SECRET"
    const single = extractWriteEffect("bash", null, cmd, cwd)
    const plural = extractWriteEffects("bash", null, cmd, cwd)
    expect(plural[0]).toEqual(single)
    expect(plural.length).toBe(1)
  })

  test("non-shell write tool yields exactly one effect (its path)", () => {
    const effs = extractWriteEffects("Write", { path: "/repo/F" }, null, cwd)
    expect(effs).toEqual([{ kind: "write", path: "/repo/F" }])
  })
})
