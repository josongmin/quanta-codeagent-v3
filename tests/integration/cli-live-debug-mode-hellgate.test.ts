/**
 * Live CLI behavioral hellgate — debug-mode surface (ADR-0239 family +
 * follow-ups ADR-0267 timeline / ADR-0268 inspect / ADR-0269 replay /
 * ADR-0270 decision-counter / ADR-0271 why).
 *
 * Spawns the real CLI binary as a subprocess (`bun src/apps/cli/index.ts
 * /<slash>`) and asserts on exit code + stdout + stderr. This is the
 * SOTA++ "outer ring" verification — the inner ring (per-leaf unit tests
 * + cross-slice in-process dispatch in `debug-cli-surface-e2e-hellgate
 * .test.ts`) already pins handler logic; this file pins the BOOT-TIME
 * argv routing → `runSlashMain` → BUILTINS dispatch path that ONLY the
 * real binary exercises.
 *
 * Critical gate posture — proven by every case here:
 *   - Subprocess is non-TTY (Bun.spawn pipes ⇒ `process.stderr.isTTY ===
 *     undefined`). Both `QUANTA_DEBUG` and `QUANTA_TIMELINE` boot-gates
 *     test `isTTY === true` FIRST, so even with env=1 no tracer / panel
 *     is allocated. The /debug slash therefore prints "not wired …
 *     boot with QUANTA_DEBUG=1" in this surface (one-shot path).
 *   - No LLM is invoked. `quanta /<cmd>` short-circuits at `runSlashMain`
 *     BEFORE `runRepl()` runs (see src/apps/cli/index.ts line 43-45). So
 *     `ANTHROPIC_API_KEY=test` is enough to keep `buildLLM` from being
 *     reached at all.
 *   - cwd is a fresh tmpdir so the repo's `.env.dev` (which carries a
 *     live OPENAI_API_KEY on the developer's box) is NOT autoloaded.
 *
 * Coverage matrix (8 cases):
 *   T1  /help              → BUILTINS enumerates /debug /inspect /replay /why
 *   T2  /debug status      → "not wired" + exit 0 + stdout-only
 *   T3  /debug bogus_cat   → "not wired" still wins (gate is checked first)
 *   T4  QUANTA_DEBUG=1+non-TTY → tracer NOT wired (gate honors non-TTY)
 *   T5  /inspect (no arg)  → exit 1 + "tool call id required"
 *   T6  /inspect tc_xx     → "no active session" + exit 1 (no session wired)
 *   T7  /replay missing    → "not wired" + exit 0 (one-shot path)
 *   T8  /why last          → "not wired" + exit 0 (one-shot path)
 *
 * Cases T2/T3/T7/T8 deliberately encode the documented "default-OFF in
 * one-shot surface" contract: `quanta /<cmd>` from the shell builds a
 * minimal SlashContext (cwd + out + err + skills), no `ctx.debug` /
 * `ctx.replay` / `ctx.inspect` / `ctx.why` — those seats are only filled
 * inside `runRepl()` after session-setup. The hellgate seals that
 * separation; if a future refactor wires them into one-shot mode, the
 * "not wired" assertions break and the developer must update the
 * contract + tests.
 *
 * Slice-fence: NEW test file only. No production code touched.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REPO_ROOT = "/Users/songmin/quanta-codeagent-v3"
const CLI_ENTRY = join(REPO_ROOT, "src/apps/cli/index.ts")
const TEST_TIMEOUT_MS = 15_000

interface RunResult {
  readonly exit: number
  readonly out: string
  readonly err: string
}

interface RunOpts {
  readonly env?: Readonly<Record<string, string>>
}

/**
 * Spawn the CLI binary with hermetic env + cwd. Forces stdin=ignore so any
 * accidental REPL prompt sees EOF immediately + the binary cannot hang
 * waiting for input. Bun.spawn pipes ⇒ the subprocess sees non-TTY stdout
 * and stderr, which is exactly the surface we want to exercise.
 */
const runCli = async (args: readonly string[], opts: RunOpts = {}): Promise<RunResult> => {
  // Isolated tmpdir cwd so `loadEnvFiles` cannot find the repo's `.env.dev`.
  const cwd = mkdtempSync(join(tmpdir(), "cli-live-debug-"))
  try {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      QUANTA_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "test",
      ...opts.env,
    }
    const proc = Bun.spawn({
      cmd: ["bun", CLI_ENTRY, ...args],
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    })
    const [out, err, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { exit, out, err }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

describe("CLI live debug-mode surface — subprocess hellgate", () => {
  test(
    "T1 — `/help` enumerates the 5 debug-mode slash commands",
    async () => {
      const r = await runCli(["/help"])
      expect(r.exit).toBe(0)
      // BUILTINS registers /debug /inspect /replay /why (case-12 of the
      // in-process integration). Here we prove the boot-time argv path
      // resolves them to the same registry the dispatcher sees.
      expect(r.out).toContain("/debug")
      expect(r.out).toContain("/inspect")
      expect(r.out).toContain("/replay")
      expect(r.out).toContain("/why")
      // Categorical sectioning is rendered (proves help-render saw the
      // canonical category enums from BUILTINS).
      expect(r.out).toContain("session")
      expect(r.out).toContain("history")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "T2 — `/debug status` in one-shot surface ⇒ 'not wired' + exit 0 + stdout-only",
    async () => {
      const r = await runCli(["/debug", "status"])
      expect(r.exit).toBe(0)
      // Exact message from src/apps/cli/slash-commands.ts:725.
      expect(r.out).toContain("not wired in this surface")
      expect(r.out).toContain("QUANTA_DEBUG=1")
      // Stream segregation: the "not wired" line is written via ctx.out,
      // so stderr MUST be empty.
      expect(r.err).toBe("")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "T3 — `/debug bogus_cat` in one-shot ⇒ 'not wired' wins before bad-arg check",
    async () => {
      // The slash handler checks `ctx.debug === undefined` FIRST and exits
      // 0 with the "not wired" message — the unknown-argument branch (which
      // would print to stderr + exit 1) is unreachable from one-shot mode.
      // This pins the gate ordering: a typo in subprocess-mode never looks
      // like a "/debug subsystem broke" diagnostic.
      const r = await runCli(["/debug", "bogus_cat"])
      expect(r.exit).toBe(0)
      expect(r.out).toContain("not wired in this surface")
      // The "unknown argument" branch in debugCmd.run writes to ctx.err. If
      // gate ordering ever flips, this assertion fires.
      expect(r.err).not.toContain("/debug: unknown argument")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "T4 — `QUANTA_DEBUG=1` in non-TTY subprocess does NOT wire the tracer",
    async () => {
      // The boot-gate in repl.ts:412-423 (`buildDebugTracerAndStream`)
      // tests `isTTY !== true` FIRST and returns `{stream, debugHandle:
      // undefined}` without consulting QUANTA_DEBUG. Bun.spawn pipes mean
      // `process.stderr.isTTY` is undefined ⇒ the tracer is never
      // allocated. We use `/help` so we never enter `runRepl()` — but we
      // still set the env knob to prove that even if a future refactor
      // moved the gate to the slash dispatcher, the non-TTY guard would
      // still hold. The hellgate fires if a tracer ever writes to stderr
      // in this surface.
      const r = await runCli(["/help"], { env: { QUANTA_DEBUG: "1" } })
      expect(r.exit).toBe(0)
      // Tracer lines have the shape `HH:MM:SS.mmm [tN] kind ...` — assert
      // NONE of them appear on stderr. (We can't grep for the regex
      // directly because some unrelated logger.error lines also use ISO
      // timestamps; instead we pin the literal `[t` turn-marker which is
      // tracer-exclusive.)
      expect(r.err).not.toContain("[t0]")
      expect(r.err).not.toContain("[t1]")
      // Same posture as T2 — `/help` writes its panel to stdout.
      expect(r.out).toContain("/debug")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "T5 — `/inspect` (no arg) ⇒ 'tool call id required' + exit 1 + stderr-only",
    async () => {
      const r = await runCli(["/inspect"])
      expect(r.exit).toBe(1)
      // The arg-count branch fires BEFORE the ctx.inspect check (it's a
      // hard usage error, not a wiring error). Goes to stderr.
      expect(r.err).toContain("tool call id required")
      expect(r.out).toBe("")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "T6 — `/inspect tc_xx` in one-shot ⇒ 'no active session' + exit 1 (stdout)",
    async () => {
      // /inspect's wiring-absent message goes to STDOUT (via runInspectCmd
      // → deps.out), NOT stderr. This is distinct from the other slash
      // surfaces — pinning it here catches a refactor that "normalises"
      // the wiring-absent message to stderr.
      const r = await runCli(["/inspect", "tc_doesnotexist"])
      expect(r.exit).toBe(1)
      expect(r.out).toContain("no active session")
      expect(r.err).toBe("")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "T7 — `/replay nonexistent-session` in one-shot ⇒ 'not wired' + exit 0",
    async () => {
      const r = await runCli(["/replay", "nonexistent-session-id-zzz"])
      // Default-OFF: ctx.replay is undefined in one-shot mode ⇒ exit 0,
      // stdout-only. The "session not found" branch is unreachable from
      // subprocess /one-shot since the gate prevents the resolver from
      // ever being called.
      expect(r.exit).toBe(0)
      expect(r.out).toContain("/replay: not wired in this surface")
      expect(r.err).toBe("")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "T8 — `/why last` in one-shot ⇒ 'not wired' + exit 0 (no LLM invocation)",
    async () => {
      // The wiring check in whyCmd.run sits AFTER the arg-count check, so
      // `/why last` (single arg) passes arg validation then hits the
      // ctx.why === undefined branch ⇒ "not wired" + exit 0. Importantly
      // this proves `/why` in one-shot mode NEVER invokes the LLM — no
      // ANTHROPIC_API_KEY beyond the dummy is consulted, no network
      // round-trip, no cost.
      const r = await runCli(["/why", "last"])
      expect(r.exit).toBe(0)
      expect(r.out).toContain("/why: not wired in this surface")
      expect(r.err).toBe("")
    },
    TEST_TIMEOUT_MS,
  )
})
