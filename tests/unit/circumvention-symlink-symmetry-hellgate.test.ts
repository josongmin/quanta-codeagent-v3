/**
 * jun-7-misc 04 (b) — ROUND-4 hellgate: symlink canonicalization SYMMETRY.
 *
 * CARRIED ITEM (rounds 1-3 #4), settled empirically: `canonicalizeEffectPath`
 * is PURE — no filesystem, therefore NO symlink resolution (an accepted FN, §5).
 * The crucial property is SYMMETRY: BOTH the denied write tool's path AND the
 * later bash-redirect path are recorded through the SAME lexical canonicalizer
 * from the SAME raw `action.input` (the gate never realpaths one side). So:
 *
 *   - a denied write to `/repo/X` vs a later bash write to the SAME lexical
 *     `/repo/X` (via `./X`, `/repo/./X`, etc.) ALWAYS collides — no asymmetric
 *     bypass where one side is realpath'd and the other lexical.
 *   - a denied write to `/repo/real` vs a bash write to `/repo/link` (a symlink
 *     to it) does NOT collide — the documented accepted FN, NOT a regression.
 *
 * This ratchet pins the symmetry: if a future change realpaths the denied path
 * (or the bash path) on only ONE side, the lexical-collision assertions below
 * break, surfacing the asymmetry before it ships as a silent partial-bypass.
 *
 * Red-on-injection: make `canonicalizeEffectPath` resolve a known symlink on one
 * call but not the other and the collision assertion fails.
 */
import { describe, expect, test } from "bun:test"
import { canonicalizeEffectPath, CircumventionTracker } from "@/permission/circumvention"

const cwd = "/repo"

describe("circumvention symlink symmetry (round-4)", () => {
  test("lexically-equal paths from different syntaxes ALWAYS collide (symmetry)", () => {
    const t = new CircumventionTracker()
    // Denied write recorded from the write tool's input `/repo/X`.
    t.noteDenied({ kind: "write", path: canonicalizeEffectPath("/repo/X", cwd) }, "Edit", 1)
    // Later bash redirect to the SAME path written three different ways.
    for (const form of ["/repo/X", "./X", "/repo/./X", "X", "/repo/sub/../X"]) {
      const sig = { kind: "write" as const, path: canonicalizeEffectPath(form, cwd) }
      expect(t.matchCircumvention(sig, "bash", 2)?.path).toBe("/repo/X")
    }
  })

  test("a DIFFERENT lexical path (symlink-name) does NOT collide — accepted FN", () => {
    const t = new CircumventionTracker()
    t.noteDenied({ kind: "write", path: canonicalizeEffectPath("/repo/real", cwd) }, "Edit", 1)
    // `/repo/link` is (hypothetically) a symlink to /repo/real; lexically distinct.
    const linkSig = { kind: "write" as const, path: canonicalizeEffectPath("/repo/link", cwd) }
    // Documented accepted FN: the pure canonicalizer cannot know they're the same
    // file. This is NOT a bypass — it's the §5 conservative trade. Pinned so a
    // future symlink-resolution change is a DELIBERATE, reviewed behavior shift.
    expect(t.matchCircumvention(linkSig, "bash", 2)).toBeUndefined()
  })

  test("canonicalizer is PURE: identical input ⇒ identical output (no FS read)", () => {
    // Determinism guard — if a symlink resolution snuck in, a non-existent path
    // would still resolve identically (no throw, no FS dependence).
    const a = canonicalizeEffectPath("/nonexistent/../also-gone/X", cwd)
    const b = canonicalizeEffectPath("/nonexistent/../also-gone/X", cwd)
    expect(a).toBe(b)
    expect(a).toBe("/also-gone/X")
  })
})
