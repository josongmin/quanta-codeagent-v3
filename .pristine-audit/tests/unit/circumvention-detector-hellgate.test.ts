/**
 * HELLGATE — jun-7-misc 04 (b): tool-switch circumvention detector.
 *
 * THE BYPASS this closes: a write to path X is SOFT-denied via tool A
 * (`Edit`/`Write`), then a manipulated agent achieves the SAME effect via a
 * DIFFERENT tool B (`bash` `echo > X` / `sed -i X` / `cat > X` / heredoc /
 * `python -c`). quanta evaluates each action independently with no denied-effect
 * memory, so the redirect-around-deny is invisible. This battery pins:
 *
 *  - CATCH: a soft-denied write to /repo/X followed by a bash write to the SAME
 *    canonical X via a DIFFERENT tool raises a circumvention signal.
 *  - NO FALSE-POSITIVE: a write to a DIFFERENT path /repo/Y is NOT flagged; a
 *    READ of X (cat X) is NOT a write effect; a SAME-tool re-attempt is NOT a
 *    circumvention (that is the denial-limit's job — no double-count).
 *  - PATH CANONICALIZATION: ./X, /repo/X, /repo/./X collide; /repo/X vs
 *    /repo/sub/X do NOT.
 *  - TTL / CLEAR-ON-ALLOW: a genuine allow clears the signature; an expired
 *    signature (past the turn window) no longer matches.
 *  - HARD_DENY is NEVER tracked (terminal — needs no soft-deny memory).
 *  - RED-ON-INJECTION: the catch/no-FP/clear assertions fail if any guard is
 *    removed.
 *
 * Source under test:
 *   src/permission/circumvention.ts — canonicalizeEffectPath / extractWriteEffect
 *     / extractShellWritePaths / CircumventionTracker
 */
import { describe, expect, test } from "bun:test"
import {
  CIRCUMVENTION_TTL_TURNS,
  CircumventionTracker,
  canonicalizeEffectPath,
  type EffectSignature,
  extractShellWritePaths,
  extractWriteEffect,
} from "@/permission"

const CWD = "/repo"
const writeSig = (path: string): EffectSignature => ({ kind: "write", path })

describe("canonicalizeEffectPath — collision semantics", () => {
  test("./X, X, /repo/./X all collide with /repo/X", () => {
    const canon = "/repo/X"
    expect(canonicalizeEffectPath("./X", CWD)).toBe(canon)
    expect(canonicalizeEffectPath("X", CWD)).toBe(canon)
    expect(canonicalizeEffectPath("/repo/./X", CWD)).toBe(canon)
    expect(canonicalizeEffectPath("/repo/X", CWD)).toBe(canon)
  })

  test("/repo/X and /repo/sub/X do NOT collide", () => {
    expect(canonicalizeEffectPath("/repo/X", CWD)).not.toBe(
      canonicalizeEffectPath("/repo/sub/X", CWD),
    )
  })

  test("`..` segments resolve", () => {
    expect(canonicalizeEffectPath("/repo/sub/../X", CWD)).toBe("/repo/X")
    expect(canonicalizeEffectPath("sub/../X", CWD)).toBe("/repo/X")
  })

  test("backslash separators normalize to forward slashes", () => {
    expect(canonicalizeEffectPath("sub\\X", CWD)).toBe("/repo/sub/X")
  })
})

describe("extractShellWritePaths — closed v1 pattern set (§9.4)", () => {
  test("redirect `>` and `>>`", () => {
    expect(extractShellWritePaths("echo hi > /repo/X", CWD)).toContain("/repo/X")
    expect(extractShellWritePaths("echo hi >> /repo/X", CWD)).toContain("/repo/X")
  })

  test("cat > FILE and heredoc", () => {
    expect(extractShellWritePaths("cat > /repo/X", CWD)).toContain("/repo/X")
    expect(extractShellWritePaths("cat > /repo/X <<EOF\ndata\nEOF", CWD)).toContain("/repo/X")
  })

  test("sed -i FILE (in-place)", () => {
    expect(extractShellWritePaths("sed -i 's/a/b/' /repo/X", CWD)).toContain("/repo/X")
    // sed WITHOUT -i is not an in-place write
    expect(extractShellWritePaths("sed 's/a/b/' /repo/X", CWD)).not.toContain("/repo/X")
  })

  test("tee FILE", () => {
    expect(extractShellWritePaths("echo hi | tee /repo/X", CWD)).toContain("/repo/X")
    expect(extractShellWritePaths("echo hi | tee -a /repo/X", CWD)).toContain("/repo/X")
  })

  test("cp/mv DEST (last operand)", () => {
    expect(extractShellWritePaths("cp src /repo/X", CWD)).toContain("/repo/X")
    expect(extractShellWritePaths("mv src /repo/X", CWD)).toContain("/repo/X")
  })

  test("python -c open(FILE, 'w')", () => {
    expect(extractShellWritePaths(`python -c 'open("/repo/X","w").write("x")'`, CWD)).toContain(
      "/repo/X",
    )
    // open in READ mode is not a write
    expect(extractShellWritePaths(`python -c 'open("/repo/X","r").read()'`, CWD)).not.toContain(
      "/repo/X",
    )
  })

  test("a pure READ (cat X, no redirect) yields NO write target", () => {
    expect(extractShellWritePaths("cat /repo/X", CWD)).toEqual([])
  })

  test("a computed / $VAR target is an accepted false-negative (not parsed)", () => {
    expect(extractShellWritePaths("echo hi > $TARGET", CWD)).toEqual([])
  })
})

describe("extractWriteEffect — tool-vs-shell dispatch", () => {
  test("non-shell write tool reads input.path", () => {
    const eff = extractWriteEffect("Write", { path: "./X" }, undefined, CWD)
    expect(eff).toEqual(writeSig("/repo/X"))
  })

  test("shell-equivalent action parses the command", () => {
    const eff = extractWriteEffect("bash", { command: "echo > /repo/X" }, "echo > /repo/X", CWD)
    expect(eff).toEqual(writeSig("/repo/X"))
  })

  test("a read tool yields undefined", () => {
    expect(
      extractWriteEffect("bash", { command: "cat /repo/X" }, "cat /repo/X", CWD),
    ).toBeUndefined()
  })

  test("a tool with no path / no shell command yields undefined", () => {
    expect(extractWriteEffect("search", { query: "foo" }, undefined, CWD)).toBeUndefined()
  })
})

describe("CircumventionTracker — catch, no-FP, same-tool, TTL, clear", () => {
  test("CATCH: soft-denied Write to /repo/X, then bash write to SAME path ⇒ signal", () => {
    const t = new CircumventionTracker()
    t.noteDenied(writeSig("/repo/X"), "Write", 1)
    const signal = t.matchCircumvention(writeSig("/repo/X"), "bash", 2)
    expect(signal).toBeDefined()
    expect(signal?.deniedByTool).toBe("Write")
    expect(signal?.currentTool).toBe("bash")
    expect(signal?.advisory).toContain("/repo/X")
  })

  test("NO-FP: a write to a DIFFERENT path /repo/Y is NOT flagged", () => {
    const t = new CircumventionTracker()
    t.noteDenied(writeSig("/repo/X"), "Write", 1)
    expect(t.matchCircumvention(writeSig("/repo/Y"), "bash", 2)).toBeUndefined()
  })

  test("SAME-TOOL re-attempt is NOT circumvention (denial-limit's job, no double-count)", () => {
    const t = new CircumventionTracker()
    t.noteDenied(writeSig("/repo/X"), "Write", 1)
    expect(t.matchCircumvention(writeSig("/repo/X"), "Write", 2)).toBeUndefined()
  })

  test("no prior deny ⇒ never flagged", () => {
    const t = new CircumventionTracker()
    expect(t.matchCircumvention(writeSig("/repo/X"), "bash", 2)).toBeUndefined()
  })

  test("CLEAR-ON-ALLOW: a genuine allow of /repo/X clears the signature", () => {
    const t = new CircumventionTracker()
    t.noteDenied(writeSig("/repo/X"), "Write", 1)
    t.clearOnAllow(writeSig("/repo/X"))
    expect(t.matchCircumvention(writeSig("/repo/X"), "bash", 2)).toBeUndefined()
    expect(t.size()).toBe(0)
  })

  test("TTL: a signature past the turn window no longer matches (and is pruned)", () => {
    const t = new CircumventionTracker()
    t.noteDenied(writeSig("/repo/X"), "Write", 0)
    // Just within window still matches.
    expect(t.matchCircumvention(writeSig("/repo/X"), "bash", CIRCUMVENTION_TTL_TURNS)).toBeDefined()
    // Re-arm (match pruned nothing because in-window).
    t.noteDenied(writeSig("/repo/X"), "Write", 0)
    // Past the window ⇒ no match, and pruned.
    expect(
      t.matchCircumvention(writeSig("/repo/X"), "bash", CIRCUMVENTION_TTL_TURNS + 1),
    ).toBeUndefined()
    expect(t.size()).toBe(0)
  })

  test("reset() drops all signatures", () => {
    const t = new CircumventionTracker()
    t.noteDenied(writeSig("/repo/X"), "Write", 1)
    t.noteDenied(writeSig("/repo/Y"), "Write", 1)
    t.reset()
    expect(t.size()).toBe(0)
  })

  test("canonicalization collides across forms: Edit ./X denied, bash > /repo/X caught", () => {
    const t = new CircumventionTracker()
    const editEff = extractWriteEffect("Edit", { path: "./X" }, undefined, CWD)
    const bashEff = extractWriteEffect("bash", { command: "echo > /repo/X" }, "echo > /repo/X", CWD)
    expect(editEff).toBeDefined()
    expect(bashEff).toBeDefined()
    if (editEff && bashEff) {
      t.noteDenied(editEff, "Edit", 1)
      expect(t.matchCircumvention(bashEff, "bash", 2)).toBeDefined()
    }
  })
})
