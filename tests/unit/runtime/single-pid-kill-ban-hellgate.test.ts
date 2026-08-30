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
import { stripComments } from "../_shared/strip-comments"

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

const IDENT = "escalatingKill"

/**
 * Scan forward from `open` (the index of the `(` that opens an argument list)
 * and return the arg-list text plus the number of TOP-LEVEL arguments.
 *
 * Depth is tracked over `()`, `[]` and `{}` so a comma nested inside an object
 * literal, array, call expression or type argument is NOT mistaken for an
 * argument separator (the original predicate's `args.includes(",")` proxy).
 * String literals — single, double and template, with backslash escapes and
 * `${…}` interpolation — are skipped wholesale so a bracket or comma inside a
 * string cannot corrupt the depth. Line and block comments are skipped for the
 * same reason. Returns `undefined` if the list is never closed (malformed).
 */
/** If a line/block comment starts at `i`, return the index just past it; else -1.
 *  Comments are skipped so a bracket or comma in prose cannot skew the depth. */
const skipComment = (text: string, i: number): number => {
  if (text[i] !== "/") return -1
  if (text[i + 1] === "/") {
    const nl = text.indexOf("\n", i)
    return nl === -1 ? text.length : nl
  }
  if (text[i + 1] === "*") {
    const end = text.indexOf("*/", i + 2)
    return end === -1 ? text.length : end + 2
  }
  return -1
}

/** Consume a balanced `${ … }` template interpolation starting at `i` (the `$`).
 *  Returns the index just past the closing brace. */
const skipInterpolation = (text: string, i: number): number => {
  let braces = 0
  let j = i + 1
  while (j < text.length) {
    const c = text[j] as string
    if (c === "{") braces++
    else if (c === "}") {
      braces--
      if (braces === 0) return j + 1
    }
    j++
  }
  return j
}

/** If a string/template literal starts at `i`, return the index just past its
 *  closing quote; else -1. Backslash escapes and `${…}` interpolation are
 *  handled so a quoted bracket or comma cannot skew the depth. */
const skipStringLiteral = (text: string, i: number): number => {
  const quote = text[i]
  if (quote !== '"' && quote !== "'" && quote !== "`") return -1
  let j = i + 1
  while (j < text.length) {
    const c = text[j] as string
    if (c === "\\") {
      j += 2
      continue
    }
    if (quote === "`" && c === "$" && text[j + 1] === "{") {
      j = skipInterpolation(text, j + 1)
      continue
    }
    if (c === quote) return j + 1
    j++
  }
  return j
}

const OPENERS = "([{"
const CLOSERS = ")]}"

/** Skip one run of non-code trivia at `i`. `isValue` says whether what was
 *  skipped counts as argument CONTENT (a string literal does; a comment does
 *  not). Returns undefined when `i` is ordinary code. */
const skipTrivia = (text: string, i: number): { next: number; isValue: boolean } | undefined => {
  const comment = skipComment(text, i)
  if (comment > i) return { next: comment, isValue: false }
  const str = skipStringLiteral(text, i)
  if (str > i) return { next: str, isValue: true }
  return undefined
}

/** Mutable tally carried across {@link stepArgList} calls. */
interface ArgScan {
  depth: number
  commas: number
  sawArg: boolean
}

/** Advance one token from `i`, updating `scan`. Returns the next index, or -1
 *  when the argument list closes at `i`. */
const stepArgList = (text: string, i: number, scan: ArgScan): number => {
  const trivia = skipTrivia(text, i)
  if (trivia !== undefined) {
    if (trivia.isValue) scan.sawArg = true
    return trivia.next
  }
  const c = text[i] as string
  if (OPENERS.includes(c)) {
    scan.depth++
    if (scan.depth > 1) scan.sawArg = true
    return i + 1
  }
  if (CLOSERS.includes(c)) {
    scan.depth--
    return scan.depth === 0 ? -1 : i + 1
  }
  if (c === "," && scan.depth === 1) scan.commas++
  else if (!/\s/.test(c)) scan.sawArg = true
  return i + 1
}

/**
 * Scan forward from `open` (the index of the `(` that opens an argument list)
 * and return the arg-list text plus the number of TOP-LEVEL arguments.
 *
 * Depth is tracked over `()`, `[]` and `{}` so a comma nested inside an object
 * literal, array, call expression or type argument is NOT mistaken for an
 * argument separator (the original predicate's `args.includes(",")` proxy).
 * Comments and string/template literals are skipped wholesale. Returns
 * `undefined` if the list is never closed (malformed).
 */
const readArgList = (text: string, open: number): { args: string; count: number } | undefined => {
  const scan: ArgScan = { depth: 0, commas: 0, sawArg: false }
  let i = open
  while (i < text.length) {
    const next = stepArgList(text, i, scan)
    if (next === -1) {
      return { args: text.slice(open + 1, i), count: scan.sawArg ? scan.commas + 1 : 0 }
    }
    i = next
  }
  return undefined
}

/**
 * Is the `escalatingKill` token at `idx` a DEFINITION rather than a call?
 *
 * Anchored on the ACTUAL definition text — the binding keyword or `function`
 * immediately preceding the identifier — instead of the old `args.includes(":")`
 * heuristic, which both exempted real one-argument CALLS whose argument happened
 * to contain a colon (typed object literals, ternaries) and flagged an UNTYPED
 * function declaration as a violation.
 */
const isDefinition = (text: string, idx: number): boolean =>
  /(?:^|[^\w$])(?:const|let|var|function)\s+$/.test(text.slice(Math.max(0, idx - 40), idx))

/**
 * Pure predicate: return the one-argument `escalatingKill(…)` CALL snippets in
 * `text` (the VIOLATIONS), excluding the function DEFINITION.
 *
 * A call is a violation iff its argument list holds exactly ONE top-level
 * argument — i.e. no {@link ProcessTreeKiller} was passed. Argument counting is
 * done by bracket-depth tracking (see {@link readArgList}), so neither a comma
 * nor a colon INSIDE a single argument can be mistaken for a second argument or
 * for a type annotation. The reported snippet spans the full BALANCED argument
 * list.
 */
export const singlePidKillCalls = (text: string): string[] => {
  const violations: string[] = []
  let from = 0
  for (;;) {
    const idx = text.indexOf(IDENT, from)
    if (idx === -1) break
    from = idx + IDENT.length
    // Must be a whole identifier (not a suffix of `myEscalatingKill`).
    const before = idx === 0 ? "" : (text[idx - 1] as string)
    if (/[\w$]/.test(before)) continue
    // The call form requires `(` immediately after the identifier; a binding
    // (`= (`), an import specifier or a bare mention has something else there.
    if (text[from] !== "(") continue
    if (isDefinition(text, idx)) continue
    const parsed = readArgList(text, from)
    if (parsed === undefined) continue
    if (parsed.count === 1) violations.push(`${IDENT}(${parsed.args})`)
  }
  return violations
}

/**
 * F3 — the ban's SECOND entry point.
 *
 * The `escalatingKill(` ban above polices ONE way to tear a tree down. A site
 * that skips `escalatingKill` entirely and drives `ProcessTreeKiller.signalTree`
 * BY HAND is invisible to it — measured against the ban's own walk, 8 files call
 * `escalatingKill` while 4 issue a direct `.signalTree(` call, and three of those
 * were outside the ban's population. Driving `signalTree` by hand means opting
 * out of everything `escalatingKill` centralises: the `reaped` latch (which stops
 * a late SIGKILL landing on a RECYCLED pid), the single shared `KILL_GRACE_MS`,
 * the non-stacking one-shot grace timer, and its `unref`.
 *
 * DECISION: the ban covers BOTH entry points. Direct `signalTree` callers are an
 * explicit, JUSTIFIED allowlist rather than a blanket prohibition — two adapters
 * legitimately signal a process they did not spawn under a deadline guard. The
 * point of the allowlist is that it is CLOSED: a NEW direct caller, or a site
 * that re-diverges away from `escalatingKill`, turns this test RED.
 *
 * This does NOT weaken the `escalatingKill` ban above, which stays allowlist-free.
 */

/** The two modules that OWN the tree-kill primitive — the definition and the one
 *  canonical wrapper every spawn site is supposed to route through. They are not
 *  "callers" in the sense this guard polices. */
const TREE_KILL_OWNERS = new Set(["runtime/process-tree.ts", "runtime/guarded-spawn.ts"])

/**
 * Files permitted to call `signalTree` directly, each with the reason. Adding an
 * entry is a deliberate act that must come with a justification; a direct caller
 * that is NOT here fails the test.
 */
const DIRECT_SIGNAL_TREE_ALLOWLIST = new Map<string, string>([
  [
    "host/runtime/pty-backend.ts",
    // Signals a PTY session handle it hands to a caller, not a child it is
    // consuming under a deadline; there is no `exited` promise in that handle to
    // hang escalatingKill's `reaped` latch on. NOTE (reported, not fixed here —
    // this file is outside this change's ownership): it sends SIGTERM only, with
    // no SIGKILL escalation, so a TERM-trapping PTY shell survives it.
    "PTY session handle: no exited-promise to drive escalatingKill's latch",
  ],
  [
    "lsp/adapters/base/transport.ts",
    // The LSP stop() sequence in adapters/base.ts drives its own escalation —
    // SIGTERM, AWAIT the exit, then SIGKILL — so it needs a bare signal
    // dispatcher, not escalatingKill's timer-based escalation. It already guards
    // `pid > 0` and falls back to proc.kill when no killer is injected.
    "LSP stop() owns its own await-based SIGTERM→SIGKILL escalation",
  ],
])

/** Files (repo-relative to `src/`) that issue a direct `.signalTree(` CALL.
 *  Doc-comment mentions do not count — the match requires a call paren. Pure;
 *  exported for the red-on-injection proof. */
export const directSignalTreeCallers = (files: ReadonlyArray<{ rel: string; text: string }>) =>
  files
    .filter(
      ({ rel, text }) =>
        !TREE_KILL_OWNERS.has(rel) && /\.signalTree\s*\(/.test(stripComments(text)),
    )
    .map(({ rel }) => rel)
    .sort()

describe("F3 — direct signalTree callers are a closed, justified population", () => {
  test("no src file drives signalTree by hand outside the justified allowlist", () => {
    const files = tsFiles(SRC).map((f) => ({
      rel: f.slice(SRC.length + 1),
      text: readFileSync(f, "utf8"),
    }))
    expect(files.length, "the walk read no source files — this ban is vacuous").toBeGreaterThan(
      3250,
    )
    expect(directSignalTreeCallers(files)).toEqual([...DIRECT_SIGNAL_TREE_ALLOWLIST.keys()].sort())
  })

  test("every allowlist entry carries a non-empty justification", () => {
    for (const [file, why] of DIRECT_SIGNAL_TREE_ALLOWLIST) {
      expect(why.trim().length, `allowlist entry ${file} has no justification`).toBeGreaterThan(20)
    }
  })

  test("red-on-injection: a hand-rolled signalTree call IS detected; a mention is NOT", () => {
    // A new site bypassing escalatingKill — must be caught.
    expect(
      directSignalTreeCallers([{ rel: "some/new/site.ts", text: 'K.signalTree(pid, "SIGKILL")' }]),
    ).toEqual(["some/new/site.ts"])
    // A doc-comment mention is not a call site — must NOT be caught (paired
    // control: a predicate that greps the raw text fails this).
    expect(
      directSignalTreeCallers([
        { rel: "doc/only.ts", text: "/** routes through killer.signalTree(pid, …) */" },
      ]),
    ).toEqual([])
    // The owner modules are exempt even though they contain real calls.
    expect(
      directSignalTreeCallers([
        { rel: "runtime/guarded-spawn.ts", text: 'k.signalTree(pid, "SIGTERM")' },
      ]),
    ).toEqual([])
  })
})

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

  /**
   * F2 — the predicate must count TOP-LEVEL ARGUMENTS, not grep for punctuation.
   *
   * The original predicate used two proxies, both wrong:
   *   `args.includes(",")` as a stand-in for "two arguments" — but a SINGLE
   *      argument CONTAINING a comma (an object literal / destructured fake
   *      child, exactly what `guarded-spawn.ts` documents call sites passing)
   *      reads as compliant.
   *   `args.includes(":")` as a stand-in for "this is a definition" — but a
   *      colon also appears in typed object literals and in TERNARIES, so those
   *      calls were exempted as if they were signatures.
   * And `[^)]*` stopped at the FIRST `)`, so a call-expression argument produced
   * a malformed, unbalanced snippet.
   *
   * MEASURED against the shipped predicate before the fix:
   *   A bare      escalatingKill(proc)             → ["escalatingKill(proc)"]     CAUGHT
   *   B objlit    escalatingKill({ kill, exited }) → []                           MISSED
   *   C typedobj  escalatingKill({ kill: k })      → []                           MISSED
   *   D ternary   escalatingKill(a ? b : c)        → []                           MISSED
   *   E callexpr  escalatingKill(makeProc())       → ["escalatingKill(makeProc("] TRUNCATED
   *   F two-arg   escalatingKill(proc, TREE_KILLER)→ []                           correct
   *
   * Every shape is an arm below, in BOTH directions. F (and the definition arms)
   * are the PAIRED CONTROL: a predicate that "fixed" this by flagging everything
   * fails them.
   */
  describe("F2 — one-argument detection is by top-level arg COUNT, not punctuation", () => {
    const VIOLATIONS: Array<[string, string, string]> = [
      ["A bare identifier", "const { kill } = escalatingKill(proc)", "escalatingKill(proc)"],
      [
        "B object literal (comma is NOT a second argument)",
        "const { kill } = escalatingKill({ kill, exited })",
        "escalatingKill({ kill, exited })",
      ],
      [
        "C typed object literal (colon is NOT a signature)",
        "const { kill } = escalatingKill({ kill: k })",
        "escalatingKill({ kill: k })",
      ],
      [
        "D ternary (colon is NOT a signature)",
        "const { kill } = escalatingKill(a ? b : c)",
        "escalatingKill(a ? b : c)",
      ],
      [
        "E call expression (snippet must stay BALANCED)",
        "const { kill } = escalatingKill(makeProc())",
        "escalatingKill(makeProc())",
      ],
    ]
    for (const [name, src, snippet] of VIOLATIONS) {
      test(`FLAGS ${name}`, () => {
        expect(singlePidKillCalls(src)).toEqual([snippet])
      })
    }

    // PAIRED CONTROL — the fix must not degenerate into "flag every call".
    const CLEAN: Array<[string, string]> = [
      ["F two real arguments", "const { kill } = escalatingKill(proc, TREE_KILLER)"],
      [
        "F2 two args where the FIRST contains commas and colons",
        "const { kill } = escalatingKill({ kill, exited: p.exited }, TREE_KILLER)",
      ],
      [
        "definition — arrow binding",
        "export const escalatingKill = (proc: KillableChild): EscalatingKill => ({})",
      ],
      [
        "definition — function declaration (immediate paren, no comma, no colon proxy)",
        "export function escalatingKill(proc) { return proc }",
      ],
      ["a bare mention with no call at all", "import { escalatingKill } from '@/runtime'"],
      [
        "a COMPLIANT two-arg call quoted inside a comment",
        "// bash-bg-registry.ts calls escalatingKill(proc, BG_TREE_KILLER) here",
      ],
    ]
    for (const [name, src] of CLEAN) {
      test(`CLEARS ${name}`, () => {
        expect(singlePidKillCalls(src)).toEqual([])
      })
    }

    // KNOWN LIMITATION, pinned rather than papered over: the scan is
    // comment-aware INSIDE an argument list (see readArgList) but does not
    // exclude a whole call written inside a comment. A one-argument call quoted
    // in prose therefore reds the ban. This fails CLOSED — the safe direction,
    // and trivially resolved by rewording the comment — so it is documented here
    // instead of being fixed with a whole-file comment strip, which would risk
    // corrupting string literals containing `//` and produce false NEGATIVES.
    test("KNOWN LIMITATION: a one-arg call quoted inside a comment fails CLOSED", () => {
      expect(singlePidKillCalls("// never write escalatingKill(proc) at a new site")).toEqual([
        "escalatingKill(proc)",
      ])
    })
  })
})
