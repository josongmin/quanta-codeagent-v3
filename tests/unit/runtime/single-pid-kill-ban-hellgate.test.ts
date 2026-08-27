/**
 * ★ PERMANENT GUARD — SINGLE-PID KILL BAN (D1, RFC jun-7 §6.1).
 *
 * THE BUG CLASS THIS LOCKS DOWN:
 *   A spawn site that runs a user-command SHELL TREE (`bash -lc "<cmd>"`, a
 *   command-hook shell, a sandboxed run) but terminates it with the legacy
 *   single-PID `proc.kill()` SIGTERMs ONLY the shell — its forked children
 *   (node→vite workers, test runners, dev servers) reparent to init and LEAK
 *   ports/CPU/locks. The D1 fix routes every such kill through an
 *   `escalatingKill(proc, <ProcessTreeKiller>)` so the WHOLE descendant tree is
 *   signalled. This was applied to shell.ts + bash-bg-registry.ts; a later audit
 *   found THREE more sites (LocalSandbox.run, DockerSandbox.run, command-hook
 *   sandbox-exec) that still used the bare single-PID form and were fixed.
 *
 * WHY A SOURCE RATCHET (not just the behavioral process-tree hellgate):
 *   The killer is OPT-IN — `escalatingKill(proc)` (one arg) silently falls back
 *   to single-PID `proc.kill()`. A FUTURE exec site that calls the one-arg form
 *   re-opens the orphan leak, and no behavioral test would notice (the leaked
 *   children are invisible to a unit test). This guard makes the one-arg form a
 *   RED TEST: EVERY `escalatingKill(` CALL in `src/` must pass a second
 *   (ProcessTreeKiller) argument. Completeness by construction — no allowlist,
 *   because there is no legitimate reason to kill a spawned child single-PID once
 *   the tree killer exists (it degrades to single-PID safely when `ps` is absent
 *   or the child has no descendants, so wiring it is never wrong).
 *
 * RED-ON-INJECTION PROOF (bottom): a synthetic one-arg `escalatingKill(proc)`
 * source string is shown to be FLAGGED by the same predicate; the two-arg form
 * is clean. Then GREEN on the current fixed tree.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const SRC = join(import.meta.dir, "..", "..", "..", "src")

/** Recursively collect every `.ts` file under `dir` (skips `.js` mirrors). */
const tsFiles = (dir: string): string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const s = statSync(p)
    if (s.isDirectory()) out.push(...tsFiles(p))
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p)
  }
  return out
}

/**
 * Pure predicate: return the one-arg `escalatingKill(<ident>)` call snippets in
 * `text` (the VIOLATIONS), excluding the function DEFINITION (`= (`). A call is
 * a violation iff its argument list has NO top-level comma before the closing
 * paren — i.e. exactly one argument (no ProcessTreeKiller).
 */
export const singlePidKillCalls = (text: string): string[] => {
  const violations: string[] = []
  // Match `escalatingKill(` … `)` non-greedily up to the first `)`; the call
  // sites in this codebase never nest parens inside the arg list, so a simple
  // balanced-free match is sufficient and avoids false negatives.
  // The regex requires `escalatingKill` IMMEDIATELY followed by `(` — so the
  // function DEFINITION (`export const escalatingKill = (` — note the ` = (`
  // with spaces) is never matched; only call sites are. A param list containing
  // a `:` is a TYPE annotation (a definition/signature, not a call) and is
  // skipped. A call with exactly one argument (no top-level comma) is the
  // single-PID-kill violation.
  const re = /escalatingKill\(([^)]*)\)/g
  let m: RegExpExecArray | null = re.exec(text)
  while (m !== null) {
    const args = (m[1] ?? "").trim()
    const isSignature = args.includes(":") // typed params ⇒ definition, not a call
    if (!isSignature && args.length > 0 && !args.includes(",")) {
      violations.push(`escalatingKill(${args})`)
    }
    m = re.exec(text)
  }
  return violations
}

describe("single-PID kill ban — every escalatingKill passes a tree killer (D1 §6.1)", () => {
  test("NO src file calls escalatingKill with a single argument (orphan-leak ban)", () => {
    const offenders: Array<{ file: string; calls: string[] }> = []
    let scanned = 0
    for (const file of tsFiles(SRC)) {
      scanned++
      const text = readFileSync(file, "utf8")
      const calls = singlePidKillCalls(text)
      if (calls.length > 0) offenders.push({ file: file.slice(SRC.length + 1), calls })
    }
    // Any one-arg call is a regression (a new exec site that would orphan its
    // process tree). The current tree wires a killer at every site.
    // Anti-vacuity. The verdict is `offenders === []`, so a walk that reads
    // NOTHING is the same green as a clean tree. Proven vacuous before this line
    // existed: the whole file passes 2/0 against an empty mirror of the repo's
    // directory skeleton — a ban on orphan-leaking `escalatingKill` calls that
    // could not fail.
    expect(scanned, "the walk read no source files — the ban below is vacuous").toBeGreaterThan(
      3250,
    )
    expect(offenders).toEqual([])
  })

  test("red-on-injection: the predicate FLAGS a one-arg call and CLEARS a two-arg call", () => {
    // A reintroduced bug — bare single-PID kill.
    expect(singlePidKillCalls("const { kill } = escalatingKill(proc)")).toEqual([
      "escalatingKill(proc)",
    ])
    // The fixed form — killer wired.
    expect(
      singlePidKillCalls("const { kill } = escalatingKill(proc, SANDBOX_TREE_KILLER)"),
    ).toEqual([])
    // The definition must NOT be flagged (it is not a call site).
    expect(
      singlePidKillCalls("export const escalatingKill = (proc: KillableChild) => ({})"),
    ).toEqual([])
  })
})
