/**
 * ★ PERMANENT GUARD — EXEC-CLUSTER SPAWN ENV-SCRUB BAN (R-D3, RFC jun-7 Phase-2).
 *
 * THE BUG CLASS THIS LOCKS DOWN:
 *   A spawn site in the exec cluster (`shell.ts`, `bash-bg-registry.ts`,
 *   `sandbox.ts`, `command-hooks/sandbox-exec.ts`, `host/runtime/pty-backend.ts`)
 *   that runs a user-command SHELL (`bash -lc <cmd>` / an interactive PTY shell)
 *   leaks the PARENT process env — including `*_API_KEY` / `*_TOKEN` / `*_SECRET`
 *   — into the child UNLESS it passes an `env:` that was produced by the shared
 *   scrubber (`scrubEnv` / `buildPtyEnv` / `applyLocalEnv`). There are TWO leak
 *   shapes:
 *     (1) a RAW `{ ...process.env }` spread — explicit full-inherit leak;
 *     (2) an `env:`-ABSENT spawn — Bun then SNAPSHOTS the parent env
 *         (inherit-by-omission), the silent leak the `R-D3` audit flagged.
 *   This guard makes BOTH a RED test: every `Bun.spawn(...)` that runs a
 *   user-command shell MUST pass an `env:` AND that env MUST route through
 *   `scrubEnv` / `buildPtyEnv` / `applyLocalEnv`.
 *
 * SCOPE / ALLOWLIST (each entry documented with a reason):
 *   The cluster also spawns benign ARGV-TOOLS that are NOT user-command shells
 *   and legitimately do not (or cannot) take a scrubbed `env:`:
 *     - `pty-backend.ts` `Bun.spawn(["tmux", ...args] …)` — a `tmux` subcommand
 *       runner (argv-array, no shell); it queries/controls tmux, runs no model
 *       command, and inherits the operator env on purpose.
 *     - `sandbox.ts` `Bun.spawn([this.dockerBin, "version"] …)` — the docker
 *       availability PROBE; argv-tool, runs no user command.
 *     - `sandbox.ts` `Bun.spawn(argv …)` inside `DockerSandbox.run` — the
 *       `docker run …` host process; the CONTAINER env is governed by docker's
 *       own `--env NAME` allowlist flags (built in `buildArgv`), NOT by the host
 *       spawn's `env`, so a scrubbed host `env:` would be the wrong mechanism.
 *   The `buildPtyEnv` opt-out branch (`QUANTA_PTY_INHERIT_ENV`) is NOT
 *   separately allowlisted: it lives INSIDE `buildPtyEnv`, so the spawn site
 *   still routes through the scrubber token and stays clean by construction.
 *
 * RED-ON-INJECTION (bottom): a synthetic exec-cluster `Bun.spawn(["bash","-lc",
 * c], {})` (no env) AND a `Bun.spawn(argv, { env: { ...process.env } })` are
 * BOTH flagged by the predicate; `{ env: scrubEnv() }` is clean. Then GREEN on
 * the current cluster.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const SRC = join(import.meta.dir, "..", "..", "..", "src")

/** The exec-cluster files this guard scans (R-D3 scope). */
const CLUSTER_FILES = [
  "runtime/shell.ts",
  "runtime/bash-bg-registry.ts",
  "runtime/sandbox.ts",
  "agent/command-hooks/sandbox-exec.ts",
  "host/runtime/pty-backend.ts",
]

/** The scrubber producers — an `env:` value MUST reference one of these to be
 *  considered routed. `withProxyEnv(...)` / `applyLocalEnv(...)` compose OVER a
 *  scrubber base, so they are accepted only when the base token also appears in
 *  the env expression (the production sites all do — they wrap `scrubEnv()`). */
const SCRUBBER_TOKENS = ["scrubEnv", "buildPtyEnv", "applyLocalEnv"]

/** Benign non-shell ARGV-TOOL spawns that are allowlisted by an argv head
 *  substring appearing in the spawn call text. Each has a reason (see header). */
const ARGV_TOOL_ALLOW = [
  '["tmux"', // pty-backend tmux subcommand runner
  '[this.dockerBin, "version"]', // sandbox docker availability probe
]

/** Allowlist by a stable substring of the spawn-call text for argv that is built
 *  elsewhere (not a literal in the call). DockerSandbox.run: container env is
 *  governed by docker's `--env NAME` flags, not the host spawn env. */
const BUILT_ARGV_ALLOW = [
  // `DockerSandbox.run` spawns `argv` from `buildArgv`; the spawn options are
  // exactly `{ stdout: "pipe", stderr: "pipe" }` with NO env by design.
  'Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })',
]

/** Strip block + line comments so doc-comment MENTIONS of `Bun.spawn(...)`
 *  (`Bun.spawn(["git", …])`, `Bun.spawn({ env })`) are not mistaken for real
 *  call sites. Crude but sufficient: the cluster files contain no `//` / `/*`
 *  inside string literals that would confuse this. */
export const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")

/**
 * Extract every `Bun.spawn(` call's argument text (balanced to the matching
 * close paren) from `text`. Pure. Used to inspect the options object of each
 * spawn site without a full TS parse.
 */
export const bunSpawnCalls = (rawText: string): string[] => {
  const text = stripComments(rawText)
  const calls: string[] = []
  const NEEDLE = "Bun.spawn("
  let i = text.indexOf(NEEDLE)
  while (i !== -1) {
    let depth = 0
    let j = i + NEEDLE.length - 1 // points at the opening "("
    for (; j < text.length; j++) {
      const ch = text[j]
      if (ch === "(") depth++
      else if (ch === ")") {
        depth--
        if (depth === 0) break
      }
    }
    calls.push(text.slice(i, j + 1))
    i = text.indexOf(NEEDLE, j + 1)
  }
  return calls
}

/** A spawn call is ALLOWLISTED (benign argv-tool / docker host process) iff its
 *  text matches an argv-tool head OR a built-argv allow snippet. */
const isAllowlisted = (call: string): boolean =>
  ARGV_TOOL_ALLOW.some((s) => call.includes(s)) || BUILT_ARGV_ALLOW.some((s) => call.includes(s))

/** Extract the env-value EXPRESSION from a spawn call's `env: <expr>` (up to the
 *  next top-level `,` or `}`), or `undefined` when there is no `env:` key. A
 *  SHORTHAND property (`env,` / `env}` — the variable IS the value) resolves to
 *  the identifier `"env"`. */
const envValueOf = (call: string): string | undefined => {
  // Shorthand: `{ ..., env, ... }` or `{ ..., env }` — the property is the var.
  if (/[,{]\s*env\s*[,}]/.test(call)) return "env"
  const m = /\benv\s*:\s*/.exec(call)
  if (m === null) return undefined
  const start = m.index + m[0].length
  let depth = 0
  for (let k = start; k < call.length; k++) {
    const ch = call[k]
    if (ch === "{" || ch === "(" || ch === "[") depth++
    else if (ch === "}" || ch === ")" || ch === "]") {
      if (depth === 0) return call.slice(start, k).trim()
      depth--
    } else if (ch === "," && depth === 0) return call.slice(start, k).trim()
  }
  return call.slice(start).trim()
}

/** The assignment RHS of a bare `const/let/var <ident> = <rhs>` in the file, or
 *  undefined. The RHS is captured BALANCED (it MAY span lines —
 *  `const env = withProxyEnv(\n  scrubEnv(...),\n)` ) so a multi-line compose
 *  chain is followed. Capture runs from `=` to a top-level statement
 *  terminator (`;`/newline at depth 0) honoring `()[]{}` nesting. */
const assignmentRhs = (ident: string, fileText: string): string | undefined => {
  const m = new RegExp(`(?:const|let|var)\\s+${ident}\\s*=\\s*`).exec(fileText)
  if (m === null) return undefined
  const start = m.index + m[0].length
  let depth = 0
  for (let k = start; k < fileText.length; k++) {
    const ch = fileText[k]
    if (ch === "(" || ch === "[" || ch === "{") depth++
    else if (ch === ")" || ch === "]" || ch === "}") depth--
    else if ((ch === "\n" || ch === ";") && depth === 0) return fileText.slice(start, k)
  }
  return fileText.slice(start)
}

/**
 * Does this env expression route through a scrubber producer? Directly (it
 * mentions a scrubber token) OR transitively — a BARE IDENTIFIER whose
 * assignment chain reaches a scrubber token. Compose wrappers
 * (`withProxyEnv(applyLocalEnv(scrubEnv()))`) are followed by chasing the bare
 * identifiers they wrap (`const env = withProxyEnv(localEnvBase, …)` →
 * `localEnvBase` → `applyLocalEnv` ✓). Bounded by a `seen` set (no cycle hang).
 */
const expressionIsScrubbed = (expr: string, fileText: string, seen: Set<string>): boolean => {
  if (SCRUBBER_TOKENS.some((t) => expr.includes(t))) return true
  // Collect every bare identifier in the expression and follow each assignment.
  for (const ident of expr.match(/[A-Za-z_$][\w$]*/g) ?? []) {
    if (seen.has(ident)) continue
    seen.add(ident)
    const rhs = assignmentRhs(ident, fileText)
    if (rhs !== undefined && expressionIsScrubbed(rhs, fileText, seen)) return true
  }
  return false
}

/**
 * Is the env routed through a scrubber producer? `env:` must be present (incl.
 * shorthand) AND its value must reach a scrubber token directly or through the
 * compose chain. A raw `{ ...process.env }` spread (no scrubber identifier in
 * the chain) ⇒ not scrubbed.
 */
const hasScrubbedEnv = (call: string, fileText: string): boolean => {
  const value = envValueOf(call)
  if (value === undefined) return false
  return expressionIsScrubbed(value, fileText, new Set())
}

/**
 * Pure predicate: return the LEAKY `Bun.spawn` calls in `text` — those that run
 * a user-command shell but DON'T route env through the scrubber. A call is a
 * violation iff it is NOT allowlisted AND NOT scrubbed (covers both the raw
 * `{ ...process.env }` spread and the `env:`-absent inherit-by-omission).
 */
export const leakySpawnCalls = (text: string): string[] =>
  bunSpawnCalls(text).filter((call) => !isAllowlisted(call) && !hasScrubbedEnv(call, text))

describe("exec-cluster spawn env-scrub ban — every shell spawn routes through the scrubber (R-D3)", () => {
  test("NO exec-cluster spawn leaks parent env (raw spread OR env-absent)", () => {
    const offenders: Array<{ file: string; calls: string[] }> = []
    for (const rel of CLUSTER_FILES) {
      const text = readFileSync(join(SRC, rel), "utf8")
      const calls = leakySpawnCalls(text)
      if (calls.length > 0) offenders.push({ file: rel, calls })
    }
    expect(offenders).toEqual([])
  })

  test("red-on-injection: env-absent AND raw-process.env spawns are flagged; scrubbed is clean", () => {
    // (2) inherit-by-omission — no `env:` at all.
    expect(leakySpawnCalls('Bun.spawn(["bash","-lc",c], {})')).toEqual([
      'Bun.spawn(["bash","-lc",c], {})',
    ])
    // (1) raw full-inherit spread.
    expect(
      leakySpawnCalls('Bun.spawn(argv, { cwd, env: { ...process.env }, stdout: "pipe" })'),
    ).toEqual(['Bun.spawn(argv, { cwd, env: { ...process.env }, stdout: "pipe" })'])
    // The fixed form — env routed through the scrubber.
    expect(leakySpawnCalls('Bun.spawn(argv, { cwd, env: scrubEnv(), stdout: "pipe" })')).toEqual([])
    // Bare identifier `env: childEnv` traced to its scrubber assignment ⇒ clean.
    expect(
      leakySpawnCalls(
        "const childEnv = buildPtyEnv({})\nconst child = Bun.spawn(argv, { cwd, env: childEnv })",
      ),
    ).toEqual([])
    // …but a bare identifier with NO scrubber assignment IS flagged.
    expect(
      leakySpawnCalls("const childEnv = process.env\nBun.spawn(a, { env: childEnv })"),
    ).toEqual(["Bun.spawn(a, { env: childEnv })"])
    // Allowlisted argv-tool — not flagged even without env.
    expect(leakySpawnCalls('Bun.spawn(["tmux", ...args], { stdout: "pipe" })')).toEqual([])
  })

  test("balanced extraction handles nested parens / object literals", () => {
    const text = "Bun.spawn(argv, { env: withProxyEnv(scrubEnv(), {}) })"
    expect(bunSpawnCalls(text)).toEqual(["Bun.spawn(argv, { env: withProxyEnv(scrubEnv(), {}) })"])
    expect(leakySpawnCalls(text)).toEqual([]) // composed over scrubEnv ⇒ clean
  })
})
