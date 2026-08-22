/**
 * Pure parser for `bun test` textual output.
 *
 * The flake-resilience runner (`cli.ts`) needs to know, from a full-suite run:
 *   1. the pass/fail/error summary, and
 *   2. WHICH (file, test-name) pairs failed — so each can be re-run in true
 *      isolation to classify it as a genuine failure vs a parallelism flake.
 *
 * `bun test` prints a per-file section header (`path/to/x.test.ts:`) followed by
 * `(fail) <describe> > <leaf>` lines. This module is the ONLY place that knows
 * that text shape; it is pure (string in, struct out) so the brittle parsing is
 * exhaustively unit-testable without spawning a real suite.
 */

export interface ParsedFailure {
  /** Test file path as printed in the section header (e.g. `tests/unit/x.test.ts`). */
  readonly file: string
  /** Full test name as printed after `(fail) ` (describe chain + leaf, no timing). */
  readonly name: string
  /** Leaf segment (after the last ` > `) — the most specific `-t` pattern. */
  readonly leaf: string
}

export interface ParsedRun {
  readonly pass: number
  readonly fail: number
  readonly error: number
  readonly failures: readonly ParsedFailure[]
}

// ESC built via charCode (not a literal control char) — mirrors src/ui/ui-helpers.ts.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")
const FILE_HEADER = /^(\S.*\.test\.[tj]s):$/
// `(fail) name [12.34ms]` — strip the trailing timing if present.
const FAIL_LINE = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/
const SUMMARY = /^\s*(\d+) (pass|fail|error)\b/

/** Parse the captured stdout+stderr of a `bun test` run. Unknown/extra lines
 *  are ignored. A `(fail)` seen before any file header is attributed to an
 *  empty file (still surfaced so it is never silently dropped). */
/** A `(fail)` line → ParsedFailure (attributed to the current file), or null. */
const matchFailure = (line: string, currentFile: string): ParsedFailure | null => {
  const fm = FAIL_LINE.exec(line)
  if (!fm?.[1]) return null
  const name = fm[1].trim()
  const segs = name.split(" > ")
  return { file: currentFile, name, leaf: segs[segs.length - 1] ?? name }
}

export const parseBunTestOutput = (output: string): ParsedRun => {
  let currentFile = ""
  const counts = { pass: 0, fail: 0, error: 0 }
  const failures: ParsedFailure[] = []

  for (const raw of output.split("\n")) {
    const line = raw.replace(ANSI, "") // strip ANSI

    const header = FILE_HEADER.exec(line)
    if (header?.[1]) {
      currentFile = header[1]
      continue
    }

    const f = matchFailure(line, currentFile)
    if (f) {
      failures.push(f)
      continue
    }

    const sm = SUMMARY.exec(line)
    if (sm?.[1] && sm[2]) counts[sm[2] as "pass" | "fail" | "error"] = Number(sm[1])
  }

  return { ...counts, failures }
}

/** A quarantine-ledger entry: a test KNOWN to be flaky under parallel load,
 *  tracked (not hidden) with its resource class + why, so the count can be
 *  ratcheted down — never silently up. */
export interface QuarantineEntry {
  readonly file: string
  /** Substring of the test name used as the `-t` isolation pattern. */
  readonly name: string
  /** Resource class driving the flake (see SOTA taxonomy). */
  readonly resourceClass: "external-server" | "timing" | "repo-walk" | "io"
  readonly reason: string
}

export interface QuarantineLedger {
  /** One-directional ceiling: the runner FAILS if live flaky count exceeds it.
   *  Lower it as flakes are structurally fixed (e.g. via the replay seam). */
  readonly maxCount: number
  readonly entries: readonly QuarantineEntry[]
}

/** True iff `f` matches a ledger entry (same file + the entry's name is a
 *  substring of the failing test name — mirrors how `-t` matches). */
export const isQuarantined = (f: ParsedFailure, ledger: QuarantineLedger): boolean =>
  ledger.entries.some((e) => f.file.endsWith(e.file) && f.name.includes(e.name))
