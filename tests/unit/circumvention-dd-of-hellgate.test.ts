/**
 * HELLGATE — jun-7-misc 04 (b), round-2 adversarial finding: `dd of=FILE` write
 * primitive was an UNHANDLED circumvention path.
 *
 * THE HOLE this closes: §3.2 names `python -c`, `sed -i`, `cat >`, heredocs "or
 * similar" as the same-effect-different-tool moves. `dd of=FILE` is a primary,
 * universally-available write primitive — arguably a MORE common circumvention
 * move than `python -c` (it is the canonical "write raw bytes to a path"
 * builtin). The round-1 verifier explicitly flagged `dd of=` as the gap most
 * likely to violate the spec's own "named-in-spec mechanism" claim.
 *
 * Before the fix the v1 extractor returned `[]` for EVERY `dd of=...` form, so a
 * soft-denied `Edit /repo/X` followed by `bash dd if=/dev/zero of=/repo/X` was a
 * SILENT bypass of the feature's own contract.
 *
 * RED-ON-INJECTION: delete the `dd of=` pattern and every CATCH assertion below
 * fails. The NO-FALSE-POSITIVE assertions guard that the deterministic parse
 * never invents a target from a computed (`$VAR`) operand or a non-`of=` key —
 * keeping the no-heuristics / FP-tolerant posture (§5).
 */
import { describe, expect, test } from "bun:test"
import { extractShellWritePaths } from "@/permission"

const CWD = "/repo"

describe("dd of=FILE write target (round-2 finding)", () => {
  test("bare `dd of=FILE` is a write target", () => {
    expect(extractShellWritePaths("dd of=/repo/X", CWD)).toContain("/repo/X")
  })

  test("canonical `dd if=... of=FILE ...` form is a write target", () => {
    expect(extractShellWritePaths("dd if=/dev/zero of=/repo/X bs=1 count=1", CWD)).toContain(
      "/repo/X",
    )
    expect(extractShellWritePaths("dd of=/repo/X conv=notrunc", CWD)).toContain("/repo/X")
  })

  test("quoted `of='FILE'` / `of=\"FILE\"` targets are extracted", () => {
    expect(extractShellWritePaths("dd of='/repo/X'", CWD)).toContain("/repo/X")
    expect(extractShellWritePaths('dd of="/repo/X"', CWD)).toContain("/repo/X")
  })

  test("relative `of=` operand is canonicalized against cwd", () => {
    expect(extractShellWritePaths("dd of=X", CWD)).toContain("/repo/X")
    expect(extractShellWritePaths("dd of=./sub/X", CWD)).toContain("/repo/sub/X")
  })

  test("INVARIANT — computed (`$VAR`) `of=` operand does NOT match (accepted FN)", () => {
    // A `$VAR` target is an accepted false-negative (§5) — never invent a
    // (likely-wrong) signature from an un-expanded variable.
    expect(extractShellWritePaths("dd of=$TARGET", CWD)).toEqual([])
    // `dd of=${OUT}` as a SHELL operand — built via concat so this stays a plain
    // string literal (no JS template-placeholder lint), still feeding the parser
    // the exact bytes `dd of=${OUT}`.
    expect(extractShellWritePaths(`dd of=$${"{"}OUT}`, CWD)).toEqual([])
  })

  test("INVARIANT — a non-`of=` key is NOT a write target", () => {
    // `if=` is a READ source; `ofx=`/`xof=` are not the write key.
    expect(extractShellWritePaths("dd if=/repo/X", CWD)).toEqual([])
    expect(extractShellWritePaths("dd ofx=/repo/X", CWD)).toEqual([])
    expect(extractShellWritePaths("dd xof=/repo/X", CWD)).toEqual([])
  })

  test("INVARIANT — `of=` must be space-bounded on the left (not a substring)", () => {
    // `seekof=` / `notof=` are not the `of=` operand; only a token whose key is
    // exactly `of` writes. (Whitespace/segment boundary required.)
    expect(extractShellWritePaths("dd seekof=/repo/X", CWD)).toEqual([])
  })
})
