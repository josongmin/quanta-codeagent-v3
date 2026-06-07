/**
 * HELLGATE — jun-7-misc 04 (b), round-3 finding: the `>|` noclobber-override
 * redirect was an UNHANDLED write primitive (false negative).
 *
 * THE HOLE (round-3 adversarial audit): the redirect extractor matched `>` and
 * `>>` (incl. fd-prefixed `1>`/`&>`), but `cmd >| FILE` — the POSIX/bash
 * "force truncate-write even under `set -o noclobber`" redirect — produced `[]`.
 * After the `>` operator the next char is `|`, which the target char-class
 * (`[^\s|;&<>]`) excludes and `\s*` cannot consume, so the target was never
 * captured. `>|` is squarely a §3.2 redirect operator (`>`/`>>`/`|`) and a clean
 * same-effect-different-tool move: a soft-denied `Edit /repo/X` routed around via
 * `bash : >| /repo/X` was a SILENT BYPASS of the feature's own contract.
 *
 * THE FIX: the operator may carry a trailing `|` (the noclobber override) before
 * the (optional) whitespace and the target token.
 *
 * INVARIANTS preserved (red-on-injection both directions):
 *   - `>|` / `>>|` file targets ARE caught.
 *   - a pure PIPE `cmd | grep` is NOT a redirect target (no leading `>`).
 *   - an fd-DUP `2>&1` still yields NO file target.
 *
 * Source under test: src/permission/circumvention.ts — redirectTargets
 */
import { describe, expect, test } from "bun:test"
import { extractShellWritePaths } from "@/permission"

const W = (cmd: string): readonly string[] => extractShellWritePaths(cmd, "/repo")

describe("`>|` noclobber-override redirect is a write target", () => {
  test("`>| FILE` (force truncate-write) is caught", () => {
    expect(W("echo hi >| /repo/X")).toContain("/repo/X")
    expect(W(": >| /repo/X")).toContain("/repo/X")
    expect(W("cmd >|/repo/X")).toContain("/repo/X") // no space variant
  })

  test("`>>|` (append, noclobber-irrelevant but valid token) is caught", () => {
    expect(W("cmd >>| /repo/X")).toContain("/repo/X")
  })

  test("INVARIANT: a pure pipe is NOT a redirect write target", () => {
    // `cmd | grep x` pipes — no `>` operator, so no file target.
    expect(W("cat /repo/X | grep secret")).toEqual([])
  })

  test("INVARIANT: an fd-DUP `2>&1` still yields NO file target", () => {
    expect(W("cmd 2>&1")).toEqual([])
  })
})
