/**
 * HELLGATE — jun-7-misc 04 (b), round-1 adversarial finding: fd-prefixed
 * redirect write targets.
 *
 * THE HOLE this closes: the §3.2 circumvention mechanism is "routing around a
 * deny rule" with redirect operators. The v1 extractor matched `> FILE` and
 * `>> FILE` but its fd-guard lookbehind `(?<![0-9&])` ALSO swallowed the
 * file-target forms that carry an explicit fd or `&` on the LEFT of `>`:
 *
 *   - `cmd 1>/repo/X`  (explicit stdout → file)   — a real write, was MISSED
 *   - `cmd 2>/repo/X`  (stderr → file)            — a real write, was MISSED
 *   - `cmd &>/repo/X`  (bash both streams → file) — a real write, was MISSED
 *
 * These are exactly the same-effect-different-tool move (`Edit X` denied → bash
 * `cmd 1>X`). They MUST be extracted as write targets so the tracker can match a
 * prior soft-deny.
 *
 * THE INVARIANT THAT MUST NOT REGRESS (the reason the guard existed): an fd-DUP
 * target (`2>&1`, `>&2`) is NOT a file write — its target starts with `&` — and
 * MUST still yield NOTHING. Catching `1>X` while still rejecting `2>&1` is the
 * point.
 *
 * RED-ON-INJECTION: if the extractor regresses to dropping `1>`/`2>`/`&>` file
 * targets, the CATCH assertions fail; if it starts treating `2>&1`/`>&2` as a
 * file write, the NO-FALSE-POSITIVE assertions fail.
 */
import { describe, expect, test } from "bun:test"
import { extractShellWritePaths } from "@/permission"

const CWD = "/repo"

describe("fd-prefixed redirect write targets (round-1 finding)", () => {
  test("explicit stdout `1>FILE` is a write target", () => {
    expect(extractShellWritePaths("cmd 1>/repo/X", CWD)).toContain("/repo/X")
    expect(extractShellWritePaths("cmd 1>>/repo/X", CWD)).toContain("/repo/X")
  })

  test("stderr `2>FILE` is a write target", () => {
    expect(extractShellWritePaths("cmd 2>/repo/X", CWD)).toContain("/repo/X")
    expect(extractShellWritePaths("cmd 2>>/repo/X", CWD)).toContain("/repo/X")
  })

  test("bash both-streams `&>FILE` / `&>>FILE` is a write target", () => {
    expect(extractShellWritePaths("cmd &>/repo/X", CWD)).toContain("/repo/X")
    expect(extractShellWritePaths("cmd &>>/repo/X", CWD)).toContain("/repo/X")
  })

  test("plain `>FILE` / `>>FILE` still extracted (no regression)", () => {
    expect(extractShellWritePaths("echo x > /repo/X", CWD)).toContain("/repo/X")
    expect(extractShellWritePaths("echo x >> /repo/X", CWD)).toContain("/repo/X")
    expect(extractShellWritePaths("echo x>/repo/X", CWD)).toContain("/repo/X")
  })

  test("INVARIANT — fd-DUP (`2>&1`, `>&2`) is NOT a file write", () => {
    expect(extractShellWritePaths("cmd 2>&1", CWD)).toEqual([])
    expect(extractShellWritePaths("cmd >&2", CWD)).toEqual([])
    // mixed: a real file target plus a trailing dup — only the file is a write.
    expect(extractShellWritePaths("cmd >/repo/X 2>&1", CWD)).toEqual(["/repo/X"])
    expect(extractShellWritePaths("cmd 1>/repo/X 2>&1", CWD)).toEqual(["/repo/X"])
  })
})
