/**
 * jun-7-misc 04 (b) — ROUND-4 hellgate: `cp`/`mv -t DIR` target-directory form.
 *
 * THE HOLE (carried round-1..3 #2, LOW/correctness): `copyMoveDests` assumed the
 * LAST operand is the destination (`cp SRC DEST`). But the GNU `-t DIR` /
 * `--target-directory=DIR` form puts the destination FIRST and the sources after:
 *
 *     cp -t /repo/dst /repo/src      # dest = /repo/dst, last operand = SOURCE
 *
 * So the extractor returned `/repo/src` (a READ — a false target) and MISSED
 * `/repo/dst` (the real write). Two failures in one: a false attribution to the
 * source AND a silent FN on the real destination. A manipulated agent could
 * route a soft-denied write to `/repo/dst` via `cp -t /repo/dst src` and slip
 * past. The fix parses `-t DIR` / `--target-directory=DIR` and yields the DIR
 * (the real dest), excluding the source operands.
 *
 * Red-on-injection: remove the `-t`/`--target-directory` handling and the
 * dest-from-flag cases fail.
 */
import { describe, expect, test } from "bun:test"
import { extractShellWritePaths } from "@/permission/circumvention"

const cwd = "/repo"
const w = (cmd: string) => [...extractShellWritePaths(cmd, cwd)].sort()

describe("cp/mv -t DIR target-directory (round-4)", () => {
  test("`cp -t /repo/dst /repo/src` yields the DEST dir, not the source", () => {
    const out = w("cp -t /repo/dst /repo/src")
    expect(out).toContain("/repo/dst")
    // The source operand must NOT be attributed as a write target.
    expect(out).not.toContain("/repo/src")
  })

  test("`mv -t /repo/dst a b c` yields the dest dir, not the last source", () => {
    const out = w("mv -t /repo/dst /repo/a /repo/b /repo/c")
    expect(out).toContain("/repo/dst")
    expect(out).not.toContain("/repo/c")
  })

  test("`cp --target-directory=/repo/dst /repo/src` yields the dest dir", () => {
    const out = w("cp --target-directory=/repo/dst /repo/src")
    expect(out).toContain("/repo/dst")
    expect(out).not.toContain("/repo/src")
  })

  test("the classic `cp SRC DEST` form is UNCHANGED (last operand is the dest)", () => {
    const out = w("cp /repo/src /repo/dst")
    expect(out).toEqual(["/repo/dst"])
  })

  test("`mv a b` classic form still attributes the last operand", () => {
    expect(w("mv /repo/a /repo/b")).toEqual(["/repo/b"])
  })
})
